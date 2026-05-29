// options.js — full settings page logic.

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp);
    });
  });
}
const $ = (id) => document.getElementById(id);

const AVAIL = {
  available: ["ready", "ok"],
  downloadable: ["will download on first use", "warn"],
  downloading: ["downloading…", "warn"],
  unavailable: ["unavailable on this device", "bad"],
  unsupported: ["not supported in this browser", "bad"],
};

function linesToList(s) {
  return s.split("\n").map((x) => x.trim()).filter(Boolean);
}
function listToLines(a) {
  return (a || []).join("\n");
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

let state = null;

function applyToForm(s) {
  $("enabled").checked = !!s.enabled;
  $("myNameOverride").value = s.myNameOverride || "";
  $("scanIntervalMinutes").value = s.scanIntervalMinutes;
  $("classifier").value = s.classifier;
  $("heuristicPrefilter").checked = !!s.heuristicPrefilter;
  $("sensitivity").value = s.sensitivity;
  $("sensitivity-val").textContent = Number(s.sensitivity).toFixed(2);
  $("offenderStrikeThreshold").value = s.offenderStrikeThreshold;
  $("allowlist").value = listToLines(s.allowlist);
  $("blocklist").value = listToLines(s.blocklist);
}

function renderBuiltinStatus(availability) {
  const [label, cls] = AVAIL[availability] || AVAIL.unsupported;
  const el = $("builtin-status");
  el.textContent = label;
  el.className = `pill ${cls}`;
}

function renderAudit(audit) {
  const tbody = $("audit");
  tbody.innerHTML = "";
  for (const a of (audit || []).slice(0, 60)) {
    const tr = document.createElement("tr");
    const cls = a.action === "deleted" ? "del" : a.action === "kept" ? "keep" : "flag";
    tr.innerHTML = `
      <td>${fmtTime(a.ts)}</td>
      <td>${escapeHtml(a.author || "")}</td>
      <td>${escapeHtml((a.text || "").slice(0, 90))}</td>
      <td><span class="tag ${cls}">${escapeHtml(a.action || "")}</span></td>`;
    tbody.appendChild(tr);
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function load() {
  state = await send({ type: "GET_STATE" });
  if (!state?.ok) return;
  applyToForm(state.settings);
  renderBuiltinStatus(state.builtinAvailability);
  renderAudit(state.audit);
}

function collect() {
  return {
    enabled: $("enabled").checked,
    myNameOverride: $("myNameOverride").value.trim(),
    scanIntervalMinutes: Number($("scanIntervalMinutes").value) || 5,
    classifier: $("classifier").value,
    heuristicPrefilter: $("heuristicPrefilter").checked,
    sensitivity: Number($("sensitivity").value),
    offenderStrikeThreshold: Number($("offenderStrikeThreshold").value) || 3,
    allowlist: linesToList($("allowlist").value),
    blocklist: linesToList($("blocklist").value),
  };
}

// --- events -----------------------------------------------------------------
$("sensitivity").addEventListener("input", (e) => {
  $("sensitivity-val").textContent = Number(e.target.value).toFixed(2);
});

$("save").addEventListener("click", async () => {
  await send({ type: "SET_SETTINGS", patch: collect() });
  const saved = $("saved");
  saved.classList.add("show");
  setTimeout(() => saved.classList.remove("show"), 1500);
});

$("check-builtin").addEventListener("click", async () => {
  $("builtin-status").textContent = "checking…";
  const resp = await send({ type: "CHECK_BUILTIN" });
  renderBuiltinStatus(resp?.availability || "unsupported");
});

// Kick off the Gemini Nano download. This runs in the (extension) options page,
// and the click is the user gesture Chrome requires to start the download.
$("download-model").addEventListener("click", async () => {
  const el = $("builtin-status");
  if (typeof LanguageModel === "undefined") {
    el.textContent = "not supported in this browser";
    el.className = "pill bad";
    return;
  }
  try {
    const avail = await LanguageModel.availability();
    if (avail === "available") {
      el.textContent = "ready (already downloaded)";
      el.className = "pill ok";
      return;
    }
    if (avail === "unavailable") {
      el.textContent = "unavailable on this device";
      el.className = "pill bad";
      return;
    }
    el.textContent = "starting download…";
    el.className = "pill warn";
    const session = await LanguageModel.create({
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          el.textContent = `downloading ${Math.round((e.loaded || 0) * 100)}%`;
          el.className = "pill warn";
        });
      },
    });
    el.textContent = "ready ✓ downloaded";
    el.className = "pill ok";
    if (session && session.destroy) session.destroy();
  } catch (e) {
    el.textContent = "download couldn't start: " + (e?.name || e?.message || "error");
    el.className = "pill bad";
  }
});

$("reset").addEventListener("click", async () => {
  // Note: no window.confirm() — it would block the page. Use a soft confirm flow.
  const btn = $("reset");
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Click again to confirm reset";
    setTimeout(() => {
      btn.dataset.armed = "0";
      btn.textContent = "Reset data (keep settings)";
    }, 4000);
    return;
  }
  await send({ type: "RESET_DATA", wipeSettings: false });
  btn.dataset.armed = "0";
  btn.textContent = "Reset data (keep settings)";
  await load();
});

load();
