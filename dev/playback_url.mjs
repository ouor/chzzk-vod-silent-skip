// Grab a fresh playback manifest URL from a CHZZK VOD page.
//
// The playback URL is signed and expires, so `dev/fetch_regions.py` cannot
// carry one in the repository (and should not: it is a credential). This script
// loads the page in a real Chromium, watches the player's own requests, and
// prints the newest manifest URL.
//
// Usage:
//   node dev/playback_url.mjs                      # default test VOD
//   node dev/playback_url.mjs <chzzk video url>
//   node dev/playback_url.mjs <url> --json         # machine readable
//
// Then:  PB_URL='...' python dev/fetch_regions.py 15000
import { chromium } from "playwright";

const URL_ = process.argv[2] ?? "https://chzzk.naver.com/video/16105077";
const AS_JSON = process.argv.includes("--json");

const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  // Capture the manifest requests the player makes, before any page script runs.
  await page.addInitScript(() => {
    window.__manifests = [];
    const keep = (u) => {
      const s = String(u);
      if (s.includes("/v3/playback/") || /vod_(playlist|chunklist)\.m3u8/.test(s)) {
        window.__manifests.push(s);
      }
    };
    const of = window.fetch;
    if (of) {
      window.fetch = function (input, init) {
        try {
          keep(typeof input === "string" ? input : input?.url);
        } catch { /* ignore */ }
        return of.call(this, input, init);
      };
    }
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        keep(url);
      } catch { /* ignore */ }
      return oo.call(this, method, url, ...rest);
    };
  });

  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  // The player fetches the manifest once it has the video metadata.
  let urls = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000);
    urls = await page.evaluate(() => window.__manifests ?? []);
    if (urls.some((u) => u.includes("/v3/playback/"))) break;
  }
  // A DASH playback response is preferred (separate audio rendition), else HLS.
  const dash = urls.filter((u) => u.includes("/v3/playback/"));
  const hls = urls.filter((u) => /vod_playlist\.m3u8/.test(u));
  const picked = dash.at(-1) ?? hls.at(-1) ?? null;

  if (!picked) {
    console.error("no playback manifest observed; the player may not have started");
    console.error(`seen: ${JSON.stringify(urls.slice(0, 5))}`);
    process.exitCode = 1;
  } else if (AS_JSON) {
    console.log(JSON.stringify({ kind: dash.length ? "dash" : "hls", url: picked }, null, 1));
  } else {
    console.log(picked);
  }
} finally {
  await browser.close();
}
