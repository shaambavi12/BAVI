// ═══════════════════════════════════════════
// FlowState v9 — Remote / D-pad spatial navigation
// Arrow keys move focus to the nearest control in that direction; the page
// scrolls to bring the focused control into view. Enter activates. This is
// what a TV remote sends, so it "just works" on a smart-TV browser.
// ═══════════════════════════════════════════
(function () {
  const FOCUSABLE = 'button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]), .focusable';

  function activeScreen() {
    return document.querySelector('.screen.active')
        || document.querySelector('.overlay.active')
        || document.querySelector('.break-overlay.active')
        || document.getElementById('app');
  }

  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  function candidates() {
    // Prefer the topmost active overlay if present, else the active screen.
    const overlay = document.querySelector('.overlay.active, .break-overlay.active');
    const root = overlay || activeScreen();
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(visible);
  }

  function center(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function move(dir) {
    const list = candidates();
    if (!list.length) return;
    const cur = document.activeElement && list.includes(document.activeElement)
      ? document.activeElement : null;

    if (!cur) { focus(list[0]); return; }
    const c = center(cur);
    let best = null, bestScore = Infinity;

    for (const el of list) {
      if (el === cur) continue;
      const p = center(el);
      const dx = p.x - c.x, dy = p.y - c.y;
      let primary, perp, ok;
      if (dir === 'down')  { ok = dy > 4;  primary = dy;  perp = Math.abs(dx); }
      else if (dir === 'up')   { ok = dy < -4; primary = -dy; perp = Math.abs(dx); }
      else if (dir === 'right'){ ok = dx > 4;  primary = dx;  perp = Math.abs(dy); }
      else                     { ok = dx < -4; primary = -dx; perp = Math.abs(dy); }
      if (!ok) continue;
      const score = primary + perp * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) focus(best);
  }

  function focus(el) {
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  function focusFirst() {
    const list = candidates();
    if (list.length) focus(list[0]);
  }

  // Choose a sensible starting focus per screen.
  function onScreen(name) {
    setTimeout(() => {
      const map = {
        home: '#homeScreen .home-btn.primary',
        library: '.lib-tab.active',
        editor: '#editorPaste:not([hidden]) .editor-textarea, #editorPreview:not([hidden]) .home-btn.primary',
        runner: '#doneBtn',
        breathing: '#breathRestart',
        complete: '.restart-btn',
        settings: '#settingsScreen .focusable, #settingsScreen button'
      };
      const sel = map[name];
      let el = sel ? document.querySelector(sel) : null;
      if (!el || !visible(el)) { focusFirst(); return; }
      focus(el);
    }, 60);
  }

  let remoteActive = false;
  function setRemote(on) {
    if (on === remoteActive) return;
    remoteActive = on;
    document.body.classList.toggle('remote-active', on);
  }

  document.addEventListener('keydown', e => {
    const k = e.key;
    const inText = /^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName)
                   && document.activeElement.type !== 'range';

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
      // In a textarea/text input, let arrows edit text.
      if (inText) return;
      setRemote(true);
      e.preventDefault();
      move(k.replace('Arrow', '').toLowerCase());
      return;
    }
    if (k === 'Enter') {
      if (inText && document.activeElement.tagName === 'TEXTAREA') return; // allow newline
      setRemote(true);
      const el = document.activeElement;
      if (el && el !== document.body && typeof el.click === 'function' &&
          !/^(TEXTAREA|SELECT)$/.test(el.tagName)) {
        e.preventDefault();
        el.click();
      }
      return;
    }
    if ((k === 'Escape' || k === 'Backspace' || k === 'BrowserBack' || k === 'GoBack') && !inText) {
      e.preventDefault();
      if (typeof window.handleBack === 'function') window.handleBack();
    }
  });

  // Any pointer/touch interaction drops remote mode (hides focus rings).
  ['pointerdown', 'mousemove', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, () => setRemote(false), { passive: true }));

  window.Nav = { onScreen, focusFirst, refresh: focusFirst, setRemote };
})();
