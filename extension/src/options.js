// Options page: on/off, pick a skip preset, or fine-tune it by hand.

import { PRESETS, DEFAULT_SETTINGS, resolveSkipParams, isCustom, clearOverrides } from "./settings.js";

const stored = await chrome.storage.local.get("settings");
const settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };

const byId = (id) => document.getElementById(id);
const el = {
  enabled: byId("enabled"),
  enabledText: byId("enabledText"),
  presets: byId("presets"),
  custom: byId("custom"),
  threshold: byId("threshold"),
  thresholdVal: byId("thresholdVal"),
  minSkip: byId("minSkip"),
  minSkipVal: byId("minSkipVal"),
  reset: byId("reset"),
};

function paintPresets() {
  el.presets.innerHTML = "";
  const custom = isCustom(settings);
  for (const p of Object.values(PRESETS)) {
    const b = document.createElement("button");
    b.className = "preset";
    b.setAttribute("role", "radio");
    // A hand-tuned value means no preset is what actually applies.
    b.setAttribute("aria-checked", String(!custom && settings.preset === p.id));
    b.innerHTML = `<span class="name"></span><span class="desc"></span><span class="stat"></span>`;
    b.children[0].textContent = p.label;
    b.children[1].textContent = p.description;
    b.children[2].textContent = `약 ${Math.round(p.measured.skippedPct)}% 단축`;
    b.addEventListener("click", () => {
      settings.preset = p.id;
      clearOverrides(settings);
      paint();
      save();
    });
    el.presets.append(b);
  }
}

function paintValues() {
  el.thresholdVal.textContent = Number(el.threshold.value).toFixed(2);
  el.minSkipVal.textContent = `${Number(el.minSkip.value).toFixed(1)}초`;
}

function paint() {
  el.enabled.checked = settings.enabled !== false;
  el.enabledText.textContent = el.enabled.checked ? "켜짐" : "꺼짐";
  paintPresets();
  const eff = resolveSkipParams(settings);
  el.threshold.value = String(eff.threshold);
  el.minSkip.value = String(eff.minSkipSec);
  paintValues();
  const custom = isCustom(settings);
  el.reset.hidden = !custom;
  if (custom) el.custom.open = true;
}

let lastWritten = JSON.stringify(settings);
function save() {
  lastWritten = JSON.stringify(settings);
  chrome.storage.local.set({ settings });
}

el.threshold.addEventListener("input", paintValues);
el.minSkip.addEventListener("input", paintValues);
el.enabled.addEventListener("change", () => {
  settings.enabled = el.enabled.checked;
  paint();
  save();
});
el.threshold.addEventListener("change", () => {
  settings.threshold = Number(el.threshold.value);
  paint();
  save();
});
el.minSkip.addEventListener("change", () => {
  settings.minSkipSec = Number(el.minSkip.value);
  paint();
  save();
});
el.reset.addEventListener("click", () => {
  // Only the hand-tuned values: the on/off state and chosen preset stay.
  clearOverrides(settings);
  paint();
  save();
});

// Keep in sync when the setting is changed elsewhere (player button, another
// tab). `lastWritten` holds what this page already knows about.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const next = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue ?? {}) };
  if (JSON.stringify(next) === lastWritten) return;
  Object.assign(settings, next);
  lastWritten = JSON.stringify(settings);
  paint();
});

paint();
