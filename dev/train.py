"""Train the speech-activity classifier on the v2 feature set and export it for the extension.

Usage: python dev/train.py [dataset.npz] [epochs]
"""
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

CACHE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("dev/data/dataset_ref.npz")
EPOCHS = int(sys.argv[2]) if len(sys.argv) > 2 else 20
CONTEXT = [-50, -34, -24, -16, -10, -6, -3, 0, 3, 6, 10, 16, 24, 34, 50]
HIDDEN = 48
MIN_SKIP = 3.5
SMOOTH = 15

D = np.load(CACHE, allow_pickle=True)
X, y, g, t = D["X"], D["y"], D["g"], D["t"]
names = [str(n) for n in D["names"]]
N, NF = X.shape
dev = "cuda" if torch.cuda.is_available() else "cpu"
print(f"frames {N} feats {NF} regions {len(set(g.tolist()))} speech {y.mean():.3f}")


def build_ctx(X, g, ctx):
    out = np.zeros((N, len(ctx) * NF), dtype=np.float32)
    for j, off in enumerate(ctx):
        idx = np.arange(N) + off
        ok = (idx >= 0) & (idx < N)
        ok &= g[np.clip(idx, 0, N - 1)] == g
        out[ok, j * NF:(j + 1) * NF] = X[idx[ok]]
    return out


Xc = build_ctx(X, g, CONTEXT)
mu, sd = Xc.mean(0), Xc.std(0) + 1e-6
Xs = ((Xc - mu) / sd).astype(np.float32)
DIN = Xs.shape[1]
print("input dim", DIN)


class Net(nn.Module):
    def __init__(self, d_in, h=HIDDEN):
        super().__init__()
        self.l1 = nn.Linear(d_in, h)
        self.l2 = nn.Linear(h, h // 2)
        self.l3 = nn.Linear(h // 2, 1)

    def forward(self, x):
        return self.l3(torch.relu(self.l2(torch.relu(self.l1(x))))).squeeze(-1)


def auc(scores, labels):
    order = np.argsort(scores)
    ranks = np.empty(len(scores))
    ranks[order] = np.arange(1, len(scores) + 1)
    npos = labels.sum()
    nneg = len(labels) - npos
    return float((ranks[labels == 1].sum() - npos * (npos + 1) / 2) / (npos * nneg))


def smooth(s, k=SMOOTH):
    k = min(k, len(s))
    c = np.cumsum(np.insert(s, 0, 0))
    out = (c[k:] - c[:-k]) / k
    pl, pr = (k - 1) // 2, k - 1 - (k - 1) // 2
    return np.concatenate([np.full(pl, out[0]), out, np.full(pr, out[-1])])[: len(s)]


def skip_plan(scores, g, thr, min_skip=MIN_SKIP):
    stay = np.ones(len(scores), dtype=bool)
    for reg in np.unique(g):
        m = np.where(g == reg)[0]
        cand = scores[m] < thr
        tm = t[m]
        i = 0
        while i < len(cand):
            if cand[i]:
                j = i
                while j < len(cand) and cand[j]:
                    j += 1
                if tm[j - 1] - tm[i] >= min_skip:
                    stay[m[i:j]] = False
                i = j
            else:
                i += 1
    return stay


def evaluate(stay, y, g):
    return {
        "speech_kept": float((stay & (y > 0.5)).sum() / max(1, (y > 0.5).sum())),
        "skipped_frac": float((~stay).sum() / len(stay)),
        "speech_cut_sec": float((~stay & (y > 0.5)).sum() * 0.01),
    }


regions = sorted(set(g.tolist()))
oof = np.zeros(N, dtype=np.float32)
fold_auc = []
for held in regions:
    tr, te = g != held, g == held
    net = Net(DIN).to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5)
    pw = torch.tensor(float((y[tr] == 0).sum() / max(1, (y[tr] == 1).sum()))).to(dev)
    lf = nn.BCEWithLogitsLoss(pos_weight=pw)
    Xt = torch.tensor(Xs[tr], device=dev)
    yt = torch.tensor(y[tr], device=dev)
    for ep in range(EPOCHS):
        perm = torch.randperm(len(Xt), device=dev)
        for i in range(0, len(perm), 4096):
            b = perm[i:i + 4096]
            opt.zero_grad()
            lf(net(Xt[b]), yt[b]).backward()
            opt.step()
    with torch.no_grad():
        oof[te] = torch.sigmoid(net(torch.tensor(Xs[te], device=dev))).cpu().numpy()
    fold_auc.append(auc(oof[te], y[te]))
    print(f"held {held}: AUC {fold_auc[-1]:.4f}", flush=True)

print(f"mean frame AUC {np.mean(fold_auc):.4f}")
so = smooth(oof)
print(f"smoothed OOF AUC {auc(so, y):.4f}")

# choose the operating point: keep >= 99% of speech, then maximise skipped time
rows = []
for thr in np.arange(0.15, 0.95, 0.025):
    stay = skip_plan(so, g, thr)
    r = evaluate(stay, y, g)
    rows.append((float(thr), r))
    print(f"  thr {thr:.2f}  kept {r['speech_kept']*100:6.2f}%  skip {r['skipped_frac']*100:6.2f}%  cut {r['speech_cut_sec']:7.1f}s")

good = [(th, r) for th, r in rows if r["speech_kept"] >= 0.99]
best = max(good, key=lambda x: x[1]["skipped_frac"]) if good else rows[0]
print("operating point:", best)

# final model on all data
net = Net(DIN).to(dev)
opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5)
pw = float((y == 0).sum() / max(1, (y == 1).sum()))
lf = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(pw).to(dev))
Xt = torch.tensor(Xs, device=dev)
yt = torch.tensor(y, device=dev)
for ep in range(EPOCHS + 6):
    perm = torch.randperm(len(Xt), device=dev)
    for i in range(0, len(perm), 4096):
        b = perm[i:i + 4096]
        opt.zero_grad()
        lf(net(Xt[b]), yt[b]).backward()
        opt.step()

def r6(v):
    return float(f"{v:.7g}")


model = {
    "version": 2,
    "sampleRate": 16000,
    "win": 400,
    "hop": 160,
    "nfft": 512,
    "nmel": 26,
    "nmfcc": 13,
    "bands": [0, 200, 400, 700, 1000, 1500, 2200, 3000, 4000, 5500, 8000],
    "features": names,
    "contextFrames": CONTEXT,
    "inputDim": DIN,
    "mu": [r6(v) for v in mu.tolist()],
    "sd": [r6(v) for v in sd.tolist()],
    "w1": [[r6(v) for v in row] for row in net.l1.weight.detach().cpu().numpy().tolist()],
    "b1": [r6(v) for v in net.l1.bias.detach().cpu().numpy().tolist()],
    "w2": [[r6(v) for v in row] for row in net.l2.weight.detach().cpu().numpy().tolist()],
    "b2": [r6(v) for v in net.l2.bias.detach().cpu().numpy().tolist()],
    "w3": [r6(v) for v in net.l3.weight.detach().cpu().numpy().reshape(-1).tolist()],
    "b3": r6(float(net.l3.bias.detach().cpu().numpy()[0])),
    "smoothingFrames": SMOOTH,
    "minSkipSec": MIN_SKIP,
    "threshold": float(best[0]),
    "cvFoldAuc": fold_auc,
    "cvMeanAuc": float(np.mean(fold_auc)),
    "operatingPoint": best[1],
}
Path("dev/data/model_v2.json").write_text(json.dumps(model))
np.savez("dev/data/oof_v2.npz", scores=so, y=y, g=g, t=t)

# scores from the final full-data model, so the JS port can be verified exactly
with torch.no_grad():
    outs = []
    for i in range(0, len(Xt), 8192):
        outs.append(torch.sigmoid(net(Xt[i:i + 8192])).cpu().numpy())
    final = np.concatenate(outs)
np.savez("dev/data/final_scores.npz", scores=final, y=y, g=g, t=t)
print("wrote dev/data/model_v2.json")
