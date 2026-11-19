// Tests for the MPEG-TS demuxer and the SegmentTemplate/muxed manifest paths.
import { demuxMpegTsAudio, looksLikeMpegTs, readPts, encodePts } from "../extension/src/mpegts.js";
import { parseAudioTrack, fillTemplate, expandTimeline } from "../extension/src/dash.js";

let fails = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    fails++;
  }
}
const eq = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ------------------------------------------------------------ PTS decoding
{
  // Verified against ffprobe: the first audio PES of a real CHZZK TS segment has this
  // header and starts at 1.157333 s -> 104160 ticks at 90 kHz.
  check("PTS of a real PES header", readPts(Uint8Array.from([0x21, 0x00, 0x07, 0x2d, 0xc1]), 0) === 104160,
    String(readPts(Uint8Array.from([0x21, 0x00, 0x07, 0x2d, 0xc1]), 0)));

  // Round-trip every value around the int32 and 33-bit boundaries: a PTS beyond
  // 2^31 ticks (~6 h 38 min at 90 kHz) is inside a normal VOD, and bitwise
  // operators silently made it negative.
  const boundaries = [0, 1, 90, 0x7fffffff, 0x80000000, 0xffffffff, 0x100000000, 0x1ffffffff];
  let roundTripOk = true;
  for (const ticks of boundaries) {
    const got = readPts(encodePts(ticks), 0);
    if (got !== ticks) {
      roundTripOk = false;
      console.log(`     round-trip ${ticks} -> ${got}`);
    }
  }
  check("PTS round-trips across the 32/33-bit boundary", roundTripOk);
  check("PTS uses all 33 bits", readPts(encodePts(0x1ffffffff), 0) === 0x1ffffffff);
  // 8 h at 90 kHz is the case that mattered.
  const eightHours = 8 * 3600 * 90000;
  check("PTS of an 8 hour stream is positive", readPts(encodePts(eightHours), 0) === eightHours,
    String(readPts(encodePts(eightHours), 0)));
}

// ------------------------------------------------------------ template fill
{
  check(
    "Number padding",
    fillTemplate("$RepresentationID$-$Number%06d$.ts", "abc", 7, 0) === "abc-000007.ts",
    fillTemplate("$RepresentationID$-$Number%06d$.ts", "abc", 7, 0),
  );
  check("Number without padding", fillTemplate("seg-$Number$.ts", "r", 42, 0) === "seg-42.ts");
  check("Time substitution", fillTemplate("t$Time$.m4s", "r", 0, 96000) === "t96000.m4s");
  check("literal dollar survives", fillTemplate("a$$b$Number$", "r", 1, 0) === "a$b1");
  check("unknown placeholder is untouched", fillTemplate("$Foo$-$Number$", "r", 5, 0) === "$Foo$-5");
}

// ---------------------------------------------------- muxed TS manifest shape
{
  // The shape actually served for video/13166636 (abridged).
  const playback = {
    MPD: [{
      "@mediaPresentationDuration": "PT6H52M48.813S",
      Period: [{
        "@duration": "PT6H52M48.813S",
        AdaptationSet: [{
          "@mimeType": "video/mp2t",
          Representation: [
            { "@id": "hi", "@bandwidth": "8197000", "@codecs": "avc1.64002a,mp4a.40.2",
              BaseURL: ["https://cdn.example/hls/"],
              SegmentTemplate: [{ "@timescale": "1000", "@startNumber": "0",
                "@media": "$RepresentationID$-$Number%06d$.ts",
                SegmentTimeline: [{ S: [{ "@t": "0", "@d": "4000", "@r": "2" }] }] }] },
            { "@id": "lo", "@bandwidth": "170000", "@codecs": "avc1.4dc00c,mp4a.40.2",
              BaseURL: ["https://cdn.example/hls/"],
              SegmentTemplate: [{ "@timescale": "1000", "@startNumber": "0",
                "@media": "$RepresentationID$-$Number%06d$.ts",
                SegmentTimeline: [{ S: [{ "@t": "0", "@d": "4000", "@r": "2" }] }] }] },
          ],
        }],
      }],
    }],
  };

  const track = parseAudioTrack(playback);
  check("muxed TS manifest yields a track", !!track);
  check("muxed track is marked muxed", track?.muxed === true);
  check("kind identifies the TS path", track?.kind === "dash-ts", String(track?.kind));
  check("cheapest representation is chosen", track?.bandwidth === 170000, String(track?.bandwidth));
  check("no init segment for TS", track?.initRange === null);
  check("no priming offset for TS", track?.primingSec === 0);
  check("timeline expanded with @r", track?.segments.length === 3, String(track?.segments.length));
  check("segment urls are filled in", track?.segments[1].url === "https://cdn.example/hls/lo-000001.ts", String(track?.segments[1].url));
  check("segment starts follow the timeline", eq(track?.segments[2].start ?? -1, 8), String(track?.segments[2].start));
  check("segment durations follow the timeline", eq(track?.segments[1].duration ?? -1, 4), String(track?.segments[1].duration));
}

// ------------------------------------------------------------ robustness
{
  check("empty input is rejected", demuxMpegTsAudio(new Uint8Array(0)).ok === false);
  check("random bytes are rejected", demuxMpegTsAudio(new Uint8Array([1, 2, 3, 4])).ok === false);
  const notTs = new Uint8Array(376);   // right size, wrong sync
  check("non-TS input is rejected", demuxMpegTsAudio(notTs).ok === false);
  check("looksLikeMpegTs is false for junk", looksLikeMpegTs(notTs) === false);
}

// ------------------------------------------------ separate-audio still wins
{
  const playback = {
    MPD: [{ Period: [{
      AdaptationSet: [
        { "@mimeType": "audio/mp4", Representation: [{
          "@id": "a", BaseURL: ["https://cdn.example/a.m4a"],
          SegmentList: [{ "@timescale": "48000", Initialization: [{ "@range": "0-99" }],
            SegmentTimeline: [{ S: [{ "@d": "192000", "@r": "1" }] }],
            SegmentURL: [{ "@mediaRange": "100-999" }, { "@mediaRange": "1000-1999" }] }] }] },
        { "@mimeType": "video/mp2t", Representation: [{
          "@id": "v", "@bandwidth": "1", "@codecs": "avc1,mp4a.40.2",
          BaseURL: ["https://cdn.example/hls/"],
          SegmentTemplate: [{ "@timescale": "1000", "@media": "$RepresentationID$-$Number$.ts",
            SegmentTimeline: [{ S: [{ "@d": "4000" }] }] }] }] },
      ],
    }] }],
  };
  const track = parseAudioTrack(playback);
  check("a dedicated audio rendition is preferred", track?.kind === "dash" && track?.muxed !== true, String(track?.kind));
  check("audio rendition keeps its priming offset", eq(track?.primingSec ?? 0, 2048 / 48000));
}

console.log(fails ? `\n${fails} FAILURES` : "\nall mpegts tests passed");
process.exitCode = fails ? 1 : 0;
