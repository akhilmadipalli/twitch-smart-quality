// popup.js — Settings UI + live stats readout.

const SETTINGS_KEY = "tsq_settings";

const DEFAULTS = {
  enabled: true,
  panicThreshold: 3,
  lowThreshold: 8,
  recoveryThreshold: 20,
  recoveryDwell: 15,
  qualityCeiling: "source",
  allowUpgrades: true,
};

// ---- Elements -------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const el = {
  enabled: $("enabled"),
  panic: $("panic"),
  panicVal: $("panicVal"),
  low: $("low"),
  lowVal: $("lowVal"),
  recovery: $("recovery"),
  recoveryVal: $("recoveryVal"),
  dwell: $("dwell"),
  dwellVal: $("dwellVal"),
  ceiling: $("ceiling"),
  upgrades: $("upgrades"),
  reset: $("reset"),
  // Stats
  statusDot: $("statusDot"),
  bufferVal: $("bufferVal"),
  qualityVal: $("qualityVal"),
  streakVal: $("streakVal"),
};

// ---- Load & render --------------------------------------------------------

function renderSettings(s) {
  el.enabled.checked = !!s.enabled;
  el.panic.value = s.panicThreshold;
  el.panicVal.textContent = s.panicThreshold + "s";
  el.low.value = s.lowThreshold;
  el.lowVal.textContent = s.lowThreshold + "s";
  el.recovery.value = s.recoveryThreshold;
  el.recoveryVal.textContent = s.recoveryThreshold + "s";
  el.dwell.value = s.recoveryDwell;
  el.dwellVal.textContent = s.recoveryDwell + "s";
  el.ceiling.value = s.qualityCeiling || "source";
  el.upgrades.checked = !!s.allowUpgrades;
}

function currentSettings() {
  return {
    enabled: el.enabled.checked,
    panicThreshold: parseInt(el.panic.value, 10),
    lowThreshold: parseInt(el.low.value, 10),
    recoveryThreshold: parseInt(el.recovery.value, 10),
    recoveryDwell: parseInt(el.dwell.value, 10),
    qualityCeiling: el.ceiling.value,
    allowUpgrades: el.upgrades.checked,
  };
}

function save() {
  chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings() });
}

// ---- Stats display --------------------------------------------------------

function updateStats({ buffer, currentQuality, healthyStreak }) {
  if (typeof buffer === "number") {
    el.bufferVal.textContent = buffer.toFixed(1);
    // Color the status dot by buffer health.
    el.statusDot.classList.remove("on", "warn", "bad");
    if (!el.enabled.checked) {
      // disabled — leave gray
    } else if (buffer < parseInt(el.panic.value, 10)) {
      el.statusDot.classList.add("bad");
    } else if (buffer < parseInt(el.low.value, 10)) {
      el.statusDot.classList.add("warn");
    } else {
      el.statusDot.classList.add("on");
    }
  }
  if (currentQuality) {
    el.qualityVal.textContent = currentQuality;
  }
  if (typeof healthyStreak === "number") {
    el.streakVal.textContent = Math.floor(healthyStreak);
  }
}

// ---- Bindings -------------------------------------------------------------

[el.panic, el.low, el.recovery, el.dwell].forEach((input) => {
  input.addEventListener("input", () => {
    const label = input.id + "Val";
    $(label).textContent = input.value + "s";
    save();
  });
});

el.enabled.addEventListener("change", save);
el.ceiling.addEventListener("change", save);
el.upgrades.addEventListener("change", save);

el.reset.addEventListener("click", () => {
  renderSettings(DEFAULTS);
  chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULTS });
});

// Initial load
chrome.storage.local.get([SETTINGS_KEY], (res) => {
  renderSettings({ ...DEFAULTS, ...(res[SETTINGS_KEY] || {}) });
});

// Listen for live stats from content script.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "tsq-stats") {
    updateStats(msg.payload || {});
  }
});

// Ask the active tab for a fresh stats snapshot.
function requestStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url || !/twitch\.tv/.test(tab.url)) {
      el.bufferVal.textContent = "—";
      el.qualityVal.textContent = "not on twitch";
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "tsq-request-stats" }).catch(() => {
      el.qualityVal.textContent = "reload page";
    });
  });
}
requestStats();
setInterval(requestStats, 1000);
