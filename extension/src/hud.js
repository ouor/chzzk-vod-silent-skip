// Player-integrated UI: one button in CHZZK's own control bar plus a short skip
// notice inside the player. Reusing the player's `pzp-*` classes gives us its
// size, hover, tooltip, auto-hide and fullscreen behaviour for free.
// shortcut: depends on CHZZK's pzp class names; if they change the button just
// does not appear (skipping keeps working), update the selectors below.

const BAR = ".pzp-pc__bottom-buttons-right";
const PLAYER = ".pzp.pzp-pc";

const CSS = `
.css-skip-button { position: relative; width: 36px; height: 36px; }
.css-skip-button svg { display: block; width: 32px; height: 32px; }
.css-skip-button.css-skip-off .pzp-ui-icon,
.css-skip-button.css-skip-wait .pzp-ui-icon { opacity: .45; }
.css-skip-button.css-skip-err::after {
  content: ""; position: absolute; top: 6px; right: 6px;
  width: 6px; height: 6px; border-radius: 50%; background: #f87171;
}
.css-skip-toast {
  position: absolute; top: 16px; left: 50%; transform: translate(-50%, -4px);
  z-index: 20; pointer-events: none; opacity: 0;
  padding: 6px 12px; border-radius: 4px; background: rgba(0,0,0,.6);
  color: #fff; font-size: 13px; white-space: nowrap;
  transition: opacity .15s, transform .15s;
}
.css-skip-toast.css-skip-show { opacity: 1; transform: translate(-50%, 0); }
`;

// Skip-forward glyph: play triangle + bar, drawn in currentColor like the native icons.
// A 36-unit box like the native icons, so the player scales and centres it the same.
const ICON = `<svg width="36" height="36" viewBox="-6 -6 36 36" fill="currentColor" aria-hidden="true">
<path d="M5 6.5v11a.75.75 0 0 0 1.15.63l8.4-5.5a.75.75 0 0 0 0-1.26l-8.4-5.5A.75.75 0 0 0 5 6.5Z"/>
<rect x="16.5" y="6" width="2.5" height="12" rx=".75"/></svg>`;

export function createHud({ onToggle, onOpenOptions }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  (document.head || document.documentElement).append(style);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "pzp-button pzp-pc-setting-button pzp-pc__setting-button pzp-pc-ui-button css-skip-button";
  button.innerHTML =
    `<span class="pzp-button__tooltip pzp-button__tooltip--top"></span>` +
    `<span class="pzp-ui-icon pzp-pc-setting-button__icon">${ICON}</span>`;
  const tip = button.firstElementChild;

  const toast = document.createElement("div");
  toast.className = "css-skip-toast";

  let enabled = true;
  let visible = false;
  button.addEventListener("click", () => {
    enabled = !enabled;
    onToggle?.(enabled);
  });
  // Right-click opens the settings page instead of the player's own menu.
  button.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenOptions?.();
  });

  /** (Re)insert into the player of `video`; CHZZK re-renders its controls often. */
  function mount(video) {
    const player = video?.closest(PLAYER) ?? document.querySelector(PLAYER);
    const bar = player?.querySelector(BAR);
    if (!bar) return;
    if (button.parentElement !== bar) {
      // `:scope >` because other extensions nest buttons with the same class in portals.
      bar.insertBefore(button, bar.querySelector(":scope > .pzp-setting-button"));
    }
    if (toast.parentElement !== player) player.append(toast);
  }

  let toastTimer = null;
  function flashSkip(seconds) {
    toast.textContent = `${seconds.toFixed(1)}초 건너뜀`;
    toast.classList.add("css-skip-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("css-skip-show"), 1200);
  }

  let shownTip = null;
  let shownCls = null;
  function render(snap) {
    if (!snap) return;
    let cls = "";
    let text;
    if (!snap.enabled) {
      cls = "css-skip-off";
      text = "무음 건너뛰기 (꺼짐)";
    } else if (snap.state === "error") {
      cls = "css-skip-err";
      text = `무음 건너뛰기 (오류: ${String(snap.error || "알 수 없음").slice(0, 60)})`;
    } else if (snap.state !== "running") {
      cls = "css-skip-wait";
      text = "무음 건너뛰기 (분석 준비 중)";
    } else {
      const saved = Math.round(snap.skippedSeconds);
      text = `무음 건너뛰기 (${snap.presetLabel}` + (saved > 0 ? `, ${saved}초 절약)` : ")");
    }
    // render() runs at the tick rate: touch the DOM only on change.
    if (text !== shownTip) {
      shownTip = text;
      tip.textContent = text;
      button.setAttribute("aria-label", text);
    }
    if (cls !== shownCls) {
      button.classList.remove("css-skip-off", "css-skip-wait", "css-skip-err");
      if (cls) button.classList.add(cls);
      shownCls = cls;
    }
  }

  return {
    render,
    flashSkip,
    /** Show (mounted into `video`'s player) or remove the UI. Cheap to call every frame. */
    setVisible(v, video) {
      if (v) mount(video);
      if (visible === v) return;
      visible = v;
      if (!v) {
        button.remove();
        toast.remove();
      }
    },
    setEnabled(v) {
      enabled = v;
    },
  };
}
