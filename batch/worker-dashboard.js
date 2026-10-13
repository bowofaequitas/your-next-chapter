// Your Next Chapter: batch links, saved responses, L&D admin API.
// Static files (the game and /admin) are served by the assets binding; only /api/* reaches this Worker.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), env.ADMIN_KEY);
}

async function getBatch(env, id) {
  if (id === 'general') return { id: 'general', name: 'General', closed: 0 };
  return env.DB.prepare('SELECT id, name, closed FROM batches WHERE id = ?').bind(id).first();
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      const file = (path === '/admin' || path === '/admin.html') ? 'batch/public/admin.html' : 'index.html';
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const r = await fetch('https://raw.githubusercontent.com/bowofaequitas/your-next-chapter/main/' + file, { cf: { cacheTtl: 60, cacheEverything: true } });
      if (!r.ok) return new Response('Page unavailable', { status: 502 });
      return new Response(r.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
    }

    try {
      // ---- public: is this batch link valid? ----
      if (path === '/api/batch-info' && request.method === 'GET') {
        const b = await getBatch(env, clip(url.searchParams.get('batch') || 'general', 80));
        if (!b) return json({ error: 'This link could not be opened. Please ask the organiser for a new one.' }, 404);
        if (b.closed) return json({ error: 'This batch is closed. Please ask the organiser.' }, 410);
        return json({ ok: true, name: b.name });
      }

      // ---- public: save one submission ----
      if (path === '/api/responses' && request.method === 'POST') {
        const raw = await request.text();
        if (raw.length > 60000) return json({ error: 'Submission too large.' }, 413);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid submission.' }, 400); }

        const batchId = clip(body.batch || 'general', 80);
        const b = await getBatch(env, batchId);
        if (!b) return json({ error: 'This link could not be opened.' }, 404);
        if (b.closed) return json({ error: 'This batch is closed.' }, 410);

        const p = body.participant || {};
        const name = clip(p.name, 100);
        const id = clip(body.id, 80);
        if (!name || !id) return json({ error: 'Name is required.' }, 400);
        if (typeof body.tally !== 'object' || typeof body.summary !== 'object' || !Array.isArray(body.answers))
          return json({ error: 'Invalid submission.' }, 400);

        await env.DB.prepare(
          "INSERT OR IGNORE INTO responses (id, batch, browser, name, company, department, role, answers, tally, summary, version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(
          id, batchId, clip(body.browser, 80), name, clip(p.company, 100), clip(p.department, 120), clip(p.role, 60),
          JSON.stringify(body.answers), JSON.stringify(body.tally), JSON.stringify(body.summary),
          clip(body.version, 20), new Date().toISOString()
        ).run();
        return json({ ok: true });
      }

      // ---- admin ----
      if (path.startsWith('/api/admin/')) {
        if (!isAdmin(request, env)) return json({ error: 'Unauthorised' }, 401);

        if (path === '/api/admin/batches' && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            "SELECT b.id, b.name, b.closed, b.created_at, (SELECT COUNT(*) FROM responses r WHERE r.batch = b.id) AS responses FROM batches b ORDER BY b.created_at DESC"
          ).all();
          const g = await env.DB.prepare("SELECT COUNT(*) AS n FROM responses WHERE batch='general'").first();
          return json({ batches: results, general: g.n });
        }

        if (path === '/api/admin/batches' && request.method === 'POST') {
          const { name } = await request.json();
          const n = clip(name, 80);
          if (!n) return json({ error: 'Batch name is required.' }, 400);
          const id = crypto.randomUUID();
          await env.DB.prepare('INSERT INTO batches (id, name, closed, created_at) VALUES (?,?,0,?)')
            .bind(id, n, new Date().toISOString()).run();
          return json({ ok: true, id });
        }

        const m = path.match(/^\/api\/admin\/batches\/([^/]+)\/(close|open)$/);
        if (m && request.method === 'POST') {
          await env.DB.prepare('UPDATE batches SET closed = ? WHERE id = ?').bind(m[2] === 'close' ? 1 : 0, m[1]).run();
          return json({ ok: true });
        }

        if (path === '/api/admin/responses' && request.method === 'GET') {
          const batch = clip(url.searchParams.get('batch') || 'general', 80);
          const { results } = await env.DB.prepare(
            'SELECT id, name, company, department, role, tally, summary, version, created_at FROM responses WHERE batch = ? ORDER BY created_at DESC'
          ).bind(batch).all();
          return json({ responses: results.map((r) => ({ ...r, tally: JSON.parse(r.tally), summary: JSON.parse(r.summary) })) });
        }

        if (path === '/api/admin/export.csv' && request.method === 'GET') {
          const batch = clip(url.searchParams.get('batch') || 'general', 80);
          const { results } = await env.DB.prepare(
            'SELECT name, company, department, role, summary, tally, created_at FROM responses WHERE batch = ? ORDER BY created_at'
          ).bind(batch).all();
          const head = ['Name','Company','Department','Role','Career pull','Growth direction','Stated focus','Thinking style','Learning style','Drive','Why','Environment','Support wanted','Submitted'];
          const rows = results.map((r) => {
            const s = JSON.parse(r.summary);
            return [r.name, r.company, r.department, r.role, s.careerLabel, s.pathLabel, (s.statedLabels || []).join(' + '),
              s.thinkLabel, s.learnLabel, s.energiseLabel, s.whyLabel, s.envLabel, s.supportLabel, r.created_at];
          });
          const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join(decodeURIComponent("%0D%0A"));
          return new Response('﻿' + csv, {
            headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="your-next-chapter-' + batch.slice(0, 8) + '.csv"', 'Cache-Control': 'no-store' },
          });
        }
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
};
