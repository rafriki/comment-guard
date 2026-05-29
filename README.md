# LinkedIn Comment Guard

A Chrome (Manifest V3) extension that watches **your own** LinkedIn posts and gets rid of
the low-effort, generic, AI-generated junk comments — *"Great post! 🚀"*, *"Thanks for
sharing!"*, *"DM me to 10x your pipeline"* — especially from the same repeat offenders who
show up every day.

It runs **inside your normal browser session, as you**. There is no scraping bot, no second
login, and no credentials stored anywhere. It only ever acts on comments on posts **you
authored** (the only comments LinkedIn lets you delete).

---

## Why an extension (and not a script/API)?

- **LinkedIn's API can't do this.** Reading and deleting comments on posts is gated behind
  LinkedIn's partner-only Community Management API — not available to individuals.
- **A standalone scraping bot is the thing LinkedIn's Terms specifically prohibit** and is
  the most likely to get an account flagged.
- An extension reads the page **you already loaded** and clicks the same buttons **you would
  click**. For moderating *your own* content, it's the lowest-risk approach.

> **Honest note on Terms of Service:** even in-session automation lives in a grey area of
> LinkedIn's User Agreement (the "no automated means" clause). You're moderating your own
> posts, which is benign, but use it at your own discretion. Default mode is **Review first**
> so nothing is deleted without your click until you trust it.

---

## How it works

1. A **content script** runs on `linkedin.com`, finds the posts that are **yours**, and reads
   the comments on them (author + text only).
2. Each new comment is sent to the **background service worker**, which classifies it as spam
   or genuine.
3. Flagged comments get a small ⚠ badge with **Delete** / **Keep** buttons.
   - LinkedIn only deletes a comment on a **trusted user click** (its ••• menu won't open for an
     automated/synthetic click — verified by live testing). So the badge's **Delete** tries, and
     if LinkedIn blocks it, it **scrolls to and spotlights the comment's ••• button** so you can
     finish the delete in one obvious click. Detection and tracking are automatic; the final
     click is yours.
4. **Repeat offenders** are tracked. After N strikes (default 3), that person's future comments
   are auto-flagged regardless of content.

### Two classifier backends — both free and fully local (choose in Settings)

| Backend | Cost | Privacy | Notes |
|---|---|---|---|
| **Chrome built-in AI (Gemini Nano)** — *default* | Free | On-device, nothing leaves your machine | Needs Chrome 138+ and a supported device; model downloads once |
| **Heuristics only** | Free | On-device | Keyword/pattern rules; fastest; also the automatic fallback when the model is unavailable |

No accounts, no API keys, no signup — it works out of the box. The heuristics also act as a
**pre-filter** so the on-device model is only asked about the borderline cases (faster).

---

## Install

> There's no "Add to Chrome" yet (that needs the Chrome Web Store). Until then it loads as an
> unpacked extension — about 30 seconds: **paste one line, then flip one toggle and click Load
> unpacked.**

### Quick install

**1 — Download it.** Paste the line for your OS into a terminal. It only downloads and unzips the
extension, then opens the folder and Chrome's extensions page — it runs **no remote code**, so you
can read exactly what it does before pasting.

Windows (PowerShell):

```powershell
$d="$env:USERPROFILE\comment-guard"; iwr "https://github.com/rafriki/comment-guard/archive/refs/heads/main.zip" -OutFile "$env:TEMP\cg.zip"; Expand-Archive "$env:TEMP\cg.zip" $d -Force; ii (gci $d -Directory)[0].FullName; start chrome "chrome://extensions"
```

macOS (Terminal):

```bash
cd ~ && curl -L "https://github.com/rafriki/comment-guard/archive/refs/heads/main.zip" -o cg.zip && unzip -oq cg.zip -d comment-guard && open comment-guard/* && open -a "Google Chrome" "chrome://extensions"
```

**2 — Load it into Chrome.** On the extensions page that just opened:

1. Turn on **Developer mode** (top-right toggle)
2. Click **Load unpacked** and select the folder that just opened (the one containing `manifest.json`)
3. Pin the extension and click its icon for the dashboard

> **Keep the downloaded folder where it is** — Chrome runs the extension from that path. To update
> later, re-run the line and click ↻ on the extension card. Chrome will also show a "developer mode
> extensions" warning periodically — that's expected for an unpacked extension.

### Manual install (no terminal)

1. On GitHub: **Code → Download ZIP**, then unzip it.
2. Open `chrome://extensions` → turn on **Developer mode**.
3. Click **Load unpacked** → select the unzipped folder (the one containing `manifest.json`).

### Turn on the on-device AI (optional but recommended)

The built-in AI (Gemini Nano) needs Chrome **138+** and a capable device. To enable it: open the
extension's **Settings** and click **Download model** — Chrome requires that one click to start the
(multi-GB) download. The Settings page shows live status: *will download → downloading → ready ✓*.

If it reports *unavailable* on a locked-down build, set these flags, restart Chrome, and click
**Download model** again:

- `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled**
- `chrome://flags/#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**

No model, no problem — the extension automatically falls back to the heuristic classifier, still
free and fully local, just rule-based instead of model-based.

---

## Using it

- Click the toolbar icon for the **dashboard**: today's scanned/flagged/deleted counts,
  classifier status, a **Scan this tab now** button, and your top repeat offenders.
- Open **Settings** (gear / "Settings →") for everything else:
  - **Sensitivity** slider — higher = only the most blatant spam is flagged.
  - **Allowlist** — people who are never flagged (name or `/in/slug` fragment, one per line).
  - **Blocklist** — people who are always flagged.
  - **Offender strike threshold**, **scan interval**, and an **audit log** of recent actions.

Browse LinkedIn as normal. The extension scans your posts when a page loads, re-scans every few
minutes while a LinkedIn tab is open, and reacts as you scroll/expand comment threads.

---

## Privacy

- No account credentials are ever read or stored.
- **Comment text never leaves your machine** — both classifiers run entirely on-device.
- No network requests at all: the extension only needs access to `linkedin.com`.
- All state (settings, stats, offenders, audit log) lives in `chrome.storage.local`.

---

## Limitations & maintenance

- **AI detection is imperfect.** The classifier targets generic/low-effort/promotional/likely-
  automated comments and is tuned to be conservative. Watch the audit log and tune sensitivity.
- **Deletion is a manual click by design.** Live testing confirmed LinkedIn's comment ••• menu
  only opens for a *trusted* user gesture, which a content script cannot produce. The extension
  therefore flags + spotlights; you click Delete. (Truly hands-off deletion would require the
  `chrome.debugger` API to inject trusted clicks — heavier permissions and a debugging banner —
  which this build intentionally avoids.)
- **LinkedIn uses obfuscated/hashed CSS class names**, so the extension keys off stable hooks
  (`aria-label`, `data-testid`) instead — all centralized in the `HOOKS` object at the top of
  `src/content.js`. These were validated against the live DOM; if scanning ever stops finding
  posts/comments, that's the one place to update.
- You can only delete comments on **your own** posts — the extension never touches comments on
  other people's posts (you'd only be able to *report* those anyway).

---

## Project layout

```
manifest.json            MV3 manifest
src/
  background.js          service worker: classify, storage, alarms, message routing
  classifier.js          heuristic + on-device Gemini Nano backends
  store.js               chrome.storage helpers (settings, stats, offenders, audit)
  content.js             scans your posts, badges/deletes comments (all selectors live here)
  content.css            badge styles
  popup.html / popup.js  dashboard
  options.html / options.js  full settings + audit log
icons/                   generated PNGs
tools/
  make-icons.mjs         regenerate icons (node tools/make-icons.mjs)
  zip.mjs                package dist/ zip for the Web Store (node tools/zip.mjs)
test/classifier.test.js  unit tests for the heuristics
```

## Development

```powershell
node --test          # run heuristic tests
node tools/make-icons.mjs   # regenerate icons
node tools/zip.mjs          # build dist/linkedin-comment-guard.zip
```

No build step and no `node_modules` — it loads unpacked as-is.
