// content.js — runs inside linkedin.com in your own logged-in session.
// Finds comments on YOUR posts, asks the background worker to classify them,
// then flags them (review mode) or attempts deletion (auto mode).
//
// SELECTOR STRATEGY (validated against the live LinkedIn DOM, 2026):
// LinkedIn now uses obfuscated/hashed CSS class names, so we DO NOT rely on
// classes. Instead we use stable hooks:
//   - posts:    button[aria-label^="Open control menu for post by <Author>"]
//   - comments: button[aria-label^="View more options for <Name>'s comment."]
//   - text:     [data-testid="expandable-text-box"]
//   - identity: the nav avatar's img alt is the bare user name; everyone else's
//               alt begins with "View ... profile".
// If LinkedIn changes these, update the HOOKS object below — it's the only place.
(() => {
  "use strict";

  const LOG = "[CommentGuard]";
  const HOOKS = {
    feedRoot: '[data-testid="mainFeed"]',
    postCtrlBtn: 'button[aria-label^="Open control menu for post by " i]',
    // Every rendered comment carries a "Reply to <name>'s comment" button in
    // every view, so we locate comments by that. The "View more options" •••
    // button (which contains Delete) is only present on some surfaces, so it's
    // optional and used only for the delete assist.
    commentReplyBtn: 'button[aria-label^="Reply to" i][aria-label*="comment" i]',
    commentOptionsBtn: 'button[aria-label^="View more options for" i][aria-label*="comment" i]',
    textBox: '[data-testid="expandable-text-box"]',
  };

  // ---- tiny utilities ------------------------------------------------------
  const txt = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const isVisible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
    return (h >>> 0).toString(36);
  }
  function profileUrl(container) {
    const a = container.querySelector('a[href*="/in/"], a[href*="/company/"]');
    if (!a) return "";
    try {
      return new URL(a.getAttribute("href"), location.origin).origin + new URL(a.href).pathname;
    } catch {
      return a.getAttribute("href") || "";
    }
  }
  async function waitFor(fn, { timeout = 2500, interval = 120 } = {}) {
    const start = Date.now();
    for (;;) {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (Date.now() - start > timeout) return null;
      await sleep(interval);
    }
  }

  // ---- identity ------------------------------------------------------------
  let ME = null;
  function getMyName() {
    if (SETTINGS.myNameOverride && SETTINGS.myNameOverride.trim()) return SETTINGS.myNameOverride.trim();
    if (ME) return ME;
    // The logged-in user's avatar carries their bare name in alt text; every
    // other person's avatar alt begins with "View ... profile".
    const candidates = [...document.querySelectorAll("img[alt]")]
      .map((i) => i.alt.trim())
      .filter((a) => a && !/^View\b/i.test(a) && !/[:\/]/.test(a) && a.split(/\s+/).length <= 5);
    ME = candidates[0] || null;
    if (ME) console.debug(LOG, "detected user:", ME);
    return ME;
  }

  // ---- post / comment discovery -------------------------------------------
  function postAuthor(btn) {
    return (btn.getAttribute("aria-label") || "").replace(/^Open control menu for post by\s*/i, "").trim();
  }
  // Climb to the largest ancestor that still contains exactly this one post.
  function postContainer(btn) {
    let c = btn, best = btn;
    for (let i = 0; i < 12 && c.parentElement; i++) {
      c = c.parentElement;
      const n = c.querySelectorAll(HOOKS.postCtrlBtn).length;
      if (n === 1) best = c;
      else if (n > 1) break;
    }
    return best;
  }
  function commenterName(btn) {
    const m = (btn.getAttribute("aria-label") || "").match(
      /(?:Reply to|View more options for) (.+?)[’']s? comment/i
    );
    return m ? m[1].trim() : "";
  }
  // Climb up from a comment's Reply button to its subtree, without bleeding into
  // the post body (stop once we'd include the post-level control button).
  function commentContainer(btn) {
    let c = btn, best = btn;
    for (let i = 0; i < 10 && c.parentElement; i++) {
      c = c.parentElement;
      if (c.querySelector(HOOKS.postCtrlBtn)) break; // reached post level
      const n = c.querySelectorAll(HOOKS.commentReplyBtn).length;
      if (n === 1) best = c;
      else if (n > 1) break;
    }
    return best;
  }
  // Comment text usually lives in an expandable-text-box, but short/untruncated
  // comments don't get that wrapper — fall back to the container's own text
  // with interactive/meta bits stripped out.
  function commentText(container, author) {
    const tb = container.querySelector(HOOKS.textBox);
    if (tb && txt(tb)) return txt(tb);
    const clone = container.cloneNode(true);
    clone
      .querySelectorAll('button, a, svg, time, .cg-badge, [aria-hidden="true"]')
      .forEach((e) => e.remove());
    let t = txt(clone);
    if (author && t.startsWith(author)) t = t.slice(author.length).trim();
    return t.slice(0, 1000);
  }
  function commentData(replyBtn, postKey) {
    const container = commentContainer(replyBtn);
    const author = commenterName(replyBtn);
    const text = commentText(container, author);
    const authorUrl = profileUrl(container);
    const norm = text.toLowerCase().slice(0, 200);
    const id = hash(postKey + "|" + author + "|" + norm);
    // The ••• "View more options" button (with Delete) is only on some surfaces.
    const optionsBtn = container.querySelector(HOOKS.commentOptionsBtn);
    return { id, author, authorUrl, text, postUrn: postKey, _container: container, _reply: replyBtn, _options: optionsBtn };
  }

  // ---- deletion (best-effort) ---------------------------------------------
  // NOTE: On the current LinkedIn build, a synthetic click opens the control
  // menu's state (aria-expanded=true) but the menu PANEL does not render into
  // script-reachable DOM (it requires a trusted user gesture). So this routine
  // is best-effort: it tries, and reports failure cleanly so the UI can fall
  // back to flagging for a manual one-click delete by you.
  function findDeleteItem() {
    const roots = [document, ...[...document.querySelectorAll("*")].filter((e) => e.shadowRoot).map((e) => e.shadowRoot)];
    for (const root of roots) {
      const items = root.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] [role="button"], li button');
      for (const it of items) {
        if (isVisible(it) && /^delete\b/i.test(txt(it))) return it;
      }
    }
    return null;
  }
  function findConfirmDelete() {
    const dialogs = document.querySelectorAll('[role="dialog"], [data-testid="dialog-content"]');
    for (const d of dialogs) {
      if (!isVisible(d)) continue;
      for (const b of d.querySelectorAll("button")) {
        const t = txt(b).toLowerCase();
        if (t === "delete" || t === "delete comment") return b;
      }
    }
    return null;
  }
  async function attemptDelete(ctrlBtn) {
    if (!ctrlBtn) return { ok: false, reason: "no-delete-button-in-this-view" };
    try {
      ctrlBtn.scrollIntoView({ block: "center" });
      await sleep(120);
      // Full pointer+mouse sequence (some handlers ignore a bare click()).
      const fire = (type, C) =>
        ctrlBtn.dispatchEvent(new C(type, { bubbles: true, cancelable: true, view: window, pointerId: 1, button: 0 }));
      fire("pointerdown", PointerEvent); fire("mousedown", MouseEvent);
      fire("pointerup", PointerEvent); fire("mouseup", MouseEvent); fire("click", MouseEvent);

      const del = await waitFor(findDeleteItem, { timeout: 2000 });
      if (!del) {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return { ok: false, reason: "menu-not-accessible" };
      }
      del.click();
      const confirm = await waitFor(findConfirmDelete, { timeout: 2000 });
      if (confirm) confirm.click();
      return { ok: true };
    } catch (e) {
      console.warn(LOG, "attemptDelete error", e);
      return { ok: false, reason: String(e) };
    }
  }

  // ---- badge UI ------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function renderBadge(container, info, onDelete, onKeep) {
    if (container.querySelector(":scope > .cg-badge")) return;
    const badge = document.createElement("div");
    badge.className = "cg-badge";
    badge.innerHTML = `
      <span class="cg-badge__icon">⚠</span>
      <span class="cg-badge__text">Likely AI/spam${info.reason ? ` · ${escapeHtml(info.reason)}` : ""}${
        typeof info.confidence === "number" ? ` (${Math.round(info.confidence * 100)}%)` : ""
      }</span>
      <button class="cg-btn cg-btn--del" type="button">Delete</button>
      <button class="cg-btn cg-btn--keep" type="button">Keep</button>`;
    badge.querySelector(".cg-btn--del").addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      const t = badge.querySelector(".cg-badge__text");
      t.textContent = "Deleting…";
      const res = await onDelete();
      if (!res || !res.ok) {
        t.textContent =
          res && res.reason === "no-delete-button-in-this-view"
            ? "Open the post itself to delete — LinkedIn doesn't show the ⋯ menu in this view."
            : "Couldn't auto-delete — use the spotlighted ⋯ menu and click Delete.";
      }
    });
    badge.querySelector(".cg-btn--keep").addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      badge.remove(); onKeep();
    });
    container.prepend(badge);
  }
  function highlightForManual(container, ctrlBtn) {
    try {
      (ctrlBtn || container).scrollIntoView({ block: "center", behavior: "smooth" });
      container.classList.add("cg-flag-highlight");
      if (ctrlBtn) {
        ctrlBtn.classList.add("cg-target");
        setTimeout(() => ctrlBtn.classList.remove("cg-target"), 6000);
      }
      setTimeout(() => container.classList.remove("cg-flag-highlight"), 6000);
    } catch {}
  }

  // ---- messaging -----------------------------------------------------------
  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (resp) => { void chrome.runtime.lastError; resolve(resp); });
      } catch { resolve(null); }
    });
  }
  const report = (entry) => send({ type: "REPORT", ...entry });

  // ---- settings cache ------------------------------------------------------
  let SETTINGS = { enabled: true, mode: "review", myNameOverride: "" };
  async function refreshSettings() {
    const resp = await send({ type: "GET_SETTINGS" });
    if (resp?.settings) { SETTINGS = resp.settings; ME = null; }
  }
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.settings?.newValue) { SETTINGS = changes.settings.newValue; ME = null; }
  });

  // ---- scan loop -----------------------------------------------------------
  const processedBtns = new WeakSet();
  const handledIds = new Set();
  let scanning = false;

  async function scan() {
    if (scanning || !SETTINGS.enabled) return;
    scanning = true;
    try {
      const me = getMyName();
      if (!me) { console.debug(LOG, "could not detect your name — set it in Settings"); return; }

      const root = document.querySelector(HOOKS.feedRoot) || document.querySelector("main") || document.body;
      const myPostBtns = [...root.querySelectorAll(HOOKS.postCtrlBtn)].filter(
        (b) => postAuthor(b).toLowerCase() === me.toLowerCase()
      );
      if (!myPostBtns.length) return;

      const batch = [];
      for (const pb of myPostBtns) {
        const container = postContainer(pb);
        const postKey = "post:" + hash(postAuthor(pb) + "|" + txt(container.querySelector(HOOKS.textBox)).slice(0, 60));
        for (const cb of container.querySelectorAll(HOOKS.commentReplyBtn)) {
          if (processedBtns.has(cb)) continue;
          const data = commentData(cb, postKey);
          if (!data.text && !data.author) continue;
          if (data.author && data.author.toLowerCase() === me.toLowerCase()) { processedBtns.add(cb); continue; }
          if (handledIds.has(data.id)) { processedBtns.add(cb); continue; }
          batch.push(data);
        }
      }
      if (!batch.length) return;

      const resp = await send({
        type: "CLASSIFY",
        comments: batch.map(({ id, author, authorUrl, text, postUrn }) => ({ id, author, authorUrl, text, postUrn })),
      });
      const byId = new Map((resp?.results || []).map((r) => [r.id, r]));

      for (const d of batch) {
        processedBtns.add(d._reply);
        handledIds.add(d.id);
        const r = byId.get(d.id);
        if (!r || !r.flagged) continue;

        const doDelete = async () => {
          const res = await attemptDelete(d._options);
          if (res.ok) {
            report({ ...stripEls(d), verdict: r, action: "deleted" });
            return { ok: true };
          }
          // Couldn't auto-delete — scroll to and spotlight the comment (and its
          // ••• button if present) so the manual delete is one obvious click.
          highlightForManual(d._container, d._options);
          return res;
        };
        renderBadge(d._container, r, doDelete, () => report({ ...stripEls(d), verdict: r, action: "kept" }));
        report({ ...stripEls(d), verdict: r, action: "flagged" });
      }
    } catch (e) {
      console.warn(LOG, "scan error", e);
    } finally {
      scanning = false;
    }
  }
  function stripEls(d) {
    const { _container, _reply, _options, ...rest } = d;
    return rest;
  }

  // ---- triggers ------------------------------------------------------------
  let scanTimer = null;
  function scheduleScan(delay = 1200) { clearTimeout(scanTimer); scanTimer = setTimeout(scan, delay); }

  chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === "SCAN_NOW") scheduleScan(200); });

  const observer = new MutationObserver(() => scheduleScan());

  (async function init() {
    await refreshSettings();
    getMyName();
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleScan(2000);
    setInterval(() => scheduleScan(0), 60_000);
    console.debug(LOG, "content script ready");
  })();
})();
