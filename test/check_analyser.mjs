// Tests for the PcmBuilder timeline guarantees and the skip-policy boundaries.
//
// These cover the two failure modes that were previously silent:
//   * a hole in the timeline that never gets filled stalls the stream forever
//   * a reset during an in-flight decode corrupts the window
import { PcmBuilder } from "../extension/src/audio-decode.js";
import { smoothScores, buildSkips, FrameCache, SpeechModel, ScoreWindow } from "../extension/src/vad.js";

let fails = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    fails++;
  }
}

const RATE = 16000;

/** Fake AudioBuffer filled with a constant value. */
function fakeBuffer(value, seconds, rate = RATE) {
  const length = Math.round(seconds * rate);
  return {
    sampleRate: rate,
    length,
    numberOfChannels: 1,
    duration: seconds,
    getChannelData() {
      const a = new Float32Array(length);
      a.fill(value);
      return a;
    },
  };
}

// ------------------------------------------------------------------ baseline
{
  const b = new PcmBuilder(null, RATE);
  b.push(fakeBuffer(0.5, 1), 10);
  b.push(fakeBuffer(0.25, 1), 11);
  const out = b.drain();
  check("contiguous chunks concatenate", out && out.pcm.length === 2 * RATE, String(out?.pcm.length));
  check("contiguous start kept", out.startTime === 10);
  check("no gaps reported", out.gaps.length === 0);
}

// --------------------------------------------------------------- small hole
{
  const b = new PcmBuilder(null, RATE);
  b.push(fakeBuffer(0.5, 1), 10);
  b.push(fakeBuffer(0.25, 1), 11.2);   // 200 ms hole
  const out = b.drain();
  check("small hole is padded with silence", out.pcm.length === Math.round(2.2 * RATE), String(out.pcm.length));
  check("small hole is reported", out.gaps.length === 1, JSON.stringify(out.gaps));
  check("hole reported at the right time", Math.abs(out.gaps[0].start - 11) < 1e-6 && Math.abs(out.gaps[0].end - 11.2) < 1e-6);
}

// --------------------------------------------------- priming-sized hole
{
  // decodeAudioData drops the AAC priming from each DASH chunk, so consecutive
  // segments leave a ~42.7 ms hole. That is padding, not unknown audio: it must
  // be bridged silently (no gap reported) or every 4 s of silence is split in
  // two and stops being skippable.
  const b = new PcmBuilder(null, RATE);
  b.push(fakeBuffer(0.5, 3.968), 10);
  b.push(fakeBuffer(0.25, 3.947), 10 + 3.968 + 0.0427);
  const out = b.drain();
  check("priming hole is padded", Math.abs(out.pcm.length / RATE - (3.968 + 0.0427 + 3.947)) < 0.01, String(out.pcm.length / RATE));
  check("priming hole is not reported as unknown audio", out.gaps.length === 0, JSON.stringify(out.gaps));
  check("priming hole does not inflate totalGapSec", Math.abs(b.totalGapSec) < 1e-9, String(b.totalGapSec));

  // A real gap (dropped segment) is still reported.
  const c = new PcmBuilder(null, RATE);
  c.push(fakeBuffer(0.5, 1), 10);
  c.push(fakeBuffer(0.25, 1), 11.5);
  const o2 = c.drain();
  check("a dropped-segment gap is still reported", o2.gaps.length === 1 && Math.abs(o2.gaps[0].start - 11) < 1e-6, JSON.stringify(o2.gaps));
}

// -------------------------------------------------------------- large hole
{
  const b = new PcmBuilder(null, RATE, { maxHoleSec: 5 });
  b.push(fakeBuffer(0.5, 1), 10);
  b.push(fakeBuffer(0.25, 1), 20);     // 9 s hole
  const out = b.drain();
  check("large hole bridges instead of stalling", !!out);
  check("large hole padded to full length", out.pcm.length === Math.round(11 * RATE), String(out.pcm.length));
  check("large hole reported", out.gaps.length === 1 && Math.abs(out.gaps[0].end - 20) < 1e-6);
  check("totalGapSec accumulates", Math.abs(b.totalGapSec - 9) < 0.01, String(b.totalGapSec));
}

// ------------------------------------------------------- permanent stall fix
{
  // The old implementation returned null forever once a hole existed. The
  // builder must emit the prefix it has, and eventually bridge the hole.
  const b = new PcmBuilder(null, RATE, { maxHoleSec: 100, maxStallDrains: 3 });
  b.push(fakeBuffer(0.5, 1), 10);
  b.push(fakeBuffer(0.25, 1), 30);     // 19 s hole, below maxHoleSec
  const first = b.drain();
  check("drain emits the available prefix", first && first.pcm.length === RATE, String(first?.pcm.length));
  check("prefix has no gap", first && first.gaps.length === 0);
  let forced = null;
  for (let i = 0; i < 10 && !forced; i++) forced = b.drain();
  check("builder recovers after the stall threshold", !!forced, String(forced));
  check("recovered output bridges the hole", forced && forced.pcm.length > 19 * RATE, String(forced?.pcm.length));
  check("bridged hole is reported", forced && forced.gaps.length === 1);
}

// ------------------------------------------------------------------ overlap
{
  const b = new PcmBuilder(null, RATE);
  b.push(fakeBuffer(0.5, 1), 10);
  b.push(fakeBuffer(0.25, 1), 10.5);   // 500 ms overlap
  const out = b.drain();
  check("overlap is trimmed, not summed", out.pcm.length === Math.round(1.5 * RATE), String(out.pcm.length));
  check("no gap for an overlap", out.gaps.length === 0);
}

// ------------------------------------------------------- out of order push
{
  const b = new PcmBuilder(null, RATE);
  b.push(fakeBuffer(0.25, 1), 11);
  b.push(fakeBuffer(0.5, 1), 10);
  const out = b.drain();
  check("out-of-order chunks emit in timeline order", out.startTime === 10 && out.pcm.length === 2 * RATE);
  check("first sample belongs to the earlier chunk", Math.abs(out.pcm[0] - 0.5) < 1e-6);
}

// ------------------------------------------------------------ idempotent nil
{
  const b = new PcmBuilder(null, RATE);
  check("empty builder returns null", b.drain() === null);
  b.push(fakeBuffer(0.5, 1), 10);
  b.drain();
  check("drained builder returns null", b.drain() === null);
  check("builder reports idle", b.idle === true);
}

// -------------------------------------------------------- smoothScores edge
{
  check("smooth of empty is empty", smoothScores(new Float32Array(0), 15).length === 0);
  const one = smoothScores(new Float32Array([0.5]), 15);
  check("smooth of single frame is itself", one.length === 1 && Math.abs(one[0] - 0.5) < 1e-6);
  const flat = smoothScores(new Float32Array(100).fill(0.4), 15);
  check("smooth preserves a flat signal", Math.abs(flat[50] - 0.4) < 1e-6);
}

// ------------------------------------------------------ buildSkips boundary
{
  const hop = 0.01;
  // A run of frames 50..150 inclusive is 101 candidate frames. The interval is
  // [start + leadOut, lastFrame - leadIn], so with no margins it spans exactly
  // 150 hops: this is the calibration convention in dev/calibrate.py.
  const s = new Float32Array(300).fill(1);
  for (let i = 50; i <= 150; i++) s[i] = 0;
  const exact = buildSkips(s, 0, hop, { threshold: 0.5, minSkipSec: 1.0, leadInSec: 0, leadOutSec: 0 });
  check("a gap exactly at minSkipSec is kept", exact.length === 1 && Math.abs(exact[0].end - exact[0].start - 1.0) < 1e-6, JSON.stringify(exact));
  const longer = buildSkips(s, 0, hop, { threshold: 0.5, minSkipSec: 1.01, leadInSec: 0, leadOutSec: 0 });
  check("a gap shorter than minSkipSec is dropped", longer.length === 0, JSON.stringify(longer));
  // One candidate frame is one hop; 100 frames span 99 hops, so it must be rejected.
  const shrunk = new Float32Array(300).fill(1);
  for (let i = 50; i < 150; i++) shrunk[i] = 0;
  const near = buildSkips(shrunk, 0, hop, { threshold: 0.5, minSkipSec: 1.0, leadInSec: 0, leadOutSec: 0 });
  check("100 candidate frames span 0.99s and are dropped", near.length === 0, JSON.stringify(near));

  const lead = buildSkips(s, 0, hop, { threshold: 0.5, minSkipSec: 0.5, leadInSec: 0.1, leadOutSec: 0.05 });
  check("lead margins eat into the silence, not the speech", lead.length === 1
    && Math.abs(lead[0].start - 0.55) < 1e-6
    && Math.abs(lead[0].end - 1.40) < 1e-6, JSON.stringify(lead));

  // A run that reaches the end of the buffer still closes at its last frame.
  const tail = new Float32Array(200).fill(1);
  for (let i = 150; i < 200; i++) tail[i] = 0;
  const t2 = buildSkips(tail, 0, hop, { threshold: 0.5, minSkipSec: 0.4, leadInSec: 0, leadOutSec: 0 });
  check("a trailing run closes at its last frame", t2.length === 1 && Math.abs(t2[0].end - 1.99) < 1e-6, JSON.stringify(t2));
}

// ----------------------------------------------------------- FrameCache trim
{
  const cache = new FrameCache(8, 2);
  for (let i = 0; i < 20; i++) cache.append(Float32Array.from([i, i]), 1, i);
  check("cache keeps the newest rows", cache.rowOffset(19) >= 0);
  check("cache drops rows older than capacity", cache.rowOffset(10) < 0, String(cache.oldest));
}

// ------------------------------------------------------------ ScoreWindow
{
  const w = new ScoreWindow(100);
  w.merge(10, Float32Array.from({ length: 20 }, (_, i) => i / 20));
  check("score window stores a run at its absolute position", w.base === 10 && w.len === 20 && w.endFrame === 30);
  check("score window reads back the values", Math.abs(w.data[5] - 5 / 20) < 1e-6);

  // Contiguous appends are the normal path and must not reallocate.
  const bufRef = w.buf;
  w.merge(30, Float32Array.from({ length: 30 }, () => 0.5));
  check("contiguous append reuses the buffer", w.buf === bufRef, "reallocated");
  check("contiguous append extends the window", w.base === 10 && w.len === 50 && w.endFrame === 60);

  // A gap between runs must default to "speech" (1) rather than 0: unscored
  // frames must never be skipped.
  w.merge(70, Float32Array.from({ length: 10 }, () => 0.1));
  check("a gap is filled with speech, not silence", w.data[50] === 1 && w.data[59] === 1, String(w.data[50]));
  check("the appended run lands after the gap", Math.abs(w.data[60] - 0.1) < 1e-6);

  // Capacity is respected by dropping the oldest frames.
  const small = new ScoreWindow(20);
  small.merge(0, new Float32Array(15).fill(0.25));
  small.merge(15, new Float32Array(15).fill(0.75));
  check("score window honours its capacity", small.len === 20, String(small.len));
  check("score window keeps the newest frames", small.endFrame === 30 && small.base === 10);
  check("retained values are the newest ones", Math.abs(small.data[19] - 0.75) < 1e-6);

  // Overwriting an existing range (a bridged gap) updates in place.
  const o = new ScoreWindow(50);
  o.merge(0, new Float32Array(20).fill(0.9));
  o.merge(5, new Float32Array(5).fill(0.1));
  check("overlapping merge overwrites in place", o.len === 20 && Math.abs(o.data[7] - 0.1) < 1e-6 && Math.abs(o.data[3] - 0.9) < 1e-6);
}

// ------------------------------------------------------ smoothScores scratch
{
  const f = new Float32Array(50).fill(0.5);
  const scratch = {};
  const a = smoothScores(f, 15, scratch);
  const b = smoothScores(f, 15, scratch);
  check("scratch buffers are reused", a.buffer === b.buffer, "reallocated");
  check("scratch result is still correct", Math.abs(a[25] - 0.5) < 1e-6);
}

// --------------------------------------------------- model shape validation
{
  const bad = {
    features: new Array(49).fill("f"),
    contextFrames: [0],
    mu: new Float64Array(49),
    sd: new Float64Array(49),
    w1: [new Float64Array(10)],     // wrong width for a 49-feature input
    b1: new Float64Array(1),
    w2: [new Float64Array(1)],
    b2: new Float64Array(1),
    w3: new Float64Array(1),
    b3: 0,
    hop: 160,
    sampleRate: 16000,
  };
  let threw = false;
  try {
    new SpeechModel(bad);
  } catch {
    threw = true;
  }
  check("model with a truncated w1 row is rejected", threw);
}

// ------------------------------------------- pump recovers from a window reset
// Regression: pump() used to capture the generation token *before* it called
// resetWindow() for a playhead that had left the window. The reset bumped the
// token, the pump then bailed on its own token check, and every following tick
// reset again — "running" forever with coverage stuck at 0.
{
  const fs = await import("node:fs");
  const model = JSON.parse(fs.readFileSync(new URL("../extension/src/model.json", import.meta.url), "utf8"));
  const { Analyser } = await import("../extension/src/analyser.js");

  const SEG = 4;
  const segments = Array.from({ length: 2000 }, (_, i) => ({
    start: i * SEG, duration: SEG, range: [0, 1], url: `seg${i}.m4a`,
  }));
  const track = {
    kind: "dash", baseUrl: "https://example.invalid/x.m4a", initRange: null,
    segments, timescale: 48000, primingSec: 0,
  };

  // decodeAudioData only has to return an AudioBuffer-shaped object.
  const fakeCtx = {
    sampleRate: RATE,
    async decodeAudioData() {
      const length = SEG * RATE;
      return {
        sampleRate: RATE, length, numberOfChannels: 1, duration: SEG,
        getChannelData() { return new Float32Array(length); },
      };
    },
  };

  const errors = [];
  const a = new Analyser({ ctx: fakeCtx, model });
  a.onError = (e) => errors.push(String(e?.message || e));
  a.track = track;
  a.resetWindow(0);
  a.fetchSegment = async () => ({ bytes: new ArrayBuffer(8), pts: null });

  // A zero budget still performs one fetch batch and one decode per call, which
  // is enough to make progress without extracting minutes of features.
  for (let i = 0; i < 6; i++) await a.pump(0, 0);
  check("pump decodes at the window origin", a.analysedUntil > 0, String(a.analysedUntil));
  check("pump reports no error", errors.length === 0, errors.join("; "));

  // The playhead leaps past the decoded window: exactly one reset, and the same
  // pump must then do real work. (With the stale token it returned right after
  // the reset, so coverage stayed 0 and every following tick reset again once
  // the playhead had drifted 5 s past the window start.)
  await a.pump(3000, 0);
  check("a far playhead re-anchors the window once", a.debug.resets === 1, String(a.debug.resets));
  check("the window moved to the playhead", a.scoreBase * a.hopSec >= 2990, String(a.scoreBase * a.hopSec));
  check("the resetting pump itself decodes", a.analysedUntil > 3000, String(a.analysedUntil));

  // Nobody else touches the analyser: let the playhead advance the way playback
  // does and require coverage to keep up.
  let last = a.analysedUntil;
  for (let t = 3001; t < 3012; t++) {
    await a.pump(t, 0);
    check(`coverage advances at playhead ${t}`, a.analysedUntil >= last, `${last} -> ${a.analysedUntil}`);
    check(`no extra reset at playhead ${t}`, a.debug.resets === 1, String(a.debug.resets));
    last = a.analysedUntil;
  }
  check("no error was reported across the reset", errors.length === 0, errors.join("; "));
}

// ------------------------------------- a failed init segment does not poison decode
// Regression: the init segment's promise was memoised once. If the first fetch
// was aborted by a seek (or failed), the rejected promise stayed cached, every
// later segment was built from it, and decodeAudioData failed for the rest of
// the session ("Unable to decode audio data", coverage stuck at 0).
{
  const fs = await import("node:fs");
  const model = JSON.parse(fs.readFileSync(new URL("../extension/src/model.json", import.meta.url), "utf8"));
  const { Analyser } = await import("../extension/src/analyser.js");

  const SEG = 4;
  const segments = Array.from({ length: 40 }, (_, i) => ({
    start: i * SEG, duration: SEG, range: [1000 + i * 10, 1009 + i * 10], url: null,
  }));
  const a = new Analyser({ ctx: { sampleRate: RATE }, model });
  a.track = {
    kind: "dash", baseUrl: "https://example.invalid/x.m4a", initRange: [0, 99],
    segments, timescale: 48000, primingSec: 0,
  };

  let initAttempts = 0;
  a.fetchBytes = async (url, range) => {
    if (range && range[0] === 0) {
      initAttempts++;
      if (initAttempts === 1) throw new Error("HTTP 403 for init");
      return new ArrayBuffer(range[1] - range[0] + 1);
    }
    return new ArrayBuffer(range[1] - range[0] + 1);
  };

  let first = null;
  try {
    await a.fetchSegment(0);
  } catch (e) {
    first = e;
  }
  check("a failing init segment surfaces as an error", !!first, String(first));
  check("the init promise was dropped after the failure", a.initPromise === null);

  // The next attempt must go out again and succeed.
  const ok = (await a.fetchSegment(0)).bytes;
  check("the next segment refetches the init and succeeds", ok.byteLength === 100 + 10, String(ok?.byteLength));
  check("init was fetched twice", initAttempts === 2, String(initAttempts));

  // A failed *media* segment must not invalidate the init segment.
  const before = a.initPromise;
  a.fetchBytes = async (url, range) => {
    if (range && range[0] === 0) return new ArrayBuffer(100);   // init
    throw new Error("HTTP 500 for media");
  };
  let mediaErr = null;
  try {
    await a.fetchSegment(1);
  } catch (e) {
    mediaErr = e;
  }
  check("a failing media segment surfaces as an error", !!mediaErr, String(mediaErr));
  check("the init promise survives a media failure", a.initPromise === before);
}

// ------------------------------------- every transport returns { bytes, pts }
// Regression: the HLS branch returned a bare ArrayBuffer, so decodeAhead read
// `queued.bytes` as undefined and every HLS segment failed to decode silently.
{
  const fs = await import("node:fs");
  const model = JSON.parse(fs.readFileSync(new URL("../extension/src/model.json", import.meta.url), "utf8"));
  const { Analyser } = await import("../extension/src/analyser.js");
  const a = new Analyser({ ctx: { sampleRate: RATE }, model });
  a.track = {
    kind: "hls", baseUrl: "https://example.invalid/c.m3u8", initUri: "https://example.invalid/init.m4s",
    segments: [{ start: 0, duration: 2, uri: "https://example.invalid/0.m4s" }], duration: 2,
  };
  a.fetchBytes = async (url) => new ArrayBuffer(url.endsWith("init.m4s") ? 10 : 20);
  const r = await a.fetchSegment(0);
  check("hls segment is { bytes, pts }", r?.bytes instanceof ArrayBuffer && r.bytes.byteLength === 30, String(r?.bytes?.byteLength));

  // An expired token must reach onError instead of being abandoned as a hole.
  const errors = [];
  a.onError = (e) => errors.push(String(e?.message || e));
  a.resetWindow(0);
  a.fetchSegment = async () => { throw new Error("HTTP 403 for seg"); };
  await a.pump(0, 0);
  check("a 403 is reported via onError", errors.length === 1 && errors[0].includes("403"), errors.join("; "));
}

console.log(fails ? `\n${fails} FAILURES` : "\nall analyser tests passed");
process.exitCode = fails ? 1 : 0;
