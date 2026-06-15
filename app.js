// ═══════════════════════════════════════════
// BAVI FlowState v13 — Main App
// ═══════════════════════════════════════════

// ── Device ──
const FlowDevice = (() => {
  const ua = navigator.userAgent.toLowerCase();
  const isTVUA = /\b(tv|smarttv|googletv|appletv|crkey|aftt|aftb|afts|aftn|bravia|webos|web0s|tizen|hbbtv|netcast|viera|aquos|roku)\b/.test(ua);
  const coarse = matchMedia('(pointer:coarse)').matches;
  const noHover = matchMedia('(hover:none)').matches;
  let type;
  if (isTVUA) type = 'tv';
  else if (/ipad|tablet/.test(ua) || (coarse && Math.min(screen.width, screen.height) >= 600)) type = 'tablet';
  else if (coarse || noHover) type = 'phone';
  else type = 'desktop';
  return { type, isTVUA };
})();

// ── State ──
let currentFlow = null, tasks = [], ci = 0;
let taskTotalSec = 0, taskEndAt = 0, taskRemainingMs = 0;
let running = false, paused = false;
let tickTimer = null, rafId = null;
let flowStartMs = null, pausedAccumMs = 0, pauseStartMs = 0;
let tgain = 0, lastBreakMs = 0, breakPending = false;
let actx = null, tickI = null, kaStarted = false;
let pendingAddMins = 0, awaitingAddConfirm = false;
let overtimeShown = false, nudgeTimer = null, pauseNudgeTimer = null;
let currentScreen = 'home';
let editorTasks = [], editingFlowId = null;
let taskStartMs = 0, sessionId = 's_' + Date.now().toString(36);
let breakCountdownTimer = null, breakCountdownLeft = 0, breakAwaitingStart = false, breakStarted = false;
let syncEnabled = false, deviceType = FlowDevice.type;

// ── Settings cache ──
const S = {
  defaultSecs: 300, maxItems: 20, enforceMax: true, drainMode: true,
  audioTakeover: true, voiceRecog: false, ticking: true,
  breakCountdown: 5, vibrateAlerts: true, aiBuffer: 30,
  workFriendlyBreaks: false, microSteps: false, duckAudio: false
};

// ── Phrasing — restored from the old version, verbatim. Zero new lines. ──
const ENC_DONE = [
  "Yes. Gorgeous.", "That's my girl.", "Smooth.", "Nailed it.", "Beautiful.",
  "Look at you go.", "Effortless.", "Mmhmm. Perfect.", "So good.", "You're on fire.",
  "Like a dream.", "Incredible.", "That focus though.", "Stunning.", "Unstoppable.",
  "Queen energy.", "Divine.", "Pure flow.", "Absolute magic.", "Flawless.",
  "Ah, see? Easy.", "You make it look easy.", "There she is."
];
const ENC_OT = [
  { t: "Hey, you're close...", p: "Almost there, beautiful. Two minutes to end strong?" },
  { t: "Take a breath...", p: "You're doing so well. Two minutes to finish strong?" },
  { t: "No rush, gorgeous...", p: "You've got this. Two more minutes to finish strong?" },
  { t: "Still flowing...", p: "Your pace is perfect. Two minutes to end strong?" },
  { t: "You're magnetic right now...", p: "That focus is something else. Two minutes to finish strong?" },
];
const NUDGES = [
  { t: "Hey, gorgeous...", p: "You've gone quiet on me. Everything okay? Tap when you're back." },
  { t: "Still here?", p: "I'm not going anywhere. Take a breath and tap when you're ready." },
  { t: "Just checking in...", p: "You're doing so well. Whenever you're ready, I'm here." },
  { t: "Don't disappear on me...", p: "You're so close. Come back and finish this strong." },
];
const BREAKS = [
  { title: "Shake it out", instruction: "Stand up. Shake your arms, legs, whole body. 30 seconds of pure chaos. Go.", secs: 30 },
  { title: "Floor time", instruction: "Lie flat on the floor. Spread out. Stare at the ceiling. Breathe deep. Just exist for a minute.", secs: 60 },
  { title: "Breathe", instruction: "4 counts in through your nose. Hold for 4. Out for 6. Feel your feet on the floor.", secs: 45 },
  { title: "Power pose", instruction: "Hands on hips. Feet wide. Chin up. You are running this. Hold it.", secs: 30 },
  { title: "Jump break", instruction: "10 jumping jacks. Don't think. Just move. NOW.", secs: 20 },
];
// Work-friendly breaks: quiet, desk-appropriate, nothing you'd be embarrassed
// to do in an open-plan office or on a call.
const BREAKS_WORK = [
  { title: "Eyes off", instruction: "Look at something far away — out a window if you can. Let your eyes soften for twenty seconds.", secs: 20 },
  { title: "Reset your posture", instruction: "Roll your shoulders back and down. Lengthen your spine. Unclench your jaw. Settle.", secs: 25 },
  { title: "Quiet breath", instruction: "Slow breath in through your nose for four. Out for six. Three easy rounds. No one will notice.", secs: 30 },
  { title: "Sip", instruction: "Reach for your water and take a proper drink. Hydration is a feature, not a treat.", secs: 20 },
  { title: "Stretch your hands", instruction: "Spread your fingers wide, then make a loose fist. Roll the wrists. Ease the typing tension.", secs: 25 },
];
function activeBreaks() { return S.workFriendlyBreaks ? BREAKS_WORK : BREAKS; }
// The old completion line, kept verbatim as the default. The language AI may
// swap ONLY the middle "first sip" clause for one that fits the routine just run.
const COMPLETE_PRE = "You did it. Every single one.";
const COMPLETE_CLOSER_DEFAULT = "That first sip is yours.";
const COMPLETE_POST = "Enjoy it, beautiful.";
// Words you can say instead of "done" (when voice control is on) — old set
const DONE_WORDS = ['done', 'yep', 'next', 'now what', 'ok', 'okay', 'yes', 'finished', 'complete', 'check'];

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// Untitled flows get a timestamped name: Flo_HH:MM:SS_DDMMMYYYY
function defaultFlowName(prefix = 'Flo') {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${prefix}_${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}_${p(d.getDate())}${mon}${d.getFullYear()}`;
}
async function nextFromBag(key, pool) {
  let bag = await getSetting(key, []);
  if (!Array.isArray(bag) || !bag.length) bag = shuffle([...Array(pool.length).keys()]);
  const idx = bag.pop();
  await setSetting(key, bag);
  return pool[(idx == null ? 0 : idx) % pool.length];
}

// ═══════════════════════════════════════════
// TASK PARSING (minutes + seconds aware)
// ═══════════════════════════════════════════
function parseTasks(text) {
  // "boom" (dictated by speech-to-text) acts like pressing Enter — it starts a
  // new task on its own line. Works mid-line too: "deep work boom stretch 1min".
  text = text.replace(/\bboom\b/gi, '\n');
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    let label = line, secs = null, m;
    m = line.match(/^(.+?)\s*[-–—:]?\s*(\d{1,3}):(\d{2})\s*$/);
    if (m) { label = m[1]; secs = parseInt(m[2]) * 60 + parseInt(m[3]); }
    if (secs === null) {
      m = line.match(/^(.+?)\s*[-–—]?\s*(?:(\d+)\s*(?:min(?:ute)?s?|m))?\s*(?:(\d+)\s*(?:sec(?:ond)?s?|s))?\s*$/i);
      if (m && (m[2] || m[3]) && !/^\d+$/.test(line)) { label = m[1]; secs = parseInt(m[2] || 0) * 60 + parseInt(m[3] || 0); }
    }
    if (secs === null) { m = line.match(/^(.+?)\s*[-–—]?\s*(\d+)\s*$/); if (m) { label = m[1]; secs = parseInt(m[2]) * 60; } }
    if (secs === null) secs = S.defaultSecs;
    label = label.replace(/[-–—:\s]+$/, '').trim();
    secs = Math.max(5, Math.min(7200, secs));
    if (label) out.push({ label, secs });
  }
  return out;
}

// ═══════════════════════════════════════════
// SEQUENCES — chain saved flows into one run.
// A sequence stores flow IDs; tasks are expanded fresh at launch, so editing
// a block (e.g. your Coffee flow) updates every sequence that uses it.
// ═══════════════════════════════════════════
// Optional "Sip / Bite" micro-steps: a tiny cue at the very start and a quick
// one right after each real step — a beat to hydrate or grab a bite before the
// next thing. Short by design (12s) so they never derail the flow.
const MICRO_CUES = [
  { label: 'Sip 💧', secs: 12 },
  { label: 'Bite 🍴', secs: 12 },
];
function withMicroSteps(arr) {
  const out = [];
  let k = 0;
  out.push({ ...MICRO_CUES[0], micro: true });           // auto first step
  arr.forEach((t, i) => {
    out.push(t);
    if (i < arr.length - 1) out.push({ ...MICRO_CUES[(++k) % MICRO_CUES.length], micro: true });
  });
  return out;
}
async function expandFlowTasks(flow) {
  if (!flow) return [];
  if (flow.type !== 'sequence') {
    return (flow.tasks || []).map(t => ({ label: t.label, secs: t.secs || (t.mins || 5) * 60 }));
  }
  const out = [];
  for (const bid of (flow.blocks || [])) {
    const b = await getFlow(bid);
    if (!b || b.type === 'sequence') continue;
    for (const t of (b.tasks || [])) out.push({ label: t.label, secs: t.secs || (t.mins || 5) * 60 });
  }
  return out;
}
async function flowMeta(flow) {
  const ts = await expandFlowTasks(flow);
  const total = ts.reduce((s, t) => s + t.secs, 0);
  if (flow.type === 'sequence') {
    const n = (flow.blocks || []).length;
    return `Sequence · ${n} ${n === 1 ? 'block' : 'blocks'} · ${ts.length} tasks · ${fmtDur(total)}`;
  }
  return `${ts.length} ${ts.length === 1 ? 'task' : 'tasks'} · ${fmtDur(total)}`;
}

let seqEditingId = null, seqBlocks = [];
async function openSequenceEditor(id) {
  haptic(40);
  seqEditingId = id || null; seqBlocks = [];
  let name = '';
  if (id) {
    const f = await getFlow(id);
    if (f && f.type === 'sequence') { name = f.name; seqBlocks = [...(f.blocks || [])]; }
  }
  document.getElementById('seqTitle').value = name;
  await renderSequenceEditor();
  showScreen('seq');
}
async function renderSequenceEditor() {
  const all = (await getAllFlows()).filter(f => f.type !== 'sequence' && !f.archived);
  const byId = {}; all.forEach(f => byId[f.id] = f);
  const listEl = document.getElementById('seqBlocks');
  listEl.innerHTML = '';
  if (!seqBlocks.length) listEl.innerHTML = '<div class="empty-hint">No blocks yet. Add flows below — they\'ll run back to back, in this order.</div>';
  seqBlocks.forEach((bid, i) => {
    const f = byId[bid]; if (!f) return;
    const total = (f.tasks || []).reduce((s, t) => s + (t.secs || 0), 0);
    const div = document.createElement('div');
    div.className = 'preview-item';
    div.innerHTML = `
      <div class="preview-num">${i + 1}</div>
      <div class="preview-body"><div class="seq-block-name">${esc(f.name)}</div>
        <div class="lib-meta">${f.tasks.length} tasks · ${fmtDur(total)}</div></div>
      <div class="preview-reorder">
        <button class="reorder-btn focusable" onclick="moveSeqBlock(${i},-1)" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
        <button class="reorder-btn focusable" onclick="moveSeqBlock(${i},1)" ${i === seqBlocks.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
      </div>
      <button class="preview-remove focusable" onclick="removeSeqBlock(${i})" aria-label="Remove">✕</button>`;
    listEl.appendChild(div);
  });
  const availEl = document.getElementById('seqAvail');
  availEl.innerHTML = '';
  if (!all.length) availEl.innerHTML = '<div class="empty-hint">No flows in your library yet. Build a flow first — then chain them here.</div>';
  for (const f of all) {
    const total = (f.tasks || []).reduce((s, t) => s + (t.secs || 0), 0);
    const div = document.createElement('div');
    div.className = 'preview-item';
    div.innerHTML = `
      <div class="preview-body"><div class="seq-block-name">${esc(f.name)}</div>
        <div class="lib-meta">${f.tasks.length} tasks · ${fmtDur(total)}</div></div>
      <button class="seq-add-btn focusable" onclick="addSeqBlock('${f.id}')" aria-label="Add">+</button>`;
    availEl.appendChild(div);
  }
}
// From the library: spin up a fresh sequence already holding this flow.
async function addToSequence(flowId) {
  haptic(40);
  await openSequenceEditor();
  seqBlocks = [flowId];
  renderSequenceEditor();
  toast('New sequence — add more flows below');
}
function addSeqBlock(id) { haptic(40); seqBlocks.push(id); renderSequenceEditor(); }
function removeSeqBlock(i) { haptic(40); seqBlocks.splice(i, 1); renderSequenceEditor(); }
function moveSeqBlock(i, dir) {
  const j = i + dir; if (j < 0 || j >= seqBlocks.length) return;
  haptic(40); [seqBlocks[i], seqBlocks[j]] = [seqBlocks[j], seqBlocks[i]]; renderSequenceEditor();
}
async function saveSequence(run) {
  haptic(120);
  if (!seqBlocks.length) { toast('Add at least one block'); return; }
  const name = document.getElementById('seqTitle').value.trim() || defaultFlowName('Seq');
  let flow;
  if (seqEditingId) {
    flow = await getFlow(seqEditingId);
    if (flow) { flow.name = name; flow.blocks = [...seqBlocks]; flow.type = 'sequence'; flow.tasks = []; await saveFlow(flow); }
  } else {
    flow = createFlow(name, []);
    flow.type = 'sequence'; flow.blocks = [...seqBlocks];
    await saveFlow(flow); seqEditingId = flow.id;
  }
  try { if (flow) Sync.pushFlow(flow); } catch (e) {}
  if (run && flow) launchFlow(flow.id); else { speak('Saved.'); renderHome(); }
}
function editItem(id) { getFlow(id).then(f => { if (f && f.type === 'sequence') openSequenceEditor(id); else editExistingFlow(id); }); }

// ═══════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════
function showScreen(name) {
  currentScreen = name;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(name + 'Screen')?.classList.add('active');
  const isRun = name === 'runner';
  const isFlow = isRun || name === 'breathing';
  document.getElementById('headerStats').style.display = isRun ? 'flex' : 'none';
  document.getElementById('progressWrap').style.display = isRun ? 'block' : 'none';
  document.getElementById('timeInfo').style.display = isRun ? 'flex' : 'none';
  document.getElementById('backBtn').style.display = ['library', 'editor', 'settings', 'seq'].includes(name) ? 'flex' : 'none';
  document.getElementById('settingsBtn').style.display = ['settings', 'runner', 'breathing', 'complete'].includes(name) ? 'none' : 'flex';
  document.getElementById('wordmark').style.display = isRun || name === 'breathing' ? 'none' : 'block';
  // Global PiP button: show during runner + breathing if supported
  const gpip = document.getElementById('globalPipBtn');
  if (gpip) gpip.style.display = isFlow && pipSupported() ? 'flex' : 'none';
  // Phone hardware-back trap is live only inside a flow.
  if (isFlow) armFlowBackTrap(); else disarmFlowBackTrap();
  if (window.Nav) Nav.onScreen(name);
}
function handleBack() {
  // In a flow (runner or breathing) the back gesture should never silently bail
  // — it pauses and asks. The phone hardware-back path goes through popstate
  // below; this covers the on-screen / remote back affordances.
  if (currentScreen === 'runner' || currentScreen === 'breathing') return showFlowBackPrompt();
  if (currentScreen === 'complete') return resetApp();
  renderHome();
}
window.handleBack = handleBack;
function goBack() { haptic(40); handleBack(); }

// ── Phone hardware-back handling ──
// When a flow (or its breathing lead-in) is on screen we keep a "trap" entry on
// the history stack. Pressing the phone's Back button pops it, which fires
// popstate — we intercept, re-arm the trap, and show a Pause / Exit prompt
// instead of letting the app fall out of the flow.
let _flowBackArmed = false, _flowBackWasRunning = false;
function armFlowBackTrap() {
  if (_flowBackArmed) return;
  _flowBackArmed = true;
  try { history.pushState({ flowTrap: true }, ''); } catch (e) {}
}
function disarmFlowBackTrap() { _flowBackArmed = false; }
window.addEventListener('popstate', () => {
  if (currentScreen === 'runner' || currentScreen === 'breathing') {
    // Re-arm so a second back press also lands here, then prompt.
    _flowBackArmed = false; armFlowBackTrap();
    showFlowBackPrompt();
  }
});
function showFlowBackPrompt() {
  const ov = document.getElementById('flowBackOverlay');
  if (!ov) return;
  haptic(60);
  // Pause anything that's actually counting so the world stops while they decide.
  _flowBackWasRunning = running && !paused && currentScreen === 'runner';
  if (_flowBackWasRunning) togglePauseTimer();
  ov.classList.add('active');
}
function flowBackResume() {
  document.getElementById('flowBackOverlay').classList.remove('active');
  haptic(40);
  if (_flowBackWasRunning && paused) togglePauseTimer();
  _flowBackWasRunning = false;
}
function flowBackExit() {
  document.getElementById('flowBackOverlay').classList.remove('active');
  disarmFlowBackTrap();
  _flowBackWasRunning = false;
  stopSequence();
}

// ═══════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════
async function renderHome() {
  const pinned = await getPinnedFlows();
  const el = document.getElementById('pinnedFlows');
  el.innerHTML = '';
  if (!pinned.length) {
    el.innerHTML = '<div class="empty-hint">No pinned flows yet. Make one, then pin it from your library.</div>';
  } else {
    for (const flow of pinned) {
      const meta = await flowMeta(flow);
      const div = document.createElement('div');
      div.className = 'pinned-card focusable'; div.tabIndex = 0;
      div.innerHTML = `
        <div class="pinned-name">${esc(flow.name)}</div>
        <div class="pinned-meta">${meta}</div>
        ${flow.bookmark ? '<div class="pinned-bookmark">↻ resume at step ' + (flow.bookmark.taskIndex + 1) + '</div>' : ''}`;
      div.onclick = () => launchFlow(flow.id, flow.bookmark ? flow.bookmark.taskIndex : 0);
      el.appendChild(div);
    }
  }
  showScreen('home');
}

// ═══════════════════════════════════════════
// LIBRARY
// ═══════════════════════════════════════════
let libraryFilter = 'active';
async function renderLibrary() {
  const all = await getAllFlows();
  const filtered = libraryFilter === 'active' ? all.filter(f => !f.archived)
    : libraryFilter === 'archived' ? all.filter(f => f.archived) : all;
  const listEl = document.getElementById('libraryList');
  listEl.innerHTML = '';
  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-hint">Nothing here yet.</div>';
  } else {
    for (const flow of filtered) {
      const meta = await flowMeta(flow);
      const tvBtn = (syncEnabled && deviceType !== 'tv')
        ? `<button class="lib-btn focusable" onclick="castToTV('${flow.id}')" title="Play on TV" aria-label="Play on TV">📺</button>` : '';
      const pipBtn = pipSupported()
        ? `<button class="lib-btn focusable" onclick="launchFlowInPiP('${flow.id}')" title="Start in PiP" aria-label="Start in picture-in-picture" style="font-size:12px">⧉</button>` : '';
      const div = document.createElement('div');
      div.className = 'library-item';
      div.innerHTML = `
        <button class="lib-main focusable" onclick="launchFlow('${flow.id}')">
          <div class="lib-name">${flow.pinned ? '<span class="pin-icon">◆</span> ' : ''}${esc(flow.name)}</div>
          <div class="lib-meta">${meta}${flow.lastRun ? ' · ran ' + timeAgo(flow.lastRun) : ''}</div>
        </button>
        <div class="lib-actions">
          ${tvBtn}
          ${pipBtn}
          ${flow.type !== 'sequence' ? `<button class="lib-btn focusable" onclick="addToSequence('${flow.id}')" title="Start a sequence with this flow" aria-label="Add to a sequence">⧉</button>` : ''}
          <button class="lib-btn focusable" onclick="editItem('${flow.id}')" title="Edit" aria-label="Edit">✎</button>
          <button class="lib-btn focusable" onclick="togglePin('${flow.id}').then(renderLibrary)" title="Pin to home" aria-label="Pin">${flow.pinned ? '◆' : '◇'}</button>
          <button class="lib-btn focusable" onclick="toggleArchive('${flow.id}').then(renderLibrary)" title="${flow.archived ? 'Restore' : 'Archive — hide but keep'}" aria-label="Archive">${flow.archived ? '↩' : '⊘'}</button>
          <button class="lib-btn lib-del focusable" onclick="confirmDeleteFlow('${flow.id}')" title="Delete forever" aria-label="Delete">✕</button>
        </div>`;
      listEl.appendChild(div);
    }
  }
  document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.lib-tab[data-filter="${libraryFilter}"]`)?.classList.add('active');
  showScreen('library');
}
function setLibFilter(f) { haptic(40); libraryFilter = f; renderLibrary(); }
async function confirmDeleteFlow(id) {
  if (confirm('Delete this flow forever? This cannot be undone.\n\n(To just hide it from Active, use Archive instead.)')) {
    await deleteFlow(id); try { Sync.deleteFlowRemote(id); } catch (e) {}
    haptic(40); renderLibrary();
  }
}
async function castToTV(id) {
  const ok = await Sync.sendToTV(id, 0);
  toast(ok ? 'Sent to your TV ▸' : 'Could not reach TV — check sync in Settings');
}

// ═══════════════════════════════════════════
// EDITOR
// ═══════════════════════════════════════════
function openNewEditor() {
  haptic(40); editingFlowId = null; editorTasks = [];
  document.getElementById('editorTitle').value = '';
  document.getElementById('editorTextarea').value = '';
  document.getElementById('editorPaste').hidden = false;
  document.getElementById('editorPreview').hidden = true;
  showScreen('editor');
}
async function editExistingFlow(id) {
  haptic(40);
  const flow = await getFlow(id); if (!flow) return;
  editingFlowId = id;
  editorTasks = flow.tasks.map(t => ({ label: t.label, secs: t.secs || (t.mins || 5) * 60 }));
  document.getElementById('editorTitle').value = flow.name;
  document.getElementById('editorTextarea').value = editorTasks.map(t => `${t.label} ${fmtClock(t.secs)}`).join('\n');
  renderEditorPreview();
  showScreen('editor');
}
function parseEditorInput() {
  haptic(40);
  const text = document.getElementById('editorTextarea').value.trim();
  if (!text) return;
  editorTasks = parseTasks(text);
  renderEditorPreview();
}
function renderEditorPreview() {
  document.getElementById('editorPaste').hidden = true;
  document.getElementById('editorPreview').hidden = false;
  let trimmed = false;
  if (S.enforceMax && editorTasks.length > S.maxItems) { editorTasks = editorTasks.slice(0, S.maxItems); trimmed = true; }
  const listEl = document.getElementById('previewList');
  listEl.innerHTML = '';
  const liveTasks = editorTasks.filter(t => !t.muted);
  const total = liveTasks.reduce((s, t) => s + t.secs, 0);
  const mutedCount = editorTasks.length - liveTasks.length;
  document.getElementById('previewSummary').innerHTML =
    `${liveTasks.length} ${liveTasks.length === 1 ? 'task' : 'tasks'} · ${fmtDur(total)} total` +
    (mutedCount ? ` <span class="trim-note">· ${mutedCount} muted</span>` : '') +
    (trimmed ? ` <span class="trim-note">· capped at ${S.maxItems}</span>` : '');
  editorTasks.forEach((task, i) => {
    const mins = Math.floor(task.secs / 60), secs = task.secs % 60;
    const div = document.createElement('div');
    div.className = 'preview-item' + (task.muted ? ' muted' : '');
    div.setAttribute('data-idx', i);
    div.draggable = false; // touch drag handled manually
    div.innerHTML = `
      <div class="drag-handle" title="Hold and drag to reorder" style="cursor:grab;padding:0 6px 0 2px;color:var(--muted-2);display:flex;align-items:center;flex-shrink:0;touch-action:none">
        <svg width="14" height="20" viewBox="0 0 14 20" fill="currentColor" opacity=".6"><circle cx="4" cy="4" r="2"/><circle cx="10" cy="4" r="2"/><circle cx="4" cy="10" r="2"/><circle cx="10" cy="10" r="2"/><circle cx="4" cy="16" r="2"/><circle cx="10" cy="16" r="2"/></svg>
      </div>
      <div class="preview-num-tap" title="Double-tap to type a new position" ondblclick="promptMoveTask(${i})" onclick="promptMoveTask(${i})" style="width:24px;height:24px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(201,183,156,.12);color:var(--gold);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;-webkit-tap-highlight-color:transparent">${i + 1}</div>
      <div class="preview-body">
        <input class="preview-label focusable" value="${esc(task.label)}" aria-label="Task name" onchange="updateEditorTask(${i},'label',this.value)" />
        <div class="preview-time-row">
          <input class="preview-time focusable" type="number" value="${mins}" min="0" max="120" aria-label="Minutes" ondblclick="this.select()" onchange="updateEditorSecs(${i}, this.value, null)" /><span class="t-unit">m</span>
          <input class="preview-time focusable" type="number" value="${secs}" min="0" max="59" aria-label="Seconds" ondblclick="this.select()" onchange="updateEditorSecs(${i}, null, this.value)" /><span class="t-unit">s</span>
        </div>
      </div>
      <button class="mute-btn focusable ${task.muted ? 'on' : ''}" onclick="toggleMuteTask(${i})" aria-label="${task.muted ? 'Unmute task' : 'Mute task — leave it out of the total'}" title="${task.muted ? 'Muted — not counted in the total' : 'Mute — see the total without this task'}">
        ${task.muted
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>'}
      </button>
      <button class="preview-remove focusable" onclick="removeEditorTask(${i})" aria-label="Remove">✕</button>`;
    listEl.appendChild(div);
  });
  initDragReorder(listEl);
}

// ── Tap task number → prompt new position ──
function promptMoveTask(fromIdx) {
  const total = editorTasks.length;
  if (total <= 1) return;
  const answer = window.prompt(`Move task to position (1–${total}):`, String(fromIdx + 1));
  if (answer === null) return;
  const toIdx = parseInt(answer) - 1;
  if (isNaN(toIdx) || toIdx < 0 || toIdx >= total || toIdx === fromIdx) return;
  haptic(40);
  const moved = editorTasks.splice(fromIdx, 1)[0];
  editorTasks.splice(toIdx, 0, moved);
  renderEditorPreview();
}

// ── Hold-and-drag reorder (touch + mouse) ──
let _drag = null; // { el, listEl, fromIdx, startY, currentY, ghost, placeholder, items }
function initDragReorder(listEl) {
  listEl.querySelectorAll('.drag-handle').forEach(handle => {
    handle.addEventListener('touchstart', _onDragStart, { passive: false });
    handle.addEventListener('mousedown', _onDragStart);
  });
}
function _onDragStart(e) {
  if (e.type === 'mousedown' && e.button !== 0) return;
  const handle = e.currentTarget;
  const el = handle.closest('.preview-item');
  const listEl = el.parentNode;
  const items = [...listEl.querySelectorAll('.preview-item')];
  const fromIdx = items.indexOf(el);
  const rect = el.getBoundingClientRect();
  const clientY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;

  // Only start drag after a short hold (200ms) to not conflict with taps
  let holdTimer = setTimeout(() => {
    haptic(60);
    el.style.opacity = '0.4';
    el.style.transform = 'scale(0.97)';

    // Create ghost
    const ghost = el.cloneNode(true);
    ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;opacity:0.92;pointer-events:none;z-index:9999;background:var(--raised);border:1px solid rgba(201,183,156,.35);border-radius:14px;box-shadow:0 8px 28px -8px rgba(0,0,0,.6);transform:scale(1.02);transition:none`;
    document.body.appendChild(ghost);

    _drag = { el, listEl, fromIdx, startY: clientY, ghostY: rect.top, ghost, items, active: true };

    const move = ev => _onDragMove(ev);
    const end = ev => _onDragEnd(ev);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', end);
    _drag._move = move; _drag._end = end;
  }, 220);

  // cancel if released before hold completes
  const cancelHold = () => clearTimeout(holdTimer);
  handle.addEventListener('touchend', cancelHold, { once: true });
  handle.addEventListener('mouseup', cancelHold, { once: true });
}
function _onDragMove(e) {
  if (!_drag?.active) return;
  e.preventDefault();
  const clientY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
  const dy = clientY - _drag.startY;
  _drag.ghost.style.top = (_drag.ghostY + dy) + 'px';

  // determine target slot
  const listRect = _drag.listEl.getBoundingClientRect();
  const relY = clientY - listRect.top + _drag.listEl.scrollTop;
  const items = [..._drag.listEl.querySelectorAll('.preview-item')];
  let targetIdx = _drag.fromIdx;
  for (let i = 0; i < items.length; i++) {
    const ir = items[i].getBoundingClientRect();
    if (clientY < ir.top + ir.height / 2) { targetIdx = i; break; }
    targetIdx = i + 1;
  }
  targetIdx = Math.min(targetIdx, items.length - 1);
  _drag.targetIdx = targetIdx;
  // visual: shift items
  items.forEach((it, i) => {
    it.style.transition = 'transform 0.15s ease';
    if (i === _drag.fromIdx) { it.style.transform = 'scale(0.97)'; it.style.opacity = '0.3'; return; }
    if (_drag.fromIdx < targetIdx && i > _drag.fromIdx && i <= targetIdx) it.style.transform = 'translateY(-' + items[_drag.fromIdx].offsetHeight + 'px)';
    else if (_drag.fromIdx > targetIdx && i >= targetIdx && i < _drag.fromIdx) it.style.transform = 'translateY(' + items[_drag.fromIdx].offsetHeight + 'px)';
    else it.style.transform = '';
    it.style.opacity = '';
  });
}
function _onDragEnd(e) {
  if (!_drag?.active) return;
  document.removeEventListener('touchmove', _drag._move);
  document.removeEventListener('touchend', _drag._end);
  document.removeEventListener('mousemove', _drag._move);
  document.removeEventListener('mouseup', _drag._end);
  _drag.ghost.remove();
  _drag.active = false;
  const fromIdx = _drag.fromIdx;
  const toIdx = _drag.targetIdx ?? fromIdx;
  if (fromIdx !== toIdx && toIdx !== undefined) {
    haptic(40);
    const moved = editorTasks.splice(fromIdx, 1)[0];
    editorTasks.splice(toIdx > fromIdx ? toIdx : toIdx, 0, moved);
  }
  _drag = null;
  renderEditorPreview();
}

function updateEditorTask(i, field, value) { if (editorTasks[i]) editorTasks[i][field] = value; }
function updateEditorSecs(i, mins, secs) {
  if (!editorTasks[i]) return;
  const cur = editorTasks[i].secs;
  const m = mins !== null ? Math.max(0, Math.min(120, parseInt(mins) || 0)) : Math.floor(cur / 60);
  const s = secs !== null ? Math.max(0, Math.min(59, parseInt(secs) || 0)) : cur % 60;
  editorTasks[i].secs = Math.max(5, m * 60 + s);
}
function moveTask(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= editorTasks.length) return;
  haptic(40);
  [editorTasks[i], editorTasks[j]] = [editorTasks[j], editorTasks[i]];
  renderEditorPreview();
}
function removeEditorTask(i) { haptic(40); editorTasks.splice(i, 1); renderEditorPreview(); }
// Mute a task to instantly see the total without it — a what-if, not a delete.
// Muted tasks are excluded from the total here and dropped when you save/run.
function toggleMuteTask(i) {
  if (!editorTasks[i]) return;
  haptic(50);
  editorTasks[i].muted = !editorTasks[i].muted;
  renderEditorPreview();
}
function addEditorTask() {
  if (S.enforceMax && editorTasks.length >= S.maxItems) { toast(`Capped at ${S.maxItems} tasks`); return; }
  haptic(40);
  editorTasks.push({ label: 'New task', secs: S.defaultSecs });
  renderEditorPreview();
  const list = document.getElementById('previewList'); list.scrollTop = list.scrollHeight;
}
function backToPaste() {
  document.getElementById('editorPaste').hidden = false;
  document.getElementById('editorPreview').hidden = true;
}
async function persistFlow(run) {
  haptic(120);
  // Muted tasks are a preview-only what-if — they don't get saved into the flow.
  editorTasks = editorTasks.filter(t => !t.muted);
  if (!editorTasks.length) { toast('Add at least one task'); return; }
  const name = document.getElementById('editorTitle').value.trim() || defaultFlowName('Flo');
  let flow;
  if (editingFlowId) {
    flow = await getFlow(editingFlowId);
    if (flow) { flow.name = name; flow.tasks = editorTasks.map(t => ({ ...t })); await saveFlow(flow); }
  } else {
    flow = createFlow(name, editorTasks.map(t => ({ ...t }))); await saveFlow(flow); editingFlowId = flow.id;
  }
  try { if (flow) Sync.pushFlow(flow); } catch (e) {}
  if (run && flow) launchFlow(flow.id); else { speak('Saved.'); renderHome(); }
}
const saveEditorFlow = () => persistFlow(false);
const saveAndRunEditorFlow = () => persistFlow(true);
async function saveAndRunInPiP() {
  // Must enter PiP while still inside the tap gesture.
  // 1. Set up the canvas stream immediately
  setupPiP();
  // 2. Paint a placeholder frame and request PiP NOW, inside the gesture
  if (pipReady && !document.pictureInPictureElement) {
    try {
      const ctx = pipCanvas.getContext('2d');
      ctx.fillStyle = '#08070e'; ctx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);
      await pipVideo.play();
      if (pipVideo.readyState < 2) await new Promise(r => { pipVideo.onloadeddata = r; setTimeout(r, 400); });
      await pipVideo.requestPictureInPicture();
    } catch (e) { /* PiP unavailable -- fall through to normal run */ }
  }
  // 3. Now launch the flow (navigates to breathing screen; PiP already open)
  await persistFlow(true);
}

async function launchFlowInPiP(flowId, startAt) {
  // Must enter PiP while still inside the tap gesture -- before any navigation.
  setupPiP();
  if (pipReady && !document.pictureInPictureElement) {
    try {
      const ctx = pipCanvas.getContext('2d');
      ctx.fillStyle = '#08070e'; ctx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);
      await pipVideo.play();
      if (pipVideo.readyState < 2) await new Promise(r => { pipVideo.onloadeddata = r; setTimeout(r, 400); });
      await pipVideo.requestPictureInPicture();
    } catch (e) { /* fall through */ }
  }
  await launchFlow(flowId, startAt);
}

// ═══════════════════════════════════════════
// BREATHING — box breathing on the new orb:
// "3 2 1" lead-in · IN 4 · HOLD 4 (counted) · OUT 4 · HOLD 4 (counted) · …
// 2 full rounds, then ONE final lone inhale — no text at all, just a subtle
// swell of the orb that fades into the background layer and hands over to
// whatever comes next. Holds pulse smoothly — eased, 4 cycles over 4 seconds.
// ═══════════════════════════════════════════
let breathRAF = null, breathPlaying = false, breathCountTimer = null;
const BREATH = { inhale: 4000, hold1: 4000, exhale: 4000, hold2: 4000 };
const BREATH_ROUNDS = 2;
// PiP mirrors these so drawPiP can render breathing state without DOM access
let _pipBreathPhase = 'Get ready\u2026', _pipBreathCount = '', _pipBreathRound = '',
    _pipBreathOrbR = 18, _pipBreathOrbOp = 0.45;
function startBreathing(onDone) {
  showScreen('breathing'); breathPlaying = true; window._breathDone = onDone;
  const dot = document.getElementById('breathDot');
  dot.style.width = '18px'; dot.style.height = '18px'; dot.style.transform = ''; dot.style.opacity = '';
  document.getElementById('breathPhase').textContent = 'Get ready\u2026';
  document.getElementById('breathRound').textContent = '';
  document.getElementById('breathCount').textContent = '';
  _pipBreathPhase = 'Get ready\u2026'; _pipBreathCount = ''; _pipBreathRound = '';
  _pipBreathOrbR = 18; _pipBreathOrbOp = 0.45;
  updMediaSession();
  speak("Close your eyes. Let's breathe.", () => {
    if (!breathPlaying) return;
    // Old-version "3 2 1…" countdown before the first inhale
    let c = 3;
    const countEl = document.getElementById('breathCount');
    countEl.textContent = c; _pipBreathCount = String(c);
    breathCountTimer = setInterval(() => {
      c--;
      if (!breathPlaying) { clearInterval(breathCountTimer); return; }
      if (c >= 1) { countEl.textContent = c; _pipBreathCount = String(c); }
      else { clearInterval(breathCountTimer); countEl.textContent = ''; _pipBreathCount = ''; runBreath(); }
    }, 1000);
  });
}
function runBreath() {
  if (!breathPlaying) return;
  const dot = document.getElementById('breathDot');
  const phaseEl = document.getElementById('breathPhase');
  const roundEl = document.getElementById('breathRound');
  const countEl = document.getElementById('breathCount');
  const minR = 18, maxR = 150;
  const seq = [
    { name: 'Breathe in', dur: BREATH.inhale, from: minR, to: maxR, hold: false },
    { name: 'Hold', dur: BREATH.hold1, from: maxR, to: maxR, hold: true },
    { name: 'Breathe out', dur: BREATH.exhale, from: maxR, to: minR, hold: false },
    { name: 'Hold', dur: BREATH.hold2, from: minR, to: minR, hold: true }
  ];
  // Final lone inhale: no phase text, no count — a subtle swell that fades out.
  const FINAL = { name: '', dur: 3500, from: minR, to: minR + (maxR - minR) * 0.62, hold: false, final: true };
  let round = 0, pi = 0, phaseStart = performance.now(), lastCount = 0, inFinal = false;
  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  function frame(now) {
    if (!breathPlaying) return;
    const ph = inFinal ? FINAL : seq[pi];
    const t = Math.min(1, (now - phaseStart) / ph.dur);
    let r;
    if (ph.final) {
      const e = ease(t);
      r = ph.from + (ph.to - ph.from) * e;
      dot.style.width = r + 'px'; dot.style.height = r + 'px';
      // swell up while melting into the background visual layer
      const op = ((0.45 + 0.55 * (r - minR) / (maxR - minR)) * (1 - e));
      dot.style.opacity = op.toFixed(3);
      _pipBreathOrbR = r; _pipBreathOrbOp = op;
      if (t >= 1) return finishBreathing();
      breathRAF = requestAnimationFrame(frame);
      return;
    }
    if (ph.hold) {
      // Two bounces on each hold, one second per bounce (sin² completes one
      // full 0→1→0 swell per second). After the 2 bounces the orb sits still
      // for the rest of the (4s) counted hold.
      const elapsedSec = t * ph.dur / 1000;
      const swell = elapsedSec < 2 ? Math.pow(Math.sin(Math.PI * elapsedSec), 2) : 0;
      const amp = (maxR - minR) * 0.07;            // visible — a real bounce, not a flutter
      r = ph.from + (ph.from === maxR ? -amp * swell : amp * swell);
      // Counted hold: 1 2 3 4 changing on the second (old version's mechanism)
      const c = Math.min(4, Math.floor(t * 4) + 1);
      if (c !== lastCount) { lastCount = c; countEl.textContent = c; _pipBreathCount = String(c); }
    } else {
      const e = ease(t);
      r = ph.from + (ph.to - ph.from) * e;
      if (lastCount !== 0) { lastCount = 0; countEl.textContent = ''; _pipBreathCount = ''; }
    }
    const orbOp = 0.45 + 0.55 * (r - minR) / (maxR - minR);
    dot.style.width = r + 'px'; dot.style.height = r + 'px';
    dot.style.opacity = orbOp.toFixed(3);
    _pipBreathOrbR = r; _pipBreathOrbOp = orbOp;
    if (t >= 1) {
      pi++;
      if (pi >= seq.length) {
        // Held out for four — the next inhale begins the next round…
        pi = 0; round++;
        if (round >= BREATH_ROUNDS) {
          // …unless both rounds are done: one last wordless inhale, then through.
          inFinal = true; phaseStart = now; lastCount = 0;
          phaseEl.textContent = ''; roundEl.textContent = ''; countEl.textContent = '';
          _pipBreathPhase = ''; _pipBreathRound = ''; _pipBreathCount = '';
          breathRAF = requestAnimationFrame(frame);
          return;
        }
      }
      phaseStart = now; lastCount = 0; countEl.textContent = ''; _pipBreathCount = '';
      phaseEl.textContent = seq[pi].name; _pipBreathPhase = seq[pi].name;
      roundEl.textContent = `Round ${round + 1} of ${BREATH_ROUNDS}`; _pipBreathRound = `Round ${round + 1} of ${BREATH_ROUNDS}`;
    }
    breathRAF = requestAnimationFrame(frame);
  }
  phaseEl.textContent = seq[0].name; roundEl.textContent = `Round 1 of ${BREATH_ROUNDS}`;
  _pipBreathPhase = seq[0].name; _pipBreathRound = `Round 1 of ${BREATH_ROUNDS}`;
  breathRAF = requestAnimationFrame(frame);
}
function restartBreath() {
  haptic(40); cancelAnimationFrame(breathRAF); clearInterval(breathCountTimer); cancelSpeech();
  breathPlaying = false;
  setTimeout(() => { breathPlaying = true; startBreathing(window._breathDone); }, 30);
}
function finishBreathing() {
  cancelAnimationFrame(breathRAF); clearInterval(breathCountTimer); breathPlaying = false;
  const d = document.getElementById('breathDot'); d.style.opacity = '0';
  document.getElementById('breathCount').textContent = '';
  speak("Beautiful. Let's go.");
  const scr = document.getElementById('breathingScreen');
  scr.style.transition = 'opacity 1s ease'; scr.style.opacity = '0';
  setTimeout(() => { scr.style.opacity = ''; scr.style.transition = ''; transitionToRunner(); }, 1000);
}
function skipBreathing() { haptic(40); cancelAnimationFrame(breathRAF); clearInterval(breathCountTimer); breathPlaying = false; cancelSpeech(); transitionToRunner(); }
function transitionToRunner() {
  showScreen('runner');
  const r = document.getElementById('runnerScreen');
  r.style.opacity = '0'; r.style.transition = 'opacity 0.7s ease';
  requestAnimationFrame(() => { r.style.opacity = '1'; });
  setTimeout(() => { r.style.transition = ''; }, 800);
  startMainFlow();
}

// ═══════════════════════════════════════════
// LAUNCH
// ═══════════════════════════════════════════
async function launchFlow(flowId, startAt) {
  haptic(700); initAudio(); startKeepAlive(); reqWakeLock(); setupPiP();
  const flow = await getFlow(flowId);
  if (!flow) return;
  currentFlow = flow;
  const expanded = await expandFlowTasks(flow);
  if (!expanded.length) return;
  tasks = S.microSteps ? withMicroSteps(expanded) : expanded;
  // Language AI quietly drafts a routine-specific closer while you flow (falls
  // back to the original "first sip" line if it isn't ready or isn't set up).
  try { if (window.AI) AI.prepareCloser(flow, tasks); } catch (e) {}
  ci = startAt || 0;
  const jump = document.getElementById('jumpSelect');
  jump.innerHTML = '<option value="0">From the beginning</option>';
  tasks.forEach((t, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `${i + 1}. ${t.label} (${fmtClock(t.secs)})`; jump.appendChild(o); });
  if (ci > 0) jump.value = ci;
  await setBookmark(flowId, null);
  if (ci > 0) transitionToRunner(); else startBreathing();
}
function jumpTo(v) {
  const idx = parseInt(v); if (isNaN(idx) || idx === ci) return;
  logTaskEvent('jumped');
  clearInterval(tickTimer); stopTicking(); cancelSpeech();
  tickTimer = setInterval(tick, 250);
  loadTask(idx);
}

// ═══════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════
function initAudio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
}
const keepAliveEl = document.createElement('audio');
keepAliveEl.loop = true; keepAliveEl.setAttribute('playsinline', '');
function startKeepAlive() {
  if (kaStarted) return; initAudio(); if (!actx) return;
  try {
    const dest = actx.createMediaStreamDestination();
    const osc = actx.createOscillator(), g = actx.createGain();
    osc.type = 'sine'; osc.frequency.value = 30; g.gain.value = 0.0006;
    osc.connect(g); g.connect(dest); osc.start();
    keepAliveEl.srcObject = dest.stream; keepAliveEl.volume = 0.02;
    keepAliveEl.play().catch(() => {});
    kaStarted = true;
  } catch (e) {}
}
function startTicking() {
  if (!S.ticking) return; if (!actx) initAudio(); if (!actx) return;
  stopTicking(); let beat = 0; const iv = (60 / 92) * 1000 / 2;
  tickI = setInterval(() => {
    if (paused || !actx) return;
    const now = actx.currentTime;
    const isKick = beat % 4 === 0, isSnare = beat % 4 === 2, isHat = beat % 2 === 1;
    if (isKick) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(80, now); o.frequency.exponentialRampToValueAtTime(40, now + 0.12);
      g.gain.setValueAtTime(0.10, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      o.connect(g); g.connect(actx.destination); o.start(now); o.stop(now + 0.15);
    } else if (isSnare) {
      const buf = actx.createBuffer(1, actx.sampleRate * 0.05, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (actx.sampleRate * 0.015));
      const n = actx.createBufferSource(); n.buffer = buf;
      const f = actx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 320; f.Q.value = 3;
      const g = actx.createGain(); g.gain.setValueAtTime(0.05, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      n.connect(f); f.connect(g); g.connect(actx.destination); n.start(now); n.stop(now + 0.06);
    } else if (isHat) {
      const buf = actx.createBuffer(1, actx.sampleRate * 0.02, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (actx.sampleRate * 0.005));
      const n = actx.createBufferSource(); n.buffer = buf;
      const f = actx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
      const g = actx.createGain(); g.gain.setValueAtTime(0.012, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
      n.connect(f); f.connect(g); g.connect(actx.destination); n.start(now); n.stop(now + 0.03);
    }
    beat++;
  }, iv);
}
function stopTicking() { if (tickI) { clearInterval(tickI); tickI = null; } }
function chimeStart() {
  flowVibe();
  if (!actx) initAudio(); if (!actx) return; const now = actx.currentTime;
  [659.25, 880].forEach((fr, i) => {
    const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine'; o.frequency.value = fr;
    g.gain.setValueAtTime(0, now + i * .12); g.gain.linearRampToValueAtTime(0.06, now + i * .12 + .04);
    g.gain.exponentialRampToValueAtTime(0.001, now + i * .12 + .55);
    o.connect(g); g.connect(actx.destination); o.start(now + i * .12); o.stop(now + i * .12 + .55);
  });
}
function chimeEnd() {
  flowVibe();
  if (!actx) initAudio(); if (!actx) return; const now = actx.currentTime;
  [587.33, 440].forEach((fr, i) => {
    const o = actx.createOscillator(), g = actx.createGain(); o.type = 'triangle'; o.frequency.value = fr;
    g.gain.setValueAtTime(0, now + i * .16); g.gain.linearRampToValueAtTime(0.05, now + i * .16 + .04);
    g.gain.exponentialRampToValueAtTime(0.001, now + i * .16 + .6);
    o.connect(g); g.connect(actx.destination); o.start(now + i * .16); o.stop(now + i * .16 + .6);
  });
}
function chimeComplete() { chimeStart(); setTimeout(chimeStart, 320); }
function haptic(ms = 60) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (e) {} }
// Buzz whenever FlowState speaks or chimes. The web can't read system volume or
// headphone state, so this errs on the side of always buzzing when enabled.
function flowVibe() { if (S.vibrateAlerts) haptic(60); }
window.flowVibe = flowVibe;
function hapticBurst() { if (navigator.vibrate) try { navigator.vibrate([40, 30, 40, 30, 40]); } catch (e) {} }

// ═══════════════════════════════════════════
// VOICE RECOGNITION (optional)
// ═══════════════════════════════════════════
let recog = null, recogOn = false;
function startRecog() {
  if (!S.voiceRecog) return;
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recog = new SR(); recog.continuous = true; recog.interimResults = false; recog.lang = 'en-AU';
  recog.onresult = e => {
    const l = e.results[e.results.length - 1]; if (!l.isFinal) return;
    const t = l[0].transcript.toLowerCase().trim();
    if (breakOverlayActive()) {
      if (/\b(hold on|hang on|wait|one sec|pause)\b/.test(t)) { holdBreakCountdown(); return; }
      if (/\b(ready|go|start|okay|ok)\b/.test(t)) { startBreak2(); return; }
      return;
    }
    if (awaitingAddConfirm) { if (/\byes\b/.test(t)) confirmAddTime(); else if (/\b(no|cancel|never ?mind)\b/.test(t)) cancelAddTime(); return; }
    const add = t.match(/add\s+(\d+)\s*min/);
    if (add) { const m = parseInt(add[1]); if (m >= 1 && m <= 8) return addTime(m); }
    if (new RegExp('\\b(' + DONE_WORDS.join('|') + ')\\b').test(t)) markDone();
  };
  recog.onend = () => { if (recogOn) try { recog.start(); } catch (e) {} };
  recog.onerror = () => {};
  try { recog.start(); recogOn = true; } catch (e) {}
}
function stopRecog() { recogOn = false; if (recog) try { recog.stop(); } catch (e) {} }

// ═══════════════════════════════════════════
// TIME HELPERS
// ═══════════════════════════════════════════
function fmtTime(d) { const h = d.getHours(), m = d.getMinutes(); return `${h % 12 || 12}:${m.toString().padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`; }
function fmtDur(secs) { const m = Math.round(secs / 60); if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}m` : `${h}h`; }
function fmtClock(secs) { const m = Math.floor(secs / 60), s = secs % 60; return s ? `${m}:${s.toString().padStart(2, '0')}` : `${m}min`; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now'; if (mins < 60) return mins + 'm ago';
  const h = Math.floor(mins / 60); if (h < 24) return h + 'h ago'; return Math.floor(h / 24) + 'd ago';
}
function remainingSec() { return running ? (taskEndAt - Date.now()) / 1000 : taskRemainingMs / 1000; }
function totalElapsedSec() { if (!flowStartMs) return 0; const extra = paused ? Date.now() - pauseStartMs : 0; return Math.max(0, (Date.now() - flowStartMs - pausedAccumMs - extra) / 1000); }

// ═══════════════════════════════════════════
// ORB
// ═══════════════════════════════════════════
function renderOrb() {
  const frac = clamp(remainingSec() / taskTotalSec, 0, 1);
  // Perceptual curve: pow > 1 makes the ring *look* like it empties a touch
  // faster than real time early on — subtle urgency without lying about digits.
  const curved = Math.pow(frac, 1.22);
  const drain = document.getElementById('orbDrain'); if (!drain) return;
  if (S.drainMode) {
    // EMPTIES CLOCKWISE: the remaining gold arc shrinks with its leading edge
    // sweeping clockwise from 12 o'clock. The spent (transparent) wedge grows
    // clockwise from the top as time runs down.
    const remDeg = curved * 360;
    const emptyDeg = 360 - remDeg;
    drain.style.opacity = remDeg > 0.3 ? '1' : '0';
    drain.style.background = `conic-gradient(from 0deg, transparent 0deg, transparent ${emptyDeg}deg, var(--gold-deep) ${emptyDeg}deg, var(--gold) ${emptyDeg + remDeg * 0.45}deg, var(--gold-bright) 360deg)`;
  } else {
    // FILLS CLOCKWISE from 12 o'clock as time passes.
    const deg = (1 - curved) * 360;
    drain.style.opacity = deg > 0.3 ? '1' : '0';
    drain.style.background = `conic-gradient(from 0deg, var(--gold-bright) 0deg, var(--gold) ${deg * 0.55}deg, var(--gold-deep) ${deg}deg, transparent ${deg}deg)`;
  }
  drawPiP();
}
function setOrbRunning(on) { document.getElementById('timerOrb')?.classList.toggle('running', on && !paused); }

// ═══════════════════════════════════════════
// MAIN FLOW
// ═══════════════════════════════════════════
function startMainFlow() {
  tgain = 0; pausedAccumMs = 0; flowStartMs = Date.now(); lastBreakMs = Date.now(); breakPending = false;
  setAudioMode(true); startRecog(); setupPiP(); reqWakeLock();
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 250);
  startRAF();
  loadTask(ci);
}
function startRAF() { cancelAnimationFrame(rafId); const loop = () => { renderOrb(); rafId = requestAnimationFrame(loop); }; rafId = requestAnimationFrame(loop); }
function loadTask(i) {
  if (i >= tasks.length) return completeAll();
  if (tryBreak()) { ci = i; return; }
  ci = i;
  const task = tasks[i];
  taskTotalSec = task.secs; taskRemainingMs = taskTotalSec * 1000;
  running = false; paused = false; awaitingAddConfirm = false; overtimeShown = false; taskStartMs = Date.now();
  clearTimeout(nudgeTimer); clearTimeout(pauseNudgeTimer);
  document.getElementById('mainArea').classList.remove('paused');
  document.getElementById('taskNum').textContent = `Task ${i + 1} of ${tasks.length}`;
  const l = document.getElementById('taskLabel'); l.textContent = task.label;
  l.classList.remove('fade-in'); void l.offsetWidth; l.classList.add('fade-in');
  document.getElementById('taskDeadline').textContent = fmtTime(new Date(Date.now() + taskTotalSec * 1000));
  updTimer(); updProgress(); updPause(); updMediaSession(); setOrbRunning(true);
  speak(task.label, () => { chimeStart(); startTicking(); resumeTimer(); });
  if (i + 1 < tasks.length) prefetchAudio(tasks[i + 1].label);
}
function resumeTimer() { taskEndAt = Date.now() + taskRemainingMs; running = true; setOrbRunning(true); }
function tick() {
  if (!running || paused) { updHeader(); return; }
  const sl = remainingSec();
  updTimer(); updHeader();
  if (sl <= 0 && !overtimeShown) onTimeUp();
}
function onTimeUp() {
  overtimeShown = true; stopTicking(); chimeEnd(); haptic(200); showOvertime();
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { if (document.getElementById('overtimeOverlay').classList.contains('active')) { hapticBurst(); showNudge(); } }, 120000);
}
function updTimer() {
  const sl = remainingSec(), abs = Math.abs(sl);
  const m = Math.floor(abs / 60), s = Math.floor(abs % 60);
  document.getElementById('timerDigits').textContent = `${m}:${s.toString().padStart(2, '0')}`;
  document.getElementById('timerStatus').textContent = sl >= 0 ? 'remaining' : 'overtime';
  document.getElementById('timerOrb').classList.toggle('over', sl < 0);
}
function updProgress() {
  document.getElementById('progressFill').style.width = (ci / tasks.length) * 100 + '%';
  // Show the CURRENT task number (matches "Task X of Y" up top) — not the
  // completed count, which is what made the counters disagree.
  document.getElementById('stepCount').textContent = `${Math.min(ci + 1, tasks.length)} / ${tasks.length}`;
  document.getElementById('etaInfo').textContent = 'ETA ' + fmtTime(calcETA());
}
function calcETA() { let rem = remainingSec(); for (let i = ci + 1; i < tasks.length; i++) rem += tasks[i].secs; return new Date(Date.now() + Math.max(0, rem) * 1000); }
function updHeader() {
  const te = Math.floor(totalElapsedSec());
  document.getElementById('totalElapsed').textContent = `${Math.floor(te / 60).toString().padStart(2, '0')}:${(te % 60).toString().padStart(2, '0')}`;
  const g = Math.round(tgain), gm = Math.floor(Math.abs(g) / 60), gs = Math.abs(g) % 60;
  const el = document.getElementById('timeGained');
  el.textContent = `${g >= 0 ? '+' : '−'}${gm}:${gs.toString().padStart(2, '0')}`;
  el.classList.toggle('neg', g < 0);
}
function updPause() {
  document.getElementById('pauseIcon').innerHTML = paused
    ? '<polygon points="8,4 20,12 8,20" fill="currentColor"/>'
    : '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>';
}

// ── Media Session (lock-screen widget + controls) ──
function updMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    const isBreathing = currentScreen === 'breathing';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: isBreathing ? (_pipBreathPhase || 'Breathing') : (tasks[ci]?.label || 'FlowState'),
      artist: isBreathing ? (_pipBreathRound || 'Box breathing') : `Task ${ci + 1} of ${tasks.length}`,
      album: currentFlow?.name || 'FlowState',
      artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icon-192.png', sizes: '192x192', type: 'image/png' }]
    });
    navigator.mediaSession.playbackState = 'playing';
    const set = (a, h) => { try { navigator.mediaSession.setActionHandler(a, h); } catch (e) {} };

    if (isBreathing) {
      // LEFT → nothing useful during breathing; disable
      set('seekbackward', null);
      // RIGHT → nothing useful during breathing; disable
      set('seekforward', null);
      // CENTRE → skip breathing
      set('play', () => { skipBreathing(); });
      set('pause', () => { skipBreathing(); });
      set('stop', () => stopSequence());
      return;
    }

    // LEFT button (seekbackward) → pause / resume
    set('seekbackward', () => { togglePauseTimer(); });

    // CENTRE (play/pause toggle) → acts as DONE tap
    // We immediately flip play→pause→play so the state appears unchanged (stays "playing")
    // giving it the feel of a tap-to-confirm rather than a real pause.
    set('play', () => {
      _pipCenterTapPending = true;
      setTimeout(() => {
        if (_pipCenterTapPending) {
          _pipCenterTapPending = false;
          try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
          markDone();
        }
      }, 80);
    });
    set('pause', () => {
      _pipCenterTapPending = true;
      setTimeout(() => {
        if (_pipCenterTapPending) {
          _pipCenterTapPending = false;
          try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
          markDone();
        }
      }, 80);
    });

    // RIGHT button (seekforward) → +1 minute
    set('seekforward', () => { addTime(1); });

    // stop → full stop
    set('stop', () => stopSequence());
  } catch (e) {}
}
let _pipCenterTapPending = false;
function prevTask() {
  if (ci <= 0) return;
  logTaskEvent('back'); clearInterval(tickTimer); stopTicking(); cancelSpeech();
  tickTimer = setInterval(tick, 250); loadTask(ci - 1);
}

// ── Picture-in-Picture (floating timer on mobile) ──
let pipCanvas = null, pipVideo = null, pipReady = false;
function pipSupported() {
  return !!(document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream);
}
function setupPiP() {
  const btn = document.getElementById('pipBtn');
  if (!pipSupported()) { if (btn) btn.style.display = 'none'; return; }
  if (btn) btn.style.display = 'flex';
  if (pipReady) return;
  // 2× logical resolution so it's crisp on retina / high-DPI screens
  pipCanvas = document.createElement('canvas');
  pipCanvas.width = 960; pipCanvas.height = 540;  // render at 2×
  pipVideo = document.createElement('video');
  pipVideo.muted = true; pipVideo.setAttribute('playsinline', ''); pipVideo.autoplay = true;
  pipVideo.setAttribute('autopictureinpicture', '');
  // Must be in the DOM (and not display:none) for true system-level PiP overlay
  pipVideo.style.cssText = 'position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(pipVideo);
  try { pipVideo.srcObject = pipCanvas.captureStream(8); pipReady = true; } catch (e) { if (btn) btn.style.display = 'none'; }
}
// PiP marquee state
let _pipMarqueeX = 0, _pipMarqueeW = 0, _pipMarqueeDir = 1, _pipMarqueeTimer = 0;
// Safe canvas font stack — avoids web-font race; looks sharp on all platforms
const PIP_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
function drawPiP() {
  if (!pipReady || !pipCanvas || document.pictureInPictureElement !== pipVideo) return;
  const ctx = pipCanvas.getContext('2d');
  // Canvas is 960×540 (2×), logical co-ords below are in 480×270 space —
  // we apply a uniform scale so all numbers stay readable.
  const S = 2; // scale factor
  const W = 480, H = 270;
  ctx.save();
  ctx.scale(S, S);

  // ── Background ──
  const grd = ctx.createRadialGradient(W / 2, H * 0.38, 10, W / 2, H * 0.38, 280);
  grd.addColorStop(0, '#1a1230'); grd.addColorStop(1, '#08070e');
  ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);

  if (currentScreen === 'breathing') {
    // ════════════════════════════════
    // BREATHING VIEW
    // ════════════════════════════════
    const CX = W / 2, CY = H / 2 - 10;
    const minR = 18, maxR = 150;
    const r = _pipBreathOrbR;
    const frac = (r - minR) / (maxR - minR);

    // outer glow ring (dim track)
    ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(CX, CY, 88, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.stroke();

    // gold arc — shows expansion fraction
    if (frac > 0.01) {
      ctx.beginPath();
      ctx.arc(CX, CY, 88, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      ctx.strokeStyle = 'rgba(201,183,156,0.6)'; ctx.stroke();
    }

    // orb dot (gold radial gradient, sized by breath)
    const orbGrd = ctx.createRadialGradient(CX - r * 0.18, CY - r * 0.18, r * 0.08, CX, CY, r);
    orbGrd.addColorStop(0, '#ecdcb4'); orbGrd.addColorStop(0.55, '#c9b79c'); orbGrd.addColorStop(1, '#9a8662');
    ctx.globalAlpha = Math.min(1, _pipBreathOrbOp + 0.15);
    ctx.beginPath(); ctx.arc(CX, CY, r, 0, Math.PI * 2);
    ctx.fillStyle = orbGrd; ctx.fill();
    ctx.globalAlpha = 1;

    // phase label — italic, gold
    if (_pipBreathPhase) {
      ctx.font = `italic 500 22px ${PIP_FONT}`;
      ctx.fillStyle = '#c9b79c'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(_pipBreathPhase, CX, CY + 116);
    }

    // count number (large, centred over orb when in hold)
    if (_pipBreathCount) {
      ctx.font = `300 38px ${PIP_FONT}`;
      ctx.fillStyle = '#ecdcb4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(_pipBreathCount, CX, CY);
    }

    // round indicator (top small label)
    if (_pipBreathRound) {
      ctx.font = `500 11px ${PIP_FONT}`;
      ctx.fillStyle = '#76708c'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.letterSpacing = '0.12em';
      ctx.fillText(_pipBreathRound.toUpperCase(), CX, 18);
      ctx.letterSpacing = '';
    }

    // bottom hint
    ctx.font = `400 11px ${PIP_FONT}`;
    ctx.fillStyle = '#4a4560';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('tap \u25B6 to skip', CX, H - 10);

  } else {
    // ════════════════════════════════
    // RUNNER VIEW
    // ════════════════════════════════

    // ── TOP: Task label marquee ──
    const LABEL_H = 38;
    const rawLabel = tasks[ci]?.label || '';
    ctx.font = `600 17px ${PIP_FONT}`;
    const measW = ctx.measureText(rawLabel).width;
    const LABEL_ZONE = W - 28;
    ctx.save();
    ctx.beginPath(); ctx.rect(14, 0, LABEL_ZONE, LABEL_H); ctx.clip();
    if (measW <= LABEL_ZONE) {
      ctx.fillStyle = '#efeaf2';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(rawLabel, W / 2, LABEL_H / 2);
    } else {
      _pipMarqueeX -= 0.9;
      const minX = -(measW - LABEL_ZONE + 20);
      if (_pipMarqueeX < minX) _pipMarqueeX = LABEL_ZONE + 10;
      ctx.fillStyle = '#efeaf2';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(rawLabel, 14 + _pipMarqueeX, LABEL_H / 2);
      const fadeL = ctx.createLinearGradient(14, 0, 44, 0);
      fadeL.addColorStop(0, '#08070e'); fadeL.addColorStop(1, 'rgba(8,7,14,0)');
      ctx.fillStyle = fadeL; ctx.fillRect(14, 0, 30, LABEL_H);
      const fadeR = ctx.createLinearGradient(LABEL_ZONE - 10, 0, LABEL_ZONE + 14, 0);
      fadeR.addColorStop(0, 'rgba(8,7,14,0)'); fadeR.addColorStop(1, '#08070e');
      ctx.fillStyle = fadeR; ctx.fillRect(LABEL_ZONE - 10, 0, 24, LABEL_H);
    }
    ctx.restore();

    // ── CENTRE: Circle ring + timecode ──
    const sl = remainingSec(), abs = Math.abs(sl);
    const timeTxt = `${Math.floor(abs / 60)}:${Math.floor(abs % 60).toString().padStart(2, '0')}`;
    const frac = clamp(sl / taskTotalSec, 0, 1);
    const CX = W / 2, CY = H / 2 + 8, R = 92;

    ctx.lineWidth = 10; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(CX, CY, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.stroke();

    if (frac > 0.002) {
      ctx.beginPath();
      // Empties clockwise: the arc's start edge sweeps clockwise as time runs
      // down, the end edge stays pinned at 12 o'clock.
      const startA = -Math.PI / 2 + Math.PI * 2 * (1 - frac);
      ctx.arc(CX, CY, R, startA, -Math.PI / 2 + Math.PI * 2);
      const ringGrd = ctx.createLinearGradient(CX - R, CY, CX + R, CY);
      ringGrd.addColorStop(0, '#9a8662'); ringGrd.addColorStop(0.5, '#c9b79c'); ringGrd.addColorStop(1, '#ecdcb4');
      ctx.strokeStyle = sl < 0 ? '#e6a98c' : ringGrd; ctx.stroke();
    }

    ctx.fillStyle = sl < 0 ? '#e6a98c' : '#efeaf2';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `300 ${sl < 0 ? '48' : '52'}px ${PIP_FONT}`;
    ctx.fillText(timeTxt, CX, CY - 4);

    // ── BOTTOM BAR: task X/Y + ETA ──
    const BOT_Y = H - 14;
    const taskFrac = tasks.length > 0 ? `${ci + 1} / ${tasks.length}` : '';
    const eta = fmtTime(calcETA());

    ctx.font = `500 13px ${PIP_FONT}`;
    ctx.fillStyle = '#a59cb8';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(taskFrac, 18, BOT_Y);

    ctx.textAlign = 'right';
    ctx.fillStyle = paused ? '#c9b79c' : '#76708c';
    ctx.fillText(paused ? '\u23F8  paused' : `ends ${eta}`, W - 18, BOT_Y);
  }

  ctx.restore(); // undo the 2× scale
}
async function togglePiP() {
  if (!pipReady) setupPiP(); if (!pipReady) { toast('Picture-in-picture unavailable here'); return; }
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    // Paint a frame using actual canvas dimensions, ensure stream is playing,
    // then request — all inside this tap so the browser treats it as a user gesture.
    const ctx = pipCanvas.getContext('2d');
    ctx.fillStyle = '#08070e'; ctx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);
    drawPiP();
    await pipVideo.play();
    if (pipVideo.readyState < 2) await new Promise(r => { pipVideo.onloadeddata = r; setTimeout(r, 400); });
    await pipVideo.requestPictureInPicture();
  } catch (e) { toast('Picture-in-picture unavailable here'); }
}
// Keep painting while PiP is active — fast enough for breathing orb animation
setInterval(() => { if (document.pictureInPictureElement === pipVideo) drawPiP(); }, 33);

// ── Wake lock ──
let wakeLock = null;
async function reqWakeLock() {
  try {
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { wakeLock = null; }
}
// Re-acquire every 15s while a flow (or the breathing lead-in) is on screen —
// the OS can silently drop the lock; this keeps the screen on like Netflix does.
setInterval(() => {
  if ((currentScreen === 'runner' || currentScreen === 'breathing') && !wakeLock && document.visibilityState === 'visible') reqWakeLock();
}, 15000);
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    initAudio();
    if (currentScreen === 'runner' || currentScreen === 'breathing') { if (!wakeLock) reqWakeLock(); if (currentScreen === 'runner') tick(); }
    if (rafId) { cancelAnimationFrame(rafId); startRAF(); }
  }
  // auto-PiP on background is handled by the autopictureinpicture attribute on the video element;
  // calling requestPictureInPicture() here is NOT a user gesture and is silently blocked on mobile.
});

// ═══════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════
function logTaskEvent(outcome) {
  if (!currentFlow || !tasks[ci]) return;
  const actual = Math.round((Date.now() - taskStartMs) / 1000);
  logEvent({
    flow: currentFlow.name, taskIndex: ci, taskLabel: tasks[ci].label,
    allotted: taskTotalSec, actual, delta: taskTotalSec - actual,
    outcome, device: deviceType, session: sessionId
  }).catch(() => {});
}
async function markDone() {
  if (awaitingAddConfirm) return;
  document.getElementById('overtimeOverlay').classList.remove('active');
  document.getElementById('nudgeOverlay').classList.remove('active');
  clearTimeout(nudgeTimer); clearTimeout(pauseNudgeTimer);
  const sl = remainingSec();
  tgain += sl;                        // + if early, − if overtime
  logTaskEvent(sl < 0 ? 'overtime-done' : 'completed');
  running = false; stopTicking(); chimeStart(); haptic(700);
  speak(await nextFromBag('encBag', ENC_DONE));
  ci++; updHeader(); setTimeout(() => loadTask(ci), 800);
}
function togglePauseTimer() {
  if (!running && !paused) return;
  paused = !paused; haptic(80); updPause(); updMediaSession();
  document.getElementById('mainArea').classList.toggle('paused', paused);
  setOrbRunning(!paused);
  if (paused) {
    pauseStartMs = Date.now();
    taskRemainingMs = taskEndAt - Date.now();   // freeze (signed)
    running = false; stopTicking(); speak('Paused');
    clearTimeout(pauseNudgeTimer);
    pauseNudgeTimer = setTimeout(() => { if (paused) { hapticBurst(); showNudge(); } }, 300000);
  } else {
    pausedAccumMs += Date.now() - pauseStartMs;
    resumeTimer(); startTicking(); speak("Let's go"); clearTimeout(pauseNudgeTimer);
  }
}
// +1/+2 buttons: single tap, immediate (no confirm) — fixes the unresponsive double-tap
function addTime(mins, quiet) {
  haptic(80);
  taskRemainingMs = (running ? taskEndAt - Date.now() : taskRemainingMs) + mins * 60000;
  taskTotalSec += mins * 60; tgain -= mins * 60;
  if (running) taskEndAt = Date.now() + taskRemainingMs;
  overtimeShown = remainingSec() <= 0;
  if (running) startTicking();
  updTimer(); updHeader();
  toast(`+${mins} min`);
  if (!quiet) speak(`Added ${mins} minute${mins > 1 ? 's' : ''}.`);
}
// Voice path keeps a confirm step
function requestAddTime(mins) {
  pendingAddMins = mins; awaitingAddConfirm = true;
  document.getElementById('confirmText').textContent = `Add ${mins} minute${mins > 1 ? 's' : ''}?`;
  document.getElementById('confirmOverlay').classList.add('active');
  speak(`Add ${mins} minute${mins > 1 ? 's' : ''}? Say yes to confirm.`);
}
function confirmAddTime() { document.getElementById('confirmOverlay').classList.remove('active'); awaitingAddConfirm = false; const m = pendingAddMins; pendingAddMins = 0; addTime(m); }
function cancelAddTime() { document.getElementById('confirmOverlay').classList.remove('active'); awaitingAddConfirm = false; pendingAddMins = 0; haptic(40); }

// Overtime overlay — clearly LABELLED buttons (fixes "tick acted like done")
function showOvertime() {
  const e = ENC_OT[Math.floor(Math.random() * ENC_OT.length)];
  document.getElementById('overtimeTitle').textContent = e.t;
  document.getElementById('overtimeText').textContent = e.p;
  document.getElementById('overtimeOverlay').classList.add('active');
  speak(e.t + ' ' + e.p);
}
function overtimeAddTime() { document.getElementById('overtimeOverlay').classList.remove('active'); clearTimeout(nudgeTimer); addTime(2, true); speak("Two minutes to finish strong. You've got this."); }
function overtimeDone() { document.getElementById('overtimeOverlay').classList.remove('active'); clearTimeout(nudgeTimer); markDone(); }

function showNudge() {
  document.getElementById('overtimeOverlay').classList.remove('active');
  const n = NUDGES[Math.floor(Math.random() * NUDGES.length)];
  document.getElementById('nudgeTitle').textContent = n.t;
  document.getElementById('nudgeText').textContent = n.p;
  document.getElementById('nudgeOverlay').classList.add('active');
  speak(n.t + ' ' + n.p);
}
function dismissNudge() { haptic(80); document.getElementById('nudgeOverlay').classList.remove('active'); speak("There she is. Let's keep going."); }

function stopSequence() {
  haptic(120);
  if (currentFlow && ci < tasks.length && running) logTaskEvent('stopped');
  running = false; clearInterval(tickTimer); stopTicking(); stopRecog(); cancelAnimationFrame(rafId);
  clearTimeout(nudgeTimer); clearTimeout(pauseNudgeTimer);
  setAudioMode(false); releaseWakeLock(); cancelSpeech();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  if (currentFlow && ci < tasks.length) {
    if (confirm('Bookmark your spot to resume later?')) setBookmark(currentFlow.id, ci);
  }
  if (currentFlow) addRunRecord(currentFlow.id, { started: flowStartMs, finished: Date.now(), tasksCompleted: ci, totalTasks: tasks.length, elapsed: Math.round(totalElapsedSec()), gained: Math.round(tgain), device: deviceType });
  renderHome();
}

// ── Breaks ──
function tryBreak() { if (!breakPending) return false; breakPending = false; lastBreakMs = Date.now(); showBreakScreen(); return true; }
function checkBreakTime() { if (breakPending) return; if ((Date.now() - lastBreakMs) / 1000 >= 900) breakPending = true; }
let breakTi = null;
function breakOverlayActive() { return document.getElementById('breakScreen2').classList.contains('active'); }
function showBreakScreen() {
  running = false; stopTicking();
  const set = activeBreaks();
  const b = set[Math.floor(Math.random() * set.length)];
  document.getElementById('breakTitle').textContent = b.title;
  document.getElementById('breakInstruction').textContent = b.instruction;
  document.getElementById('breakTimer').textContent = '';
  document.getElementById('breakPhase').textContent = '';
  document.getElementById('breakCountdown').textContent = '';
  const tap = document.getElementById('breakTap');
  tap.textContent = "I'm ready"; tap.style.display = 'inline-flex'; tap.dataset.secs = b.secs;
  document.getElementById('breakHold').style.display = 'none';
  breakAwaitingStart = false; breakStarted = false;
  document.getElementById('breakScreen2').classList.add('active'); haptic(700);
  speak(`Break time. ${b.title}. ${b.instruction}`, () => { if (breakOverlayActive() && !breakAwaitingStart && !breakStarted) beginBreakCountdown(); });
}
function beginBreakCountdown() {
  if (breakStarted) return;
  breakCountdownLeft = Math.max(1, S.breakCountdown || 5);
  const cd = document.getElementById('breakCountdown');
  cd.textContent = breakCountdownLeft;
  document.getElementById('breakHold').style.display = 'inline-flex';
  const tap = document.getElementById('breakTap');
  tap.textContent = "I'm ready"; tap.style.display = 'inline-flex';
  clearInterval(breakCountdownTimer);
  breakCountdownTimer = setInterval(() => {
    breakCountdownLeft--;
    if (breakCountdownLeft <= 0) { clearInterval(breakCountdownTimer); cd.textContent = ''; startBreak2(); return; }
    cd.textContent = breakCountdownLeft;
  }, 1000);
}
function holdBreakCountdown() {
  haptic(40); clearInterval(breakCountdownTimer); breakAwaitingStart = true;
  document.getElementById('breakCountdown').textContent = '';
  document.getElementById('breakHold').style.display = 'none';
  const tap = document.getElementById('breakTap');
  tap.textContent = "I'm ready"; tap.style.display = 'inline-flex';
}
function startBreak2() {
  if (!breakOverlayActive() || breakStarted) return;
  breakStarted = true;
  clearInterval(breakCountdownTimer); breakAwaitingStart = false;
  cancelSpeech(); haptic(80);
  document.getElementById('breakTap').style.display = 'none';
  document.getElementById('breakHold').style.display = 'none';
  document.getElementById('breakCountdown').textContent = '';
  let s = parseInt(document.getElementById('breakTap').dataset.secs) || 30;
  document.getElementById('breakPhase').textContent = 'HOLD IT';
  document.getElementById('breakTimer').textContent = `0:${s.toString().padStart(2, '0')}`;
  clearInterval(breakTi);
  breakTi = setInterval(() => {
    s--; document.getElementById('breakTimer').textContent = `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
    if (s <= 0) { clearInterval(breakTi); document.getElementById('breakScreen2').classList.remove('active'); haptic(700); chimeStart(); speak('Beautiful. Back to it.'); loadTask(ci); }
  }, 1000);
}

// ═══════════════════════════════════════════
// COMPLETE
// ═══════════════════════════════════════════
async function completeAll() {
  running = false; clearInterval(tickTimer); stopTicking(); stopRecog(); cancelAnimationFrame(rafId);
  clearTimeout(nudgeTimer); clearTimeout(pauseNudgeTimer); setAudioMode(false); releaseWakeLock();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  const te = Math.round(totalElapsedSec()), m = Math.floor(te / 60), s = te % 60;
  const g = Math.round(tgain), gm = Math.floor(Math.abs(g) / 60), gs = Math.abs(g) % 60;
  document.getElementById('finalStats').innerHTML =
    `<div>Started <span>${flowStartMs ? fmtTime(new Date(flowStartMs)) : '--'}</span></div>` +
    `<div>Finished <span>${fmtTime(new Date())}</span></div>` +
    `<div>Total time <span>${m}m ${s}s</span></div>` +
    `<div>Time ${g >= 0 ? 'saved' : 'over'} <span>${gm}m ${gs}s</span></div>` +
    `<div>Tasks completed <span>${tasks.length}</span></div>`;
  document.getElementById('progressFill').style.width = '100%';
  document.getElementById('stepCount').textContent = `${tasks.length} / ${tasks.length}`;
  if (currentFlow) addRunRecord(currentFlow.id, { started: flowStartMs, finished: Date.now(), tasksCompleted: tasks.length, totalTasks: tasks.length, elapsed: te, gained: g, device: deviceType });
  showScreen('complete');
  chimeComplete(); haptic(700);
  const closer = (currentFlow && currentFlow.aiCloser) ? currentFlow.aiCloser : COMPLETE_CLOSER_DEFAULT;
  speak(`${COMPLETE_PRE} ${closer} ${COMPLETE_POST}`);
}
function resetApp() { haptic(40); renderHome(); }

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
async function openSettings() {
  haptic(40); showScreen('settings');
  initBrowserVoices();
  populateElDropdown(await fetchElVoices());
  const slider = document.getElementById('speedSlider'), disp = document.getElementById('speedDisplay');
  slider.value = elSpeed; disp.textContent = elSpeed.toFixed(2) + 'x';
  document.getElementById('elKeyInput').value = EL_KEY && EL_KEY.length > 10 ? '••••••••' + EL_KEY.slice(-4) : '';
  document.getElementById('defaultMin').value = Math.floor(S.defaultSecs / 60);
  document.getElementById('defaultSec').value = S.defaultSecs % 60;
  document.getElementById('maxItemsInput').value = S.maxItems;
  document.getElementById('enforceMaxToggle').checked = S.enforceMax;
  document.getElementById('drainToggle').checked = S.drainMode;
  document.getElementById('takeoverToggle').checked = S.audioTakeover;
  document.getElementById('voiceRecogToggle').checked = S.voiceRecog;
  document.getElementById('tickingToggle').checked = S.ticking;
  document.getElementById('deviceNameInput').value = Sync.deviceName || '';
  document.getElementById('syncUrlInput').value = await getSetting('syncUrl', '');
  document.getElementById('syncSpaceInput').value = await getSetting('syncSpace', '');
  document.getElementById('doneWordsList').textContent = DONE_WORDS.join(' · ');
  document.getElementById('breakCountdownInput').value = S.breakCountdown;
  document.getElementById('workFriendlyToggle').checked = S.workFriendlyBreaks;
  document.getElementById('microStepsToggle').checked = S.microSteps;
  document.getElementById('duckAudioToggle').checked = S.duckAudio;
  document.getElementById('vibrateToggle').checked = S.vibrateAlerts;
  document.getElementById('aiBufferInput').value = S.aiBuffer;
  document.getElementById('deviceTypeSelect').value = await getSetting('deviceTypeOverride', 'auto');
  if (window.AI) AI.populateSettings();
  renderPronunciationList();
}
async function saveBreakCountdown() {
  S.breakCountdown = Math.max(1, Math.min(30, parseInt(document.getElementById('breakCountdownInput').value) || 5));
  await setSetting('breakCountdown', S.breakCountdown);
}
async function toggleVibrate() {
  const el = document.getElementById('vibrateToggle');
  if (!el.checked) {
    // Turning the buzz off is meant to be hard. Type it to mean it.
    const typed = prompt('Vibration keeps alerts felt even when sound is low.\n\nType OFF (capitals) to disable it:');
    if (typed !== 'OFF') { el.checked = true; return; }
  }
  S.vibrateAlerts = el.checked;
  await setSetting('vibrateAlerts', S.vibrateAlerts);
  if (el.checked) haptic(120);
}
async function toggleWorkFriendly() { S.workFriendlyBreaks = document.getElementById('workFriendlyToggle').checked; await setSetting('workFriendlyBreaks', S.workFriendlyBreaks); }
async function toggleMicroSteps() { S.microSteps = document.getElementById('microStepsToggle').checked; await setSetting('microSteps', S.microSteps); }
async function toggleDuckAudio() { S.duckAudio = document.getElementById('duckAudioToggle').checked; await setSetting('duckAudio', S.duckAudio); window.flowDuckAudio = S.duckAudio; }
async function saveAiBuffer() {
  S.aiBuffer = Math.max(0, Math.min(300, parseInt(document.getElementById('aiBufferInput').value) || 30));
  await setSetting('aiBuffer', S.aiBuffer);
}
async function saveDeviceType() {
  const v = document.getElementById('deviceTypeSelect').value;
  await setSetting('deviceTypeOverride', v);
  deviceType = (v && v !== 'auto') ? v : FlowDevice.type;
  document.body.classList.toggle('tv', deviceType === 'tv');
  toast('Device type saved — reopen the app to apply fully');
}
async function testSync() {
  haptic(40);
  const r = await Sync.test();
  toast(r.ok ? `Connected ✓ — ${r.count} flow${r.count === 1 ? '' : 's'} in the cloud` : 'Could not reach sync — check the URL and shared key');
}
async function syncNow() {
  haptic(40); toast('Syncing…');
  const n = await Sync.mergeRemote();
  toast(n > 0 ? `Synced — ${n} update${n === 1 ? '' : 's'} pulled` : 'Synced — already up to date');
  if (currentScreen === 'home') renderHome();
  if (currentScreen === 'library') renderLibrary();
}
async function saveElVoicePref() { elVoiceId = document.getElementById('elVoiceSelect').value; await setSetting('elVoiceId', elVoiceId); }
function updateSpeedSlider() {
  const raw = parseFloat(document.getElementById('speedSlider').value);
  elSpeed = snapSpeed(raw); document.getElementById('speedSlider').value = elSpeed;
  const disp = document.getElementById('speedDisplay');
  disp.textContent = elSpeed.toFixed(2) + 'x';
  disp.style.color = SNAP_POINTS.includes(elSpeed) ? 'var(--gold)' : 'var(--muted)';
}
async function saveSpeedPref() { await setSetting('elSpeed', elSpeed); }
function saveBrowserVoicePref() { const sel = document.getElementById('browserVoiceSelect'); setSetting('browserVoice', sel.value); selBrowserVoice = speechSynthesis.getVoices()[parseInt(sel.value)]; }
function previewVoice() { speak("You've got this, gorgeous. Let's flow."); }
async function saveElKey() {
  const v = document.getElementById('elKeyInput').value.trim();
  if (!v || v.startsWith('•')) return;
  EL_KEY = v; await setSetting('elKey', v);
  toast('Voice key saved'); populateElDropdown(await fetchElVoices());
}
async function saveDefaultTime() {
  const m = Math.max(0, Math.min(120, parseInt(document.getElementById('defaultMin').value) || 0));
  const s = Math.max(0, Math.min(59, parseInt(document.getElementById('defaultSec').value) || 0));
  S.defaultSecs = Math.max(5, m * 60 + s); await setSetting('defaultSecs', S.defaultSecs);
}
async function saveMaxItems() { S.maxItems = Math.max(1, Math.min(200, parseInt(document.getElementById('maxItemsInput').value) || 20)); await setSetting('maxItems', S.maxItems); }
async function toggleEnforceMax() { S.enforceMax = document.getElementById('enforceMaxToggle').checked; await setSetting('enforceMax', S.enforceMax); }
async function toggleDrain() { S.drainMode = document.getElementById('drainToggle').checked; await setSetting('drainMode', S.drainMode); }
async function toggleTakeover() { S.audioTakeover = document.getElementById('takeoverToggle').checked; audioTakeover = S.audioTakeover; await setSetting('audioTakeover', S.audioTakeover); }
async function toggleVoiceRecog() { S.voiceRecog = document.getElementById('voiceRecogToggle').checked; await setSetting('voiceRecog', S.voiceRecog); if (currentScreen === 'runner') { S.voiceRecog ? startRecog() : stopRecog(); } }
async function toggleTicking() { S.ticking = document.getElementById('tickingToggle').checked; await setSetting('ticking', S.ticking); if (!S.ticking) stopTicking(); }
async function saveDeviceName() { Sync.deviceName = document.getElementById('deviceNameInput').value.trim(); }
async function saveSyncUrl() { await setSetting('syncUrl', document.getElementById('syncUrlInput').value.trim().replace(/\/+$/, '')); toast('Sync saved — reopen the app to apply'); }
async function saveSyncSpace() { await setSetting('syncSpace', document.getElementById('syncSpaceInput').value.trim()); }

async function renderPronunciationList() {
  const dict = await getPronunciations();
  const list = document.getElementById('pronList'); list.innerHTML = '';
  if (!dict.length) { list.innerHTML = '<div class="empty-hint">No custom pronunciations yet.</div>'; return; }
  dict.forEach(e => {
    const div = document.createElement('div'); div.className = 'pron-item';
    div.innerHTML = `<span class="pron-word">${esc(e.word)}</span><span class="pron-arrow">→</span><span class="pron-phonetic">${esc(e.phonetic)}</span><button class="pron-del focusable" onclick="removePron('${esc(e.word)}')" aria-label="Remove">✕</button>`;
    list.appendChild(div);
  });
}
async function addPron() {
  const w = document.getElementById('pronWord').value.trim(), p = document.getElementById('pronPhonetic').value.trim();
  if (!w || !p) return;
  await setPronunciation(w, p);
  document.getElementById('pronWord').value = ''; document.getElementById('pronPhonetic').value = '';
  renderPronunciationList(); haptic(40);
}
async function removePron(w) { await deletePronunciation(w); renderPronunciationList(); haptic(40); }

async function exportData() {
  const blob = new Blob([await exportAllData()], { type: 'application/json' });
  downloadBlob(blob, 'flowstate-backup.json'); haptic(40); toast('Backup downloaded');
}
function triggerImport() { document.getElementById('importInput').click(); }
async function handleImport(e) {
  const file = e.target.files[0]; if (!file) return;
  try { const n = await importData(await file.text()); toast(`Imported ${n} flows`); haptic(120); renderHome(); }
  catch (err) { toast('Import failed'); }
  e.target.value = '';
}
async function clearCache() { if (confirm('Clear cached voice audio? Your flows stay.')) { await clearAudioCache(); haptic(40); toast('Audio cache cleared'); } }
async function exportCSV() {
  const csv = await eventsToCSV();
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `flowstate-history-${new Date().toISOString().slice(0, 10)}.csv`);
  haptic(40); toast('History CSV downloaded');
}
async function clearEventsData() { if (confirm('Clear all logged history? Your flows stay.')) { await clearEvents(); haptic(40); toast('History cleared'); } }
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url); }

// ═══════════════════════════════════════════
// TAP ANYWHERE = DONE — single tap, like the old version
// ═══════════════════════════════════════════
function setupMainAreaTap() {
  const area = document.getElementById('runnerScreen');
  area.addEventListener('click', e => {
    if (currentScreen !== 'runner' || paused || awaitingAddConfirm) return;
    if (e.target.closest('button,select,input,a,.controls-zone,.icon-btn,.addtime-btn,.jump-select')) return;
    markDone();
  });
}

// ── Toast ──
let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
async function loadSettings() {
  S.defaultSecs = await getSetting('defaultSecs', 300);
  S.maxItems = await getSetting('maxItems', 20);
  S.enforceMax = await getSetting('enforceMax', true);
  S.drainMode = await getSetting('drainMode', true);
  S.audioTakeover = await getSetting('audioTakeover', true);
  S.voiceRecog = await getSetting('voiceRecog', false);
  S.ticking = await getSetting('ticking', true);
  S.breakCountdown = await getSetting('breakCountdown', 5);
  S.vibrateAlerts = await getSetting('vibrateAlerts', true);
  S.aiBuffer = await getSetting('aiBuffer', 30);
  S.workFriendlyBreaks = await getSetting('workFriendlyBreaks', false);
  S.microSteps = await getSetting('microSteps', false);
  S.duckAudio = await getSetting('duckAudio', false);
  const ov = await getSetting('deviceTypeOverride', 'auto');
  deviceType = (ov && ov !== 'auto') ? ov : FlowDevice.type;
  window.flowDuckAudio = S.duckAudio;
}
async function initApp() {
  await loadSettings();
  document.body.classList.toggle('tv', deviceType === 'tv');

  // ── Paint first. The home screen must never wait on the network. ──
  await renderHome();

  // ── Everything else is background work ──
  try { await initTTS(); } catch (e) { console.warn('TTS init:', e); }
  try { await Sync.init(); } catch (e) { console.warn('Sync init:', e); }
  if (window.AI) { try { await AI.init(); } catch (e) {} }
  syncEnabled = Sync.enabled();

  let firstMerge = Promise.resolve(0);
  if (syncEnabled) {
    // Pull the shared library down quietly, then refresh whatever's on screen.
    firstMerge = Sync.mergeRemote().catch(() => 0);
    firstMerge.then(n => {
      if (n > 0) { if (currentScreen === 'home') renderHome(); if (currentScreen === 'library') renderLibrary(); }
    });
    // Keep every device's library fresh in the background.
    setInterval(async () => {
      if (currentScreen === 'runner' || currentScreen === 'breathing') return;
      const n = await Sync.mergeRemote().catch(() => 0);
      if (n > 0) { if (currentScreen === 'home') renderHome(); if (currentScreen === 'library') renderLibrary(); }
    }, 20000);
  }

  // TV receives "play on TV" handoffs from the phone — make sure the flow is
  // pulled down first, then launch it.
  if (deviceType === 'tv' && syncEnabled) {
    Sync.startPolling(async cmd => {
      if (!cmd || cmd.action !== 'play' || !cmd.flowId) return;
      let f = await getFlow(cmd.flowId);
      if (!f) { await Sync.mergeRemote().catch(() => {}); f = await getFlow(cmd.flowId); }
      if (f) launchFlow(cmd.flowId, cmd.startAt || 0);
    });
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  setupMainAreaTap();

  // resume audio on first gesture (autoplay policies)
  const unlock = () => { initAudio(); document.removeEventListener('pointerdown', unlock); document.removeEventListener('keydown', unlock); };
  document.addEventListener('pointerdown', unlock); document.addEventListener('keydown', unlock);

  // periodic break check
  setInterval(() => { if (currentScreen === 'runner' && running && !paused) checkBreakTime(); }, 5000);

  // ── Deep links (for ADB / Tasker / shortcuts): ──
  //   index.html?flow=<flow id or exact flow name>          → launches it
  //   index.html?flow=Morning%20Reset&start=2               → starts at task 3
  // Works on any device, including the TV.
  try {
    const p = new URLSearchParams(location.search);
    const want = p.get('flow');
    if (want) {
      // A deep-linked flow may live only in the cloud — give the first
      // merge a moment, but never wait more than 3s.
      await Promise.race([firstMerge, new Promise(r => setTimeout(r, 3000))]);
      const all = await getAllFlows();
      const match = all.find(x => x.id === want) || all.find(x => x.name.toLowerCase() === want.toLowerCase());
      if (match) {
        const startAt = parseInt(p.get('start') || '0') || 0;
        // strip params so a reload doesn't relaunch
        history.replaceState(null, '', location.pathname);
        launchFlow(match.id, startAt);
      } else {
        toast('Flow not found: ' + want);
      }
    }
  } catch (e) {}
}
openDB().then(initApp).catch(e => console.error('DB init failed:', e));
