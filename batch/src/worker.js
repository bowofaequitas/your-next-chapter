// Your Next Chapter v17: personal links tied to staff ID, saved responses, Lark sync, L&D admin API.
import { syncResult, readGaps } from './lark.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
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
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const yes = (v) => /^(1|y|yes|true|ya)$/i.test(String(v ?? '').trim());
const staffByToken = (env, t) => t ? env.DB.prepare('SELECT * FROM staff WHERE token = ?').bind(clip(t, 80)).first() : null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---- public: who is this personal link for? ----
      if (path === '/api/link-info' && request.method === 'GET') {
        const s = await staffByToken(env, url.searchParams.get('t'));
        if (!s) return json({ error: 'This link could not be opened. Please ask L&D for your personal link.' }, 404);
        const done = await env.DB.prepare('SELECT 1 AS x FROM responses WHERE staff_id = ? LIMIT 1').bind(s.staff_id).first();
        return json({ ok: true, name: s.name, directorship: !!s.directorship, done: !!done });
      }

      // ---- public: this person's skill gaps, read live from Lark ----
      if (path === '/api/skill-gaps' && request.method === 'GET') {
        const s = await staffByToken(env, url.searchParams.get('t'));
        if (!s) return json({ error: 'Not found' }, 404);
        try {
          const g = await readGaps(env, s.staff_id);
          return g ? json(g) : json({ gaps: null });
        } catch (e) { console.error(e); return json({ gaps: null }); }
      }

      // ---- public: save one submission (replaces this person's earlier answers for the same version) ----
      if (path === '/api/responses' && request.method === 'POST') {
        const raw = await request.text();
        if (raw.length > 60000) return json({ error: 'Submission too large.' }, 413);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid submission.' }, 400); }
        const s = await staffByToken(env, body.t);
        if (!s) return json({ error: 'This link could not be opened.' }, 404);
        const id = clip(body.id, 80);
        if (!id || typeof body.tally !== 'object' || typeof body.summary !== 'object' || !Array.isArray(body.answers))
          return json({ error: 'Invalid submission.' }, 400);
        const version = clip(body.version || body.summary.surveyVersion, 20);
        const now = new Date().toISOString();
        const dup = await env.DB.prepare('SELECT id FROM responses WHERE id = ?').bind(id).first();
        if (!dup) {
          await env.DB.prepare('DELETE FROM responses WHERE staff_id = ? AND survey_version = ?').bind(s.staff_id, version).run();
          await env.DB.prepare(
            'INSERT INTO responses (id, batch, browser, name, company, department, role, answers, tally, summary, version, created_at, staff_id, survey_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).bind(id, s.cohort || 'general', '', s.name, s.company, s.department, s.role,
            JSON.stringify(body.answers), JSON.stringify(body.tally), JSON.stringify(body.summary), version, now, s.staff_id, version).run();
          ctx.waitUntil((async () => {
            let r;
            try { r = await syncResult(env, s, body.summary, now); } catch (e) { console.error(e); r = { status: 'error', note: String(e.message || e).slice(0, 200) }; }
            await env.DB.prepare('UPDATE responses SET lark_status = ?, lark_note = ? WHERE id = ?').bind(r.status, r.note || '', id).run();
          })());
        }
        return json({ ok: true });
      }

      // ---- admin ----
      if (path.startsWith('/api/admin/')) {
        if (!isAdmin(request, env)) return json({ error: 'Unauthorised' }, 401);

        if (path === '/api/admin/staff' && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT s.staff_id, s.token, s.name, s.company, s.department, s.role, s.directorship, s.cohort, ' +
            '(SELECT created_at FROM responses r WHERE r.staff_id = s.staff_id ORDER BY created_at DESC LIMIT 1) AS answered_at, ' +
            '(SELECT lark_status FROM responses r WHERE r.staff_id = s.staff_id ORDER BY created_at DESC LIMIT 1) AS lark_status ' +
            'FROM staff s ORDER BY s.name'
          ).all();
          return json({ staff: results });
        }

        if (path === '/api/admin/staff/import' && request.method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const rows = Array.isArray(b.rows) ? b.rows.slice(0, 3000) : [];
          if (!rows.length) return json({ error: 'No rows to import.' }, 400);
          const now = new Date().toISOString(); let added = 0, updated = 0, skipped = 0;
          for (const r of rows) {
            const sid = clip(r.staff_id, 40), name = clip(r.name, 100);
            if (!sid || !name) { skipped++; continue; }
            const ex = await env.DB.prepare('SELECT staff_id FROM staff WHERE staff_id = ?').bind(sid).first();
            if (ex) {
              await env.DB.prepare('UPDATE staff SET name=?, company=?, department=?, role=?, directorship=?, cohort=? WHERE staff_id=?')
                .bind(name, clip(r.company, 100), clip(r.department, 120), clip(r.role, 60), yes(r.directorship) ? 1 : 0, clip(r.cohort, 80), sid).run();
              updated++;
            } else {
              await env.DB.prepare('INSERT INTO staff (staff_id, token, name, company, department, role, directorship, cohort, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
                .bind(sid, newToken(), name, clip(r.company, 100), clip(r.department, 120), clip(r.role, 60), yes(r.directorship) ? 1 : 0, clip(r.cohort, 80), now).run();
              added++;
            }
          }
          return json({ ok: true, added, updated, skipped });
        }

        if (path === '/api/admin/staff/delete' && request.method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const sid = clip(b.staff_id, 40);
          if (!sid) return json({ error: 'Missing staff ID.' }, 400);
          await env.DB.prepare('DELETE FROM staff WHERE staff_id = ?').bind(sid).run();
          return json({ ok: true });
        }

        if (path === '/api/admin/staff/new-link' && request.method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const sid = clip(b.staff_id, 40);
          if (!sid) return json({ error: 'Missing staff ID.' }, 400);
          await env.DB.prepare('UPDATE staff SET token = ? WHERE staff_id = ?').bind(newToken(), sid).run();
          return json({ ok: true });
        }

        if (path === '/api/admin/responses/delete' && request.method === 'POST') {
          const b = await request.json().catch(() => ({}));
          const rid = clip(b.id, 80);
          if (!rid) return json({ error: 'Missing id.' }, 400);
          const r = await env.DB.prepare('DELETE FROM responses WHERE id = ?').bind(rid).run();
          return json({ ok: true, deleted: (r.meta && r.meta.changes) || 0 });
        }

        if (path === '/api/admin/responses/clear' && request.method === 'POST') {
          const r = await env.DB.prepare('DELETE FROM responses').run();
          return json({ ok: true, deleted: (r.meta && r.meta.changes) || 0 });
        }

        if (path === '/api/admin/responses' && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT id, staff_id, name, company, department, role, batch, tally, summary, survey_version, lark_status, lark_note, created_at FROM responses ORDER BY created_at DESC'
          ).all();
          return json({ responses: results.map((r) => ({ ...r, tally: JSON.parse(r.tally), summary: JSON.parse(r.summary) })) });
        }

        if (path === '/api/admin/export.csv' && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT staff_id, name, company, department, role, summary, survey_version, lark_status, created_at FROM responses ORDER BY created_at'
          ).all();
          const head = ['Staff ID', 'Name', 'Company', 'Department', 'Role', 'Aspiration', 'Also close to', 'Learning style', 'Motivation', 'Development wishes', 'Wish note', 'Support wanted', 'Survey version', 'Survey date', 'Lark status'];
          const rows = results.map((r) => {
            const s = JSON.parse(r.summary);
            return [r.staff_id, r.name, r.company, r.department, r.role, s.roleLabel, s.roleSecondLabel, s.learnLabel,
              (s.whyLabels || []).join(' + '), (s.areaLabels || []).join(' + '), s.wish, s.supportLabel, r.survey_version, r.created_at, r.lark_status];
          });
          const csv = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
          return new Response('﻿' + csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="your-next-chapter-results.csv"', 'Cache-Control': 'no-store' } });
        }
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  },
};
