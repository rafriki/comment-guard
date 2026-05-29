// background.js — MV3 service worker. Orchestrates classification, owns all
// persisted state, and drives periodic re-scans of open LinkedIn tabs.

import { heuristicScore, classifyWithBuiltin, builtinAvailability } from "./classifier.js";
import {
  DEFAULT_SETTINGS,
  getSettings,
  setSettings,
  bumpStat,
  getTodayStats,
  getStats,
  hasSeen,
  recordSeen,
  recordOffender,
  getOffenders,
  getOffender,
  addAudit,
  getAudit,
  resetData,
} from "./store.js";

const ALARM_NAME = "comment-guard-scan";

// --- lifecycle --------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  // Seed defaults without clobbering anything already set.
  const settings = await getSettings();
  await setSettings(settings);
  await armAlarm(settings.scanIntervalMinutes);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await armAlarm(settings.scanIntervalMinutes);
});

async function armAlarm(minutes) {
  await chrome.alarms.clear(ALARM_NAME);
  const period = Math.max(1, Number(minutes) || DEFAULT_SETTINGS.scanIntervalMinutes);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: period });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const settings = await getSettings();
  if (!settings.enabled) return;
  await broadcastScan();
});

async function broadcastScan() {
  const tabs = await chrome.tabs.query({ url: "https://www.linkedin.com/*" });
  for (const tab of tabs) {
    if (tab.id != null) {
      chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" }).catch(() => {});
    }
  }
}

// --- classification ---------------------------------------------------------
function matchesList(comment, list) {
  if (!Array.isArray(list) || !list.length) return false;
  const author = (comment.author || "").toLowerCase();
  const url = (comment.authorUrl || "").toLowerCase();
  return list.some((entry) => {
    const e = String(entry || "").trim().toLowerCase();
    if (!e) return false;
    return author.includes(e) || (url && url.includes(e));
  });
}

function decide(verdict, settings) {
  const flagged = !!verdict.spam && verdict.confidence >= settings.sensitivity;
  return { ...verdict, flagged };
}

async function classifyOne(comment, settings, offenders) {
  // Hard lists win first.
  if (matchesList(comment, settings.allowlist)) {
    return { spam: false, confidence: 0, reason: "on your allowlist", source: "list", flagged: false };
  }
  if (matchesList(comment, settings.blocklist)) {
    return { spam: true, confidence: 1, reason: "on your blocklist", source: "list", flagged: true };
  }

  // Known repeat offender → auto-flag.
  const off = comment.authorUrl ? offenders[comment.authorUrl] : null;
  if (off && off.strikes >= settings.offenderStrikeThreshold) {
    return {
      spam: true,
      confidence: 1,
      reason: `repeat offender (${off.strikes} prior strikes)`,
      source: "offender",
      flagged: true,
    };
  }

  const h = heuristicScore(comment);

  if (settings.classifier === "heuristic") return decide(h, settings);

  // Cheap pre-filter: skip the LLM when the heuristic is very confident.
  if (settings.heuristicPrefilter) {
    if (h.confidence >= 0.85 || h.confidence <= 0.1) return decide(h, settings);
  }

  // 'builtin' (default): on-device Gemini Nano, with the heuristic as fallback.
  let verdict = await classifyWithBuiltin(comment);
  if (!verdict) verdict = h; // model unavailable → graceful fallback
  return decide(verdict, settings);
}

// --- message handling -------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((err) => {
      console.warn("[CommentGuard] message handler error", err);
      sendResponse({ ok: false, error: String(err) });
    });
  return true; // keep the channel open for async sendResponse
});

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case "GET_SETTINGS":
      return { ok: true, settings: await getSettings() };

    case "CLASSIFY": {
      const settings = await getSettings();
      if (!settings.enabled) return { ok: true, results: [] };
      const offenders = await getOffenders();
      const results = [];
      for (const c of msg.comments || []) {
        if (!c?.id) continue;
        if (await hasSeen(c.id)) continue; // already handled in a prior pass
        const verdict = await classifyOne(c, settings, offenders);
        await recordSeen(c.id, { action: "pending", author: c.author });
        await bumpStat("scanned");
        results.push({
          id: c.id,
          flagged: verdict.flagged,
          confidence: verdict.confidence,
          reason: verdict.reason,
          source: verdict.source,
          // LinkedIn only deletes on a trusted user gesture, so we always flag
          // for a one-click manual delete (see content.js).
          action: verdict.flagged ? "flag" : "none",
        });
      }
      return { ok: true, results };
    }

    case "REPORT": {
      // Content script reports the final outcome of a comment so we can keep
      // stats, offender strikes, and the audit log accurate.
      const { id, author, authorUrl, postUrn, text, verdict, action } = msg;
      if (action === "flagged" || action === "deleted") {
        await bumpStat(action === "deleted" ? "deleted" : "flagged");
        if (authorUrl) await recordOffender(authorUrl, author);
      } else if (action === "skipped" || action === "kept") {
        await bumpStat("skipped");
      }
      if (id) await recordSeen(id, { action, author });
      await addAudit({ postUrn, author, authorUrl, text: (text || "").slice(0, 280), verdict, action });
      return { ok: true };
    }

    case "GET_STATE": {
      const [settings, today, stats, offenders, audit, availability] = await Promise.all([
        getSettings(),
        getTodayStats(),
        getStats(),
        getOffenders(),
        getAudit(),
        builtinAvailability(),
      ]);
      return { ok: true, settings, today, stats, offenders, audit, builtinAvailability: availability };
    }

    case "SET_SETTINGS": {
      const prev = await getSettings();
      const next = await setSettings(msg.patch || {});
      if (next.scanIntervalMinutes !== prev.scanIntervalMinutes) {
        await armAlarm(next.scanIntervalMinutes);
      }
      return { ok: true, settings: next };
    }

    case "SCAN_NOW": {
      // Triggered from the popup — scan the active tab (or all LinkedIn tabs).
      if (msg.activeTabOnly) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null && /https:\/\/www\.linkedin\.com\//.test(tab.url || "")) {
          chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" }).catch(() => {});
          return { ok: true, scanned: true };
        }
        return { ok: false, error: "Open a LinkedIn tab first." };
      }
      await broadcastScan();
      return { ok: true };
    }

    case "CHECK_BUILTIN":
      return { ok: true, availability: await builtinAvailability() };

    case "NOTIFY_DELETED": {
      const settings = await getSettings();
      if (settings.notifyOnDelete && msg.count > 0) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "LinkedIn Comment Guard",
          message: `Removed ${msg.count} spam comment${msg.count === 1 ? "" : "s"}.`,
        });
      }
      return { ok: true };
    }

    case "RESET_DATA":
      await resetData({ keepSettings: !msg.wipeSettings });
      return { ok: true };

    default:
      return { ok: false, error: `unknown message: ${msg?.type}` };
  }
}
