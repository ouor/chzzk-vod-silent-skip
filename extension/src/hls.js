// HLS support.
//
// Some CHZZK VODs are delivered as HLS instead of the DASH `play.vod.naver.com`
// JSON: the player fetches `.../vod_playlist.m3u8` (master) and then a per-quality
// `.../vod_chunklist.m3u8` media playlist listing 2 s fMP4 segments. There is no
// separate audio-only rendition in that case; the audio is muxed into the video
// segments (`mp4a.40.2`), so we analyse the cheapest variant.

function asUrl(uri, base) {
  return new URL(uri, base).toString();
}

/**
 * Parse an HLS master playlist.
 * @returns {{bandwidth:number, resolution?:string, uri:string}[]}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const bw = Number((line.match(/BANDWIDTH=(\d+)/) || [])[1]);
    const res = (line.match(/RESOLUTION=([0-9x]+)/) || [])[1];
    let uri = null;
    for (let j = i + 1; j < lines.length; j++) {
      const cand = lines[j].trim();
      if (!cand) continue;
      if (cand.startsWith("#")) break;
      uri = cand;
      break;
    }
    if (!uri) continue;
    out.push({ bandwidth: Number.isFinite(bw) ? bw : 0, resolution: res, uri: asUrl(uri, baseUrl) });
  }
  return out;
}

/**
 * Parse an HLS media playlist into absolute segments.
 *
 * Segment start times come from the cumulative `#EXTINF` durations, which is the
 * same clock the player uses: verified against the muxed audio timestamps of
 * segments 0, 1, 500 and 5000 (playlistStart matched the decoded start exactly).
 *
 * @returns {{initUri: string|null, segments: {start:number,duration:number,uri:string}[], duration:number}}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let initUri = null;
  let target = 0;
  let t = 0;
  const segments = [];
  let pendingDuration = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) initUri = asUrl(m[1], baseUrl);
      continue;
    }
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      target = Number(line.split(":")[1]) || 0;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = Number(line.slice(8).split(",")[0]);
      if (!Number.isFinite(pendingDuration)) pendingDuration = target || 2;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (pendingDuration === null) continue;
    segments.push({ start: t, duration: pendingDuration, uri: asUrl(line, baseUrl) });
    t += pendingDuration;
    pendingDuration = null;
  }
  return { initUri, segments, duration: t };
}

/** Pick the cheapest variant: analysis only needs the audio track. */
export function cheapestVariant(variants) {
  if (!variants.length) return null;
  return variants.reduce((a, b) => (b.bandwidth < a.bandwidth ? b : a));
}
