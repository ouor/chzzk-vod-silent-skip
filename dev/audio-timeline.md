# Where the VOD audio comes from, and on which timeline it sits

CHZZK serves VODs in three shapes. The extension detects each one; this note
records what was measured, because the timestamp handling in
`extension/src/analyser.js` depends on these numbers.

## DASH, audio-only rendition

`play.vod.naver.com/v3/playback/<videoId>` returns JSON. One AdaptationSet has
`@mimeType="audio/mp4"`: a single `.m4a` file with a SegmentList of 4 s segments
addressed by byte ranges (init range first, then `SegmentURL[i].@mediaRange`).

- A decoded segment is about 42.7 ms shorter than nominal, because of the AAC
  priming delay in the init segment. Measured with ffprobe at segment indexes
  0, 1, 2, 3, 500, 501, 2000 and 2500: decoded 3.947 / 3.968 s against nominal
  4.011 / 3.989 s.
- Against the player clock the offset is a **constant** 2048 samples (42.67 ms)
  at 0 s, 2 000 s, 12 000 s and 30 400 s. There is no drift.
- So each segment is placed at `segment.start + 42.67 ms`, never by accumulating
  decoded lengths. (Accumulating cost about 4 s of drift per 10 minutes before
  it was fixed.)
- `decodeAudioData` does not return the priming samples, so consecutive segments
  leave a 42.6 to 42.7 ms hole (measured in Chrome at indexes 10/11/12 and
  300/301). That is about 1 % of the timeline. The PCM builder fills it with
  silence and reports it, and the analyser scores it as real silence.

## DASH, muxed MPEG-TS rendition

Some VODs have a single `video/mp2t` AdaptationSet addressed by SegmentTemplate
and no audio-only rendition. Each 4 s TS segment is demuxed to ADTS AAC before
decoding (`decodeAudioData` rejects the TS container). Every rendition's first
PTS is a constant 1.2 s above its nominal start (measured at segments 0, 1, 2,
100, 101, 102, 1000 and 6000), and the player normalises that, so each segment
is placed at its nominal start. The PTS is only used to detect a timeline jump.

## HLS

`.../vod_playlist.m3u8` lists variants (144p to 1080p). Each variant's
`vod_chunklist.m3u8` has an `#EXT-X-MAP` init plus fMP4 segments carrying both
video and audio (`avc1…,mp4a.40.2`). There is no audio-only rendition, so the
extension analyses the cheapest variant.

- Segment length differs between VODs: 2 s on the VOD measured first, about
  4.17 s on a later one.
- Playlist timeline equals the muxed audio timestamps. At segment indexes 0, 1,
  500 and 5000 the first audio PTS was the playlist start plus a constant
  62.6 ms mapping delay inside each segment, and the player uses the same
  playlist clock, so no correction is needed.
- Cross-checked live: the player's own audio envelope against the decoded
  segment envelope for 100 to 117 s correlated best at lag 0 samples (r = 0.97).
