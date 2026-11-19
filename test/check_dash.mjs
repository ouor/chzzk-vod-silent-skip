// Unit tests for the DASH plumbing (manifest parsing + timeline placement).
import { parseAudioTrack, expandTimeline, AUDIO_PRIMING_SEC } from "../extension/src/dash.js";
import { PcmBuilder } from "../extension/src/audio-decode.js";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    failures++;
  }
}

// ---------------------------------------------------------------- timeline
{
  const segs = expandTimeline([{ S: [{ "@t": "0", "@d": 4000, "@r": 2 }, { "@t": "12000", "@d": 2000 }] }], 1000);
  check("expandTimeline expands @r", segs.length === 4, JSON.stringify(segs));
  check("expandTimeline times", segs.map((s) => s.start).join() === "0,4,8,12", segs.map((s) => s.start).join());
  check("expandTimeline durations", segs.map((s) => s.duration).join() === "4,4,4,2");
}

// ---------------------------------------------------------------- manifest
{
  const playback = {
    MPD: [{
      Period: [{
        AdaptationSet: [
          {
            "@mimeType": "video/mp2t",
            Representation: [{ "@id": "v1", BaseURL: ["https://cdn/v/"], SegmentTemplate: [{ "@media": "v-$Number$.ts" }] }],
          },
          {
            "@mimeType": "audio/mp4",
            Representation: [{
              BaseURL: ["https://cdn/a/track.m4a?token=abc"],
              SegmentList: [{
                "@timescale": 48000,
                Initialization: [{ "@range": "0-94702" }],
                SegmentTimeline: [{ S: [{ "@d": 192512 }, { "@d": 191488 }] }],
                SegmentURL: [{ "@mediaRange": "94703-160930" }, { "@mediaRange": "160931-225645" }],
              }],
            }],
          },
        ],
      }],
    }],
  };

  const track = parseAudioTrack(playback);
  check("picks the audio-only rendition", track && track.baseUrl === "https://cdn/a/track.m4a?token=abc");
  check("init range parsed", JSON.stringify(track.initRange) === "[0,94702]");
  check("segment count", track.segments.length === 2, String(track.segments.length));
  check("first segment range", JSON.stringify(track.segments[0].range) === "[94703,160930]");
  check("second segment start", Math.abs(track.segments[1].start - 4.010666) < 1e-5, String(track.segments[1].start));

  const noAudio = parseAudioTrack({ MPD: [{ Period: [{ AdaptationSet: [{ "@mimeType": "video/mp2t", Representation: [] }] }] }] });
  check("returns null without an audio rendition", noAudio === null);
}

// ---------------------------------------------------------------- pcm builder
{
  // fake AudioBuffer objects: 1 s of samples at 16 kHz, tagged by value
  const make = (value, seconds, rate = 16000) => ({
    sampleRate: rate,
    length: Math.round(seconds * rate),
    numberOfChannels: 1,
    duration: seconds,
    getChannelData() {
      const a = new Float32Array(this.length);
      a.fill(value);
      return a;
    },
  });

  const b = new PcmBuilder(null, 16000);
  b.push(make(0.5, 1.0), 10.0);
  b.push(make(0.25, 1.0), 11.0);
  const out = b.drain();
  check("drain returns a chunk", !!out);
  check("chunk covers both parts", out.pcm.length === 32000, String(out.pcm.length));
  check("chunk start", out.startTime === 10.0);
  check("values stay in order", out.pcm[0] === 0.5 && out.pcm[31999] === 0.25);

  const b2 = new PcmBuilder(null, 16000);
  b2.push(make(0.5, 1.0), 10.0);
  b2.push(make(0.25, 1.0), 12.0);       // 1 s hole at 11
  const out2 = b2.drain();
  check("short hole is bridged in one drain", out2 && out2.pcm.length === 48000, String(out2?.pcm.length));
  check("hole filled with zeros", out2.pcm[16000] === 0 && out2.pcm[31999] === 0);
  check("second part placed by its own start", out2.pcm[32000] === 0.25);
  check("bridged hole is reported for the analyser", out2.gaps.length === 1, JSON.stringify(out2.gaps));

  const b3 = new PcmBuilder(null, 16000);
  b3.push(make(0.5, 1.0), 10.0);
  b3.push(make(0.25, 1.0), 10.5);       // overlap
  const out3 = b3.drain();
  check("overlap does not duplicate", out3.pcm.length === 24000, String(out3.pcm.length));
}

// ---------------------------------------------------------------- priming
check("priming constant", Math.abs(AUDIO_PRIMING_SEC - 2048 / 48000) < 1e-12);

console.log(failures ? `\n${failures} FAILURES` : "\nall dash tests passed");
process.exitCode = failures ? 1 : 0;
