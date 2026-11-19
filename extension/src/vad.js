// Speech-activity scoring: context window + MLP + temporal smoothing.
//
// The model (model.json) is trained offline by dev/train.py on Whisper-derived
// word-level labels. Nothing here hard-codes an audio level; every decision comes
// from the learned classifier.

import { N_FEAT } from "./features.js";

export class SpeechModel {
  /** @param {object} model parsed model.json */
  constructor(model) {
    this.model = model;
    this.nFeat = model.features.length;
    if (this.nFeat !== N_FEAT) {
      throw new Error(`model expects ${this.nFeat} features, extractor produces ${N_FEAT}`);
    }
    const { w1, b1, w2, b2, w3, b3, mu, sd, contextFrames } = model;
    this.h1 = w1.length;
    this.h2 = w2.length;
    if (b1.length !== this.h1 || w2[0]?.length !== this.h1) throw new Error("model shape mismatch");
    if (b2.length !== this.h2 || w3.length !== this.h2) throw new Error("model shape mismatch");
    this.ctx = contextFrames;
    this.nCtx = contextFrames.length;
    this.din = this.nCtx * this.nFeat;
    // A truncated weight row would yield silent NaN/garbage scores, so verify
    // the full shape before accepting the model.
    const badW1 = w1.some((r) => r.length !== this.din);
    const badW2 = w2.some((r) => r.length !== this.h1);
    if (badW1 || badW2) throw new Error("model weight shape mismatch");
    if (mu.length !== this.din || sd.length !== this.din) throw new Error("model normalisation mismatch");
    this.mu = Float64Array.from(mu);
    this.sd = Float64Array.from(sd);
    this.w1 = w1.map((r) => Float64Array.from(r));
    this.w2 = w2.map((r) => Float64Array.from(r));
    this.w3 = Float64Array.from(w3);
    this.b1 = Float64Array.from(b1);
    this.b2 = Float64Array.from(b2);
    this.b3 = b3;

    this.din = this.nCtx * this.nFeat;
    this.z = new Float64Array(this.din);
    this.h = new Float64Array(this.h1 + this.h2);
  }

  get hopSec() {
    return this.model.hop / this.model.sampleRate;
  }

  /** Largest context offset (frames) the model looks ahead. */
  get lookahead() {
    return Math.max(0, ...this.ctx);
  }

  /** Largest context offset (frames) the model looks behind. */
  get lookbehind() {
    return Math.max(0, -Math.min(0, ...this.ctx));
  }

  /**
   * Score one frame given its neighbour rows.
   *
   * @param {FrameCache} cache frame rows
   * @param {number} absFrame frame index to score
   * @returns {number|null} probability, or null if context is unavailable
   */
  scoreFrame(cache, absFrame) {
    const { ctx, nCtx, nFeat, mu, sd, z, h } = this;
    for (let c = 0; c < nCtx; c++) {
      const off = cache.rowOffset(absFrame + ctx[c]);
      if (off < 0) return null;
      const cb = c * nFeat;
      for (let k = 0; k < nFeat; k++) z[cb + k] = (cache.data[off + k] - mu[cb + k]) / sd[cb + k];
    }
    const { w1, w2, w3, h1, h2, din } = this;
    for (let j = 0; j < h1; j++) {
      const w = w1[j];
      let acc = this.b1[j];
      for (let k = 0; k < din; k++) acc += w[k] * z[k];
      h[j] = acc > 0 ? acc : 0;
    }
    for (let j = 0; j < h2; j++) {
      const w = w2[j];
      let acc = this.b2[j];
      for (let k = 0; k < h1; k++) acc += w[k] * h[k];
      h[h1 + j] = acc > 0 ? acc : 0;
    }
    let logit = this.b3;
    for (let j = 0; j < h2; j++) logit += w3[j] * h[h1 + j];
    return 1 / (1 + Math.exp(-logit));
  }

  /**
   * Score a contiguous absolute frame range that is fully present in `cache`.
   * @returns {Float32Array} probabilities
   */
  scoreRange(cache, firstAbsFrame, n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.scoreFrame(cache, firstAbsFrame + i);
      out[i] = p === null ? NaN : p;
    }
    return out;
  }
}

/**
 * Sliding window of recent frame feature rows, addressed by absolute frame index.
 */
export class FrameCache {
  constructor(capacity = 1024, nFeat = N_FEAT) {
    if ((capacity & (capacity - 1)) !== 0) throw new Error("capacity must be a power of two");
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.nFeat = nFeat;
    this.data = new Float32Array(capacity * nFeat);
    this.next = 0;      // absolute frame index of the next row to write
    this.oldest = 0;    // absolute frame index of the oldest retained row
  }

  append(feats, n, absStart) {
    if (absStart !== this.next) {
      // resynchronise (e.g. a backwards seek rebuilt the analyser)
      this.next = absStart;
      this.oldest = absStart;
    }
    for (let i = 0; i < n; i++) {
      const slot = (absStart + i) & this.mask;
      this.data.set(
        feats.subarray(i * this.nFeat, (i + 1) * this.nFeat),
        slot * this.nFeat,
      );
    }
    this.next = absStart + n;
    this.oldest = Math.max(this.oldest, this.next - this.capacity);
  }

  /** Offset into `data` for an absolute frame, or -1 when not retained. */
  rowOffset(absFrame) {
    if (absFrame < this.oldest || absFrame >= this.next) return -1;
    return (absFrame & this.mask) * this.nFeat;
  }

}

/**
 * Fixed-capacity window of per-frame speech probabilities, addressed by absolute
 * frame index.
 *
 * The analyser appends one small run per decoded chunk and trims the past as the
 * playhead advances, so the cost per chunk stays constant instead of growing with
 * the length of the video.
 */
export class ScoreWindow {
  /** @param {number} capacity frames retained at most */
  constructor(capacity = 54000) {
    this.cap = capacity;
    this.buf = new Float32Array(capacity);
    this.base = 0;      // absolute frame index of buf[0]
    this.len = 0;
  }

  /** Absolute frame index just past the last stored frame. */
  get endFrame() {
    return this.base + this.len;
  }

  /** Retained scores as a view (do not hold on to it across merges). */
  get data() {
    return this.buf.subarray(0, this.len);
  }

  reset() {
    this.len = 0;
  }

  /** Append a run at the current end (or drop the oldest frames to fit). */
  append(absStart, probs) {
    const n = probs.length;
    if (!n) return;
    if (this.len === 0) this.base = absStart;
    if (n > this.cap) {
      // Only the newest `cap` frames can matter.
      const skip = n - this.cap;
      this.base = absStart + skip;
      this.len = 0;
      this.buf.set(probs.subarray(skip), 0);
      this.len = this.cap;
      return;
    }
    const excess = this.len + n - this.cap;
    if (excess > 0) this.dropFront(excess);
    this.buf.set(probs, this.len);
    this.len += n;
  }

  /** Merge a run at an arbitrary absolute position. */
  merge(absStart, probs) {
    const n = probs.length;
    if (!n) return;
    if (this.len === 0) {
      this.append(absStart, probs);
      return;
    }
    const inEnd = absStart + n;
    // Fast path: the run lies inside the window (bridged gaps overwrite scores).
    if (absStart >= this.base && inEnd <= this.endFrame) {
      this.buf.set(probs, absStart - this.base);
      return;
    }
    // Fast path: contiguous append, the normal case.
    if (absStart >= this.endFrame && absStart - this.endFrame + this.len + n <= this.cap) {
      if (absStart > this.endFrame) {
        // Unscored frames must never be skipped, so default them to "speech".
        const gap = absStart - this.endFrame;
        const filler = new Float32Array(gap).fill(1);
        this.append(this.endFrame, filler);
      }
      this.append(absStart, probs);
      return;
    }
    // General (rare) path: rebuild the union.
    let lo = Math.min(this.base, absStart);
    let hi = Math.max(this.endFrame, inEnd);
    if (hi - lo > this.cap) lo = hi - this.cap;
    const out = new Float32Array(hi - lo).fill(1);
    const keepFrom = Math.max(this.base, lo);
    if (this.len && keepFrom < this.endFrame) {
      out.set(this.buf.subarray(keepFrom - this.base, this.len), keepFrom - lo);
    }
    const copyFrom = Math.max(absStart, lo);
    const copyTo = Math.min(inEnd, hi);
    if (copyTo > copyFrom) {
      out.set(probs.subarray(copyFrom - absStart, copyTo - absStart), copyFrom - lo);
    }
    this.buf = out;
    this.base = lo;
    this.len = out.length;
  }

  dropFront(n) {
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
    this.base += n;
  }
}

/** Rolling mean over `k` frames (matches dev/train.py smooth()). */
export function smoothScores(scores, k, scratch = null) {
  const n = scores.length;
  if (k <= 1 || n === 0) return Float32Array.from(scores);
  k = Math.min(k, n);
  const out = scratch?.out?.length === n ? scratch.out : new Float32Array(n);
  const acc = scratch?.acc?.length >= n + 1 ? scratch.acc : new Float64Array(n + 1);
  if (scratch) {
    scratch.out = out;
    scratch.acc = acc;
  }
  acc[0] = 0;
  for (let i = 0; i < n; i++) acc[i + 1] = acc[i] + scores[i];
  const valid = n - k + 1;
  const tmp = scratch?.tmp?.length === valid ? scratch.tmp : new Float32Array(valid);
  if (scratch) scratch.tmp = tmp;
  for (let i = 0; i < valid; i++) tmp[i] = (acc[i + k] - acc[i]) / k;
  const pl = (k - 1) >> 1;
  for (let i = 0; i < pl && i < n; i++) out[i] = tmp[0];
  for (let i = 0; i < valid; i++) out[pl + i] = tmp[i];
  for (let i = pl + valid; i < n; i++) out[i] = tmp[valid - 1];
  return out;
}

/**
 * Turn per-frame speech probabilities into skip intervals.
 *
 * A run of candidate frames `i..j-1` becomes `[tm[i] + leadOut, tm[j-1] - leadIn]`:
 * the interval stays inside the frames that were actually classified as
 * non-speech, so the lead-in/out margins eat into the silence rather than into
 * the surrounding speech. `dev/calibrate.py` calibrates the presets with exactly
 * this boundary convention.
 *
 * @param {Float32Array|number[]} scores smoothed probabilities
 * @param {number} startSec absolute time (s) of scores[0]
 * @param {number} hopSec frame hop in seconds
 * @param {object} cfg
 * @param {number} cfg.threshold below this score a frame is a skip candidate
 * @param {number} cfg.minSkipSec shortest gap worth seeking over
 * @param {number} [cfg.leadInSec] keep this much before speech resumes
 * @param {number} [cfg.leadOutSec] keep this much after speech ends
 * @returns {{start:number,end:number}[]} absolute intervals to skip
 */
export function buildSkips(scores, startSec, hopSec, cfg) {
  const { threshold, minSkipSec, leadInSec = 0, leadOutSec = 0 } = cfg;
  const skips = [];
  let runStart = -1;
  for (let i = 0; i <= scores.length; i++) {
    const silent = i < scores.length && scores[i] < threshold;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      const a = startSec + runStart * hopSec + leadOutSec;
      const b = startSec + (i - 1) * hopSec - leadInSec;
      if (b - a >= minSkipSec) skips.push({ start: a, end: b });
      runStart = -1;
    }
  }
  return skips;
}
