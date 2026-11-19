// Content script: finds the CHZZK player, wires the analyser to the media
// element, and drives skipping. Also owns the on-screen HUD.
//
// Everything here is page-lifetime; the body is not re-run because the state
// key guards double injection, and the observers/intervals are intentionally
// kept for the lifetime of the document.

import { Analyser } from "./analyser.js";
import { createHud } from "./hud.js";
import { createDecodeContext } from "./audio-decode.js";
import { DEFAULT_SETTINGS, presetLabel, resolveSkipParams } from "./settings.js";

const STATE_KEY = "__chzzkSkipSilence";
/** CHZZK VOD pages are /video/<videoNo>. */
const VOD_PATH = /\/video\/\d+/;
/** How long a `seeked` event matching our own seek target is ignored. */
const SEEK_SUPPRESS_MS = 1500;
/** Retry delays for a failed analyser start, in ms. */
const RETRY_DELAYS = [2000, 5000, 15000, 60000];

const debug = { steps: [], error: null };

if (!window[STATE_KEY]) {
  window[STATE_KEY] = { started: false, debug };
  main().catch((e) => {
    debug.error = String(e?.stack || e);
    console.warn("[chzzk-skip] init failed", e);
  });
}

function mark(step) {
  debug.steps.push(`${new Date().toISOString().slice(11, 23)} ${step}`);
}

async function main() {
  mark("start");
  const settings = await readSettings();

  // Nothing to do outside a VOD page: skip loading the 450 KB model entirely.
  if (!isVodPage()) {
    mark("not a vod page");
    window[STATE_KEY] = { started: true, debug, idle: true };
    return;
  }

  const model = await loadModel();
  mark(`model v${model.version} ${model.features.length}f`);

  let controller = null;
  let playbackUrl = null;
  let lastVideo = null;

  const hud = createHud({
    onToggle: (on) => {
      settings.enabled = on;
      chrome.storage.local.set({ settings });
      controller?.applySettings(settings);
    },
    onOpenOptions: () => chrome.runtime.sendMessage({ type: "open-options" }),
  });
  hud.setEnabled(settings.enabled);
  hud.setVisible(false);
  mark("hud");

  // ---- playback URL discovery (MAIN-world hook -> content script) ----
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== "chzzk-skip-silence" || d.type !== "playback-url") return;
    if (d.url === playbackUrl) return;
    playbackUrl = d.url;
    mark(`playback url ${d.url.slice(0, 60)}`);
    controller?.setPlaybackUrl(playbackUrl);
  });

  const askHook = () => window.postMessage({ source: "chzzk-skip-silence", type: "hello" }, "*");
  // The MutationObserver calls `sync()` on every DOM change, which on a busy VOD
  // page is many times per second. Only re-ask the page hook when it has had time
  // to find something; the timers below cover the cold start.
  let lastAsk = 0;
  const askHookThrottled = () => {
    const now = Date.now();
    if (now - lastAsk < 1000) return;
    lastAsk = now;
    askHook();
  };
  askHookThrottled();
  setTimeout(askHook, 1500);
  setTimeout(askHook, 4000);

  // The player's own element class is authoritative. The generic fallback picks
  // the *largest* video, so an ad/preview thumbnail cannot win over the player.
  const findVideo = () => {
    const player = document.querySelector("video.webplayer-internal-video");
    if (player) return player;
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    // A tiny/hidden element is not the player.
    return bestArea >= 400 * 200 ? best : null;
  };

  const teardown = ({ clearUrl = false } = {}) => {
    controller?.destroy();
    controller = null;
    lastVideo = null;
    // The manifest URL belongs to the page, not to one <video> element: keep it
    // when the player is re-created, so the analyser can restart immediately.
    if (clearUrl) playbackUrl = null;
    hud.setVisible(false);
  };

  const sync = () => {
    if (!isVodPage()) {
      if (controller) teardown({ clearUrl: true });
      return;
    }
    const v = findVideo();
    if (!v) {
      // No player (or it is being re-created): stop working against a detached
      // element. `sync()` runs again as soon as the player is re-attached.
      if (controller) teardown();
      hud.setVisible(false);
      return;
    }
    if (v === lastVideo) {
      hud.setVisible(true, v);
      return;
    }
    controller?.destroy();
    lastVideo = v;
    controller = new Controller({ video: v, model, settings, hud, getPlaybackUrl: () => playbackUrl });
    controller.start();
    hud.setEnabled(settings.enabled);
    hud.setVisible(true, v);
    mark("attached");
    askHookThrottled();
  };

  // `sync()` is the MutationObserver callback and CHZZK re-renders constantly
  // (chat, timers, hover). Coalesce to one scan per frame.
  let syncQueued = false;
  const scheduleSync = () => {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      sync();
    });
  };

  const mo = new MutationObserver(scheduleSync);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  sync();

  // SPA navigation between pages
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (!isVodPage()) {
      teardown({ clearUrl: true });
      return;
    }
    teardown({ clearUrl: true });
    sync();
    // The new manifest may already have been fetched before this poll noticed
    // the navigation; ask for it unthrottled, or the controller waits forever.
    askHook();
  }, 800);

  // Settings changed elsewhere (options page, or another tab).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    Object.assign(settings, DEFAULT_SETTINGS, changes.settings.newValue ?? {});
    controller?.applySettings(settings);
    hud.setEnabled(settings.enabled);
  });

  window[STATE_KEY] = {
    started: true,
    debug,
    get controller() {
      return controller;
    },
  };
}

function isVodPage() {
  return VOD_PATH.test(location.pathname);
}

async function readSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const stored = await chrome.storage.local.get("settings");
    if (stored.settings) Object.assign(settings, stored.settings);
  } catch {
    /* storage unavailable: use defaults */
  }
  return settings;
}

async function loadModel() {
  const url = chrome.runtime.getURL("dist/model.json");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model.json HTTP ${res.status} (${url})`);
  return await res.json();
}

class Controller {
  constructor({ video, model, settings, hud, getPlaybackUrl }) {
    this.video = video;
    this.model = model;
    this.settings = settings;
    this.hud = hud;
    this.getPlaybackUrl = getPlaybackUrl;

    this.ctx = null;
    this.analyser = null;
    this.timer = null;
    this.ticks = 0;
    this.ticking = false;
    this.destroyed = false;
    this.skipsApplied = 0;
    this.skippedSeconds = 0;
    this.suppressSeek = 0;      // timestamp of the last self-issued seek
    this.seekTarget = null;
    this.state = "idle";
    this.error = null;
    this.retryIndex = 0;
    this.retryAt = 0;
  }

  start() {
    this.onSeeked = () => {
      if (this.isSelfSeek()) return;
      // user-driven seek: analysis restarts from the new position
      this.analyser?.resetWindow(this.video.currentTime);
    };
    this.onPlay = () => this.ensureRunning();
    this.video.addEventListener("seeked", this.onSeeked);
    this.video.addEventListener("play", this.onPlay);
    this.timer = setInterval(() => this.tick(), 250);
    this.ensureRunning();
    this.hud.render(this.snapshot());
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.timer);
    this.video.removeEventListener("seeked", this.onSeeked);
    this.video.removeEventListener("play", this.onPlay);
    this.analyser?.destroy?.();
    this.analyser = null;
    if (this.ctx) this.ctx.close?.().catch?.(() => {});
    this.ctx = null;
  }

  setPlaybackUrl() {
    this.ensureRunning();
  }

  applySettings(settings) {
    this.settings = settings;
    if (this.analyser) this.analyser.setSkipParams(resolveSkipParams(settings));
    this.hud.render(this.snapshot());
  }

  async ensureRunning() {
    if (this.destroyed) return;
    if (this.state === "running" || this.state === "starting") return;
    if (this.state === "error" && Date.now() < this.retryAt) return;

    const url = this.getPlaybackUrl();
    if (!url) {
      this.state = "waiting-manifest";
      this.hud.render(this.snapshot());
      return;
    }
    this.state = "starting";
    this.hud.render(this.snapshot());
    mark("starting analyser");
    try {
      if (!this.ctx) this.ctx = createDecodeContext(this.model.sampleRate ?? 16000);
      const params = resolveSkipParams(this.settings);
      const analyser = new Analyser({ ctx: this.ctx, model: this.model, threshold: params.threshold });
      analyser.setSkipParams(params);
      analyser.onError = (e) => this.fail(e);
      await analyser.load(url);
      if (this.destroyed) {
        analyser.destroy?.();
        return;
      }
      this.analyser = analyser;
      this.state = "running";
      this.error = null;
      this.retryIndex = 0;
      this.retryAt = 0;
      mark(`running, ${this.analyser.track.segments.length} segments`);
    } catch (e) {
      this.fail(e);
    }
    this.hud.render(this.snapshot());
  }

  /** Schedule a bounded retry instead of giving up for the whole session. */
  fail(e) {
    if (this.destroyed) return;
    this.error = String(e?.message || e);
    this.state = "error";
    this.analyser?.destroy?.();
    this.analyser = null;
    const delay = RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
    this.retryIndex++;
    this.retryAt = Date.now() + delay;
    mark(`error ${this.error} (retry in ${Math.round(delay / 1000)}s)`);
    this.hud.render(this.snapshot());
  }

  isSelfSeek() {
    if (!this.suppressSeek) return false;
    const fresh = Date.now() - this.suppressSeek < SEEK_SUPPRESS_MS;
    const near = this.seekTarget == null
      || Math.abs(this.video.currentTime - this.seekTarget) < 1.0;
    if (fresh) {
      this.suppressSeek = 0;
      this.seekTarget = null;
      return near;
    }
    this.suppressSeek = 0;
    this.seekTarget = null;
    return false;
  }

  async tick() {
    if (this.destroyed || this.ticking) return;
    this.ticks++;

    if (this.state === "waiting-manifest" || this.state === "idle"
        || (this.state === "error" && Date.now() >= this.retryAt)) {
      await this.ensureRunning();
    }
    if (this.state !== "running" || !this.analyser) {
      this.hud.render(this.snapshot());
      return;
    }
    if (this.video.paused) {
      this.hud.render(this.snapshot());
      return;
    }

    this.ticking = true;
    try {
      const startedAt = this.video.currentTime;
      await this.analyser.pump(startedAt);
      // pump's onError -> fail() can drop the analyser while we were awaiting.
      if (this.destroyed || !this.analyser) return;
      // Re-read the playhead: pump can take a whole budget, and acting on a
      // stale position would mis-report savings or seek to the wrong spot.
      const now = this.video.currentTime;
      if (this.settings.enabled) this.maybeSkip(now);
    } finally {
      this.ticking = false;
    }
    this.hud.render(this.snapshot());
  }

  maybeSkip(now) {
    const skip = this.analyser.skipAt(now);
    if (!skip) return;
    const target = Math.min(skip.end, this.video.duration || skip.end);
    if (!(target > now + 0.05)) return;
    // Avoid re-entering before the media element acknowledges the seek.
    if (Date.now() - this.suppressSeek < 400) return;

    this.suppressSeek = Date.now();
    this.seekTarget = target;
    this.video.currentTime = target;
    this.skipsApplied++;
    this.skippedSeconds += target - now;
    this.hud.flashSkip(target - now);
  }

  snapshot() {
    const a = this.analyser;
    const now = this.video.currentTime;
    return {
      state: this.state,
      error: this.error,
      enabled: this.settings.enabled,
      preset: this.settings.preset,
      presetLabel: presetLabel(this.settings),
      playhead: now,
      duration: this.video.duration,
      analysedUntil: a ? a.analysedUntil : 0,
      coverageStart: a ? a.scoreBase * a.hopSec : 0,
      skipsApplied: this.skipsApplied,
      skippedSeconds: this.skippedSeconds,
      segments: a ? a.stats.segmentsFetched : 0,
      megabytes: a ? a.stats.bytes / 1048576 : 0,
      kind: a && a.track ? a.track.kind ?? "dash" : null,
      nextSkip: a ? (a.skips.find((s) => s.start > now) ?? null) : null,
    };
  }
}
