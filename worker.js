// FlowState sync Worker (Cloudflare + D1) — OPTIONAL.
// Deploy this, put its URL in the app's Settings → Devices & sync, use the same
// "space" word on every device, and your library + history sync, and your phone
// can send a flow to the TV. See worker/README.md for the 4 setup commands.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const space = url.searchParams.get('space') || 'default';
    const path = url.pathname.replace(/\/+$/, '');

    try {
      // ── FLOWS ──
      if (path === '/flows' && request.method === 'POST') {
        const f = await request.json();
        await env.DB.prepare(
          'INSERT INTO flows (id, space, name, data, updated) VALUES (?,?,?,?,?) ' +
          'ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data, updated=excluded.updated'
        ).bind(f.id, space, f.name || 'Untitled', JSON.stringify(f), f.updated || Date.now()).run();
        return json({ ok: true });
      }
      if (path === '/flows' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT data FROM flows WHERE space=? ORDER BY updated DESC'
        ).bind(space).all();
        return json({ flows: (results || []).map(r => JSON.parse(r.data)) });
      }
      if (path.startsWith('/flows/') && request.method === 'DELETE') {
        const id = decodeURIComponent(path.split('/')[2]);
        await env.DB.prepare('DELETE FROM flows WHERE id=? AND space=?').bind(id, space).run();
        return json({ ok: true });
      }

      // ── EVENTS (behaviour log) ──
      if (path === '/events' && request.method === 'POST') {
        const e = await request.json();
        await env.DB.prepare(
          'INSERT INTO events (id, space, ts, device, flow, task_index, task_label, allotted, actual, delta, outcome, session) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
        ).bind(e.id, space, e.ts || Date.now(), e.device || '', e.flow || '', e.taskIndex ?? 0,
               e.taskLabel || '', e.allotted ?? 0, e.actual ?? 0, e.delta ?? 0, e.outcome || '', e.session || '').run();
        return json({ ok: true });
      }
      if (path === '/events' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM events WHERE space=? ORDER BY ts ASC').bind(space).all();
        return json({ events: results || [] });
      }

      // ── COMMANDS (phone → TV handoff) ──
      if (path === '/command' && request.method === 'POST') {
        const c = await request.json();
        await env.DB.prepare(
          'INSERT INTO commands (space, ts, action, flow_id, start_at, target, from_device) VALUES (?,?,?,?,?,?,?)'
        ).bind(space, c.ts || Date.now(), c.action || 'play', c.flowId || '', c.startAt || 0, c.target || 'tv', c.from || '').run();
        return json({ ok: true });
      }
      if (path === '/command' && request.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0');
        const target = url.searchParams.get('device') || 'tv';
        const { results } = await env.DB.prepare(
          'SELECT * FROM commands WHERE space=? AND target=? AND ts>? ORDER BY ts ASC LIMIT 10'
        ).bind(space, target, since).all();
        return json({ commands: (results || []).map(r => ({ ts: r.ts, action: r.action, flowId: r.flow_id, startAt: r.start_at, from: r.from_device })) });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  }
};
