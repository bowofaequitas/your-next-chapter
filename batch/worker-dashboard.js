// Your Next Chapter v17: personal links tied to staff ID, saved responses, Lark sync, L&D admin API.
// Lark Base connector. Everything table- or field-specific lives in LARK_CONFIG, so connecting
// the real Learning Passport means filling in names, not changing code.
// mode: "mock" (default: pretend, no network) | "off" | "live"
// Secrets (set as Worker secrets, never in the repo): LARK_APP_ID, LARK_APP_SECRET.
const DEFAULT_CONFIG = {
  mode: 'mock',
  baseUrl: 'https://open.larksuite.com',
  appToken: '',                       // the Learning Passport Base's app token
  // Employee information: staff are matched by email (the table has Name, Owner, Superior, Status, EMAIL, Office, Department).
  employee: { tableId: '', matchField: 'EMAIL', nameField: 'Name' },
  results:  { tableId: '', fields: {  // leave a field name empty to skip it
    employeeLink: 'Employee', staffId: 'Staff ID', aspiration: 'Aspiration', aspirationSecond: '',
    learningStyle: 'Learning style', motivation: 'Motivation', developmentWishes: 'Development wishes',
    wishNote: 'Wish note', support: 'Support wanted', surveyVersion: 'Survey version', surveyDate: 'Survey date' } },
  // One entry per C-office competency table (TMO CTO, TMO CSO, ...). All share the same column names.
  gaps: { tables: [], employeeField: 'Employee', max: 8,
    fields: { competency: 'Competency (Skill Inventory)', type: 'Type of Competency', expected: 'Expected Level', current: 'Current Level', gap: 'Skill Gap' } },
};

function larkConfig(env) {
  let c = {};
  try { c = env.LARK_CONFIG ? JSON.parse(env.LARK_CONFIG) : {}; } catch { c = {}; }
  return {
    ...DEFAULT_CONFIG, ...c,
    employee: { ...DEFAULT_CONFIG.employee, ...(c.employee || {}) },
    results: { ...DEFAULT_CONFIG.results, ...(c.results || {}), fields: { ...DEFAULT_CONFIG.results.fields, ...((c.results || {}).fields || {}) } },
    gaps: { ...DEFAULT_CONFIG.gaps, ...(c.gaps || {}), fields: { ...DEFAULT_CONFIG.gaps.fields, ...((c.gaps || {}).fields || {}) } },
  };
}

const flat = (v) => Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? (x.text ?? x.name ?? '') : x)).join('') : (v ?? '');

async function api(env, cfg, method, path, body) {
  const tr = await fetch(cfg.baseUrl + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET }),
  });
  const t = await tr.json();
  if (!t.tenant_access_token) throw new Error('Lark auth failed: ' + (t.msg || tr.status));
  const r = await fetch(cfg.baseUrl + path, {
    method, headers: { Authorization: 'Bearer ' + t.tenant_access_token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error('Lark error ' + d.code + ': ' + (d.msg || ''));
  return d.data;
}

async function findRecord(env, cfg, tableId, field, value, op = 'is') {
  const d = await api(env, cfg, 'POST', `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${tableId}/records/search?page_size=100`,
    { filter: { conjunction: 'and', conditions: [{ field_name: field, operator: op, value: [value] }] } });
  return d.items || [];
}

// Save one survey result as a new row in "Your Next Chapter results", linked to Employee information.
async function syncResult(env, staff, summary, surveyDate) {
  const cfg = larkConfig(env);
  if (cfg.mode === 'off') return { status: 'off', note: 'Lark connector is off.' };
  if (cfg.mode === 'mock') return { status: 'mock', note: 'Mock: nothing was sent to Lark.' };
  const f = cfg.results.fields, row = {};
  const put = (k, v) => { if (f[k]) row[f[k]] = v; };
  const emp = await findRecord(env, cfg, cfg.employee.tableId, cfg.employee.matchField, staff.email);
  if (!emp.length) return { status: 'error', note: 'No Employee record found for email ' + staff.email };
  put('employeeLink', [emp[0].record_id]);
  put('staffId', staff.staff_id);
  put('aspiration', summary.roleLabel);
  put('aspirationSecond', summary.roleSecondLabel || '');
  put('learningStyle', summary.learnLabel);
  put('motivation', (summary.whyLabels || []).join(', '));
  put('developmentWishes', summary.areaLabels || []);
  put('wishNote', summary.wish || '');
  put('support', summary.supportLabel || '');
  put('surveyVersion', summary.surveyVersion);
  put('surveyDate', Date.parse(surveyDate));
  await api(env, cfg, 'POST', `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${cfg.results.tableId}/records`, { fields: row });
  return { status: 'sent', note: '' };
}

// Skill gaps for one person: only rows marked "Gap", biggest first. Competencies are linked to Employee by name.
const AREA_OF = { technical: 'Technical', managerial: 'Management', organizational: 'Organizational' };
const num = (v) => { const n = parseFloat(flat(v)); return Number.isFinite(n) ? n : null; };
async function readGaps(env, staff) {
  const cfg = larkConfig(env);
  if (cfg.mode === 'off') return null;
  if (cfg.mode === 'mock') return { mock: true, gaps: [
    { competency: 'Workforce Capability Planning', type: 'Technical', areaKey: 'Technical', current: 2, expected: 3 },
    { competency: 'Stakeholder Management', type: 'Managerial', areaKey: 'Management', current: 1, expected: 3 },
    { competency: 'Business Acumen', type: 'Organizational', areaKey: 'Organizational', current: 2, expected: 3 }] };
  const g = cfg.gaps.fields, out = [];
  let name = staff.name;
  const emp = await findRecord(env, cfg, cfg.employee.tableId, cfg.employee.matchField, staff.email);
  if (emp.length) name = flat(emp[0].fields[cfg.employee.nameField]) || name;
  for (const t of cfg.gaps.tables) {
    const items = await findRecord(env, cfg, t.tableId, cfg.gaps.employeeField, name, 'contains');
    for (const i of items) {
      if (flat(i.fields[g.gap]) !== 'Gap') continue;
      const type = flat(i.fields[g.type]);
      out.push({ competency: String(flat(i.fields[g.competency])).trim(), type, areaKey: AREA_OF[type.toLowerCase()] || '', current: num(i.fields[g.current]), expected: num(i.fields[g.expected]) });
    }
  }
  out.sort((a, b) => ((b.expected ?? 0) - (b.current ?? 0)) - ((a.expected ?? 0) - (a.current ?? 0)));
  return { gaps: out.slice(0, cfg.gaps.max || 8), total: out.length };
}


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

    if (!path.startsWith('/api/')) {
      const file = (path === '/admin' || path === '/admin.html') ? 'batch/public/admin.html' : 'index.html';
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const r = await fetch('https://raw.githubusercontent.com/bowofaequitas/your-next-chapter/main/' + file + '?v=' + Math.floor(Date.now() / 60000), { cf: { cacheTtl: 60, cacheEverything: true } });
      if (!r.ok) return new Response('Page unavailable', { status: 502 });
      return new Response(r.body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
    }

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
          const g = await readGaps(env, s);
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
            'SELECT s.staff_id, s.token, s.name, s.email, s.company, s.department, s.role, s.directorship, s.cohort, ' +
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
              await env.DB.prepare('UPDATE staff SET email=?, name=?, company=?, department=?, role=?, directorship=?, cohort=? WHERE staff_id=?')
                .bind(clip(r.email, 120), name, clip(r.company, 100), clip(r.department, 120), clip(r.role, 60), yes(r.directorship) ? 1 : 0, clip(r.cohort, 80), sid).run();
              updated++;
            } else {
              await env.DB.prepare('INSERT INTO staff (staff_id, token, email, name, company, department, role, directorship, cohort, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .bind(sid, newToken(), clip(r.email, 120), name, clip(r.company, 100), clip(r.department, 120), clip(r.role, 60), yes(r.directorship) ? 1 : 0, clip(r.cohort, 80), now).run();
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
