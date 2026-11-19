"""Extended feature set v2: adds MFCCs, formant-ish LPC features and long-window envelope stats.

Frame grid: 25 ms window / 10 ms hop @ 16 kHz.
The JS port must reproduce this bit-for-bit in the same order.
"""
import numpy as np

SR = 16000
WIN = 400
HOP = 160
NFFT = 512
NMEL = 26
NMFCC = 13
BANDS = [0, 200, 400, 700, 1000, 1500, 2200, 3000, 4000, 5500, 8000]
CTX_SEC = 0.5


def _mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def _imel(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def _mel_fb():
    m = np.linspace(_mel(60.0), _mel(7600.0), NMEL + 2)
    hz = _imel(m)
    bins = np.floor((NFFT + 1) * hz / SR).astype(int)
    fb = np.zeros((NMEL, NFFT // 2 + 1))
    for i in range(NMEL):
        l, c, r = int(bins[i]), int(bins[i + 1]), int(bins[i + 2])
        for k in range(l, min(c, NFFT // 2 + 1)):
            fb[i, k] = (k - l) / max(1, c - l)
        for k in range(c, min(r, NFFT // 2 + 1)):
            fb[i, k] = (r - k) / max(1, r - c)
    return fb


def _dct_matrix(n_out, n_in):
    # orthonormal DCT-II
    D = np.zeros((n_out, n_in))
    for k in range(n_out):
        s = np.sqrt(1.0 / n_in) if k == 0 else np.sqrt(2.0 / n_in)
        for n in range(n_in):
            D[k, n] = s * np.cos(np.pi * k * (n + 0.5) / n_in)
    return D


MELFB = _mel_fb()
DCT = _dct_matrix(NMFCC, NMEL)
WINDOW = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(WIN) / WIN)
BIN_HZ = np.arange(NFFT // 2 + 1) * SR / NFFT

BASE_NAMES = (
    ["logE", "zcr", "flatness", "centroid", "spread", "rolloff", "flux", "f0sal", "f0hz", "hnr", "crest", "hient"]
    + [f"band{i}" for i in range(len(BANDS) - 1)]
)
MFCC_NAMES = [f"mfcc{i}" for i in range(NMFCC)]
LONG_NAMES = ["envStd", "envRange", "envSlope", "modE", "voicedFrac", "fluxStd", "centStd", "flatMean"]
DELTA_NAMES = ["d_logE", "d_flatness", "d_centroid", "d_zcr", "d_hnr", "d_f0sal"]
FEATURE_NAMES = BASE_NAMES + MFCC_NAMES + LONG_NAMES + DELTA_NAMES


def frames_of(x):
    pad = WIN // 2
    xp = np.concatenate([np.zeros(pad), np.asarray(x, dtype=np.float64), np.zeros(pad + WIN)])
    n = 1 + (len(x) // HOP)
    idx = np.arange(n)[:, None] * HOP + np.arange(WIN)[None, :]
    return xp[idx]


def extract(x):
    x = np.asarray(x, dtype=np.float64)
    F = frames_of(x)
    n = F.shape[0]

    spec = np.fft.rfft(F * WINDOW[None, :], n=NFFT, axis=1)
    mag = np.abs(spec)
    power = mag * mag
    psum = power.sum(axis=1) + 1e-12

    rms = np.sqrt(np.mean(F * F, axis=1) + 1e-12)
    logE = 20 * np.log10(rms + 1e-9)

    zcr = np.mean(np.signbit(F[:, 1:]) != np.signbit(F[:, :-1]), axis=1)

    lo = int(np.searchsorted(BIN_HZ, 100))
    hi = int(np.searchsorted(BIN_HZ, 7000))
    p = power[:, lo:hi] + 1e-12
    flatness = np.log(np.exp(np.mean(np.log(p), axis=1)) / np.mean(p, axis=1) + 1e-9)

    centroid = (power * BIN_HZ[None, :]).sum(axis=1) / psum
    spread = np.sqrt((power * (BIN_HZ[None, :] - centroid[:, None]) ** 2).sum(axis=1) / psum)
    cum = np.cumsum(power, axis=1)
    roll = np.argmax(cum >= 0.85 * cum[:, -1:], axis=1)
    rolloff = BIN_HZ[roll]

    magn = mag / (mag.sum(axis=1, keepdims=True) + 1e-12)
    flux = np.maximum(magn - np.vstack([magn[:1], magn[:-1]]), 0).sum(axis=1)

    f = F - F.mean(axis=1, keepdims=True)
    s2 = np.fft.rfft(f, n=NFFT, axis=1)
    ac = np.fft.irfft(s2 * np.conj(s2), n=NFFT, axis=1)[:, :WIN]
    acn = ac / (ac[:, 0] + 1e-12)[:, None]
    lag_lo, lag_hi = int(SR / 400), int(SR / 70)
    seg = acn[:, lag_lo:lag_hi + 1]
    best = np.argmax(seg, axis=1)
    f0sal = np.clip(seg[np.arange(len(seg)), best], -1, 1)
    f0hz = SR / (best + lag_lo)
    h_lo, h_hi = int(SR * 0.0015), int(SR * 0.012)
    hnr = np.clip(acn[:, h_lo:h_hi + 1].max(axis=1), -1, 1)

    crest = 20 * np.log10(np.abs(F).max(axis=1) / (rms + 1e-9) + 1e-9)
    hf = int(np.searchsorted(BIN_HZ, 4000))
    hient = power[:, hf:].sum(axis=1) / psum

    band_e = []
    for i in range(len(BANDS) - 1):
        a = int(np.searchsorted(BIN_HZ, BANDS[i]))
        b = max(a + 1, int(np.searchsorted(BIN_HZ, BANDS[i + 1])))
        band_e.append(10 * np.log10(power[:, a:b].mean(axis=1) + 1e-12))
    band_e = np.stack(band_e, axis=1)

    melE = np.log10(power @ MELFB.T + 1e-10)
    mfcc = melE @ DCT.T

    base = np.column_stack([
        logE, zcr, flatness, np.log10(centroid + 1), np.log10(spread + 1),
        np.log10(rolloff + 1), flux, f0sal, np.log10(f0hz), hnr, crest, hient,
        band_e, mfcc,
    ])

    # long-window (1 s) statistics on the dB envelope / voicing
    L = 100
    envStd = np.empty(n)
    envRange = np.empty(n)
    envSlope = np.empty(n)
    modE = np.empty(n)
    voicedFrac = np.empty(n)
    fluxStd = np.empty(n)
    centStd = np.empty(n)
    flatMean = np.empty(n)
    voiced = (f0sal > 0.45) & (hnr > 0.35)
    lcent = np.log10(centroid + 1)
    for i in range(n):
        a = max(0, i - L + 1)
        e = logE[a:i + 1]
        envStd[i] = e.std()
        envRange[i] = e.max() - e.min()
        if len(e) >= 20:
            xs = np.arange(len(e), dtype=np.float64)
            xm = xs.mean()
            denom = ((xs - xm) ** 2).sum() + 1e-12
            envSlope[i] = ((xs - xm) * (e - e.mean())).sum() / denom / len(e) * 100.0
        else:
            envSlope[i] = 0.0
        voicedFrac[i] = voiced[a:i + 1].mean()
        fluxStd[i] = flux[a:i + 1].std()
        centStd[i] = lcent[a:i + 1].std()
        flatMean[i] = flatness[a:i + 1].mean()
        if len(e) >= 50:
            d = e - e.mean()
            w = np.hanning(len(d))
            sp = np.abs(np.fft.rfft(d * w, n=128)) ** 2
            fr = np.arange(len(sp)) * (100.0 / 128.0)
            mask = (fr >= 2.0) & (fr < 8.0)
            modE[i] = sp[mask].sum() / (sp.sum() + 1e-12)
        else:
            modE[i] = 0.0

    longf = np.column_stack([envStd, envRange, envSlope, modE, voicedFrac, fluxStd, centStd, flatMean])

    feats = np.column_stack([base, longf])

    k = 10
    def delta(m):
        fwd = np.vstack([m[k:], np.repeat(m[-1:], k, axis=0)])
        bwd = np.vstack([np.repeat(m[:1], k, axis=0), m[:-k]])
        return (fwd - bwd) / (2 * k)
    d = delta(feats[:, [0, 2, 3, 1, 9, 7]])
    return np.column_stack([feats, d])


if __name__ == "__main__":
    import wave, sys
    w = wave.open(sys.argv[1])
    xx = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
    out = extract(xx)
    print(out.shape, len(FEATURE_NAMES))
    print(FEATURE_NAMES)
    print("finite:", np.isfinite(out).all())
