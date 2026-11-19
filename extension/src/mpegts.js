// Minimal MPEG-TS demuxer: pull the audio elementary stream out of a muxed
// MPEG-TS segment.
//
// CHZZK serves some VODs as DASH with a single `video/mp2t` AdaptationSet: the
// audio is muxed into 4 s `.ts` segments and there is no audio-only rendition.
// `decodeAudioData` cannot read MPEG-TS (measured: "Unable to decode audio
// data"), but it reads the ADTS AAC inside it fine, so the audio PID is
// extracted here and handed to the decoder as-is.
//
// Measured on video/13166636 (see dev/audio-timeline.md):
//   PMT streams: video type 0x1B pid 256, audio type 0x0F pid 257
//   audio ES: 390 ADTS syncwords per segment, no PAT/PMT repetition issues
//
// The PES PTS is returned alongside the bytes: it is the only way to place a
// segment on the player's timeline exactly. Placing by nominal start would leave
// a 43 ms hole per segment (the same priming offset the `audio/mp4` path has).

const TS_PACKET = 188;
const TS_SYNC = 0x47;

/** Audio stream types that carry an ADTS/raw AAC elementary stream. */
const AUDIO_STREAM_TYPES = new Set([
  0x0f, // ADTS AAC
  0x11, // LATM AAC
  0x03, 0x04, // MPEG-1/2 audio
  0x81, // AC-3 (some encoders)
]);

/**
 * @typedef {object} TsAudio
 * @property {Uint8Array} adts audio elementary stream (PES headers stripped)
 * @property {number|null} pts PTS of the first audio access unit, in seconds
 * @property {number} audioPid
 * @property {boolean} ok false when the segment had no usable audio
 */

/**
 * Demux the audio elementary stream out of one MPEG-TS segment.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {TsAudio}
 */
export function demuxMpegTsAudio(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = { adts: new Uint8Array(0), pts: null, audioPid: -1, ok: false };
  if (buf.length < TS_PACKET || buf[0] !== TS_SYNC) return out;

  let pmtPid = -1;
  let audioPid = -1;
  /** @type {Uint8Array[]} */
  const parts = [];
  let total = 0;
  let firstPts = null;
  let openPes = false;

  for (let off = 0; off + TS_PACKET <= buf.length; off += TS_PACKET) {
    // Resync on a lost packet instead of giving up on the whole segment.
    if (buf[off] !== TS_SYNC) {
      const next = findSync(buf, off + 1);
      if (next < 0) break;
      off = next - TS_PACKET;
      continue;
    }

    const pusi = (buf[off + 1] & 0x40) !== 0;
    const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
    const afc = (buf[off + 3] >> 4) & 3;   // adaptation_field_control
    if (afc === 0 || afc === 2) continue;  // no payload

    let p = off + 4;
    if (afc === 3) {
      const afLen = buf[p];
      // discontinuity_indicator: the timeline restarts here, so the PTS we have
      // is no longer comparable with earlier segments.
      p += 1 + afLen;
      if (p >= off + TS_PACKET) continue;
    }
    const payload = buf.subarray(p, off + TS_PACKET);

    if (pid === 0) {
      const sec = sectionStart(payload);
      if (sec && sec[0] === 0x00) {
        const pPid = patFirstProgramPid(sec);
        if (pPid > 0) pmtPid = pPid;
      }
      continue;
    }

    if (pid === pmtPid) {
      const sec = sectionStart(payload);
      if (sec && sec[0] === 0x02) {
        const found = pmtAudioPid(sec);
        if (found > 0) audioPid = found;
      }
      continue;
    }

    if (audioPid < 0 || pid !== audioPid) continue;

    if (pusi) {
      const pes = parsePesHeader(payload);
      if (!pes) continue;
      if (firstPts === null && pes.pts !== null) firstPts = pes.pts;
      if (pes.data.length) {
        parts.push(pes.data);
        total += pes.data.length;
      }
      // A PES packet can be followed by stuffing; the caller decides what to do
      // with the continuation below, so remember that a packet is open.
      openPes = !pes.complete;
    } else if (openPes) {
      // Continuation of the PES packet started by the previous PUSI.
      parts.push(payload);
      total += payload.length;
    }
  }

  if (!total) return out;

  const adts = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    adts.set(part, at);
    at += part.length;
  }
  // A continuation payload can only have been appended after a PUSI, so any
  // leading garbage before the first syncword is dropped here.
  const start = findAdtsSync(adts, 0);
  out.adts = start > 0 ? adts.subarray(start) : adts;
  out.pts = firstPts;
  out.audioPid = audioPid;
  out.ok = out.adts.length > 0;
  return out;
}

function findSync(buf, from) {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === TS_SYNC && (i + TS_PACKET >= buf.length || buf[i + TS_PACKET] === TS_SYNC)) return i;
  }
  return -1;
}

/** Pointer-field-aware start of a PSI section, or null. */
function sectionStart(payload) {
  if (!payload.length) return null;
  const ptr = payload[0];
  if (1 + ptr >= payload.length) return null;
  return payload.subarray(1 + ptr);
}

function patFirstProgramPid(sec) {
  if (sec.length < 12) return -1;
  const sectionLength = ((sec[1] & 0x0f) << 8) | sec[2];
  const end = 3 + sectionLength - 4;   // minus CRC
  for (let i = 8; i + 4 <= end; i += 4) {
    const program = (sec[i] << 8) | sec[i + 1];
    if (program === 0) continue;       // network PID
    return ((sec[i + 2] & 0x1f) << 8) | sec[i + 3];
  }
  return -1;
}

function pmtAudioPid(sec) {
  if (sec.length < 16) return -1;
  const sectionLength = ((sec[1] & 0x0f) << 8) | sec[2];
  const infoLength = ((sec[10] & 0x0f) << 8) | sec[11];
  const end = 3 + sectionLength - 4;
  let i = 12 + infoLength;
  while (i + 5 <= end) {
    const type = sec[i];
    const pid = ((sec[i + 1] & 0x1f) << 8) | sec[i + 2];
    const esInfoLength = ((sec[i + 3] & 0x0f) << 8) | sec[i + 4];
    if (AUDIO_STREAM_TYPES.has(type)) return pid;
    i += 5 + esInfoLength;
  }
  return -1;
}

/**
 * Parse a PES header.
 * @returns {{pts: number|null, data: Uint8Array, complete: boolean}|null}
 *   `pts` in seconds; `complete` is false when the packet continues in the next
 *   TS packet (no continuation is harmless for ADTS, but skipping one is not).
 */
function parsePesHeader(payload) {
  if (payload.length < 9) return null;
  if (payload[0] !== 0x00 || payload[1] !== 0x00 || payload[2] !== 0x01) return null;
  const streamId = payload[3];
  if (streamId === 0xBE || streamId === 0xBF) return null;   // padding / private

  const flags = payload[7];
  const headerLen = payload[8];
  let pts = null;
  if ((flags & 0x80) !== 0) pts = readPts(payload, 9) / 90000;

  const start = 9 + headerLen;
  const declared = (payload[4] << 8) | payload[5];
  // The PES_packet_length counts the bytes after the length field itself.
  const complete = declared !== 0 && start + (declared - 3) <= payload.length;
  if (start >= payload.length) return { pts, data: new Uint8Array(0), complete };
  return { pts, data: payload.subarray(start), complete };
}

/**
 * 33-bit PTS from its 5-byte encoding, in 90 kHz ticks.
 *
 * Built with multiplications rather than `|`/`<<`: a 33-bit value exceeds int32,
 * and a 90 kHz PTS crosses 2^31 at about 6 h 38 min — inside a normal 8 h VOD.
 * With bitwise operators that PTS decoded as a negative number.
 */
export function readPts(buf, i) {
  const b0 = buf[i] & 0x0e;
  const b1 = buf[i + 1];
  const b2 = buf[i + 2] & 0xfe;
  const b3 = buf[i + 3];
  const b4 = buf[i + 4] & 0xfe;
  return (b0 >>> 1) * 0x40000000
    + b1 * 0x400000
    + (b2 >>> 1) * 0x8000
    + b3 * 0x80
    + (b4 >>> 1);
}

/** Encode a PTS back into its 5-byte form (used by the tests). */
export function encodePts(ticks) {
  const v = ticks % 0x200000000;
  return Uint8Array.from([
    0x21 | ((Math.floor(v / 0x40000000) & 0x07) << 1),
    (Math.floor(v / 0x400000) & 0xff),
    (((Math.floor(v / 0x8000) & 0x7f) << 1) | 0x01),
    (Math.floor(v / 0x80) & 0xff),
    (((v & 0x7f) << 1) | 0x01),
  ]);
}

/** Offset of the first ADTS syncword (0xFFFx), or 0. */
function findAdtsSync(buf, from) {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0) return i;
  }
  return 0;
}

/**
 * True when this looks like an MPEG-TS segment (sync byte every 188 bytes).
 * @param {ArrayBuffer|Uint8Array} input
 */
export function looksLikeMpegTs(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  return buf.length >= TS_PACKET * 2 && buf[0] === TS_SYNC && buf[TS_PACKET] === TS_SYNC;
}
