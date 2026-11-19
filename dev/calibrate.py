"""Held-out calibration of the skip presets.

Train 4 fold models once, keep each fold's out-of-fold scores, then sweep the
skip policy on the held-out regions only. This avoids selecting a threshold on
data the model was trained on.

The sweep must reproduce exactly what `extension/src/vad.js:buildSkips()` does,
otherwise the numbers written into `extension/src/settings.js` describe a
different policy than the one that ships. The boundary convention used here is
therefore the same one: a silent run `i..j-1` becomes
`[tm[i] + leadOut, tm[j] - leadIn]`.

It also exports the held-out scores to dev/data/oof_holdout.bin, so that
`node dev/check_policy.mjs` can replay them through the real vad.js.

Usage: python dev/calibrate.py
"""
import json
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

D = np.load("dev/data/dataset_ref.npz", allow_pickle=True)
X, y, g, t = D["X"], D["y"], D["g"], D["t"]
N, NF = X.shape
speech = y > 0.5
HOP = 0.01
dev = "cuda" if torch.cuda.is_available() else "cpu"

# Same split and initialisation every run, so the checked-in calibration can be
# reproduced (and diffed) instead of depending on how the GPU happened to warm up.
SEED = 0
np.random.seed(SEED)
torch.manual_seed(SEED)
if torch.cuda.is_available():
    torch.cuda.manual_seed_all(SEED)

CTX = [-50, -34, -24, -16, -10, -6, -3, 0, 3, 6, 10, 16, 24, 34, 50]
HIDDEN, SMOOTH, EPOCHS = 48, 15, 20


def build_ctx(X, g, ctx):
    out = np.zeros((N, len(ctx) * NF), dtype=np.float32)
    for j, off in enumerate(ctx):
        idx = np.arange(N) + off
        ok = (idx >= 0) & (idx < N)
        ok &= g[np.clip(idx, 0, N - 1)] == g
        out[ok, j * NF:(j + 1) * NF] = X[idx[ok]]
    return out


Xc = build_ctx(X, g, CTX)
mu, sd = Xc.mean(0), Xc.std(0) + 1e-6
Xs = ((Xc - mu) / sd).astype(np.float32)


class Net(nn.Module):
    def __init__(self, d_in, h=HIDDEN):
        super().__init__()
        self.l1 = nn.Linear(d_in, h)
        self.l2 = nn.Linear(h, h // 2)
        self.l3 = nn.Linear(h // 2, 1)

    def forward(self, x):
        return self.l3(torch.relu(self.l2(torch.relu(self.l1(x))))).squeeze(-1)


regions = sorted(set(g.tolist()))
rng = np.random.default_rng(0)
order = list(rng.permutation(regions))
folds = [order[i::4] for i in range(4)]
print(f"{len(regions)} regions -> folds {[len(f) for f in folds]}")

oof = np.full(N, np.nan, dtype=np.float32)
for k, held in enumerate(folds):
    tr = ~np.isin(g, held)
    te = np.isin(g, held)
    net = Net(Xs.shape[1]).to(dev)
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
    print(f"  fold {k} done", flush=True)

np.savez("dev/data/oof_holdout.npz", scores=oof, y=y, g=g, t=t)


def export_for_node(scores, y, g, t, out="dev/data/oof_holdout"):
    """Same scores as plain little-endian arrays + JSON header, for dev/check_policy.mjs."""
    scores, y = scores.astype(np.float32), (y > 0.5).astype(np.int8)
    g, t = g.astype(np.int16), t.astype(np.float32)
    regions = []
    for reg in sorted(set(g.tolist())):          # the policy runs per region, never across gaps
        idx = np.where(g == reg)[0]
        assert idx[-1] - idx[0] + 1 == len(idx), f"region {reg} is not contiguous"
        regions.append({"id": int(reg), "offset": int(idx[0]), "count": int(len(idx))})
    Path(out + ".bin").write_bytes(scores.tobytes() + y.tobytes() + g.tobytes() + t.tobytes())
    Path(out + "_meta.json").write_text(json.dumps({
        "hopSec": 0.01, "n": int(len(scores)), "regions": regions,
        "scoresOffset": 0, "yOffset": scores.nbytes, "gOffset": scores.nbytes + y.nbytes,
        "tOffset": scores.nbytes + y.nbytes + g.nbytes,
    }, indent=1))


export_for_node(oof, y, g, t)


def smooth_vec(s, k=SMOOTH):
    c = np.cumsum(np.insert(s, 0, 0))
    out = (c[k:] - c[:-k]) / k
    pl, pr = (k - 1) // 2, k - 1 - (k - 1) // 2
    return np.concatenate([np.full(pl, out[0]), out, np.full(pr, out[-1])])[: len(s)]


def plan(reg_scores_by_reg, thr, min_skip, lead_in, lead_out):
    skipped = cut = 0.0
    total_speech = float(speech.sum()) * HOP
    for reg in regions:
        m = np.where(g == reg)[0]
        s = reg_scores_by_reg[reg]
        cand = s < thr
        tm = t[m]
        i = 0
        while i < len(cand):
            if not cand[i]:
                i += 1
                continue
            j = i
            while j < len(cand) and cand[j]:
                j += 1
            a = tm[i] + lead_out
            b = tm[j - 1] - lead_in
            if b - a >= min_skip:
                skipped += b - a
                lo = np.searchsorted(tm, a)
                hi = np.searchsorted(tm, b)
                cut += float(speech[m][lo:hi].sum()) * HOP
            i = j
    return skipped, cut, total_speech


reg_scores = {reg: smooth_vec(oof[g == reg]) for reg in regions}
total_time = N * HOP

rows = []
print("\nthr  minSkip  skipped%  kept%")
for thr in [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]:
    for min_skip in [1.0, 1.5, 2.0, 2.5, 3.0, 3.5]:
        sk, cut, tot = plan(reg_scores, thr, min_skip, 0.30, 0.25)
        kept = 100 - cut / tot * 100
        rows.append({"threshold": thr, "minSkipSec": min_skip, "leadInSec": 0.30, "leadOutSec": 0.25,
                     "skippedPct": round(sk / total_time * 100, 2), "speechKeptPct": round(kept, 2)})
        print(f"  {thr:.2f}   {min_skip:4.1f}s  {sk/total_time*100:7.2f}%  {kept:6.2f}%", flush=True)

Path("dev/data/calibration").mkdir(parents=True, exist_ok=True)
Path("dev/data/calibration/policy_sweep_holdout.json").write_text(json.dumps(rows, indent=1))

sel = {}
# `speechKeptPct` thresholds that the checked-in presets were actually selected
# with. Keep these in sync with dev/data/calibration/presets_holdout.json — a silently
# different number here makes the calibration irreproducible.
for name, min_kept in (("balanced", 98.5), ("aggressive", 95.0), ("maximum", 92.0)):
    ok = [r for r in rows if r["speechKeptPct"] >= min_kept]
    if not ok:
        best = max(rows, key=lambda r: r["speechKeptPct"])
        raise SystemExit(
            f"no sweep row keeps {min_kept}% of speech for '{name}' "
            f"(best measured: {best['speechKeptPct']}% at thr {best['threshold']}, "
            f"minSkip {best['minSkipSec']}s); widen the sweep or relax the threshold"
        )
    sel[name] = max(ok, key=lambda r: r["skippedPct"])

print("\nheld-out presets:")
for k, v in sel.items():
    print(f"  {k}: {v}")
Path("dev/data/calibration/presets_holdout.json").write_text(json.dumps(sel, indent=1))
