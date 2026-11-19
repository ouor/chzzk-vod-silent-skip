// Does the *shipped* skip policy reproduce the calibrated preset numbers?
//
// dev/calibrate.py sweeps the skip policy in Python on held-out scores and the
// chosen numbers are copied into PRESETS (extension/src/settings.js). That is only
// valid if the Python sweep matches vad.js exactly (a 10 ms boundary difference
// once moved the "maximum" preset by 0.17 points). This runs the real
// smoothScores() + buildSkips() over the same held-out scores and compares.
//
// Usage: python dev/calibrate.py   (once; writes dev/data/oof_holdout.bin)
//        node dev/check_policy.mjs
import fs from "node:fs";

import { smoothScores, buildSkips } from "../extension/src/vad.js";
import { PRESETS } from "../extension/src/settings.js";

const META = "dev/data/oof_holdout_meta.json";
const BIN = "dev/data/oof_holdout.bin";
const TOLERANCE = 0.15;   // percentage points
const SMOOTHING = 15;     // frames, as the shipped model

if (!fs.existsSync(META) || !fs.existsSync(BIN)) {
  console.error(`missing ${BIN}: run \`python dev/calibrate.py\` first`);
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(META, "utf8"));
const raw = fs.readFileSync(BIN);
const scores = new Float32Array(raw.buffer, raw.byteOffset + meta.scoresOffset, meta.n);
const y = new Int8Array(raw.buffer, raw.byteOffset + meta.yOffset, meta.n);
const t = new Float32Array(raw.buffer, raw.byteOffset + meta.tOffset, meta.n);
const HOP = meta.hopSec;
const totalTime = meta.n * HOP;
const totalSpeech = y.reduce((a, v) => a + v, 0) * HOP;

/** Skipped share of runtime and kept share of speech, policy applied per region. */
function evaluate(cfg) {
  let skipped = 0;
  let cut = 0;
  for (const r of meta.regions) {
    const regionStart = t[r.offset];
    const smoothed = smoothScores(scores.subarray(r.offset, r.offset + r.count), SMOOTHING);
    for (const s of buildSkips(smoothed, regionStart, HOP, cfg)) {
      skipped += s.end - s.start;
      const lo = Math.max(0, Math.ceil((s.start - regionStart) / HOP));
      const hi = Math.min(r.count, Math.ceil((s.end - regionStart) / HOP));
      for (let i = lo; i < hi; i++) cut += y[r.offset + i] > 0 ? HOP : 0;
    }
  }
  return { skippedPct: (skipped / totalTime) * 100, speechKeptPct: 100 - (cut / totalSpeech) * 100 };
}

let fail = 0;
console.log("preset        skipped%  (stored)    kept%  (stored)");
for (const [id, p] of Object.entries(PRESETS)) {
  const { threshold, minSkipSec, leadInSec, leadOutSec } = p;
  const got = evaluate({ threshold, minSkipSec, leadInSec, leadOutSec });
  const ok = Math.abs(got.skippedPct - p.measured.skippedPct) < TOLERANCE
    && Math.abs(got.speechKeptPct - p.measured.speechKeptPct) < TOLERANCE;
  if (!ok) fail++;
  console.log(
    `${id.padEnd(12)} ${got.skippedPct.toFixed(2).padStart(7)}%  (${p.measured.skippedPct.toFixed(2).padStart(6)}%)  ` +
    `${got.speechKeptPct.toFixed(2).padStart(6)}%  (${p.measured.speechKeptPct.toFixed(2).padStart(6)}%)  ${ok ? "ok" : "MISMATCH"}`,
  );
}
console.log(fail ? `\n${fail} preset(s) do not reproduce the calibration` : "\nall presets reproduce the calibration");
process.exitCode = fail ? 1 : 0;
