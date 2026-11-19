"""Rebuild the training dataset from the drift-free reference audio.

`dev/fetch_regions.py` already places every segment at its absolute player
time, so the whisper labels for those files need no offset correction.
"""
import json
import wave
from pathlib import Path

import numpy as np

import features as F

REF = Path("dev/data/ref")
OUT = Path("dev/data")
PAD_L, PAD_R = 0.10, 0.16

regions = []
for wav in sorted(REF.glob("ref_*.wav")):
    tag = wav.stem[4:]
    if (Path("dev/data/labels") / f"refwords_{tag}.json").exists():
        regions.append(tag)
regions.sort(key=lambda t: int(t.split("_")[0]))
print("regions:", regions)

X_all, y_all, g_all, t_all = [], [], [], []
for gi, tag in enumerate(regions):
    start = int(tag.split("_")[0])
    w = wave.open(str(REF / f"ref_{tag}.wav"))
    x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
    feats = F.extract(x)
    n = feats.shape[0]
    centers = (np.arange(n) * F.HOP + F.WIN / 2) / F.SR + start   # absolute player time
    words = json.loads((Path("dev/data/labels") / f"refwords_{tag}.json").read_text(encoding="utf-8"))
    iv = sorted((w0["start"] + start - PAD_L, w0["end"] + start + PAD_R)
                for w0 in words if w0["w"].strip())
    merged = []
    for a, b in iv:
        if merged and a <= merged[-1][1] + 0.05:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    y = np.zeros(n, dtype=np.float32)
    for a, b in merged:
        y[(centers >= a) & (centers < b)] = 1.0
    X_all.append(feats.astype(np.float32))
    y_all.append(y)
    g_all.append(np.full(n, gi, dtype=np.int16))
    t_all.append(centers)
    print(f"  {tag}: {n} frames speech {y.mean()*100:.1f}%", flush=True)

X = np.concatenate(X_all)
y = np.concatenate(y_all)
g = np.concatenate(g_all)
t = np.concatenate(t_all)
np.savez_compressed(OUT / "dataset_ref.npz", X=X, y=y, g=g, t=t,
                    names=np.array(F.FEATURE_NAMES), regions=np.array(regions))
print("saved", X.shape, "speech", round(float(y.mean()), 4))
