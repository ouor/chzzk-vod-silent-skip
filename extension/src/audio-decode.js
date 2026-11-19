// Turn decoded audio segments into one continuous mono PCM stream positioned on
// an absolute timeline.
//
// The invariant downstream code relies on: the PCM this module emits is gapless,
// so feature-stream sample 0 is always at `streamBaseSec` and frame k at
// `streamBaseSec + k * HOP`. Holes are therefore filled with silence, and the
// filled ranges are reported so the analyser can mark them "unknown" (never
// skipped) instead of mistaking them for speech-free audio.

export const TARGET_SR = 16000;

/** Holes up to this long are bridged immediately (segment timing jitter). */
const IMMEDIATE_HOLE_SEC = 1.0;

/**
 * Holes up to this long are the AAC priming padding that `decodeAudioData` does
 * not return (measured 42.6-42.7 ms per DASH segment, see dev/audio-timeline.md).
 * They are real "nothing here" spans rather than unknown audio, so they are
 * bridged as silence and are *not* reported as gaps: reporting them would put a
 * "not skippable" spike every 4 s and chop silence runs into pieces.
 */
const PRIMING_HOLE_SEC = 0.1;

/**
 * Create a context used only for decoding. `decodeAudioData` resamples to the
 * context sample rate, so an offline context at the target rate gives us proper
 * (browser-quality, anti-aliased) resampling without holding an output device
 * open for the whole video, and without needing a user gesture to resume.
 *
 * @param {number} [sampleRate]
 * @returns {AudioContext|OfflineAudioContext}
 */
export function createDecodeContext(sampleRate = TARGET_SR) {
  try {
    return new OfflineAudioContext(1, 1, sampleRate);
  } catch {
    // Very old engines: fall back to a live context and resample by hand.
    try {
      return new AudioContext({ sampleRate });
    } catch {
      return new AudioContext();
    }
  }
}

/**
 * Decode one media file (init segment, or a bare audio elementary stream).
 *
 * @param {BaseAudioContext} ctx
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeSegment(ctx, buf) {
  // decodeAudioData detaches its input, so hand it a copy. It also insists on a
  // real ArrayBuffer: a Uint8Array view (what the TS demuxer produces) throws
  // "parameter 1 is not of type 'ArrayBuffer'" in Chrome.
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return await ctx.decodeAudioData(copy.buffer);
}

/**
 * Collects decoded chunks and yields contiguous mono PCM.
 *
 * Measured behaviour of the Naver audio rendition (see dev/audio-timeline.md):
 * a chunk that starts at nominal track time S decodes to samples whose
 * cross-correlation with the player's muxed audio is a constant
 * `-AUDIO_PRIMING_SEC` shift over the whole chunk; the shift does not grow with
 * the distance into the stream. So each chunk is placed by its own absolute
 * start time, never by accumulating the previous chunk's length.
 */
export class PcmBuilder {
  /**
   * @param {BaseAudioContext|null} ctx
   * @param {number} [sampleRate] output rate
   * @param {object} [opts]
   * @param {number} [opts.maxHoleSec] bridge a hole larger than this with silence
   * @param {number} [opts.maxStallDrains] empty drains tolerated before forcing a bridge
   */
  constructor(ctx, sampleRate = TARGET_SR, opts = {}) {
    this.ctx = ctx;
    this.sampleRate = sampleRate;
    /** @type {{data: Float32Array, start: number}[]} */
    this.pending = [];
    this.nextEmitTime = null;
    this.maxHoleSec = opts.maxHoleSec ?? 8;
    this.maxStallDrains = opts.maxStallDrains ?? 6;
    this.stall = 0;
    this.totalGapSec = 0;
    this.emittedAny = false;
  }

  /**
   * @param {AudioBuffer} audioBuffer decoded chunk
   * @param {number} startSec absolute timeline position of its first sample
   */
  push(audioBuffer, startSec) {
    const mono = downmix(audioBuffer);
    const data = audioBuffer.sampleRate === this.sampleRate
      ? mono
      : resampleLinear(mono, audioBuffer.sampleRate, this.sampleRate);
    this.pending.push({ data, start: startSec });
    this.pending.sort((a, b) => a.start - b.start);
    // The timeline origin is the earliest queued chunk. While nothing has been
    // emitted yet, a chunk that arrives earlier moves the origin back.
    if (this.nextEmitTime === null || !this.emittedAny) {
      this.nextEmitTime = this.pending[0].start;
    }
  }

  /** Absolute timeline position of the next sample that will be emitted. */
  get startTime() {
    return this.nextEmitTime;
  }

  /** True when nothing is waiting to be emitted. */
  get idle() {
    return this.pending.length === 0;
  }

  /**
   * Pop everything contiguous with the already emitted prefix.
   *
   * If the missing part of the timeline never arrives (dropped request, aborted
   * fetch, discontinuity) the builder would otherwise wait forever. After
   * `maxStallDrains` empty attempts, or immediately for holes larger than
   * `maxHoleSec`, the hole is bridged with silence and reported in `gaps`.
   *
   * @returns {{pcm: Float32Array, startTime: number, gaps: {start:number,end:number}[]}|null}
   */
  drain() {
    if (this.nextEmitTime === null || !this.pending.length) {
      if (!this.pending.length) this.stall = 0;
      return null;
    }
    const normal = this.drainOnce(false);
    if (normal) {
      this.stall = 0;
      return normal;
    }
    this.stall++;
    if (this.stall < this.maxStallDrains) return null;
    this.stall = 0;
    return this.drainOnce(true);
  }

  drainOnce(force) {
    const rate = this.sampleRate;
    const parts = [];
    const gaps = [];
    let cursor = this.nextEmitTime;
    let consumed = 0;

    for (let idx = 0; idx < this.pending.length; idx++) {
      const chunk = this.pending[idx];
      const end = chunk.start + chunk.data.length / rate;
      if (end <= cursor + 1e-6) {
        consumed = idx + 1;
        continue;
      }
      const ahead = chunk.start - cursor;
      if (ahead > 0) {
        // Sub-second holes are timing jitter between segments and are bridged at
        // once. Huge holes can never be filled. Anything in between might still
        // arrive, so wait unless the caller has given up (force).
        const bridgeNow = ahead <= IMMEDIATE_HOLE_SEC || ahead > this.maxHoleSec || force;
        if (!bridgeNow) break;
        const gapLen = Math.round(ahead * rate);
        if (gapLen > 0) {
          parts.push(new Float32Array(gapLen));
          // Bridged audio is unknown unless it is the known priming padding:
          // reporting that as a gap would chop every 4 s of silence into two.
          if (ahead > PRIMING_HOLE_SEC) {
            gaps.push({ start: cursor, end: chunk.start });
            this.totalGapSec += gapLen / rate;
          }
        }
        cursor = chunk.start;
      }
      const skip = Math.max(0, Math.round((cursor - chunk.start) * rate));
      if (skip < chunk.data.length) {
        parts.push(skip ? chunk.data.subarray(skip) : chunk.data);
        cursor = chunk.start + chunk.data.length / rate;
      }
      consumed = idx + 1;
    }

    if (!parts.length) {
      if (consumed) this.pending.splice(0, consumed);
      return null;
    }
    this.pending.splice(0, consumed);

    let total = 0;
    for (const p of parts) total += p.length;
    const pcm = new Float32Array(total);
    let off = 0;
    for (const p of parts) {
      pcm.set(p, off);
      off += p.length;
    }
    const startTime = this.nextEmitTime;
    this.nextEmitTime = cursor;
    this.emittedAny = true;
    return { pcm, startTime, gaps };
  }

  reset() {
    this.pending = [];
    this.nextEmitTime = null;
    this.stall = 0;
    this.emittedAny = false;
  }
}

/** Average every channel down to mono. */
export function downmix(audioBuffer) {
  const n = audioBuffer.length;
  const ch = audioBuffer.numberOfChannels;
  if (ch === 1) return audioBuffer.getChannelData(0).slice();
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const src = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += src[i];
  }
  const g = 1 / ch;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/**
 * Linear resampler. Only used by the legacy fallback path, where the decode
 * context could not be created at the target rate. It has no anti-alias filter,
 * so everything above Nyquist folds back into the band the model looks at — see
 * `createDecodeContext` for why this path should not normally be taken.
 */
export function resampleLinear(src, from, to) {
  if (from === to) return src;
  const ratio = from / to;
  const n = Math.floor(src.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const t = x - i0;
    out[i] = src[i0] * (1 - t) + src[i1] * t;
  }
  return out;
}
