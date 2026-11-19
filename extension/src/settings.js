// Shared settings model for the content script, options page and HUD.
//
// The presets are calibrated on **held-out** regions (dev/calibrate.py): the model
// is retrained on 3/4 of the labelled regions and the policy is swept on the
// remaining quarter, so the numbers below are not fitted on the evaluation data.
// Test VOD: 8 h 41 min, 16 labelled regions with Whisper word timestamps.
//
//   balanced    skip  6.3% of runtime, keeps 98.7% of speech
//   aggressive  skip 19.2% of runtime, keeps 95.1% of speech   <- default
//   maximum     skip 25.7% of runtime, keeps 92.6% of speech
//
// "aggressive" and "maximum" deliberately treat music, BGM and game effects as
// skippable: anything the classifier does not consider speech stops playback.

export const PRESETS = {
  balanced: {
    id: "balanced",
    label: "보수적",
    description: "음악과 효과음은 남겨요",
    threshold: 0.30,
    minSkipSec: 3.0,
    leadInSec: 0.30,
    leadOutSec: 0.25,
    measured: { skippedPct: 6.3, speechKeptPct: 98.68 },
  },
  aggressive: {
    id: "aggressive",
    label: "적극적",
    description: "말 위주로 들어요",
    threshold: 0.55,
    minSkipSec: 1.5,
    leadInSec: 0.30,
    leadOutSec: 0.25,
    measured: { skippedPct: 19.2, speechKeptPct: 95.12 },
  },
  maximum: {
    id: "maximum",
    label: "최대",
    description: "말만 남겨요. 가끔 말이 잘려요",
    threshold: 0.65,
    minSkipSec: 1.0,
    leadInSec: 0.30,
    leadOutSec: 0.25,
    measured: { skippedPct: 25.69, speechKeptPct: 92.55 },
  },
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  /** preset id; individual overrides below win when set */
  preset: "aggressive",
  threshold: null,
  minSkipSec: null,
  leadInSec: null,
  leadOutSec: null,
};

export function presetOf(settings) {
  return PRESETS[settings?.preset] ?? PRESETS.aggressive;
}

const OVERRIDES = ["threshold", "minSkipSec", "leadInSec", "leadOutSec"];

/** True when a hand-tuned value overrides the preset. */
export function isCustom(settings) {
  return OVERRIDES.some((k) => settings?.[k] != null);
}

/** Drop every hand-tuned value so the preset applies again. */
export function clearOverrides(settings) {
  for (const k of OVERRIDES) settings[k] = null;
  return settings;
}

/** What the UI calls the current skip setting. */
export function presetLabel(settings) {
  return isCustom(settings) ? "직접 조정" : presetOf(settings).label;
}

/** Resolve effective skip parameters (user overrides win over the preset). */
export function resolveSkipParams(settings) {
  const p = presetOf(settings);
  return {
    threshold: settings?.threshold ?? p.threshold,
    minSkipSec: settings?.minSkipSec ?? p.minSkipSec,
    leadInSec: settings?.leadInSec ?? p.leadInSec,
    leadOutSec: settings?.leadOutSec ?? p.leadOutSec,
  };
}
