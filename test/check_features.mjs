// Verify the JS feature extractor against the Python fixture.
// Usage: node test/check_features.mjs
import fs from "node:fs";
import { extractAll, FEATURE_NAMES, HOP } from "../extension/src/features.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/features.json", import.meta.url), "utf8"));

// WAV decode (16-bit PCM mono)
const raw = fs.readFileSync(new URL("./fixtures/features.wav", import.meta.url));
let off = 12;
let dataOff = 0, dataLen = 0;
while (off < raw.length) {
  const id = raw.toString("ascii", off, off + 4);
  const size = raw.readUInt32LE(off + 4);
  if (id === "data") { dataOff = off + 8; dataLen = size; break; }
  off += 8 + size + (size & 1);
}
const n = Math.min(dataLen / 2, fx.nSamples);
const pcm = new Float64Array(n);
for (let i = 0; i < n; i++) pcm[i] = raw.readInt16LE(dataOff + i * 2) / 32768;

const { data, nFrames } = extractAll(pcm);

let fails = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    fails++;
  }
};

// A frame count difference shifts every later row, so it is a hard failure and
// not just a printed note.
check("frame count matches python", nFrames === fx.nFrames, `js ${nFrames} py ${fx.nFrames}`);
check("hop matches the model", HOP === 160, String(HOP));
const rows = Math.min(nFrames, fx.nFrames);

let worst = 0, worstAt = "", total = 0, count = 0;
const perCol = new Float64Array(FEATURE_NAMES.length);
const perColMax = new Float64Array(FEATURE_NAMES.length);
for (let f = 0; f < rows; f++) {
  for (let c = 0; c < FEATURE_NAMES.length; c++) {
    const a = data[f * FEATURE_NAMES.length + c];
    const b = fx.features[f][c];
    const d = Math.abs(a - b);
    perCol[c] += d;
    if (d > perColMax[c]) perColMax[c] = d;
    total += d;
    count++;
    if (d > worst) { worst = d; worstAt = `frame ${f} ${FEATURE_NAMES[c]} js=${a} py=${b}`; }
  }
}

console.log(`frames: js ${nFrames} py ${fx.nFrames}`);
console.log(`rows compared ${rows}, mean abs diff ${(total / count).toExponential(3)}, worst ${worst.toExponential(3)}`);
console.log("worst:", worstAt);
const bad = FEATURE_NAMES.map((nm, i) => [nm, perColMax[i], perCol[i] / rows])
  .filter((x) => x[1] > 1e-3)
  .sort((a, b) => b[1] - a[1]);
check("every column within 1e-3", bad.length === 0, bad.map((b) => b[0]).join(","));
if (bad.length) {
  console.log("columns over 1e-3 (name, max, mean):");
  for (const [nm, mx, mn] of bad) console.log(`  ${nm.padEnd(12)} ${mx.toExponential(2)}  ${mn.toExponential(2)}`);
}

check("no NaN or Infinity in the output", data.every((v) => Number.isFinite(v)));

const byName = Object.fromEntries(FEATURE_NAMES.map((nm, i) => [nm, i]));
for (const nm of ["logE", "zcr", "flatness", "centroid", "flux", "f0sal", "hnr", "mfcc1", "envStd", "modE", "d_logE"]) {
  const i = byName[nm];
  console.log(`  ${nm.padEnd(10)} max ${perColMax[i].toExponential(2)}  mean ${(perCol[i] / rows).toExponential(2)}`);
}

console.log(fails ? `\n${fails} FAILURES` : "\nall feature tests passed");
process.exitCode = fails ? 1 : 0;
