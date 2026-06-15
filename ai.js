// ═══════════════════════════════════════════
// BAVI FlowState v11 — AI layer (Groq)
// Two separate keys, two separate jobs:
//   1. TIMING key  — drafts how long each task should really get, from your
//      own history + common sense, with a small buffer.
//   2. LANGUAGE key — reads the routine you just ran and writes ONE
//      replacement for the "That first sip is yours." clause that actually
//      fits it. Everything else in the completion line stays verbatim.
// Keys live only in this device's IndexedDB. No key = silent no-op,
// the app behaves exactly as before.
// ═══════════════════════════════════════════
window.AI = (function () {
  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const DEFAULT_MODEL_TIME = 'llama-3.3-70b-versatile';
  const DEFAULT_MODEL_LANG = 'llama-3.3-70b-versatile';

  let keyTime = '', keyLang = '';
  let modelTime = DEFAULT_MODEL_TIME, modelLang = DEFAULT_MODEL_LANG;

  async function init() {
    keyTime = await getSetting('groqKeyTime', '');
    keyLang = await getSetting('groqKeyLang', '');
    modelTime = await getSetting('groqModelTime', DEFAULT_MODEL_TIME);
    modelLang = await getSetting('groqModelLang', DEFAULT_MODEL_LANG);
  }

  // ── Raw Groq call ──
  async function chat(key, model, system, user, maxTokens) {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: maxTokens || 1024,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    if (!r.ok) throw new Error('Groq ' + r.status);
    const data = await r.json();
    const txt = (data.choices && data.choices[0] && data.choices[0].message.content) || '{}';
    return JSON.parse(txt.replace(/```json|```/g, '').trim());
  }

  // ── History lookup ──
  function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
  function median(arr) {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
  }
  async function historyFor(label) {
    const events = await getAllEvents();
    const n = norm(label);
    // exact label match first; fall back to loose containment for "similar" tasks
    let hits = events.filter(e => norm(e.taskLabel) === n && e.actual > 0);
    if (hits.length < 2) {
      hits = hits.concat(events.filter(e => {
        const en = norm(e.taskLabel);
        return en !== n && e.actual > 0 && (en.includes(n) || n.includes(en)) && Math.min(en.length, n.length) >= 4;
      }));
    }
    const actuals = hits.map(h => h.actual);
    const allotteds = hits.map(h => h.allotted);
    return { count: hits.length, medianActual: median(actuals), medianAllotted: median(allotteds) };
  }

  // ═══════════════════════════════════════════
  // 1) AI TIMINGS — the formula, stated plainly:
  //    • history exists →
  //        base = median of how long you ACTUALLY took
  //        if your inputted time > actual: trust actual, keep only a sliver of
  //          the over-allocation:  best = actual + min(buffer, 25% of the gap)
  //        if your inputted time < actual: you under-budget this one:
  //          best = actual + buffer
  //    • no history → what a normal human takes for that task, sanity-checked
  //      against your inputted time, + buffer
  //    • buffer defaults to 30s (Settings → AI)
  // ═══════════════════════════════════════════
  async function draftTimings(tasksArr, bufferSecs) {
    if (!keyTime) { toast('Add your Groq timing key in Settings first'); return null; }
    const buffer = bufferSecs != null ? bufferSecs : 30;
    const ctx = [];
    for (let i = 0; i < tasksArr.length; i++) {
      const t = tasksArr[i];
      const h = await historyFor(t.label);
      ctx.push({
        i,
        label: t.label,
        inputted_secs: t.secs,
        history_runs: h.count,
        median_actual_secs: h.medianActual,
        median_allotted_secs: h.medianAllotted
      });
    }
    const system =
      'You estimate realistic task durations for a personal routine timer. ' +
      'Respond ONLY with JSON: {"timings":[{"i":<index>,"secs":<integer seconds>}...]} — one entry per task, every index present.';
    const user =
      'Buffer to add: ' + buffer + ' seconds.\n' +
      'Rules, in priority order:\n' +
      '1. If median_actual_secs exists (history_runs >= 1), anchor on it — it is how long this person REALLY takes.\n' +
      '   - If inputted_secs > median_actual_secs: secs = median_actual_secs + min(buffer, round(0.25 * (inputted_secs - median_actual_secs))).\n' +
      '   - If inputted_secs <= median_actual_secs: secs = median_actual_secs + buffer.\n' +
      '2. If no history: estimate what a typical person needs for this exact task, sanity-check against inputted_secs (do not exceed 2x inputted unless inputted is clearly absurd, e.g. 10s to shower), then add the buffer.\n' +
      '3. Round to a sensible figure (nearest 15s under 5 min, nearest 30s above). Minimum 30s, maximum 7200s.\n\n' +
      'Tasks:\n' + JSON.stringify(ctx, null, 1);
    try {
      const out = await chat(keyTime, modelTime, system, user, 2048);
      const arr = out.timings || out.tasks || [];
      const map = {};
      arr.forEach(t => { if (t && t.i != null && t.secs) map[t.i] = Math.max(30, Math.min(7200, Math.round(t.secs))); });
      return map;
    } catch (e) {
      console.warn('AI timings failed', e);
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // 2) LANGUAGE — the routine-aware closer.
  //    Logic it follows: read the task list → infer what kind of routine this
  //    was (morning, cleaning, work sprint, wind-down…) → write one clause in
  //    the exact register of "That first sip is yours." — second person,
  //    intimate, a small earned reward tied to what was just finished.
  //    It replaces ONLY that clause. If anything fails, the original line is
  //    spoken verbatim.
  // ═══════════════════════════════════════════
  async function prepareCloser(flow, tasksArr) {
    if (!keyLang || !flow) return;
    const sig = (tasksArr || []).map(t => t.label).join('|').slice(0, 400);
    if (flow.aiCloser && flow.aiCloserFor === sig) return;   // already drafted for this exact list
    const system =
      'You write ONE short closing clause for a routine timer\'s completion line. ' +
      'The full line is: "You did it. Every single one. <CLOSER> Enjoy it, beautiful." ' +
      'The canonical closer is "That first sip is yours." — same intimacy, same rhythm, second person, max 8 words, ends with a period, names a small earned reward or sensation that fits the routine just completed. ' +
      'No emojis, no exclamation marks, no questions. Respond ONLY with JSON: {"closer":"..."}';
    const user = 'Tasks just completed, in order:\n- ' + (tasksArr || []).map(t => t.label).join('\n- ');
    try {
      const out = await chat(keyLang, modelLang, system, user, 100);
      let c = (out.closer || '').trim();
      if (!c || c.length > 70) return;
      if (!/[.!]$/.test(c)) c += '.';
      flow.aiCloser = c;
      flow.aiCloserFor = sig;
      await saveFlow(flow);
      try { Sync.pushFlow(flow); } catch (e) {}
    } catch (e) { /* fall back to the original line */ }
  }

  // ── Settings UI ──
  function mask(k) { return k && k.length > 10 ? '••••••••' + k.slice(-4) : ''; }
  function populateSettings() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('groqKeyTime', mask(keyTime));
    set('groqKeyLang', mask(keyLang));
    set('groqModelTime', modelTime);
    set('groqModelLang', modelLang);
  }
  async function saveKey(which) {
    const el = document.getElementById(which === 'time' ? 'groqKeyTime' : 'groqKeyLang');
    const v = el.value.trim();
    if (!v || v.startsWith('•')) return;
    if (which === 'time') { keyTime = v; await setSetting('groqKeyTime', v); }
    else { keyLang = v; await setSetting('groqKeyLang', v); }
    toast('Groq key saved');
  }
  async function saveModel(which) {
    const el = document.getElementById(which === 'time' ? 'groqModelTime' : 'groqModelLang');
    const v = el.value.trim() || (which === 'time' ? DEFAULT_MODEL_TIME : DEFAULT_MODEL_LANG);
    if (which === 'time') { modelTime = v; await setSetting('groqModelTime', v); }
    else { modelLang = v; await setSetting('groqModelLang', v); }
  }

  return { init, draftTimings, prepareCloser, populateSettings, saveKey, saveModel };
})();

// ── Editor hook: the "✦ AI timings" button in the parse preview ──
async function aiDraftTimings() {
  haptic(40);
  if (!editorTasks.length) return;
  toast('AI is drafting your timings…');
  const map = await AI.draftTimings(editorTasks, S.aiBuffer);
  if (!map) { toast('AI timings unavailable — check your Groq key'); return; }
  let changed = 0;
  editorTasks.forEach((t, i) => { if (map[i] && map[i] !== t.secs) { t.secs = map[i]; changed++; } });
  renderEditorPreview();
  toast(changed ? `AI set ${changed} timing${changed === 1 ? '' : 's'} — tweak any of them right here` : 'Your timings already look right');
}
