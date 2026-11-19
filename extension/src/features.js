// Frame-level acoustic feature extraction.
//
// Faithful JS port of dev/features.py. Both sides must stay numerically
// identical, because the shipped model was trained on the Python output.
// dev/check_features.mjs verifies the port against Python-generated fixtures.
//
// Frame grid: 25 ms window (400 samples), 10 ms hop (160 samples) at 16 kHz.
// Frame f is centred on input sample f*HOP, i.e. it spans
// [f*HOP - 200, f*HOP + 200).

export const SR = 16000;
export const WIN = 400;
export const HOP = 160;
export const NFFT = 512;
export const NMEL = 26;
export const NMFCC = 13;
export const BANDS = [0, 200, 400, 700, 1000, 1500, 2200, 3000, 4000, 5500, 8000];
export const NFREQ = NFFT / 2 + 1;

const BASE_NAMES = [
  "logE", "zcr", "flatness", "centroid", "spread", "rolloff", "flux", "f0sal", "f0hz", "hnr", "crest", "hient",
  ...BANDS.slice(0, -1).map((_, i) => `band${i}`),
  ...Array.from({ length: NMFCC }, (_, i) => `mfcc${i}`),
];
const LONG_NAMES = ["envStd", "envRange", "envSlope", "modE", "voicedFrac", "fluxStd", "centStd", "flatMean"];
const DELTA_NAMES = ["d_logE", "d_flatness", "d_centroid", "d_zcr", "d_hnr", "d_f0sal"];

export const FEATURE_NAMES = [...BASE_NAMES, ...LONG_NAMES, ...DELTA_NAMES];
export const N_FEAT = FEATURE_NAMES.length;

const NB = BASE_NAMES.length; // 43
const IDX = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, i]));

// delta sources, in the order dev/features.py applies them
const DELTA_SRC = ["logE", "flatness", "centroid", "zcr", "hnr", "f0sal"].map((n) => IDX[n]);
const DELTA_OUT = DELTA_NAMES.map((n) => IDX[n]);
const DELTA_K = 10;

// ---------------------------------------------------------------- FFT

const twCache = new Map();
function twiddles(n) {
  let t = twCache.get(n);
  if (t) return t;
  t = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    const a = (-2 * Math.PI * k) / n;
    t[2 * k] = Math.cos(a);
    t[2 * k + 1] = Math.sin(a);
  }
  twCache.set(n, t);
  return t;
}

/** In-place complex FFT (radix-2, forward, unnormalised). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const tw = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const cr = tw[2 * k * step];
        const ci = tw[2 * k * step + 1];
        const a = i + k, b = a + half;
        const ar = re[a], ai = im[a], br = re[b], bi = im[b];
        const tr = br * cr - bi * ci;
        const ti = br * ci + bi * cr;
        re[a] = ar + tr; im[a] = ai + ti;
        re[b] = ar - tr; im[b] = ai - ti;
      }
    }
  }
}

function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

// ---------------------------------------------------------------- tables

const mel = (f) => 2595.0 * Math.log10(1.0 + f / 700.0);
const imel = (m) => 700.0 * (Math.pow(10, m / 2595.0) - 1.0);

function buildMelFb() {
  const pts = NMEL + 2;
  const m0 = mel(60), m1 = mel(7600);
  const bins = new Int32Array(pts);
  for (let i = 0; i < pts; i++) {
    bins[i] = Math.floor(((NFFT + 1) * imel(m0 + ((m1 - m0) * i) / (pts - 1))) / SR);
  }
  const rows = [];
  for (let i = 0; i < NMEL; i++) {
    const row = new Float64Array(NFREQ);
    const l = bins[i], c = bins[i + 1], r = bins[i + 2];
    for (let k = l; k < Math.min(c, NFREQ); k++) row[k] = (k - l) / Math.max(1, c - l);
    for (let k = c; k < Math.min(r, NFREQ); k++) row[k] = (r - k) / Math.max(1, r - c);
    rows.push(row);
  }
  return rows;
}

function buildDct() {
  const rows = [];
  for (let k = 0; k < NMFCC; k++) {
    const row = new Float64Array(NMEL);
    const s = k === 0 ? Math.sqrt(1 / NMEL) : Math.sqrt(2 / NMEL);
    for (let n = 0; n < NMEL; n++) row[n] = s * Math.cos((Math.PI * k * (n + 0.5)) / NMEL);
    rows.push(row);
  }
  return rows;
}

const MELFB = buildMelFb();
const DCTM = buildDct();
const WINDOW = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);
const BIN_HZ = new Float64Array(NFREQ);
for (let i = 0; i < NFREQ; i++) BIN_HZ[i] = (i * SR) / NFFT;

function searchsorted(v) {
  let lo = 0, hi = NFREQ;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BIN_HZ[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const FLAT_LO = searchsorted(100);
const FLAT_HI = searchsorted(7000);
const HF_BIN = searchsorted(4000);
const BAND_BINS = [];
for (let i = 0; i < BANDS.length - 1; i++) {
  const a = searchsorted(BANDS[i]);
  BAND_BINS.push([a, Math.max(a + 1, searchsorted(BANDS[i + 1]))]);
}

const LAG_LO = Math.floor(SR / 400);
const LAG_HI = Math.floor(SR / 70);
const H_LO = Math.floor(SR * 0.0015);
const H_HI = Math.floor(SR * 0.012);

const hannCache = new Map();
/** np.hanning(n): symmetric, endpoints zero. */
function hann(n) {
  let h = hannCache.get(n);
  if (h) return h;
  h = new Float64Array(n);
  if (n === 1) h[0] = 1;
  else for (let i = 0; i < n; i++) h[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  hannCache.set(n, h);
  return h;
}

// ---------------------------------------------------------------- extractor

const RING = 512;      // power of two; holds history (100) + look-ahead (10) + slack
const RING_MASK = RING - 1;

/**
 * Streaming feature extractor.
 *
 * Push mono 16 kHz PCM as it is decoded; pull feature rows as soon as enough
 * look-ahead exists for the 100 ms deltas. Frame indices are absolute and
 * monotonically increasing, so the output can be concatenated across chunks.
 */
export class FeatureStream {
  constructor() {
    this.pcm = new Float32Array(1 << 18);
    this.pcmBase = 0;          // absolute sample index of pcm[0]
    this.pcmLen = 0;

    this.computed = 0;         // next frame index to compute base features for
    this.emitted = 0;          // next frame index to emit

    this.prevMag = new Float64Array(NFREQ);
    this.firstFrame = true;
    this.frameLimit = Infinity;
    this.ringBase = new Float64Array(RING * NB);   // base feature rows
    this.ringEnv = new Float64Array(RING);
    this.ringCent = new Float64Array(RING);
    this.ringFlat = new Float64Array(RING);
    this.ringFlux = new Float64Array(RING);
    this.ringVoiced = new Uint8Array(RING);

    this.re = new Float64Array(NFFT);
    this.im = new Float64Array(NFFT);
    this.mag = new Float64Array(NFREQ);
    this.frame = new Float64Array(WIN);
    this.melE = new Float64Array(NMEL);
    // reused scratch for the 2-8 Hz modulation DFT (was 2 allocations/frame)
    this.modRe = new Float64Array(128);
    this.modIm = new Float64Array(128);
  }

  /** Total samples pushed so far (absolute). */
  get sampleCount() {
    return this.pcmBase + this.pcmLen;
  }

  /** Absolute index of the next frame that will be emitted. */
  get nextFrame() {
    return this.emitted;
  }

  /** Frame index of the last frame fully computable from the pushed samples. */
  framesAvailable() {
    // frame f is centred at f*HOP and spans +-WIN/2; the trailing zero padding
    // in dev/features.py allows the grid to run one frame past the signal
    return 1 + Math.floor(this.sampleCount / HOP);
  }

  push(pcm) {
    if (this.pcmLen + pcm.length > this.pcm.length) {
      let n = this.pcm.length;
      while (n < this.pcmLen + pcm.length) n <<= 1;
      const grown = new Float32Array(n);
      grown.set(this.pcm.subarray(0, this.pcmLen));
      this.pcm = grown;
    }
    this.pcm.set(pcm, this.pcmLen);
    this.pcmLen += pcm.length;
  }

  /** Drop audio that is no longer needed. Keeps the stats window and look-ahead. */
  trim() {
    const keepFrom = (this.emitted - 110) * HOP;
    const drop = keepFrom - this.pcmBase;
    if (drop > 1 << 15) {
      this.pcm.copyWithin(0, drop, this.pcmLen);
      this.pcmLen -= drop;
      this.pcmBase += drop;
    }
  }

  /**
   * Emit every frame that has the required look-ahead.
   * @param {{final?: boolean}} [opts] `final` flushes the tail without look-ahead
   * @returns {Float32Array} row-major features, N_FEAT per frame
   */
  drain(opts = {}) {
    const avail = this.framesAvailable();
    let ready = opts.final ? avail : avail - DELTA_K;
    // A finite `frameLimit` (one-shot extraction) caps the emitted range so
    // `emitted` never claims frames that were not written.
    if (Number.isFinite(this.frameLimit)) ready = Math.min(ready, this.frameLimit + 1);
    if (ready <= this.emitted) return new Float32Array(0);

    const total = ready - this.emitted;
    const out = new Float32Array(total * N_FEAT);
    let done = 0;
    // Work in blocks so the ring buffers always hold both the emitted history
    // and the look-ahead that has been computed but not yet emitted.
    const BLOCK = 32;
    while (this.emitted + done < ready) {
      const target = Math.min(ready, this.emitted + done + BLOCK);
      while (this.computed < target + DELTA_K) this.computeFrame(this.computed);
      for (let f = this.emitted + done; f < target; f++) {
        this.emitFrame(f, out, (f - this.emitted) * N_FEAT);
      }
      done = target - this.emitted;
    }
    this.emitted = ready;
    this.trim();
    return out;
  }

  // -- per-frame base features -------------------------------------------

  computeFrame(f) {
    const centre = f * HOP;
    const base = this.pcmBase;
    const len = this.pcmLen;
    const sample = (i) => {
      const j = i - base;
      return j >= 0 && j < len ? this.pcm[j] : 0;
    };

    let sumSq = 0, peak = 0, zc = 0, mean = 0;
    const half = WIN >> 1;
    for (let i = 0; i < WIN; i++) {
      const v = sample(centre + i - half);
      this.frame[i] = v;
      sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      mean += v;
      if (i > 0 && (v < 0) !== (this.frame[i - 1] < 0)) zc++;
    }
    mean /= WIN;
    const rms = Math.sqrt(sumSq / WIN + 1e-12);
    const logE = 20 * Math.log10(rms + 1e-9);

    const re = this.re, im = this.im, mag = this.mag;
    for (let i = 0; i < WIN; i++) { re[i] = this.frame[i] * WINDOW[i]; im[i] = 0; }
    for (let i = WIN; i < NFFT; i++) { re[i] = 0; im[i] = 0; }
    fft(re, im);
    let psum = 1e-12;
    for (let k = 0; k < NFREQ; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[k] = m;
      psum += m * m;
    }

    let logSum = 0, linSum = 0;
    for (let k = FLAT_LO; k < FLAT_HI; k++) {
      const p = mag[k] * mag[k] + 1e-12;
      logSum += Math.log(p);
      linSum += p;
    }
    const nFlat = FLAT_HI - FLAT_LO;
    const flatness = Math.log(Math.exp(logSum / nFlat) / (linSum / nFlat) + 1e-9);

    let centNum = 0;
    for (let k = 0; k < NFREQ; k++) centNum += mag[k] * mag[k] * BIN_HZ[k];
    const centroid = centNum / psum;
    let spreadNum = 0;
    for (let k = 0; k < NFREQ; k++) {
      const d = BIN_HZ[k] - centroid;
      spreadNum += mag[k] * mag[k] * d * d;
    }
    const spread = Math.sqrt(spreadNum / psum);
    let cum = 0, rollBin = 0;
    const target = 0.85 * psum;
    for (let k = 0; k < NFREQ; k++) {
      cum += mag[k] * mag[k];
      if (cum >= target) { rollBin = k; break; }
    }

    // autocorrelation of the mean-removed frame
    for (let i = 0; i < WIN; i++) { re[i] = this.frame[i] - mean; im[i] = 0; }
    for (let i = WIN; i < NFFT; i++) { re[i] = 0; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < NFFT; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      re[k] = p;
      im[k] = 0;
    }
    ifft(re, im);
    const ac0 = re[0] + 1e-12;
    let bestLag = LAG_LO, bestVal = -Infinity;
    for (let lag = LAG_LO; lag <= LAG_HI; lag++) {
      const v = re[lag] / ac0;
      if (v > bestVal) { bestVal = v; bestLag = lag; }
    }
    const f0sal = Math.min(1, Math.max(-1, bestVal));
    const f0hz = SR / bestLag;
    let hbest = -Infinity;
    for (let lag = H_LO; lag <= H_HI; lag++) {
      const v = re[lag] / ac0;
      if (v > hbest) hbest = v;
    }
    const hnr = Math.min(1, Math.max(-1, hbest));

    let msum = 1e-12;
    for (let k = 0; k < NFREQ; k++) msum += mag[k];
    let flux = 0;
    if (this.firstFrame) {
      // dev/features.py compares the very first frame with itself
      this.firstFrame = false;
      for (let k = 0; k < NFREQ; k++) this.prevMag[k] = mag[k] / msum;
    } else {
      for (let k = 0; k < NFREQ; k++) {
        const cur = mag[k] / msum;
        const d = cur - this.prevMag[k];
        if (d > 0) flux += d;
        this.prevMag[k] = cur;
      }
    }

    const o = (f & RING_MASK) * NB;
    const ring = this.ringBase;
    let b = 0;
    ring[o + b++] = logE;
    ring[o + b++] = zc / (WIN - 1);
    ring[o + b++] = flatness;
    ring[o + b++] = Math.log10(centroid + 1);
    ring[o + b++] = Math.log10(spread + 1);
    ring[o + b++] = Math.log10(BIN_HZ[rollBin] + 1);
    ring[o + b++] = flux;
    ring[o + b++] = f0sal;
    ring[o + b++] = Math.log10(f0hz);
    ring[o + b++] = hnr;
    ring[o + b++] = 20 * Math.log10(peak / (rms + 1e-9) + 1e-9);
    let hfSum = 0;
    for (let k = HF_BIN; k < NFREQ; k++) hfSum += mag[k] * mag[k];
    ring[o + b++] = hfSum / psum;
    for (let i = 0; i < BAND_BINS.length; i++) {
      const a = BAND_BINS[i][0], z = BAND_BINS[i][1];
      let s = 0;
      for (let k = a; k < z; k++) s += mag[k] * mag[k];
      ring[o + b++] = 10 * Math.log10(s / (z - a) + 1e-12);
    }
    for (let i = 0; i < NMEL; i++) {
      const row = MELFB[i];
      let s = 0;
      for (let k = 0; k < NFREQ; k++) s += mag[k] * mag[k] * row[k];
      this.melE[i] = Math.log10(s + 1e-10);
    }
    for (let c = 0; c < NMFCC; c++) {
      const row = DCTM[c];
      let s = 0;
      for (let i = 0; i < NMEL; i++) s += this.melE[i] * row[i];
      ring[o + b++] = s;
    }

    const r = f & RING_MASK;
    this.ringEnv[r] = logE;
    this.ringCent[r] = Math.log10(centroid + 1);
    this.ringFlat[r] = flatness;
    this.ringFlux[r] = flux;
    this.ringVoiced[r] = f0sal > 0.45 && hnr > 0.35 ? 1 : 0;

    this.computed = f + 1;
  }

  // -- per-frame long-window features + deltas ---------------------------

  emitFrame(f, out, o) {
    const b = (f & RING_MASK) * NB;
    const ring = this.ringBase;
    for (let i = 0; i < NB; i++) out[o + i] = ring[b + i];

    const L = 100;
    const a0 = Math.max(0, f - L + 1);
    const cnt = f - a0 + 1;
    const env = this.ringEnv, cent = this.ringCent, fl = this.ringFlat;
    const flx = this.ringFlux, voi = this.ringVoiced;

    let envSum = 0;
    for (let i = a0; i <= f; i++) envSum += env[i & RING_MASK];
    const envMean = envSum / cnt;
    let vsum = 0, envMin = Infinity, envMax = -Infinity;
    for (let i = a0; i <= f; i++) {
      const e = env[i & RING_MASK];
      const d = e - envMean;
      vsum += d * d;
      if (e < envMin) envMin = e;
      if (e > envMax) envMax = e;
    }
    out[o + IDX.envStd] = Math.sqrt(vsum / cnt);
    out[o + IDX.envRange] = envMax - envMin;

    let envSlope = 0;
    if (cnt >= 20) {
      const xm = (cnt - 1) / 2;
      let denom = 0, num = 0;
      for (let i = 0; i < cnt; i++) {
        const dx = i - xm;
        denom += dx * dx;
        num += dx * (env[(a0 + i) & RING_MASK] - envMean);
      }
      envSlope = (num / (denom + 1e-12) / cnt) * 100.0;
    }
    out[o + IDX.envSlope] = envSlope;

    let vf = 0, fMean = 0, cMean = 0, flMean = 0;
    for (let i = a0; i <= f; i++) {
      const k = i & RING_MASK;
      vf += voi[k];
      fMean += flx[k];
      cMean += cent[k];
      flMean += fl[k];
    }
    out[o + IDX.voicedFrac] = vf / cnt;
    fMean /= cnt; cMean /= cnt; flMean /= cnt;
    out[o + IDX.flatMean] = flMean;

    let fVar = 0, cVar = 0;
    for (let i = a0; i <= f; i++) {
      const k = i & RING_MASK;
      const d = flx[k] - fMean;
      fVar += d * d;
      const e = cent[k] - cMean;
      cVar += e * e;
    }
    out[o + IDX.fluxStd] = Math.sqrt(fVar / cnt);
    out[o + IDX.centStd] = Math.sqrt(cVar / cnt);

    let modE = 0;
    if (cnt >= 50) {
      const N = 128;
      const rr = this.modRe;
      const ii = this.modIm;
      rr.fill(0);
      ii.fill(0);
      const w = hann(cnt);
      for (let i = 0; i < cnt; i++) rr[i] = (env[(a0 + i) & RING_MASK] - envMean) * w[i];
      fft(rr, ii);
      let sp = 1e-12, lo = 0;
      for (let k = 0; k <= N / 2; k++) {
        const p = rr[k] * rr[k] + ii[k] * ii[k];
        sp += p;
        const fk = (k * 100.0) / 128.0;
        if (fk >= 2.0 && fk < 8.0) lo += p;
      }
      modE = lo / sp;
    }
    out[o + IDX.modE] = modE;

    for (let c = 0; c < DELTA_SRC.length; c++) {
      const fwdFrame = Math.min(f + DELTA_K, this.frameLimit);
      const bwdFrame = Math.max(f - DELTA_K, 0);
      const fwd = fwdFrame & RING_MASK;
      const bwd = bwdFrame & RING_MASK;
      out[o + DELTA_OUT[c]] =
        (ring[fwd * NB + DELTA_SRC[c]] - ring[bwd * NB + DELTA_SRC[c]]) / (2 * DELTA_K);
    }
  }
}

/** One-shot convenience wrapper (matches dev/features.py on a whole signal). */
export function extractAll(pcm) {
  const fs = new FeatureStream();
  fs.push(pcm);
  fs.push(new Float32Array(DELTA_K * HOP * 2 + WIN));
  const frames = Math.floor(pcm.length / HOP) + 1;
  fs.frameLimit = frames - 1;
  const out = new Float32Array(frames * N_FEAT);
  let cursor = 0;
  for (;;) {
    const chunk = fs.drain();
    if (!chunk.length) break;
    const n = chunk.length / N_FEAT;
    const take = Math.min(n, frames - cursor);
    out.set(chunk.subarray(0, take * N_FEAT), cursor * N_FEAT);
    cursor += take;
    if (cursor >= frames) break;
  }
  return { data: out, nFrames: frames };
}
