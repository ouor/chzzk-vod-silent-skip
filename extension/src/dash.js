// DASH manifest parsing for Naver VOD playback responses.

/**
 * @typedef {object} AudioTrack
 * @property {string} baseUrl absolute URL of the media file
 * @property {[number, number]|null} initRange byte range of the init segment
 * @property {{start:number,duration:number,range:[number,number]|null,url:string|null}[]} segments
 *   `start` is the nominal presentation time in seconds.
 * @property {number} timescale
 * @property {number} primingSec decoded audio leads the player clock by this much
 */

/**
 * Naver's audio-only rendition decodes to content that leads the player timeline
 * by the AAC priming delay (2048 samples at 48 kHz). Measured constant over the
 * whole stream (0 s, 2 000 s, 12 000 s, 30 400 s) — see dev/audio-timeline.md.
 */
export const AUDIO_PRIMING_SEC = 2048 / 48000;

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseRange(s) {
  if (!s) return null;
  const [a, b] = String(s).split("-").map((x) => Number(x.trim()));
  if (!Number.isFinite(a)) return null;
  return [a, Number.isFinite(b) ? b : a];
}

/**
 * Expand SegmentTimeline entries (with @r repeats) into concrete segments.
 *
 * `@r` is a repeat count: the entry appears `r + 1` times. `@r="-1"` means
 * "repeat until the end of the period", which cannot be resolved without a
 * period duration, so it is clamped to a single occurrence rather than being
 * silently dropped (dropping it would shift every later segment).
 *
 * @param {*} timelineEntries
 * @param {number} timescale
 * @param {number|null} [endTime] period end in timescale units
 */
export function expandTimeline(timelineEntries, timescale, endTime = null) {
  const out = [];
  let t = 0;
  for (const entry of asArray(timelineEntries)) {
    for (const s of asArray(entry.S)) {
      const d = Number(s["@d"]);
      if (!Number.isFinite(d) || d <= 0) continue;
      if (s["@t"] !== undefined) t = Number(s["@t"]);
      const rRaw = s["@r"] !== undefined ? Number(s["@r"]) : 0;
      let repeat = Number.isFinite(rRaw) ? rRaw : 0;
      if (repeat < 0) {
        repeat = endTime && d > 0 ? Math.max(0, Math.ceil((endTime - t) / d) - 1) : 0;
      }
      for (let i = 0; i <= repeat; i++) {
        out.push({ start: t / timescale, duration: d / timescale });
        t += d;
      }
    }
  }
  return out;
}

/**
 * Pick the audio track out of a Naver playback response.
 *
 * Three shapes are seen:
 *   * DASH with an `audio/mp4` rendition (SegmentList + byte ranges) — the
 *     audio-only path.
 *   * DASH with a single `video/mp2t` AdaptationSet: the audio is muxed into
 *     MPEG-TS segments referenced by a SegmentTemplate. There is no audio-only
 *     rendition, so the cheapest representation is used and the audio PID is
 *     demuxed at runtime (`mpegts.js`).
 *   * Nothing usable → null.
 *
 * @param {any} playback parsed JSON body of the playback endpoint
 * @returns {AudioTrack|null}
 */
export function parseAudioTrack(playback) {
  const periods = asArray(playback?.MPD?.[0]?.Period);

  // Prefer a dedicated audio rendition when the response has one.
  const audio = findSeparateAudio(periods);
  if (audio) return audio;

  // Otherwise fall back to the cheapest MPEG-TS representation, whose audio has
  // to be demuxed out of the muxed segment.
  return findMuxedTs(periods);
}

function findSeparateAudio(periods) {
  for (const period of periods) {
    for (const set of asArray(period.AdaptationSet)) {
      for (const rep of asArray(set.Representation)) {
        // @mimeType may sit on the set or on the representation
        const mime = rep["@mimeType"] ?? set["@mimeType"] ?? "";
        const codecs = String(rep["@codecs"] ?? set["@codecs"] ?? "");
        const isAudio = mime.startsWith("audio/") || (/mp4a|ac-3|ec-3/.test(codecs) && !mime.startsWith("video/"));
        if (!isAudio) continue;

        const baseUrl = asArray(rep.BaseURL)[0];
        if (!baseUrl) continue;
        const list = asArray(rep.SegmentList)[0];
        if (!list) continue;

        const timescale = Number(list["@timescale"] ?? 48000);
        const times = expandTimeline(asArray(list.SegmentTimeline)[0], timescale,
          periodEndOf(period, timescale));
        const urls = asArray(list.SegmentURL);

        /** @type {AudioTrack["segments"]} */
        const segments = [];
        for (let i = 0; i < times.length; i++) {
          const target = urls.length ? urls[i] : undefined;
          const range = parseRange(target ? target["@mediaRange"] : undefined);
          const url = target && target["@media"] ? target["@media"] : null;
          if (!range && !url) continue;
          segments.push({ ...times[i], range, url });
        }
        if (!segments.length) continue;

        return {
          kind: "dash",
          baseUrl,
          initRange: parseRange(asArray(list.Initialization)[0]?.["@range"]),
          segments,
          timescale,
          primingSec: AUDIO_PRIMING_SEC,
        };
      }
    }
  }
  return null;
}

/** @param {any} period @param {number} timescale */
function periodEndOf(period, timescale) {
  const dur = period["@duration"]
    ? Number(String(period["@duration"]).replace("PT", "").replace("S", ""))
    : null;
  return dur ? dur * timescale : null;
}

/**
 * Cheapest `video/mp2t` (or other muxed) representation addressed by a
 * SegmentTemplate, whose audio has to be demuxed out of each segment.
 */
function findMuxedTs(periods) {
  /** @type {AudioTrack|null} */
  let best = null;

  for (const period of periods) {
    for (const set of asArray(period.AdaptationSet)) {
      const setMime = String(set["@mimeType"] ?? "");
      for (const rep of asArray(set.Representation)) {
        const mime = String(rep["@mimeType"] ?? setMime);
        const codecs = String(rep["@codecs"] ?? set["@codecs"] ?? "");
        // Only containers that actually carry audio.
        if (!/mp2t|video\/mp4/.test(mime)) continue;
        if (!/mp4a|ac-3|ec-3|mp3|mp2a/.test(codecs)) continue;

        const baseUrl = asArray(rep.BaseURL)[0];
        if (!baseUrl) continue;

        const tmpl = asArray(rep.SegmentTemplate)[0];
        if (!tmpl) continue;
        const mediaUrl = String(tmpl["@media"] ?? "");
        if (!mediaUrl) continue;

        const timescale = Number(tmpl["@timescale"] ?? 1000);
        const startNumber = Number(tmpl["@startNumber"] ?? 0);
        const times = expandTimeline(asArray(tmpl.SegmentTimeline)[0], timescale,
          periodEndOf(period, timescale));
        if (!times.length) continue;

        const repId = String(rep["@id"] ?? "");
        // BaseURL may be relative; resolveTrackUrls() rebases the whole segment
        // URL against the manifest, so the base must already be part of it.
        const segments = times.map((t, i) => ({
          ...t,
          range: null,
          url: baseUrl + fillTemplate(mediaUrl, repId, startNumber + i, Math.round(t.start * timescale)),
        }));

        const bandwidth = Number(rep["@bandwidth"] ?? Number.MAX_SAFE_INTEGER);
        if (!best || bandwidth < best.bandwidth) {
          best = {
            kind: "dash-ts",
            baseUrl,
            initRange: null,
            muxed: true,
            segments,
            timescale,
            primingSec: 0,
            bandwidth,
            codecs,
          };
        }
      }
    }
  }
  return best;
}

/**
 * Substitute the DASH SegmentTemplate placeholders.
 * `$Number%06d$` pads to the width in the format spec, `$Time$` is in timescale
 * units, `$RepresentationID$` is the representation id, and `$$` is a literal.
 */
export function fillTemplate(template, representationId, number, time) {
  return template
    .replace(/\$\$/g, "\u0000")
    .replace(/\$(RepresentationID|Number|Time)(?:%0(\d+)d)?\$/g, (m, name, width) => {
      if (name === "RepresentationID") return representationId;
      const value = name === "Number" ? number : time;
      return width ? String(value).padStart(Number(width), "0") : String(value);
    })
    .replace(/\u0000/g, "$");
}

/**
 * Resolve relative media URLs against the manifest URL. DASH allows relative
 * BaseURL and SegmentURL values; resolving against the extension origin would
 * make every request fail.
 *
 * @param {AudioTrack} track
 * @param {string} manifestUrl
 * @returns {AudioTrack}
 */
export function resolveTrackUrls(track, manifestUrl) {
  const abs = (u) => {
    try {
      return new URL(u, manifestUrl).toString();
    } catch {
      return u;
    }
  };
  return {
    ...track,
    baseUrl: abs(track.baseUrl),
    segments: track.segments.map((s) => (s.url ? { ...s, url: abs(s.url) } : s)),
  };
}
