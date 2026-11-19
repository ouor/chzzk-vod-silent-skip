"""Write a feature fixture (JSON + 16-bit WAV) so the JS port can be checked against Python.

Usage:
  python dev/make_fixture.py --synthetic test/fixtures/features.json   # committed fixture
  python dev/make_fixture.py <in.wav> <out.json>                       # any 16 kHz mono wav

The committed fixture is synthetic on purpose: stream audio is third-party
content and must not be checked in (keep such files under dev/data/).
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np

import features as F

SR = 16000
SECONDS = 24


def synthetic(sr=SR, seconds=SECONDS, seed=7):
    """Deterministic test signal covering what the features react to: near-silence,
    a voice-like harmonic tone (pitch glide, vibrato, 4 Hz syllable envelope),
    broadband noise, a sustained chord and clicks."""
    rng = np.random.default_rng(seed)
    t = np.arange(sr * seconds) / sr
    x = 0.002 * rng.standard_normal(t.size)                     # floor everywhere
    def seg(a, b):
        return (t >= a) & (t < b)
    m = seg(3, 9)                                                # "voiced" part
    f0 = 140 + 40 * np.sin(2 * np.pi * 0.3 * t) + 4 * np.sin(2 * np.pi * 5.5 * t)
    phase = 2 * np.pi * np.cumsum(f0) / sr
    voice = sum(np.sin(k * phase) / k for k in range(1, 12))
    env = 0.5 * (1 - np.cos(2 * np.pi * 4 * t)) ** 2 / 4
    x[m] += 0.25 * voice[m] * env[m]
    m = seg(10, 13)                                              # broadband noise
    x[m] += 0.08 * rng.standard_normal(m.sum())
    m = seg(14, 19)                                              # sustained chord
    x[m] += 0.06 * sum(np.sin(2 * np.pi * f * t[m]) for f in (220, 277.2, 329.6, 440))
    for c in np.arange(20, 23, 0.25):                            # clicks
        i = int(c * sr)
        x[i:i + 40] += 0.4 * np.hanning(40)
    return np.clip(x, -1, 1)


def write_wav(path, x, sr):
    pcm = np.round(np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(2)
        dst.setframerate(sr)
        dst.writeframes(pcm.tobytes())
    return pcm.astype(np.float64) / 32768.0                     # what the JS side reads back


out = Path(sys.argv[2])
if sys.argv[1] == "--synthetic":
    sr = SR
    x = write_wav(out.with_suffix(".wav"), synthetic(), sr)
else:
    w = wave.open(sys.argv[1])
    sr = w.getframerate()
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
    x = write_wav(out.with_suffix(".wav"), x[: sr * SECONDS], sr)   # keep it small: first 24 s

feats = F.extract(x)
Path(out).write_text(json.dumps({
    "sr": sr,
    "nSamples": len(x),
    "nFrames": int(feats.shape[0]),
    "names": F.FEATURE_NAMES,
    "features": np.round(feats, 6).tolist(),
}))
print("wrote", out, feats.shape)
