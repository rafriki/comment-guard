// popup.js — dashboard logic. Talks to the background worker via messages.

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp);
    });
  });
}

const $ = (id) => document.getElementById(id);

const AVAIL_LABEL = {
  available: ["On-device AI ready", "ok"],
  downloadable: ["On-device AI (will download on first use)", "warn"],
  downloading: ["On-device AI downloading…", "warn"],
  unavailable: ["On-device AI unavailable on this device", "bad"],
  unsupported: ["Built-in AI not supported (using heuristics)", "bad"],
};

let state = null;

function renderClassifier() {
  const s = state.settings;
  const pill = $("classifier-pill");
  const hint = $("classifier-hint");
  if (s.classifier === "heuristic") {
    pill.textContent = "Heuristics";
    pill.className = "pill";
    hint.textContent = "Fast keyword/pattern matching. Free & fully local.";
    return;
  }
  // builtin
  const [label, cls] = AVAIL_LABEL[state.builtinAvailability] || AVAIL_LABEL.unsupported;
  pill.textContent = "On-device (Gemini Nano)";
  pill.className = `pill ${cls === "ok" ? "ok" : cls === "warn" ? "warn" : "bad"}`;
  hint.textContent = label;
}

function renderOffenders() {
  const ul = $("offenders");
  ul.innerHTML = "";
  const entries = Object.entries(state.offenders || {})
    .sort((a, b) => (b[1].strikes || 0) - (a[1].strikes || 0))
    .slice(0, 8);
  $("offenders-empty").style.display = entries.length ? "none" : "block";
  for (const [, info] of entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = info.name || "(unknown)";
    const strikes = document.createElement("span");
    strikes.className = "muted";
    strikes.textContent = `${info.strikes} ⚑`;
    li.append(name, strikes);
    ul.appendChild(li);
  }
}

function render() {
  $("enabled").checked = !!state.settings.enabled;
  $("st-scanned").textContent = state.today.scanned || 0;
  $("st-flagged").textContent = state.today.flagged || 0;
  $("st-deleted").textContent = state.today.deleted || 0;
  renderClassifier();
  renderOffenders();
}

async function load() {
  state = await send({ type: "GET_STATE" });
  if (state?.ok) render();
}

// --- events -----------------------------------------------------------------
$("enabled").addEventListener("change", async (e) => {
  await send({ type: "SET_SETTINGS", patch: { enabled: e.target.checked } });
  await load();
});

$("scan-now").addEventListener("click", async () => {
  $("scan-msg").textContent = "Scanning…";
  const resp = await send({ type: "SCAN_NOW", activeTabOnly: true });
  $("scan-msg").textContent = resp?.ok
    ? "Scan triggered on the active LinkedIn tab."
    : resp?.error || "Open a LinkedIn tab first.";
});

$("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
