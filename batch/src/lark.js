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

export function larkConfig(env) {
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
export async function syncResult(env, staff, summary, surveyDate) {
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
export async function readGaps(env, staff) {
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
