// ═══════════════════════════════════════════
// BAVI FlowState v11 — Cloud sync + phone→TV handoff (OPTIONAL)
// Local IndexedDB is always the source of truth. If you set a Sync URL in
// Settings (your Cloudflare Worker in /worker), this layer mirrors flows +
// events to D1 for a unified library across devices, and lets your phone
// "send" a flow to the TV (the TV polls and launches it itself — not screen
// mirroring). With no URL set, every call here is a silent no-op.
// ═══════════════════════════════════════════
(function () {
  let base = '';            // Worker URL, e.g. https://flowstate-sync.you.workers.dev
  let space = '';           // shared secret scoping your data across devices
  let deviceId = '';
  let deviceName = '';
  let deviceType = 'phone';
  let pollTimer = null;
  let lastCmdTs = Date.now();

  function enabled() { return !!base; }

  // fetch with a hard timeout — a flaky connection must never hang the app.
  function tfetch(resource, opts = {}, ms = 8000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    return fetch(resource, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
  }

  async function init() {
    base = (await getSetting('syncUrl', '')).replace(/\/+$/, '');
    space = await getSetting('syncSpace', '');
    deviceId = await getSetting('deviceId', '');
    if (!deviceId) { deviceId = 'd_' + Math.random().toString(36).slice(2, 10); await setSetting('deviceId', deviceId); }
    deviceType = (window.FlowDevice && FlowDevice.type) || 'phone';
    deviceName = await getSetting('deviceName', deviceType === 'tv' ? 'TV' : (deviceType === 'tablet' ? 'Tablet' : (deviceType === 'desktop' ? 'Laptop' : 'Phone')));
  }

  function url(path) {
    const u = new URL(base + path);
    if (space) u.searchParams.set('space', space);
    return u.toString();
  }

  async function pushFlow(flow) {
    if (!enabled()) return;
    try {
      await tfetch(url('/flows'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(flow)
      });
    } catch (e) {}
  }

  async function deleteFlowRemote(id) {
    if (!enabled()) return;
    try { await tfetch(url('/flows/' + encodeURIComponent(id)), { method: 'DELETE' }); } catch (e) {}
  }

  async function pullFlows() {
    if (!enabled()) return [];
    try {
      const r = await tfetch(url('/flows'));
      if (!r.ok) return [];
      const data = await r.json();
      return data.flows || [];
    } catch (e) { return []; }
  }

  async function pushEvent(ev) {
    if (!enabled()) return;
    try {
      await tfetch(url('/events'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...ev, deviceId, deviceName })
      });
    } catch (e) {}
  }

  // Phone → TV: queue a "play this flow now" command for the TV.
  async function sendToTV(flowId, startAt) {
    if (!enabled()) return false;
    try {
      const r = await tfetch(url('/command'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'play', flowId, startAt: startAt || 0, target: 'tv', from: deviceName, ts: Date.now() })
      });
      return r.ok;
    } catch (e) { return false; }
  }

  // TV: poll for commands addressed to it and run them.
  function startPolling(onCommand) {
    if (!enabled() || pollTimer) return;
    lastCmdTs = Date.now();
    const tick = async () => {
      try {
        const u = new URL(base + '/command');
        if (space) u.searchParams.set('space', space);
        u.searchParams.set('since', lastCmdTs);
        u.searchParams.set('device', 'tv');
        const r = await tfetch(u.toString());
        if (r.ok) {
          const data = await r.json();
          (data.commands || []).forEach(cmd => {
            lastCmdTs = Math.max(lastCmdTs, cmd.ts || Date.now());
            if (onCommand) onCommand(cmd);
          });
        }
      } catch (e) {}
    };
    pollTimer = setInterval(tick, 3000);
    tick();
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // Two-way library merge: newest `updated` wins; local flows the cloud
  // doesn't know about get pushed up. Returns how many local changes were pulled.
  async function mergeRemote() {
    if (!enabled()) return 0;
    const remote = await pullFlows();
    let pulled = 0;
    const rmap = {};
    for (const rf of remote) {
      if (!rf || !rf.id) continue;
      rmap[rf.id] = rf;
      const lf = await getFlow(rf.id);
      if (!lf || (rf.updated || 0) > (lf.updated || 0)) { await dbPut('flows', rf); pulled++; }
    }
    const locals = await getAllFlows();
    for (const lf of locals) {
      const rf = rmap[lf.id];
      if (!rf || (lf.updated || 0) > (rf.updated || 0)) pushFlow(lf);
    }
    return pulled;
  }

  async function test() {
    if (!enabled()) return { ok: false, count: 0 };
    try {
      const r = await tfetch(url('/flows'));
      if (!r.ok) return { ok: false, count: 0 };
      const data = await r.json();
      return { ok: true, count: (data.flows || []).length };
    } catch (e) { return { ok: false, count: 0 }; }
  }

  window.Sync = {
    init, enabled, pushFlow, pullFlows, deleteFlowRemote, pushEvent,
    sendToTV, startPolling, stopPolling, mergeRemote, test,
    get deviceName() { return deviceName; },
    set deviceName(v) { deviceName = v; setSetting('deviceName', v); }
  };
})();
