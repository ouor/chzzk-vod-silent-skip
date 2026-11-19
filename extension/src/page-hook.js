// MAIN-world hook: learn which media manifest the player asks for.
//
// Two delivery formats are seen on CHZZK VODs:
//   * DASH - `play.vod.naver.com/v3/playback/<videoId>?key=...` (JSON, audio-only rendition)
//   * HLS  - `.../vod_playlist.m3u8` master + `.../vod_chunklist.m3u8` media playlists
//
// HLS has no separate audio rendition, so audio is analysed from the cheapest
// muxed variant. Content scripts cannot see these requests, so we wrap
// fetch/XHR here and forward the URL with postMessage.
//
// The player usually starts loading before the content script is ready, so the
// last seen URL is also kept here and replayed on request ("hello").
(() => {
  const TAG = "__chzzk_skipper_playback__";
  if (window[TAG]) return;
  window[TAG] = true;

  const isPlayback = (u) =>
    typeof u === "string" &&
    (u.includes("/v3/playback/") || /vod_playlist\.m3u8/.test(u) || /vod_chunklist\.m3u8/.test(u));

  // Only the newest manifest is replayed: the content script starts on the first
  // URL it gets, so replaying history after an SPA navigation would start it on
  // the *previous* video. A master/DASH URL beats a later HLS chunklist so the
  // analyser can still pick the cheapest variant.
  let lastManifest = null;
  let lastAny = null;
  const announce = (url) => {
    lastAny = url;
    if (!/vod_chunklist\.m3u8/.test(url)) lastManifest = url;
    try {
      window.postMessage({ source: "chzzk-skip-silence", type: "playback-url", url }, "*");
    } catch {
      /* ignore */
    }
  };

  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : input && input.url;
        if (isPlayback(url)) announce(String(url));
      } catch {
        /* ignore */
      }
      return origFetch.call(this, input, init);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (isPlayback(url)) announce(String(url));
    } catch {
      /* ignore */
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // The content script may start after the player has already fetched its
  // manifest; replay the most recent master playlist when asked.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== "chzzk-skip-silence" || d.type !== "hello") return;
    const url = lastManifest ?? lastAny;
    if (url) window.postMessage({ source: "chzzk-skip-silence", type: "playback-url", url }, "*");
  });
})();
