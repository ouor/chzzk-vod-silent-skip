// End-to-end check in a real Chromium with the built extension loaded.
//
// Opens one CHZZK VOD and asserts, in order:
//   1. the analyser reaches "running" and the player button is in the control bar,
//   2. skips are applied during normal playback,
//   3. after a forward and a backward seek the analysis window follows the
//      playhead, keeps growing and still applies skips,
//   4. it stays bounded: retained window <= 461 s, no decode-error storm.
//
// Run `npm run build` first. Works for both delivery formats; pass a VOD of each:
//   node dev/check_browser.mjs https://chzzk.naver.com/video/16105077   # DASH
//   node dev/check_browser.mjs https://chzzk.naver.com/video/16120741   # HLS
//
// Exit codes: 0 passed, 1 failed, 2 skipped (playback never started here).
//
// The content script lives in an isolated world, so page code cannot see
// `window.__chzzkSkipSilence`: everything is evaluated in the extension's
// execution context through CDP. Each run gets a fresh temporary profile.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const VOD = process.argv[2] ?? "https://chzzk.naver.com/video/16105077";
const RUN_SEC = Number(process.argv[3] ?? 40);
const MAX_WINDOW_SEC = 461;   // KEEP_BEHIND_SEC + PREFETCH_HIGH_SEC + slack (analyser.js)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXT = path.resolve("extension");
if (!fs.existsSync(path.join(EXT, "dist", "content.js"))) {
  console.error("extension/dist is missing: run `npm run build` first");
  process.exit(1);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chzzk-check-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});

const failures = [];
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name} ${extra}`);
  if (!cond) failures.push(name);
};

// ---------------------------------------------------------------- page access
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const extContexts = [];
cdp.on("Runtime.executionContextCreated", (e) => {
  if (e.context.origin?.startsWith("chrome-extension://")) extContexts.push(e.context.id);
});
await cdp.send("Runtime.enable");

/** Evaluate in the extension world; the newest live context wins. */
async function ext(expr) {
  for (const id of [...extContexts].reverse()) {
    try {
      const r = await cdp.send("Runtime.evaluate", { contextId: id, expression: expr, returnByValue: true, awaitPromise: true });
      if (!r.exceptionDetails && r.result?.value !== undefined) return r.result.value;
    } catch { /* context gone */ }
  }
  return null;
}

const V = "window.__chzzkSkipSilence?.controller?.video";
const state = () => ext(`(() => {
  const c = window.__chzzkSkipSilence?.controller;
  if (!c) return null;
  const a = c.analyser;
  return {
    state: c.state, err: c.error, t: +c.video.currentTime.toFixed(1), kind: a?.track?.kind ?? null,
    base: a ? +(a.scoreBase * 0.01).toFixed(1) : null, upto: a ? +a.analysedUntil.toFixed(1) : null,
    applied: c.skipsApplied, saved: +c.skippedSeconds.toFixed(1), resets: a ? a.debug.resets : null,
    decErr: a ? a.stats.decodeErrors : null, lastErr: a?.stats?.lastError ?? null,
    next: a?.skips?.find((s) => s.end > c.video.currentTime + 0.5)?.start ?? null,
  };
})()`);
const playhead = () => ext(`(() => { const v = ${V}; return v ? v.currentTime : null; })()`);

/**
 * Pre-roll and mid-roll ads play in a separate <video> while the player root
 * has `pzp-pc--adbreak`. Keep the ad playing and press SKIP once it appears
 * (after 5 or 15 s); some ads cannot be skipped and simply run out.
 * Clicking the player during an ad opens the advertiser's page, so never do that.
 */
async function waitOutAds(maxSec = 120) {
  for (let i = 0; i < maxSec; i++) {
    const inAd = await page.evaluate(() => {
      if (!document.querySelector(".pzp.pzp-pc--adbreak")) return false;
      const skip = document.querySelector("button.btn_skip:not(.hide)");
      if (skip?.offsetParent) skip.click();
      for (const v of document.querySelectorAll("video:not(.webplayer-internal-video)")) {
        if (v.paused && v.duration > 0) { v.muted = true; v.play().catch(() => {}); }
      }
      return true;
    }).catch(() => false);
    if (!inAd) return;
    if (i === 0) console.log("     (waiting out an ad break)");
    await sleep(1000);
  }
}

/** Get the playhead moving; autoplay can be refused, so fall back to a real click. */
async function ensurePlaying() {
  await waitOutAds();
  // An HLS VOD can sit buffering at ~0.1 s for a while after play() resolves,
  // so give each attempt a few seconds before calling it stalled (~40 s total).
  for (let i = 0; i < 10; i++) {
    await ext(`(async () => { const v = ${V}; if (v) { v.muted = true; try { await v.play(); } catch {} } })()`);
    const a = await playhead();
    await sleep(3000);
    const b = await playhead();
    if (a !== null && b !== null && b > a + 0.3) return true;
    await waitOutAds();
    if (await ext(`(() => !!${V}?.paused)()`)) await page.mouse.click(640, 360).catch(() => {});
  }
  return false;
}

/** The retained window must contain the playhead and stay near it. */
const follows = (r) => !!r && r.base !== null && r.base <= r.t + 5 && r.t - r.base < 420;

/**
 * Whether skipping happens depends on the content, so wait for the next skip
 * interval the analyser has actually found, then require that it is applied.
 * Returns null (no assertion) when no silence turns up within RUN_SEC.
 */
async function nextSkipApplied() {
  let r = await state();
  const before = r?.applied ?? 0;
  for (let i = 0; i < RUN_SEC / 2 && r?.next == null; i++) { await sleep(2000); r = (await state()) ?? r; }
  if (r?.next == null) return null;
  const deadline = Date.now() + (Math.max(0, r.next - r.t) + 15) * 1000;
  while (Date.now() < deadline && !(r?.applied > before)) { await sleep(1000); r = (await state()) ?? r; }
  return { r, before, ok: r?.applied > before };
}

/** Assert a skip, or note that this stretch of the VOD had nothing to skip. */
async function checkSkip(label) {
  const res = await nextSkipApplied();
  if (!res) {
    console.log(`     (${label}: no silence found within ${RUN_SEC}s of analysis, not checked)`);
    return state();
  }
  check(label, res.ok, `applied ${res.before} -> ${res.r?.applied}, next skip at ${res.r?.next ?? "-"}s`);
  return res.r;
}

async function seekAndVerify(label, target) {
  const before = await state();
  await ext(`(() => { const v = ${V}; if (v) { v.currentTime = ${target}; v.play().catch(() => {}); } })()`);
  await sleep(1500);
  const moved = Math.abs((await playhead()) - target) < 5;
  if (!(await ensurePlaying())) {
    console.log(`     (${label} seek: playback paused afterwards, analysis checks not run)`);
    return;
  }
  let r = null;
  for (let i = 0; i < 14; i++) {
    await sleep(1500);
    r = await state();
    if (r?.state === "running" && follows(r) && r.upto > r.base + 5) break;
  }
  check(`still running after the ${label} seek`, r?.state === "running", JSON.stringify(r?.err));
  check(`window follows the playhead after the ${label} seek`, follows(r), `t=${r?.t} base=${r?.base}`);
  check(`coverage grows after the ${label} seek`, !!r && r.upto > r.base + 5, `${r?.base}..${r?.upto}`);
  if (moved) {
    // Either the seeked handler reset the window or pump noticed the playhead left it.
    const reanchored = r.resets > before.resets || Math.abs(r.base - target) < 120;
    check(`the ${label} seek re-anchored the window`, reanchored, `base=${r.base}`);
  } else {
    console.log(`     (${label} seek: the player did not move to ${target}s, re-anchor not checked)`);
  }
}

// ---------------------------------------------------------------------- run
let code = 0;
try {
  await page.goto(VOD, { waitUntil: "domcontentloaded" });
  await sleep(6000);

  if (!(await ensurePlaying())) {
    console.log("SKIPPED: playback never started in this environment\n" + JSON.stringify(await state()));
    code = 2;
  } else {
    let r = await state();
    for (let i = 0; i < 10 && r?.state !== "running"; i++) { await sleep(1000); r = await state(); }
    check("analyser is running", r?.state === "running", `${r?.kind ?? ""} ${JSON.stringify(r?.err)}`);
    const button = await page.$(".pzp-pc__bottom-buttons-right > .css-skip-button");
    check("player button is in the control bar", !!button);

    await checkSkip("a skip is applied during playback");
    await seekAndVerify("forward", 1200);
    await seekAndVerify("backward", 300);
    r = await checkSkip("a skip is still applied after seeking");

    check("retained window stays bounded", r && r.upto - r.base <= MAX_WINDOW_SEC, `${r?.base}..${r?.upto}`);
    check("no decode-error storm", (r?.decErr ?? 0) < 50, `${r?.decErr} (${r?.lastErr ?? "none"})`);
    console.log(`\nSUMMARY ${JSON.stringify(r)}`);
    console.log(failures.length ? `FAILURES: ${failures.join(", ")}` : "all browser checks passed");
    code = failures.length ? 1 : 0;
  }
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exitCode = code;
