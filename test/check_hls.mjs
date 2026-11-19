// Unit tests for the HLS plumbing (master/media parsing).
import { parseMasterPlaylist, parseMediaPlaylist, cheapestVariant } from "../extension/src/hls.js";

let fails = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name} ${extra}`);
    fails++;
  }
};

const BASE = "https://cdn.example.com/vod/hash/vod_playlist.m3u8";
const MEDIA = "https://cdn.example.com/vod/hash/hdntl=x/1080p/vod_chunklist.m3u8";

const master = `#EXTM3U
#EXT-X-VERSION:7

#EXT-X-STREAM-INF:BANDWIDTH=3192000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720
hdntl=x/720p/vod_chunklist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="avc1.4D000C,mp4a.40.2",RESOLUTION=256x144
hdntl=x/144p/vod_chunklist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8384000,RESOLUTION=1920x1080
hdntl=x/1080p/vod_chunklist.m3u8
`;
const variants = parseMasterPlaylist(master, BASE);
check("variant count", variants.length === 3, String(variants.length));
check("bandwidth parsed", variants[0].bandwidth === 3192000);
check("relative uris resolved", variants[0].uri === "https://cdn.example.com/vod/hash/hdntl=x/720p/vod_chunklist.m3u8", variants[0].uri);
const cheap = cheapestVariant(variants);
check("cheapest variant", cheap.bandwidth === 192000 && cheap.uri.endsWith("144p/vod_chunklist.m3u8"));

const media = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MAP:URI="144p_0_0_0.m4s?type=hls"
#EXTINF:2.000000,
144p_a_0.m4v
#EXTINF:2.000000,
144p_b_1.m4v
#EXT-X-DISCONTINUITY
#EXTINF:1.984000,
144p_c_2.m4v
`;
const parsed = parseMediaPlaylist(media, MEDIA);
check("init uri", parsed.initUri === "https://cdn.example.com/vod/hash/hdntl=x/1080p/144p_0_0_0.m4s?type=hls", parsed.initUri);
check("segment count", parsed.segments.length === 3, String(parsed.segments.length));
check("starts cumulative", parsed.segments.map((s) => s.start).join() === "0,2,4");
check("durations", parsed.segments.map((s) => s.duration).join() === "2,2,1.984");
check("total duration", Math.abs(parsed.duration - 5.984) < 1e-9, String(parsed.duration));

// filetype query on the init map must survive
const media2 = media.replace('144p_0_0_0.m4s?type=hls', '720p_0_0_0.m4s?type=hls&filetype=.m4s');
const p2 = parseMediaPlaylist(media2, MEDIA);
check("init keeps both query params", p2.initUri.endsWith("720p_0_0_0.m4s?type=hls&filetype=.m4s"), p2.initUri);

console.log(fails ? `\n${fails} FAILURES` : "\nall hls tests passed");
process.exitCode = fails ? 1 : 0;


