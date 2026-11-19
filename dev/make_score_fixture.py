"""Export a score fixture: features (from the JS-compatible fixture) + the model's
exact outputs, so the JS predictor can be verified against numpy."""
import json
from pathlib import Path

import numpy as np

model = json.load(open("extension/src/model.json"))
fx = json.load(open("test/fixtures/features.json"))

X = np.array(fx["features"], dtype=np.float64)   # (nFrames, NF)
N, NF = X.shape
CTX = model["contextFrames"]
mu = np.array(model["mu"])
sd = np.array(model["sd"])

ctx = np.zeros((N, len(CTX) * NF))
for j, off in enumerate(CTX):
    idx = np.arange(N) + off
    ok = (idx >= 0) & (idx < N)
    ctx[ok, j * NF:(j + 1) * NF] = X[idx[ok]]

# per-chunk VAD-padding: also produce step-by-step predictions for a JS
# "predict incrementally in chunks" test
Xs = (ctx - mu) / sd
w1 = np.array(model["w1"]); b1 = np.array(model["b1"])
w2 = np.array(model["w2"]); b2 = np.array(model["b2"])
w3 = np.array(model["w3"]); b3 = model["b3"]

h1 = np.maximum(0, Xs @ w1.T + b1)
h2 = np.maximum(0, h1 @ w2.T + b2)
logits = h2 @ w3 + b3
probs = 1 / (1 + np.exp(-logits))

Path("test/fixtures/scores.json").write_text(json.dumps({
    "model": "model_v2.json",
    "nFrames": N,
    "probs": np.round(probs, 6).tolist(),
    "logits": np.round(logits, 5).tolist(),
}))
print("wrote test/fixtures/scores.json", probs.shape)
