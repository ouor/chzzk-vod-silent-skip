"""Build reference region audio on the exact timeline the extension uses.

Each audio segment is decoded on its own and placed at
`segment.start + AUDIO_PRIMING_SEC` in an absolute player-time buffer. This is
what the extension does at runtime (see extension/src/analyser.js), so labels
derived from these files are already in absolute player time — no per-region
offset guessing.

Usage: python dev/fetch_regions.py [regionStart ...]

The playback URL is signed and expires, and it is a per-session credential, so it
is not kept in the repository. Get a fresh one with

    node dev/playback_url.mjs            # prints the URL
    set PB_URL=...                       # cmd
    $env:PB_URL="..."                    # pwsh
    PB_URL='...' python dev/fetch_regions.py 15000

Without PB_URL the script fails with a pointer to dev/playback_url.mjs.
"""
import json
import os
import subprocess
import sys
import urllib.request
import wave
from pathlib import Path

import numpy as np

PB = os.environ.get("PB_URL", "").strip()
if not PB:
    raise SystemExit(
        "PB_URL is not set.\n"
        "Get a fresh signed playback URL with:  node dev/playback_url.mjs\n"
        "then:  $env:PB_URL=\"<url>\"; python dev/fetch_regions.py"
    )
SR = 16000
PRIMING = 2048 / 48000
OUT = Path("dev/data/ref")
OUT.mkdir(parents=True, exist_ok=True)

REGIONS = [(0, 480), (600, 1200), (1800, 2280), (3000, 3600), (5400, 5880),
           (6000, 6600), (7200, 7680), (9000, 9600), (10200, 10680),
           (12600, 13080), (15000, 15600), (17400, 17880), (18600, 19080),
           (21000, 21600), (27000, 27600), (30600, 31100)]

pb = json.loads(urllib.request.urlopen(PB).read())
sets = pb["MPD"][0]["Period"][0]["AdaptationSet"]
a = next(s for s in sets if s.get("@mimeType") == "audio/mp4")
rep = a["Representation"][0]
sl = rep["SegmentList"][0]
base = rep["BaseURL"][0]
urls = sl["SegmentURL"]
init_range = sl["Initialization"][0]["@range"]
ts = int(sl["@timescale"])

times = []
t = 0
for s in sl["SegmentTimeline"][0]["S"]:
    d = int(s["@d"]) / ts
    r = int(s["@r"]) if "@r" in s else 0
    for _ in range(r + 1):
        times.append((t, d))
        t += d


def fetch(rng):
    req = urllib.request.Request(base)
    req.add_header("Range", "bytes=" + rng)
    return urllib.request.urlopen(req).read()


init = fetch(init_range)
wanted = [int(x) for x in sys.argv[1:]] or [r[0] for r in REGIONS]
regions = [r for r in REGIONS if r[0] in wanted]

for start, end in regions:
    out = OUT / f"ref_{start}_{end}.wav"
    if out.exists():
        print(f"{start}-{end}: cached")
        continue
    sel = [i for i, (s, d) in enumerate(times) if s + d > start and s < end]
    buf = np.zeros(int((end - start) * SR) + SR, dtype=np.float32)
    for i in sel:
        seg_start, _ = times[i]
        m4a = OUT / f"seg_{i}.m4a"
        if not m4a.exists():
            m4a.write_bytes(init + fetch(urls[i]["@mediaRange"]))
        pcm = OUT / f"seg_{i}.s16"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(m4a), "-ac", "1", "-ar", str(SR),
                        "-f", "s16le", str(pcm)], check=True)
        data = np.frombuffer(pcm.read_bytes(), dtype=np.int16).astype(np.float32) / 32768
        dst = int(round((seg_start + PRIMING - start) * SR))
        if dst < 0:
            data = data[-dst:]
            dst = 0
        n = min(len(data), len(buf) - dst)
        if n > 0:
            # Trim overlaps rather than summing them, like PcmBuilder: a segment
            # that overlaps already-written audio must not double the amplitude.
            buf[dst:dst + n] = data[:n]
    w = wave.open(str(out), "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(buf, -1, 1) * 32767).astype(np.int16).tobytes())
    w.close()
    print(f"{start}-{end}: {len(buf)/SR:.1f}s from {len(sel)} segments")
