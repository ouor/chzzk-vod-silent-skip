// Verify the JS speech model against numpy's exact output for the same features,
// including the edge behaviour the runtime relies on.
import fs from "node:fs";
import { SpeechModel, FrameCache } from "../extension/src/vad.js";
import { N_FEAT } from "../extension/src/features.js";

const here = new URL("./fixtures/", import.meta.url);
const model = JSON.parse(fs.readFileSync(new URL("../extension/src/model.json", import.meta.url), "utf8"));
const fx = JSON.parse(fs.readFileSync(new URL("features.json", here), "utf8"));
const expected = JSON.parse(fs.readFileSync(new URL("scores.json", here), "utf8"));

const n = fx.nFrames;
const feats = new Float32Array(fx.features.flat());

let fails = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    fails++;
  }
};

const m = new SpeechModel(model);
check("model accepts the shipped file", m.nFeat === N_FEAT);

// Re-implement the same zero-padded context numpy used in dev/make_score_fixture.py:
// rows outside the signal are zeros, i.e. normalised as (0 - mu) / sd.
const pad = m.lookbehind;
const padA = m.lookahead;
const total = pad + n + padA;
const padded = new Float32Array(total * N_FEAT);
padded.set(feats, pad * N_FEAT);

const cacheP = new FrameCache(4096, N_FEAT);
for (let off = 0; off < total; off += 1024) {
  const cnt = Math.min(1024, total - off);
  cacheP.append(padded.subarray(off * N_FEAT), cnt, off);
}
const probs = m.scoreRange(cacheP, pad, n);

let worst = 0, worstAt = -1;
for (let i = 0; i < n; i++) {
  const d = Math.abs(probs[i] - expected.probs[i]);
  if (d > worst) { worst = d; worstAt = i; }
}
console.log(`frames ${n}, worst |js - numpy| = ${worst.toExponential(3)} at frame ${worstAt}`);
check("predictor matches numpy", worst <= 1e-4, worst.toExponential(3));
if (worst > 1e-4) {
  console.log("js ", probs.slice(worstAt - 2, worstAt + 3));
  console.log("np ", expected.probs.slice(worstAt - 2, worstAt + 3));
}

// The runtime calls scoreFrame() directly and treats null as "no decision".
// Outside the retained window it must return null, never a bogus probability.
{
  const cache = new FrameCache(256, N_FEAT);
  const rows = 200;
  cache.append(feats.subarray(0, rows * N_FEAT), rows, 0);
  check("scoreFrame returns null before the retained window", m.scoreFrame(cache, -1000) === null);
  check("scoreFrame returns null past the retained window", m.scoreFrame(cache, rows + padA + 10) === null);
  const mid = m.scoreFrame(cache, Math.floor(rows / 2));
  check("scoreFrame scores a fully covered frame", typeof mid === "number" && mid >= 0 && mid <= 1, String(mid));
  // The last `lookahead` frames of what was appended have no forward context yet.
  check(
    "scoreFrame returns null when the look-ahead is missing",
    m.scoreFrame(cache, rows - 1) === null,
    String(m.scoreFrame(cache, rows - 1)),
  );
}

// A truncated weight row silently produces garbage, so the constructor checks shape.
{
  const bad = structuredClone(model);
  bad.w1[3] = bad.w1[3].slice(0, bad.w1[3].length - 2);
  let threw = false;
  try {
    new SpeechModel(bad);
  } catch {
    threw = true;
  }
  check("model with a short weight row is rejected", threw);
}
{
  const bad = structuredClone(model);
  bad.mu = bad.mu.slice(0, bad.mu.length - 5);
  let threw = false;
  try {
    new SpeechModel(bad);
  } catch {
    threw = true;
  }
  check("model with a short normalisation vector is rejected", threw);
}

console.log(fails ? `\n${fails} FAILURES` : "\nall model tests passed");
process.exitCode = fails ? 1 : 0;
