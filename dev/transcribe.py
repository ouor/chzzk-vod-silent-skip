"""Transcribe the drift-free reference region audio.

The old labelling pipeline concatenated DASH segments, which drops ~42.7 ms per
4 s segment and therefore accumulates several seconds of drift inside one region.
`dev/fetch_regions.py` places every segment at its absolute timeline position
instead, so labels from these files are directly in player time.
"""
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from faster_whisper import WhisperModel

REF = Path("dev/data/ref")
OUT = Path("dev/data/labels")
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")


def transcribe(path):
    tag = path.stem.replace("ref_", "")
    dst = OUT / f"refwords_{tag}.json"
    if dst.exists():
        return f"{tag}: cached"
    segs, _ = model.transcribe(str(path), language="ko", vad_filter=False, beam_size=5,
                               word_timestamps=True, condition_on_previous_text=False)
    rows = [{"start": round(w.start, 3), "end": round(w.end, 3), "w": w.word}
            for s in segs for w in (s.words or [])]
    dst.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return f"{tag}: {len(rows)} words"


files = sorted(REF.glob("ref_*.wav"))
if len(sys.argv) > 1:
    want = set(sys.argv[1].split(","))
    files = [f for f in files if f.stem.replace("ref_", "").split("_")[0] in want]
print(f"transcribing {len(files)} regions")

with ThreadPoolExecutor(max_workers=2) as ex:
    for r in ex.map(transcribe, files):
        print(r, flush=True)
