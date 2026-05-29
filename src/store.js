// store.js — thin wrapper over chrome.storage.local for the extension's state:
// settings, daily stats, repeat-offender tracking, seen-comment dedupe, and an
// audit log. Imported by the background service worker.

export const DEFAULT_SETTINGS = {
  enabled: true,
  // 'review' = flag with a one-click Delete button; 'auto' = delete immediately.
  mode: "review",
  // 'builtin' (on-device Gemini Nano) | 'heuristic'. 'builtin' falls back to
  // heuristic automatically when the on-device model is unavailable.
  classifier: "builtin",
  // Confidence threshold (0..1) above which a comment is flagged.
  sensitivity: 0.6,
  // Always run the cheap heuristic first; only ask the LLM on borderline cases.
  heuristicPrefilter: true,
  // After this many strikes, a commenter's future comments are auto-flagged.
  offenderStrikeThreshold: 3,
  // Names or profile-URL fragments that are NEVER flagged.
  allowlist: [],
  // Names or profile-URL fragments that are ALWAYS flagged.
  blocklist: [],
  // Re-scan open LinkedIn tabs on this interval.
  scanIntervalMinutes: 5,
  // Optional manual override if auto-detection of your name ever misfires.
  myNameOverride: "",
  // Show a desktop notification when comments are auto-deleted.
  notifyOnDelete: true,
};

const SEEN_CAP = 5000;
const AUDIT_CAP = 500;

async function get(keys) {
  return chrome.storage.local.get(keys);
}
async function set(obj) {
  return chrome.storage.local.set(obj);
}

// --- settings ---------------------------------------------------------------
export async function getSettings() {
  const { settings } = await get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await set({ settings: next });
  return next;
}

// --- stats (per day) --------------------------------------------------------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export async function getStats() {
  const { stats } = await get("stats");
  return stats || {};
}

export async function bumpStat(field, n = 1) {
  const { stats } = await get("stats");
  const s = stats || {};
  const day = todayKey();
  s[day] = s[day] || { scanned: 0, flagged: 0, deleted: 0, skipped: 0 };
  s[day][field] = (s[day][field] || 0) + n;
  await set({ stats: s });
  return s[day];
}

export async function getTodayStats() {
  const s = await getStats();
  return s[todayKey()] || { scanned: 0, flagged: 0, deleted: 0, skipped: 0 };
}

// --- seen comments (dedupe) -------------------------------------------------
export async function hasSeen(id) {
  const { seen } = await get("seen");
  return !!(seen && seen[id]);
}

export async function recordSeen(id, data) {
  const { seen } = await get("seen");
  const s = seen || {};
  s[id] = { ts: Date.now(), ...data };
  // Prune oldest entries if we exceed the cap.
  const keys = Object.keys(s);
  if (keys.length > SEEN_CAP) {
    keys
      .sort((a, b) => (s[a].ts || 0) - (s[b].ts || 0))
      .slice(0, keys.length - SEEN_CAP)
      .forEach((k) => delete s[k]);
  }
  await set({ seen: s });
}

// --- repeat offenders -------------------------------------------------------
export async function getOffenders() {
  const { offenders } = await get("offenders");
  return offenders || {};
}

export async function recordOffender(url, name) {
  if (!url) return null;
  const offenders = await getOffenders();
  const key = url;
  offenders[key] = offenders[key] || { name: name || "", strikes: 0, lastSeen: 0 };
  offenders[key].strikes += 1;
  offenders[key].name = name || offenders[key].name;
  offenders[key].lastSeen = Date.now();
  await set({ offenders });
  return offenders[key];
}

export async function getOffender(url) {
  if (!url) return null;
  const offenders = await getOffenders();
  return offenders[url] || null;
}

// --- audit log --------------------------------------------------------------
export async function addAudit(entry) {
  const { audit } = await get("audit");
  const list = audit || [];
  list.unshift({ ts: Date.now(), ...entry });
  if (list.length > AUDIT_CAP) list.length = AUDIT_CAP;
  await set({ audit: list });
}

export async function getAudit() {
  const { audit } = await get("audit");
  return audit || [];
}

// --- reset ------------------------------------------------------------------
export async function resetData({ keepSettings = true } = {}) {
  const settings = keepSettings ? await getSettings() : DEFAULT_SETTINGS;
  await chrome.storage.local.clear();
  await set({ settings });
}
