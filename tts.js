// ═══════════════════════════════════════════
// BAVI FlowState v11 — TTS Engine
// ═══════════════════════════════════════════
// Key handling: stored in IndexedDB (paste once in Settings → persists).
// Optional deploy-time bake: replace the token __ELEVENLABS_KEY__ below.
const BAKED_EL_KEY = '__ELEVENLABS_KEY__';
const EL_MODEL = 'eleven_turbo_v2_5';   // 0.5 credits/char

let EL_KEY = '';
let elVoiceId = '';
let elVoicesCache = null;
let elSpeed = 1.0;
let audioTakeover = true;                // pause other apps' audio while a flow runs
let audioDuck = false;                   // only grab focus around prompts, then hand it back
let _flowAudioRunning = false;           // is a flow (or its breathing lead-in) live?
let speechQueue = [];
let isSpeaking = false;
let selBrowserVoice = null;

function isElEnabled() { return !!EL_KEY && EL_KEY.length > 10; }

// ── Hardcoded pronunciation overrides ──
const HARDCODED_PRON = {
  'shaambavi': 'Shaam-buh-vee',
  'flowstate': 'Flow State',
};

async function processText(text) {
  let result = text;
  for (const [word, phonetic] of Object.entries(HARDCODED_PRON)) {
    const regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    result = result.replace(regex, phonetic);
  }
  result = await applyPronunciations(result);
  return result;
}

// ── Audio focus: take over the system audio session like a nav app ──
function setAudioMode(running) {
  _flowAudioRunning = running;
  audioDuck = !!window.flowDuckAudio;
  try {
    if ('audioSession' in navigator) {
      // 'playback' takes audio focus (pauses Spotify/podcasts); 'ambient' mixes.
      // Duck mode rests in 'ambient' and only grabs 'playback' around prompts
      // (see speechFocus) so podcasts/audiobooks pause then resume, instead of
      // staying paused for the whole flow.
      const rest = audioTakeover ? (audioDuck ? 'ambient' : 'playback') : 'ambient';
      navigator.audioSession.type = running ? rest : 'auto';
    }
  } catch (e) {}
}
// Grab audio focus just for the duration of a spoken line / chime, then return
// to the flow's resting mode. Other apps' audio pauses while we talk and picks
// back up after — the closest the web gets to ducking.
function speechFocus(on) {
  if (!audioDuck || !audioTakeover || !_flowAudioRunning) return;
  try {
    if ('audioSession' in navigator) navigator.audioSession.type = on ? 'playback' : 'ambient';
  } catch (e) {}
}

// ── ElevenLabs voices ──
async function fetchElVoices() {
  if (!isElEnabled()) return [];
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', {
      headers: { 'xi-api-key': EL_KEY }, signal: ac.signal
    }).finally(() => clearTimeout(t));
    if (!r.ok) return [];
    const data = await r.json();
    const voices = (data.voices || []).map(v => ({
      id: v.voice_id,
      name: v.name || 'Unknown',
      accent: (v.labels && v.labels.accent) || '',
      gender: (v.labels && v.labels.gender) || ''
    }));
    elVoicesCache = voices;
    return voices;
  } catch (e) { return []; }
}

function populateElDropdown(voices) {
  const sel = document.getElementById('elVoiceSelect');
  if (!sel) return;
  sel.innerHTML = '';
  if (!voices || !voices.length) {
    sel.innerHTML = isElEnabled()
      ? '<option value="">No voices found</option>'
      : '<option value="">Add an ElevenLabs key below</option>';
    return;
  }
  voices.forEach(v => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = `${v.name}${v.accent ? ' (' + v.accent + ')' : ''}${v.gender ? ' · ' + v.gender : ''}`;
    sel.appendChild(o);
  });
  if (elVoiceId) sel.value = elVoiceId;
  else if (voices.length) { elVoiceId = voices[0].id; sel.value = elVoiceId; }
}

// ── ElevenLabs TTS with caching ──
async function elSpeak(text) {
  if (!isElEnabled() || !elVoiceId) return false;
  try {
    const cached = await getCachedAudio(elVoiceId, text);
    if (cached) return playBlob(cached);

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elVoiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': EL_KEY },
      body: JSON.stringify({
        text, model_id: EL_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, speed: elSpeed }
      })
    });
    if (!r.ok) return false;
    const blob = await r.blob();
    cacheAudio(elVoiceId, text, blob).catch(() => {});
    return playBlob(blob);
  } catch (e) { return false; }
}

function playBlob(blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); resolve(true); };
    audio.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    audio.play().catch(() => resolve(false));
  });
}

async function prefetchAudio(text) {
  if (!isElEnabled() || !elVoiceId) return;
  const processed = await processText(text);
  const cached = await getCachedAudio(elVoiceId, processed);
  if (cached) return;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elVoiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': EL_KEY },
      body: JSON.stringify({
        text: processed, model_id: EL_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3, speed: elSpeed }
      })
    });
    if (r.ok) { const blob = await r.blob(); cacheAudio(elVoiceId, processed, blob).catch(() => {}); }
  } catch (e) {}
}

// ── Browser TTS fallback ──
function initBrowserVoices() {
  if (!('speechSynthesis' in window)) return;
  const populate = () => {
    const voices = speechSynthesis.getVoices();
    const sel = document.getElementById('browserVoiceSelect');
    if (!sel || !voices.length) return;
    sel.innerHTML = '';
    voices.forEach((v, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(o);
    });
    getSetting('browserVoice', null).then(saved => {
      if (saved !== null) {
        sel.value = saved;
        selBrowserVoice = voices[parseInt(saved)] || voices[0];
      } else {
        const good = voices.find(v => /^en/i.test(v.lang) && /daniel|james|samantha|karen|aria/i.test(v.name));
        selBrowserVoice = good || voices.find(v => /^en/i.test(v.lang)) || voices[0];
        const idx = voices.indexOf(selBrowserVoice);
        if (idx >= 0) sel.value = idx;
      }
    });
  };
  speechSynthesis.onvoiceschanged = populate;
  setTimeout(populate, 200);
  populate();
}

function browserSpeak(text) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) { resolve(false); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (selBrowserVoice) u.voice = selBrowserVoice;
    u.rate = Math.min(2, Math.max(0.5, elSpeed));
    u.pitch = 0.9; u.volume = 1.0;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(true);
    speechSynthesis.speak(u);
  });
}

// ── Unified speak with queue ──
function speak(text, cb) {
  if (!text) { if (cb) cb(); return; }
  speechQueue.push({ text, cb });
  processQueue();
}

async function processQueue() {
  if (isSpeaking || !speechQueue.length) return;
  isSpeaking = true;
  speechFocus(true);                                              // duck other audio while we talk
  const { text, cb } = speechQueue.shift();
  const processed = await processText(text);
  try { if (window.flowVibe) window.flowVibe(); } catch (e) {}   // buzz the instant it speaks
  const elOk = await elSpeak(processed);
  if (!elOk) await browserSpeak(processed);
  isSpeaking = false;
  if (cb) cb();
  if (speechQueue.length) processQueue();
  else speechFocus(false);                                        // hand audio back so it resumes
}

function cancelSpeech() {
  speechQueue = [];
  isSpeaking = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ── Speed slider snap ──
const SNAP_POINTS = [0.5, 0.75, 1.0, 1.5, 1.75, 2.0];
const SNAP_STRENGTH = 0.06;
function snapSpeed(raw) {
  for (const sp of SNAP_POINTS) if (Math.abs(raw - sp) < SNAP_STRENGTH) return sp;
  return Math.round(raw * 20) / 20;
}

// ── Init ──
async function initTTS() {
  EL_KEY = (await getSetting('elKey', '')) || (BAKED_EL_KEY.indexOf('__') === 0 ? '' : BAKED_EL_KEY);
  elVoiceId = await getSetting('elVoiceId', '');
  elSpeed = await getSetting('elSpeed', 1.0);
  audioTakeover = await getSetting('audioTakeover', true);
  initBrowserVoices();
  // Background — never block first paint on the ElevenLabs API.
  fetchElVoices().then(populateElDropdown).catch(() => {});
}
