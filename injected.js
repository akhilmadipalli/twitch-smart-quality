// injected.js — Runs in the page's own JS context on twitch.tv.
// It has full access to the <video> element and the Twitch player's DOM controls.
//
// Strategy: Twitch's "Auto" optimizes for resolution, so the buffer frequently
// drains before it bothers to step down. We watch the buffer ourselves and
// proactively step quality DOWN whenever it looks unhealthy, and only allow
// stepping back UP after a sustained healthy window.

(() => {
  "use strict";

  // State

  let settings = null;            // populated by content.js
  let qualities = [];             // ordered list of labels, lowest -> highest (excluding "Auto")
  let currentQualityLabel = null; // last label we set
  let lastChangeAt = 0;
  let healthyStreak = 0;          // consecutive healthy samples (in seconds)
  let running = false;

  const MIN_MS_BETWEEN_CHANGES = 4000; // don't thrash
  const SAMPLE_INTERVAL_MS = 1000;

  // Labels we recognize, ordered lowest -> highest. Twitch adds/removes these
  // per-stream; we match against whatever the current menu actually offers.
  const KNOWN_ORDER = [
    "160p", "360p", "480p", "720p", "720p60", "900p", "900p60",
    "1080p", "1080p60", "1440p", "1440p60", "source", "original",
  ];

  // Utils

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const log = (...args) => console.log("%c[TSQ]", "color:#a970ff;font-weight:bold;", ...args);

  function normalizeLabel(label) {
    if (!label) return "";
    return label
      .toLowerCase()
      .replace(/\s*\(source\)\s*/g, " source")
      .replace(/\s+/g, " ")
      .trim();
  }

  function rankQuality(label) {
    const n = normalizeLabel(label);
    // Prefer exact matches to KNOWN_ORDER, else fall back to parsing digits.
    for (let i = KNOWN_ORDER.length - 1; i >= 0; i--) {
      if (n.includes(KNOWN_ORDER[i])) return i;
    }
    const m = n.match(/(\d+)p/);
    return m ? parseInt(m[1], 10) / 100 : -1;
  }

  function sortedQualities(labels) {
    return [...labels]
      .filter((l) => normalizeLabel(l) !== "auto")
      .sort((a, b) => rankQuality(a) - rankQuality(b));
  }

  function getVideo() {
    return document.querySelector("video");
  }

  function getBufferAhead() {
    const v = getVideo();
    if (!v || !v.buffered || !v.buffered.length) return 0;
    const end = v.buffered.end(v.buffered.length - 1);
    return Math.max(0, end - v.currentTime);
  }

  // Quality menu interaction

  // We hide the settings menu while we flip through it programmatically so
  // the user doesn't see it flash open on every quality change.
  //
  // Two-pronged approach for robustness:
  //  A) A <style> tag with broad selectors (catches elements already in DOM)
  //  B) A MutationObserver that hides any menu-like node the moment it appears
  //     (catches dynamically rendered portals regardless of their class names)
  //
  // Our code still calls .click() on child elements - that goes through the JS
  // method, not hit-testing, so pointer-events: none doesn't block our clicks.

  let hideStyleEl = null;
  let menuObserver = null;
  let hiddenByObserver = []; // nodes we hid inline, so we can restore them

  function looksLikeSettingsMenu(node) {
    if (node.nodeType !== 1) return false;
    const target = node.getAttribute?.("data-a-target") || "";
    if (target.includes("player-settings")) return true;
    const role = node.getAttribute?.("role") || "";
    if (role === "menu" || role === "dialog") return true;
    // Also check children for settings-related elements.
    if (node.querySelector?.('[data-a-target*="player-settings"]')) return true;
    if (node.querySelector?.('[role="menuitem"]')) return true;
    return false;
  }

  function hideSettingsMenu() {
    // (A) Broad CSS covering known Twitch data-a-target patterns and
    //     generic role="menu" / role="dialog" inside the video player area.
    if (!hideStyleEl) {
      hideStyleEl = document.createElement("style");
      hideStyleEl.id = "tsq-hide-menu";
      hideStyleEl.textContent = `
        [data-a-target="player-settings-menu"],
        [data-a-target="player-settings-menu"] *,
        [data-a-target="player-settings-sub-menu"],
        [data-a-target="player-settings-sub-menu"] *,
        [data-a-target^="player-settings-menu-item"],
        .video-player [role="menu"],
        .video-player [role="dialog"] {
          opacity: 0 !important;
          pointer-events: none !important;
          transition: none !important;
          animation: none !important;
        }
      `;
      document.head.appendChild(hideStyleEl);
    }

    // (B) MutationObserver — immediately hides any new node that looks like
    //     a settings menu as soon as React renders it into the DOM.
    if (!menuObserver) {
      hiddenByObserver = [];
      menuObserver = new MutationObserver((mutations) => {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            if (!looksLikeSettingsMenu(node)) continue;
            node.style.setProperty("opacity", "0", "important");
            node.style.setProperty("pointer-events", "none", "important");
            node.style.setProperty("transition", "none", "important");
            hiddenByObserver.push(node);
          }
        }
      });
      // Watch body directly (React portals are usually direct body children)
      // AND the player container for menus rendered inside it.
      menuObserver.observe(document.body, { childList: true, subtree: false });
      const player = document.querySelector(".video-player, [data-a-target='video-player']");
      if (player) menuObserver.observe(player, { childList: true, subtree: true });
    }
  }

  function unhideSettingsMenu() {
    if (hideStyleEl) {
      hideStyleEl.remove();
      hideStyleEl = null;
    }
    if (menuObserver) {
      menuObserver.disconnect();
      menuObserver = null;
    }
    for (const node of hiddenByObserver) {
      node.style.removeProperty("opacity");
      node.style.removeProperty("pointer-events");
      node.style.removeProperty("transition");
    }
    hiddenByObserver = [];
  }

  function clickSettingsButton() {
    const btn =
      document.querySelector('[data-a-target="player-settings-button"]') ||
      document.querySelector('button[aria-label*="Settings" i]');
    if (!btn) return false;
    btn.click();
    return true;
  }

  function findQualityMenuItem() {
    // The menu item that opens the quality submenu.
    const candidates = document.querySelectorAll(
      '[role="menuitem"], [data-a-target^="player-settings-menu-item"]'
    );
    for (const el of candidates) {
      const label = (el.textContent || "").toLowerCase();
      if (label.includes("quality")) return el;
    }
    return null;
  }

  function getQualityOptionElements() {
    // Quality options are rendered as labels wrapping radio inputs.
    const nodes = document.querySelectorAll(
      '[data-a-target="player-settings-submenu-quality-option"], ' +
        '[data-a-target^="player-settings-menu-item-"][data-a-target$="p"], ' +
        'input[name^="player-settings-submenu-quality"]'
    );
    const seen = new Set();
    const results = [];
    nodes.forEach((n) => {
      const labelEl = n.closest("label") || n;
      const text = (labelEl.textContent || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      results.push({ label: text, el: labelEl, input: labelEl.querySelector?.('input[type="radio"]') || null });
    });
    return results;
  }

  async function readQualityList() {
    // Opens the settings menu just long enough to read available qualities,
    // then closes it. Runs with menu hidden.
    hideSettingsMenu();
    try {
      if (!clickSettingsButton()) return [];
      await sleep(80);

      const quality = findQualityMenuItem();
      if (!quality) {
        clickSettingsButton(); // close
        return [];
      }
      quality.click();
      await sleep(80);

      const opts = getQualityOptionElements().map((o) => o.label);
      // Close the menu by clicking the settings button again.
      clickSettingsButton();
      await sleep(40);

      return sortedQualities(opts);
    } finally {
      setTimeout(unhideSettingsMenu, 250);
    }
  }

  async function setQualityByLabel(targetLabel) {
    hideSettingsMenu();
    try {
      if (!clickSettingsButton()) return false;
      await sleep(80);

      const quality = findQualityMenuItem();
      if (!quality) {
        clickSettingsButton();
        return false;
      }
      quality.click();
      await sleep(80);

      const opts = getQualityOptionElements();
      const wanted = normalizeLabel(targetLabel);

      // Prefer exact contains-match; fall back to closest rank.
      let hit = opts.find((o) => normalizeLabel(o.label).includes(wanted));
      if (!hit) {
        const targetRank = rankQuality(targetLabel);
        let best = null;
        let bestDelta = Infinity;
        for (const o of opts) {
          if (normalizeLabel(o.label) === "auto") continue;
          const d = Math.abs(rankQuality(o.label) - targetRank);
          if (d < bestDelta) {
            bestDelta = d;
            best = o;
          }
        }
        hit = best;
      }

      if (!hit) {
        clickSettingsButton();
        return false;
      }

      (hit.input || hit.el).click();
      currentQualityLabel = hit.label;
      lastChangeAt = Date.now();

      // Menu auto-closes on selection, but click settings button as a safety.
      await sleep(40);
      return true;
    } finally {
      setTimeout(unhideSettingsMenu, 250);
    }
  }

  // Quality list read with backoff
  //
  // If readQualityList() returns [] (e.g. Twitch's menu selectors didn't
  // match, or the player wasn't ready yet), we used to retry every single
  // tick — which meant hammering the settings menu open every 1 second.
  // Now we back off exponentially, capping at 60s between retries.

  let qualityReadBackoffUntil = 0;
  let qualityReadFailCount = 0;

  async function tryReadQualityList() {
    if (Date.now() < qualityReadBackoffUntil) return; // still in backoff window

    const result = applyCeiling(await readQualityList());

    if (result.length === 0) {
      qualityReadFailCount++;
      // Backoff: 5s, 10s, 20s, 40s, 60s cap
      const backoffMs = Math.min(5000 * Math.pow(2, qualityReadFailCount - 1), 60000);
      qualityReadBackoffUntil = Date.now() + backoffMs;
      log(`Quality read failed (attempt ${qualityReadFailCount}). Retrying in ${backoffMs / 1000}s.`);
    } else {
      qualityReadFailCount = 0;
      qualityReadBackoffUntil = 0;
      qualities = result;
      log("Detected qualities:", qualities);
    }
  }

  // Decision loop
  function applyCeiling(list) {
    if (!settings || !settings.qualityCeiling || settings.qualityCeiling === "source") {
      return list;
    }
    const ceilingRank = rankQuality(settings.qualityCeiling);
    return list.filter((l) => rankQuality(l) <= ceilingRank);
  }

  async function tick() {
    if (!settings || !settings.enabled) return;
    const video = getVideo();
    if (!video || video.paused || video.readyState < 2) return;

    // Refresh quality list occasionally - streams can change available tiers.
    if (qualities.length === 0) {
      await tryReadQualityList();
      if (qualities.length === 0) return; // still empty - backed off, wait for next tick
    }

    const buffer = getBufferAhead();
    const now = Date.now();
    const cooldownOk = now - lastChangeAt > MIN_MS_BETWEEN_CHANGES;

    // Push stats to content script so the popup can display them.
    window.postMessage(
      {
        source: "tsq-page",
        type: "stats",
        payload: {
          buffer: Number(buffer.toFixed(2)),
          currentQuality: currentQualityLabel,
          availableQualities: qualities,
          healthyStreak,
        },
      },
      "*"
    );

    if (!cooldownOk) return;

    // Figure out the current quality index if we haven't set one yet.
    let currentIdx = currentQualityLabel
      ? qualities.findIndex((q) => normalizeLabel(q) === normalizeLabel(currentQualityLabel))
      : qualities.length - 1; // assume max until we've touched it
    if (currentIdx < 0) currentIdx = qualities.length - 1;

    // PANIC: buffer is critically low -> slam to lowest available
    if (buffer < settings.panicThreshold && currentIdx > 0) {
      log(`PANIC buffer=${buffer.toFixed(2)}s → dropping to ${qualities[0]}`);
      healthyStreak = 0;
      await setQualityByLabel(qualities[0]);
      return;
    }

    // LOW: step down one level
    if (buffer < settings.lowThreshold && currentIdx > 0) {
      const target = qualities[currentIdx - 1];
      log(`LOW buffer=${buffer.toFixed(2)}s → stepping down to ${target}`);
      healthyStreak = 0;
      await setQualityByLabel(target);
      return;
    }

    // HEALTHY: maybe step up
    if (buffer >= settings.recoveryThreshold) {
      healthyStreak += SAMPLE_INTERVAL_MS / 1000;
      if (
        settings.allowUpgrades &&
        healthyStreak >= settings.recoveryDwell &&
        currentIdx < qualities.length - 1
      ) {
        const target = qualities[currentIdx + 1];
        log(`HEALTHY streak=${healthyStreak.toFixed(0)}s → stepping up to ${target}`);
        healthyStreak = 0;
        await setQualityByLabel(target);
        return;
      }
    } else {
      // Reset streak if we drop below the recovery threshold.
      healthyStreak = Math.max(0, healthyStreak - SAMPLE_INTERVAL_MS / 1000);
    }
  }

  async function loop() {
    if (running) return;
    running = true;
    while (running) {
      try {
        await tick();
      } catch (e) {
        console.error("[TSQ] tick error", e);
      }
      await sleep(SAMPLE_INTERVAL_MS);
    }
  }

  // Watch for SPA navigations (Twitch is a single-page app) - whenever the URL
  // changes, re-discover the quality list because it probably changed streams.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      qualities = [];
      currentQualityLabel = null;
      healthyStreak = 0;
      qualityReadBackoffUntil = 0;
      qualityReadFailCount = 0;
      log("Navigation detected — resetting.");
    }
  }, 2000);

  // Messaging

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "tsq-extension") return;

    if (msg.type === "settings") {
      const prev = settings;
      settings = msg.payload;
      log("Settings updated", settings);
      // If ceiling changed, re-filter qualities.
      if (qualities.length) qualities = applyCeiling(qualities);
      if (!prev && settings.enabled) loop();
      if (prev && !prev.enabled && settings.enabled) loop();
      if (!settings.enabled) running = false;
    }

    if (msg.type === "requestStats") {
      const buffer = getBufferAhead();
      window.postMessage(
        {
          source: "tsq-page",
          type: "stats",
          payload: {
            buffer: Number(buffer.toFixed(2)),
            currentQuality: currentQualityLabel,
            availableQualities: qualities,
            healthyStreak,
          },
        },
        "*"
      );
    }
  });

  // Ask the extension for settings as soon as we're loaded.
  window.postMessage({ source: "tsq-page", type: "requestSettings" }, "*");

  log("Injected. Waiting for settings…");
})();