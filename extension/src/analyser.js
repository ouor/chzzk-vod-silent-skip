// Analyser: keeps audio decoded ahead of the playhead, extracts frame features
// and scores speech probability. Everything is incremental and windowed, so an
// 8 hour VOD never needs to be held in memory.
//
// Timeline: all absolute times here are in the *player* timeline, i.e. the same
// clock as `video.currentTime`.
//   DASH audio-only rendition: decodes AUDIO_PRIMING_SEC before the player clock
//     (measured constant 42.67 ms; see dev/audio-timeline.md), so each segment is
//     placed at `segment.start + AUDIO_PRIMING_SEC`.
//   HLS: audio is muxed and its timeline already equals the playlist clock.

import { parseAudioTrack, resolveTrackUrls } from "./dash.js";
import { parseMasterPlaylist, parseMediaPlaylist, cheapestVariant } from "./hls.js";
import { PcmBuilder, decodeSegment, TARGET_SR } from "./audio-decode.js";
import { demuxMpegTsAudio } from "./mpegts.js";
import { FeatureStream, HOP, SR } from "./features.js";
import { SpeechModel, FrameCache, ScoreWindow, smoothScores, buildSkips } from "./vad.js";

/** Refill the decode queue when coverage drops below this far ahead of the playhead. */
export const PREFETCH_LOW_SEC = 240;
/** Once refilling, target this much ahead. */
export const PREFETCH_HIGH_SEC = 360;
/** Never analyse further behind the playhead than this. */
export const KEEP_BEHIND_SEC = 60;
/** Parallel segment requests. Only bytes are prefetched, decoding stays serial. */
const FETCH_CONCURRENCY = 4;
/** Per-request timeout; a hung request must not freeze analysis forever. */
const REQUEST_TIMEOUT_MS = 15000;
/** Audio is decoded in bursts of this many segments so timing stays smooth. */
const DECODE_BURST = 8;
/** Attempts per segment before it is abandoned and its audio treated as unknown. */
const MAX_SEGMENT_RETRIES = 3;

export class Analyser {
  /**
   * @param {object} opts
   * @param {BaseAudioContext} opts.ctx decode-only context
   * @param {object} opts.model parsed model.json
   * @param {number} [opts.threshold]
   */
  constructor({ ctx, model, threshold }) {
    this.ctx = ctx;
    this.model = new SpeechModel(model);
    this.threshold = threshold ?? model.threshold;
    this.hopSec = HOP / SR;                       // 0.01 s
    this.sampleRate = model.sampleRate ?? TARGET_SR;
    this.smoothingFrames = model.smoothingFrames ?? 15;
    this.minSkipSec = model.minSkipSec ?? 3.5;
    this.leadInSec = 0.30;
    this.leadOutSec = 0.25;

    this.track = null;
    /** @type {Promise<ArrayBuffer>|null} DASH init segment, fetched once. */
    this.initPromise = null;
    /** @type {Promise<ArrayBuffer>|null} HLS `#EXT-X-MAP` init segment. */
    this.hlsInitPromise = null;
    /** @type {Set<AbortController>} every in-flight request, so destroy can abort all */
    this.inflight = new Set();
    this.aborted = false;
    /** Bumped on every reset so in-flight async work can bail out. */
    this.generation = 0;
    this.resetWindow(0);

    this.busy = false;
    this.onUpdate = null;
    this.onError = null;
    this.stats = {
      segmentsFetched: 0, bytes: 0, gapSec: 0, decodeErrors: 0, lastError: null,
      tsSegments: 0,      // muxed MPEG-TS segments demuxed
      tsPtsJumps: 0,      // segments whose PTS disagreed with the first anchor
    };
    /** PTS-to-nominal offset of the first TS segment analysed (constant per stream). */
    this.tsAnchor = null;
    this.debug = { resets: 0, lastResetAt: 0, firstSegment: null };
  }

  /** Clear all position-dependent state; analysis restarts at `startSec`. */
  resetWindow(startSec = 0) {
    this.generation++;
    // Cancel anything still in flight for the previous window: its chunk would
    // otherwise be pushed with a stale absolute time into the fresh builder.
    // The shared init segments were aborted too, so their memoised promises must
    // be dropped as well — a rejected (or empty) init poisons every later decode.
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
    this.initPromise = null;
    this.hlsInitPromise = null;
    this.aborted = false;
    this.builder = new PcmBuilder(this.ctx, this.sampleRate);
    this.features = new FeatureStream();
    this.cache = new FrameCache(2048, this.model.nFeat);
    this.segmentCursor = -1;
    this.coverageEnd = startSec;     // player time covered by decoded audio
    this.windowStart = startSec;     // player time the current window began at
    this.streamBaseSec = null;       // absolute time of feature-stream sample 0
    this.streamBaseFrame = 0;
    this.scoreCursor = null;         // next frame that still needs scoring
    // Retained score history: a fixed-size buffer covering everything from
    // KEEP_BEHIND_SEC behind the playhead to the prefetch horizon, so a skip
    // interval is never dropped before the playhead reaches it.
    const scoreFrames = Math.round((KEEP_BEHIND_SEC + PREFETCH_HIGH_SEC) / this.hopSec) + 4096;
    this.scores = new ScoreWindow(scoreFrames);
    this.smoothScratch = {};
    this.skips = [];
    this.fetchQueue = new Map();     // segment index -> {bytes, pts} | null
    this.fetchFailures = new Map();  // segment index -> failed attempts
    this.tsAnchor = null;            // PTS anchor for muxed MPEG-TS streams
  }

  frameOf(sec) {
    return Math.round(sec / this.hopSec);
  }

  // ------------------------------------------------------------------ source

  /** Load the manifest behind a playback URL (DASH JSON or HLS playlist). */
  async load(playbackUrl) {
    const text = await this.fetchText(playbackUrl);
    if (text === null) throw new Error("aborted while loading the manifest");

    if (/\.m3u8(\?|$)/.test(playbackUrl) || text.trimStart().startsWith("#EXTM3U")) {
      this.track = await this.loadHls(playbackUrl, text);
    } else {
      const track = parseAudioTrack(JSON.parse(text));
      if (!track) throw new Error("no separate audio rendition in this playback response");
      this.track = resolveTrackUrls(track, playbackUrl);
    }
    this.initPromise = null;
    this.hlsInitPromise = null;
    return this.track;
  }

  /** Fetch a text body with the same timeout/abort semantics as fetchBytes. */
  async fetchText(url) {
    const controller = new AbortController();
    this.inflight.add(controller);
    if (this.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { credentials: "omit", signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${shortUrl(url)}`);
      return await res.text();
    } catch (err) {
      if (this.aborted) return null;
      throw err;
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  /**
   * HLS: the audio is muxed into the video segments, so analyse the cheapest
   * variant. Segment starts come from cumulative #EXTINF durations, which match
   * the player clock (verified against the muxed timestamps and against a live
   * envelope cross-correlation: lag 0 samples).
   */
  async loadHls(masterUrl, masterText) {
    let mediaUrl = masterUrl;
    let mediaText = masterText;
    const variants = parseMasterPlaylist(masterText, masterUrl);
    if (variants.length) {
      const v = cheapestVariant(variants);
      mediaUrl = v.uri;
      const text = await this.fetchText(mediaUrl);
      if (text === null) throw new Error("aborted while loading the HLS media playlist");
      mediaText = text;
    }
    const media = parseMediaPlaylist(mediaText, mediaUrl);
    if (!media.segments.length) throw new Error("empty HLS media playlist");
    return {
      kind: "hls",
      baseUrl: mediaUrl,
      initUri: media.initUri,
      segments: media.segments,
      duration: media.duration,
    };
  }

  /** Index of the segment that contains player time `sec`. */
  segmentIndexFor(sec) {
    const segs = this.track.segments;
    const probe = this.track.kind === "hls" ? sec : sec - this.segmentShift();
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].start + segs[mid].duration <= probe) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Offset between a segment's nominal start and its player-timeline start. */
  segmentShift() {
    return this.track.kind === "hls" ? 0 : this.track.primingSec ?? 0;
  }

  segmentStart(seg) {
    return seg.start + this.segmentShift();
  }

  // -------------------------------------------------------------------- pump

  /**
   * Keep the analysis ahead of the playhead.
   * @param {number} playheadSec
   * @param {number} [budgetMs] wall-clock budget for fetch+decode work
   */
  async pump(playheadSec, budgetMs = 700) {
    if (!this.track || this.busy) return;
    this.busy = true;
    const t0 = performance.now();
    let gen = this.generation;
    try {
      if (this.segmentCursor < 0) this.openWindow(playheadSec);
      else if (this.playheadLeftWindow(playheadSec)) {
        this.debug.resets++;
        this.debug.lastResetAt = playheadSec;
        this.resetWindow(playheadSec);
        this.openWindow(playheadSec);
      }
      // Re-read the token after the window may have been reset above: a reset
      // inside this pump bumps the generation, and comparing against a token
      // captured before it would make this pump bail out immediately and reset
      // again on the next tick, forever.
      gen = this.generation;

      const target = playheadSec + (this.coverageEnd < playheadSec + PREFETCH_LOW_SEC
        ? PREFETCH_HIGH_SEC
        : PREFETCH_LOW_SEC);

      await this.prefetch(target, gen, t0, budgetMs);
      if (gen !== this.generation) return;

      await this.decodeAhead(gen, t0, budgetMs);
      if (gen !== this.generation) return;

      this.consumePcm();
      this.updateSkips();
    } catch (err) {
      // A reset (seek) cancels the requests this pump was waiting on; that is not
      // an error, it is the expected outcome.
      if (gen !== this.generation) return;
      this.onError?.(err);
    } finally {
      this.busy = false;
      if (gen === this.generation) this.onUpdate?.(this);
    }
  }

  openWindow(playheadSec) {
    this.segmentCursor = this.segmentIndexFor(playheadSec);
    const seg = this.track.segments[this.segmentCursor];
    if (!seg) return;
    this.windowStart = this.segmentStart(seg);
    this.coverageEnd = this.windowStart;
    this.debug.firstSegment = { index: this.segmentCursor, start: seg.start, playhead: playheadSec };
  }

  playheadLeftWindow(playheadSec) {
    return playheadSec < this.windowStart - 5 || playheadSec > this.coverageEnd + 5;
  }

  /** Fetch bytes for the segments needed to reach `target`, in parallel. */
  async prefetch(target, gen, t0, budgetMs) {
    let index = this.segmentCursor;
    while (this.coverageEnd < target && index < this.track.segments.length) {
      const batch = [];
      while (batch.length < FETCH_CONCURRENCY && this.fetchQueue.size + batch.length < DECODE_BURST * 2) {
        const seg = this.track.segments[index + batch.length];
        if (!seg) break;
        if (this.segmentStart(seg) + seg.duration > target) break;
        const i = index + batch.length;
        if (!this.fetchQueue.has(i)) batch.push(i);
        else break;
      }
      if (!batch.length) break;

      const results = await Promise.allSettled(batch.map((i) => this.fetchSegment(i)));
      if (gen !== this.generation) return;
      for (let k = 0; k < batch.length; k++) {
        const i = batch[k];
        if (results[k].status === "fulfilled") {
          this.fetchQueue.set(i, results[k].value);
          this.fetchFailures.delete(i);
          continue;
        }
        // Requests aborted by a reset are not failures: the segment will simply
        // be fetched again for the new window.
        const reason = results[k].reason;
        if (isAbort(reason) || this.aborted) continue;
        this.stats.lastError = String(reason?.message || reason);
        // An auth failure (expired `key`/token) hits every later segment too:
        // abandoning them one by one would silently stop all skipping. Surface it
        // so the controller retries with a freshly loaded manifest.
        if (/HTTP (401|403|410)\b/.test(this.stats.lastError)) throw reason;
        // A segment that keeps failing (403 on an expired token, a CDN hiccup)
        // must not block the rest of the stream forever. Retry a few times, then
        // abandon it and account for its audio as a hole so the window can still
        // make progress; PcmBuilder bridges the hole as unknown audio, which is
        // never skipped.
        const tries = (this.fetchFailures.get(i) ?? 0) + 1;
        this.stats.decodeErrors++;
        if (tries >= MAX_SEGMENT_RETRIES) {
          this.fetchFailures.delete(i);
          this.fetchQueue.set(i, null);   // sentinel: do not decode this segment
          const seg = this.track.segments[i];
          if (seg) this.coverageEnd = Math.max(this.coverageEnd, this.segmentStart(seg) + seg.duration);
        } else {
          this.fetchFailures.set(i, tries);
        }
      }
      // Keep the failure table bounded on a very long stream.
      if (this.fetchFailures.size > 256) {
        for (const key of this.fetchFailures.keys()) {
          if (key < this.segmentCursor) this.fetchFailures.delete(key);
        }
      }
      // do not run ahead of the decode budget with a huge byte queue
      if (this.fetchQueue.size >= DECODE_BURST * 2) break;
      index += batch.length;
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  /** Decode queued segments in order, staying inside the time budget. */
  async decodeAhead(gen, t0, budgetMs) {
    let burst = 0;
    while (this.segmentCursor >= 0 && burst < DECODE_BURST) {
      const seg = this.track.segments[this.segmentCursor];
      if (!seg) break;
      if (!this.fetchQueue.has(this.segmentCursor)) break;
      const queued = this.fetchQueue.get(this.segmentCursor);
      this.fetchQueue.delete(this.segmentCursor);
      if (queued === null) {
        // Permanently failed segment: advance and let PcmBuilder bridge the hole.
        this.segmentCursor++;
        continue;
      }

      // Prefetch stores `{ bytes, pts }`; TS segments carry their PES PTS so the
      // decoded audio is placed on the exact frame boundary, not on the 4 s grid.
      let decoded;
      try {
        decoded = await decodeSegment(this.ctx, queued.bytes);
      } catch (err) {
        this.stats.decodeErrors++;
        this.stats.lastError = `decode: ${String(err?.message || err)}`;
        this.segmentCursor++;
        continue;
      }
      if (gen !== this.generation) return;

      const audio = decoded;
      // Muxed TS segments are placed on the MPD grid like every other source
      // (their PTS is only used to detect container timeline jumps, see demuxTs).
      const absStart = this.segmentStart(seg);
      this.builder.push(audio, absStart);
      this.coverageEnd = Math.max(this.coverageEnd, absStart + audio.duration);
      this.segmentCursor++;
      this.stats.segmentsFetched++;
      burst++;
      this.consumePcm();
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  // ------------------------------------------------------------------ fetch

  /**
   * The shared init segment, fetched once per window.
   *
   * A rejected promise is dropped immediately, so one failed init request cannot
   * poison every later decode ("Unable to decode audio data" for the rest of the
   * session): the next segment simply retries.
   */
  initBytesFor(kind) {
    if (kind === "hls") {
      if (!this.hlsInitPromise) {
        this.hlsInitPromise = this.fetchHlsInit().catch((err) => {
          this.hlsInitPromise = null;
          throw err;
        });
      }
      return this.hlsInitPromise;
    }
    if (!this.initPromise) {
      this.initPromise = this.fetchBytes(this.track.baseUrl, this.track.initRange).catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  /** Fetch the bytes for one segment (init segment prepended where needed). */
  async fetchSegment(index) {
    const seg = this.track.segments[index];
    if (!seg) throw new Error(`segment ${index} out of range`);
    if (this.track.kind === "hls") {
      const init = await this.initBytesFor("hls");
      const body = await this.fetchBytes(seg.uri);
      return { bytes: concatBuffers(init, body), pts: null };
    }
    if (seg.url) {
      const body = await this.fetchBytes(seg.url);
      // A muxed MPEG-TS segment has to be demuxed: decodeAudioData rejects the
      // container ("Unable to decode audio data") but reads the ADTS inside it.
      if (!this.track.muxed) return { bytes: body, pts: null };
      return this.demuxTs(body, index);
    }

    // Without an Initialization range there is no init segment to prepend;
    // fetching the whole file instead would download hundreds of MB.
    if (!this.track.initRange) return { bytes: await this.fetchBytes(this.track.baseUrl, seg.range), pts: null };
    const init = await this.initBytesFor("dash");
    const body = await this.fetchBytes(this.track.baseUrl, seg.range);
    return { bytes: concatBuffers(init, body), pts: null };
  }

  /**
   * Extract the audio elementary stream from a muxed MPEG-TS segment.
   *
   * The PES PTS is kept: it is the only exact way to place the segment on the
   * player timeline. Measured on video/13166636, the audio PTS advances by
   * exactly the decoded length of each segment (4.032 / 4.011 / 3.989 s), while
   * the *nominal* 4 s grid would leave a hole per segment. The anchor is taken
   * from the first segment analysed, so playback stays gapless from there on;
   * the audio PTS also leads the video PTS by the same 42.67 ms AAC priming
   * measured for the `audio/mp4` path.
   */
  demuxTs(buf, index) {
    const r = demuxMpegTsAudio(buf);
    if (!r.ok) throw new Error(`no audio in TS segment ${index}`);
    this.stats.tsSegments++;
    if (r.pts !== null) {
      const seg = this.track.segments[index];
      const nominal = seg ? seg.start : 0;
      // The player normalises this container so its clock equals the MPD grid:
      // every rendition's first PTS is 1.2 s above its nominal start and stays
      // there (measured at segments 0, 1, 2, 100, 101, 102, 1000 and 6000), and
      // `buffered.start(0)` reads 0.043 — the first audio PTS minus the first
      // video PTS. So each segment belongs at its nominal start; the measured
      // audio-PTS jitter around that is at most one AAC frame (43 ms), which is
      // far below the skip policy's 250 ms lead-out.
      if (this.tsAnchor === null) this.tsAnchor = r.pts - nominal;
      const delta = r.pts - nominal;
      if (Math.abs(delta - this.tsAnchor) > 0.25) {
        // A jump here means the container timeline restarted; worth surfacing.
        this.stats.tsPtsJumps++;
        this.stats.lastError = `TS PTS jump at segment ${index} (${delta.toFixed(3)}s vs ${this.tsAnchor.toFixed(3)}s)`;
      }
    }
    return { bytes: r.adts, pts: null };
  }


  async fetchHlsInit() {
    if (!this.track.initUri) return new ArrayBuffer(0);
    return await this.fetchBytes(this.track.initUri);
  }

  /**
   * Fetch bytes with an explicit timeout and HTTP status check.
   *
   * Two hazards this guards against:
   *   * a `Range` response that ignores the header and returns the whole file
   *     (hundreds of MB straight into decodeAudioData), and
   *   * a short/truncated body. `force-cache` used to be set here, which made
   *     Chrome serve a cached range entry even when a previous request had been
   *     aborted mid-body; the truncated bytes then failed to decode for the rest
   *     of the session. Default caching plus a strict length check means such an
   *     entry is rejected and simply refetched.
   */
  async fetchBytes(url, range = null, opts = {}) {
    const controller = new AbortController();
    // Segments are prefetched in parallel, so every in-flight request must be
    // tracked: keeping only the newest one would leave the others un-abortable.
    this.inflight.add(controller);
    if (this.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        credentials: "omit",
        signal: controller.signal,
        headers: range ? { Range: `bytes=${range[0]}-${range[1]}` } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${shortUrl(url)}`);
      const buf = await res.arrayBuffer();
      if (range) {
        const expected = range[1] - range[0] + 1;
        // A server that ignores Range returns the whole file; a truncated body
        // (206 with fewer bytes, or a poisoned cache entry) must also be refused.
        if (buf.byteLength === 0 || buf.byteLength !== expected) {
          throw new Error(
            `range mismatch for ${shortUrl(url)}: asked ${range[0]}-${range[1]} ` +
            `(${expected} B), got ${buf.byteLength} B`,
          );
        }
      }
      this.stats.bytes += buf.byteLength;
      return buf;
    } catch (err) {
      if (opts.optional) return new ArrayBuffer(0);
      throw err;
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  // ---------------------------------------------------------------- scoring

  /** Move newly decoded PCM through the feature extractor, cache and scorer. */
  consumePcm() {
    for (;;) {
      const chunk = this.builder.drain();
      if (!chunk) return;
      // PcmBuilder keeps the output gapless and reports bridged holes, so stream
      // sample 0 is always at `streamBaseSec` and frame k at streamBaseSec + k*HOP.
      if (this.streamBaseSec === null) {
        this.streamBaseSec = chunk.startTime;
        this.streamBaseFrame = this.frameOf(chunk.startTime);
      }
      const localStart = this.features.nextFrame;
      this.features.push(chunk.pcm);
      const feats = this.features.drain();
      const nFrames = feats.length / this.model.nFeat;

      if (nFrames > 0) {
        const absStart = this.streamBaseFrame + localStart;
        this.cache.append(feats, nFrames, absStart);
        if (this.scoreCursor === null) this.scoreCursor = absStart;
        const endFrame = absStart + nFrames;
        // score everything whose full context window is available
        this.scoreRange(this.scoreCursor, Math.min(endFrame - this.model.lookahead, endFrame));
      }

      // Bridged holes are unknown audio: mark them as speech so they are never skipped.
      if (chunk.gaps.length) {
        for (const g of chunk.gaps) {
          this.stats.gapSec += g.end - g.start;
          const from = this.frameOf(g.start);
          const to = this.frameOf(g.end);
          if (to > from) this.fillUnknown(from, to);
        }
      }
    }
  }

  scoreRange(fromAbs, toAbsExclusive) {
    if (toAbsExclusive <= fromAbs) return;
    const n = toAbsExclusive - fromAbs;
    const probs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.model.scoreFrame(this.cache, fromAbs + i);
      probs[i] = p === null ? 1 : p;
    }
    this.mergeScores(fromAbs, probs);
    this.scoreCursor = toAbsExclusive;
  }

  /** Fill a frame range with "speech" so nothing there is skipped. */
  fillUnknown(fromAbs, toAbsExclusive) {
    const n = toAbsExclusive - fromAbs;
    if (n <= 0) return;
    const probs = new Float32Array(n);
    probs.fill(1);
    this.mergeScores(fromAbs, probs);
  }

  /**
   * Merge a score run into the retained window.
   *
   * `ScoreWindow` has a fixed capacity covering the whole actionable window
   * (KEEP_BEHIND_SEC behind to PREFETCH_HIGH_SEC ahead), so appending costs
   * O(run length) and memory does not grow with the length of the video.
   */
  mergeScores(absStart, probs) {
    this.scores.merge(absStart, probs);
  }

  updateSkips() {
    if (!this.scores.len) {
      this.skips = [];
      return;
    }
    // Smoothing is at least as long as the largest context offset, so the first
    // `smoothingFrames` frames are still transient. Reuse the scratch buffers:
    // this runs once per pump over the whole retained window.
    const smoothed = smoothScores(this.scores.data, this.smoothingFrames, this.smoothScratch);
    // Only intervals that start after the transient can be acted on; anything
    // earlier is behind the playhead anyway (and `skipAt` ignores it).
    this.skips = buildSkips(smoothed, this.scores.base * this.hopSec, this.hopSec, {
      threshold: this.threshold,
      minSkipSec: this.minSkipSec,
      leadInSec: this.leadInSec,
      leadOutSec: this.leadOutSec,
    });
  }

  /** Apply new skip parameters and recompute from the retained window. */
  setSkipParams({ threshold, minSkipSec, leadInSec, leadOutSec }) {
    if (threshold !== undefined) this.threshold = threshold;
    if (minSkipSec !== undefined) this.minSkipSec = minSkipSec;
    if (leadInSec !== undefined) this.leadInSec = leadInSec;
    if (leadOutSec !== undefined) this.leadOutSec = leadOutSec;
    this.updateSkips();
  }

  /** Abort in-flight work and release the fetch queue. */
  destroy() {
    this.generation++;
    this.aborted = true;
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
    this.track = null;
    this.fetchQueue.clear();
    this.initPromise = null;
    this.hlsInitPromise = null;
  }

  /** Skip interval containing `time` (with a small pre-roll), or null. */
  skipAt(time, preRoll = 0.45) {
    for (const s of this.skips) {
      if (time >= s.start - preRoll && time < s.end) return s;
    }
    return null;
  }

  /** Start of the retained score window (s). */
  get scoreBase() {
    return this.scores.base;
  }

  /** Number of retained score frames. */
  get scoredFrames() {
    return this.scores.len;
  }

  /** Analysed end of the player timeline (s). */
  get analysedUntil() {
    return this.scores.endFrame * this.hopSec;
  }
}

function shortUrl(url) {
  return String(url).slice(0, 80);
}

/** True for the AbortError DOMException that a cancellation produces. */
function isAbort(err) {
  return err?.name === "AbortError" || /aborted/i.test(String(err?.message ?? ""));
}

function concatBuffers(head, body) {
  const h = new Uint8Array(head);
  const b = new Uint8Array(body);
  const out = new Uint8Array(h.byteLength + b.byteLength);
  out.set(h, 0);
  out.set(b, h.byteLength);
  return out.buffer;
}
