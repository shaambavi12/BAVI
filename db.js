// ═══════════════════════════════════════════
// FlowState v9 — IndexedDB Layer
// ═══════════════════════════════════════════
const DB_NAME = 'flowstate';
const DB_VER = 3;            // bumped: adds `events` store
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('flows')) {
        const fs = db.createObjectStore('flows', { keyPath: 'id' });
        fs.createIndex('pinned', 'pinned');
        fs.createIndex('archived', 'archived');
        fs.createIndex('created', 'created');
      }
      if (!db.objectStoreNames.contains('audioCache')) {
        db.createObjectStore('audioCache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('pronunciation')) {
        db.createObjectStore('pronunciation', { keyPath: 'word' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      // NEW — behaviour tracking. Local-first; mirrored to D1 via sync.js if configured.
      if (!db.objectStoreNames.contains('events')) {
        const ev = db.createObjectStore('events', { keyPath: 'id' });
        ev.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
  });
}

// ── Generic helpers ──
async function dbPut(store, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}
async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = e => reject(e.target.error);
  });
}
async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = e => reject(e.target.error);
  });
}
async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

// ── Flows ──
function newFlowId() { return 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

function createFlow(name, tasks) {
  return {
    id: newFlowId(),
    name: name || 'Untitled flow',
    tasks: tasks,            // [{label, secs}]  (secs is the source of truth now)
    created: Date.now(),
    updated: Date.now(),
    lastRun: null,
    pinned: false,
    archived: false,
    bookmark: null,          // {taskIndex, timestamp}
    runHistory: []           // [{started, finished, tasksCompleted, totalTasks, elapsed, gained, device}]
  };
}

async function saveFlow(flow) { flow.updated = Date.now(); return dbPut('flows', flow); }
async function getFlow(id) { return dbGet('flows', id); }
async function deleteFlow(id) { return dbDelete('flows', id); }

async function getAllFlows() {
  const all = await dbGetAll('flows');
  return all.sort((a, b) => (b.updated || b.created) - (a.updated || a.created));
}
async function getPinnedFlows() {
  const all = await getAllFlows();
  return all.filter(f => f.pinned && !f.archived).slice(0, 3);
}
async function getActiveFlows() {
  const all = await getAllFlows();
  return all.filter(f => !f.archived);
}

async function togglePin(id) {
  const flow = await getFlow(id);
  if (!flow) return;
  if (!flow.pinned) {
    const pinned = await getPinnedFlows();
    if (pinned.length >= 3) {
      pinned[pinned.length - 1].pinned = false;
      await saveFlow(pinned[pinned.length - 1]);
    }
  }
  flow.pinned = !flow.pinned;
  await saveFlow(flow);
}

async function toggleArchive(id) {
  const flow = await getFlow(id);
  if (!flow) return;
  flow.archived = !flow.archived;
  if (flow.archived) flow.pinned = false;
  await saveFlow(flow);
}

async function addRunRecord(id, record) {
  const flow = await getFlow(id);
  if (!flow) return;
  flow.lastRun = Date.now();
  flow.runHistory.push(record);
  if (flow.runHistory.length > 20) flow.runHistory = flow.runHistory.slice(-20);
  await saveFlow(flow);
}

async function setBookmark(id, taskIndex) {
  const flow = await getFlow(id);
  if (!flow) return;
  flow.bookmark = taskIndex !== null ? { taskIndex, timestamp: Date.now() } : null;
  await saveFlow(flow);
}

// ── Audio Cache ──
async function getCachedAudio(voiceId, text) {
  const key = voiceId + '::' + text;
  const result = await dbGet('audioCache', key);
  return result ? result.blob : null;
}
async function cacheAudio(voiceId, text, blob) {
  const key = voiceId + '::' + text;
  await dbPut('audioCache', { key, blob, voiceId, text, cached: Date.now() });
}
async function clearAudioCache() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audioCache', 'readwrite');
    tx.objectStore('audioCache').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

// ── Pronunciation Dictionary ──
async function getPronunciations() { return dbGetAll('pronunciation'); }
async function setPronunciation(word, phonetic) { return dbPut('pronunciation', { word: word.toLowerCase(), phonetic }); }
async function deletePronunciation(word) { return dbDelete('pronunciation', word.toLowerCase()); }
async function applyPronunciations(text) {
  const dict = await getPronunciations();
  let result = text;
  for (const entry of dict) {
    const regex = new RegExp('\\b' + entry.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    result = result.replace(regex, entry.phonetic);
  }
  return result;
}

// ── Settings ──
async function getSetting(key, defaultVal) {
  const result = await dbGet('settings', key);
  return (result && result.value !== undefined) ? result.value : defaultVal;
}
async function setSetting(key, value) { return dbPut('settings', { key, value }); }

// ── Behaviour events (local mirror of D1) ──
async function logEvent(ev) {
  ev.id = 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  if (!ev.ts) ev.ts = Date.now();
  await dbPut('events', ev);
  // Best-effort cloud mirror — silent if sync not configured.
  try { if (window.Sync && Sync.enabled()) Sync.pushEvent(ev); } catch (e) {}
}
async function getAllEvents() {
  const all = await dbGetAll('events');
  return all.sort((a, b) => a.ts - b.ts);
}
async function clearEvents() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readwrite');
    tx.objectStore('events').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
async function eventsToCSV() {
  const rows = await getAllEvents();
  const cols = ['ts_iso', 'local_time', 'day', 'device', 'flow', 'task_index', 'task_label',
                'allotted_sec', 'actual_sec', 'delta_sec', 'outcome', 'session'];
  const lines = [cols.join(',')];
  for (const r of rows) {
    const d = new Date(r.ts);
    lines.push([
      d.toISOString(),
      d.toLocaleString(),
      d.toLocaleDateString(undefined, { weekday: 'short' }),
      r.device, r.flow, r.taskIndex, r.taskLabel,
      r.allotted, r.actual, r.delta, r.outcome, r.session
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

// ── Export / Import ──
async function exportAllData() {
  const flows = await getAllFlows();
  const pron = await getPronunciations();
  return JSON.stringify({ version: 9, exported: Date.now(), flows, pronunciation: pron }, null, 2);
}
async function importData(jsonStr) {
  const data = JSON.parse(jsonStr);
  if (data.flows) {
    for (const flow of data.flows) {
      flow.id = newFlowId();
      flow.pinned = false;
      // migrate older flows that used `mins`
      if (Array.isArray(flow.tasks)) {
        flow.tasks = flow.tasks.map(t => t.secs != null ? t : { label: t.label, secs: (t.mins || 5) * 60 });
      }
      await saveFlow(flow);
    }
  }
  if (data.pronunciation) {
    for (const p of data.pronunciation) await setPronunciation(p.word, p.phonetic);
  }
  return data.flows ? data.flows.length : 0;
}
