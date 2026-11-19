# dev/: rebuilding the speech model

Nothing here ships in the extension. These scripts rebuild `extension/src/model.json`,
the preset numbers in `extension/src/settings.js`, and the unit-test fixtures.
Run every command from the repository root.

## How the extension works

1. `page-hook.js` picks up the manifest URL (DASH or HLS) the player requests.
2. The analyser fetches the lightest audio (or low-res video) track of the same
   VOD 4–6 min ahead of the playhead and decodes it to 16 kHz.
3. Every 10 ms, 49 acoustic features go into a small MLP that looks 0.5 s
   either side and scores the frame as speech or not.
4. A run of low scores longer than the preset minimum becomes a skip, with a
   short lead-in and lead-out kept around it.

Only about 7 min of scores around the playhead are kept, so memory stays flat
on long VODs.

`audio-timeline.md` records how each VOD format's audio maps onto the player
clock; the timestamp handling in the extension depends on those measurements.

## `dev/data/` is never committed

Stream audio and Whisper transcripts are third-party content (the streamer's
voice and words), so they stay local in the git-ignored `dev/data/`:

```
dev/data/ref/           reference audio, one 16 kHz wav per region
dev/data/labels/        Whisper word timestamps per region (refwords_<start>_<end>.json)
dev/data/*.npz          feature dataset and scores
dev/data/calibration/   preset sweep results
```

## Requirements

- Node.js with `npm install` (Playwright, for `playback_url.mjs`)
- Python 3.11 with `numpy` and `torch`; `faster-whisper` and a GPU for
  `transcribe.py`; `ffmpeg` on PATH for `fetch_regions.py`

## Pipeline

Fetching audio needs the manifest URL the player itself requests. It is signed,
expires and is tied to a session, so **never hard-code or commit one**.

```bash
node dev/playback_url.mjs https://chzzk.naver.com/video/<videoNo>   # prints the signed URL
```

```powershell
$env:PB_URL = "<printed url>"
python dev/fetch_regions.py 15000 6000 9000    # reference audio  -> dev/data/ref
python dev/transcribe.py 15000,6000,9000       # Whisper labels   -> dev/data/labels
python dev/build_dataset.py                    # frames + labels  -> dev/data/dataset_ref.npz
python dev/train.py dev/data/dataset_ref.npz 20   # model         -> dev/data/model_v2.json
python dev/calibrate.py                        # held-out preset sweep -> dev/data/calibration
npm run check:policy                           # vad.js reproduces the swept numbers
```

- `fetch_regions.py` places each segment at its absolute player time, exactly as
  the extension does, so the labels need no offset correction.
- `features.py` is the reference implementation; `extension/src/features.js`
  must match it number for number.
- To ship a new model, copy `dev/data/model_v2.json` to `extension/src/model.json`.
- `calibrate.py` retrains on 3/4 of the regions and sweeps the skip policy on the
  rest, with the same boundary rule as `vad.js:buildSkips()`. Copy the chosen
  numbers into `PRESETS` in `extension/src/settings.js`, then run
  `npm run check:policy`: it replays the held-out scores through the shipped
  `smoothScores()` + `buildSkips()` and fails if any preset drifts by 0.15 points.

## Browser check

`check_browser.mjs` loads the built extension into a headless Chromium, opens a
VOD and checks that the analyser runs, the player button is mounted, skips are
applied, seeks re-anchor the analysis window and memory stays bounded. It waits
out pre-roll and mid-roll ads (pressing SKIP when offered). It needs the network
and live CHZZK pages, so it is not part of `npm test`:

```bash
npm run build
npm run check:browser -- https://chzzk.naver.com/video/<DASH videoNo>
npm run check:browser -- https://chzzk.naver.com/video/<HLS videoNo>
```

Exit code 0 is pass, 1 fail, 2 skipped (playback never started).

## Test fixtures

`test/fixtures/` holds a **synthetic** 24 s clip (no speech, no stream audio)
and the Python reference output for it. Regenerate after changing `features.py`
or `model.json`:

```bash
python dev/make_fixture.py --synthetic test/fixtures/features.json
python dev/make_score_fixture.py
npm test
```
