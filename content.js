// content.js - Runs in the extension's isolated world.
// Its job is to:
//   1. Inject the page-context script (which has access to the video element + DOM)
//   2. Relay settings from chrome.storage <-> the injected script via window.postMessage
//   3. Relay live stats from the injected script back to the popup

const SETTINGS_KEY = "tsq_settings";

const DEFAULTS = {
  enabled: true,
  // Buffer thresholds in seconds. These tune the aggressiveness.
  panicThreshold: 3,     // drop to lowest if buffer falls below this
  lowThreshold: 8,       // step down one level if below this
  recoveryThreshold: 20, // sustained buffer above this allows a step up
  recoveryDwell: 15,     // how many seconds of good buffer before stepping up
  qualityCeiling: "source", // max quality the extension will allow ("source" = no cap)
  allowUpgrades: true,
};

// Inject the page-context script

function inject() {
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("injected.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
}
inject();

// Settings sync

function pushSettingsToPage(settings) {
  window.postMessage(
    { source: "tsq-extension", type: "settings", payload: settings },
    "*"
  );
}

chrome.storage.local.get([SETTINGS_KEY], (res) => {
  const settings = { ...DEFAULTS, ...(res[SETTINGS_KEY] || {}) };
  pushSettingsToPage(settings);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  const newSettings = { ...DEFAULTS, ...(changes[SETTINGS_KEY].newValue || {}) };
  pushSettingsToPage(newSettings);
});

// Re-push settings whenever the page script asks for them (e.g. after reload).
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "tsq-page") return;

  if (msg.type === "requestSettings") {
    chrome.storage.local.get([SETTINGS_KEY], (res) => {
      const settings = { ...DEFAULTS, ...(res[SETTINGS_KEY] || {}) };
      pushSettingsToPage(settings);
    });
  }

  if (msg.type === "stats") {
    // Forward live stats to the popup via runtime messaging.
    chrome.runtime.sendMessage({ type: "tsq-stats", payload: msg.payload }).catch(() => {
      // Popup probably not open — ignore.
    });
  }
});

// Popup -> content requests

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "tsq-request-stats") {
    // Ask the page for the latest snapshot.
    window.postMessage({ source: "tsq-extension", type: "requestStats" }, "*");
    sendResponse({ ok: true });
  }
  return true;
});
