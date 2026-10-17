// Lark Base connector. Everything table- or field-specific lives in LARK_CONFIG, so connecting
// the real Learning Passport means filling in names, not changing code.
// mode: "off" (default) | "mock" (pretend, no network) | "live"
// Secrets (set as Worker secrets, never in the repo): LARK_APP_ID, LARK_APP_SECRET.
const DEFAULT_CONFIG = {
  mode: 'off',
  baseUrl: 'https://open.larksuite.com',
  appToken: '',                       // the Learning Passport Base's app token
  employee: { tableId: '', staffIdField: 'Staff ID' },
  results:  { tableId: '', fields: {  // leave a field name empty to skip it
    employeeLink: 'Employee', staffId: 'Staff ID', aspiration: 'Aspiration', aspirationSecond: '',
    learningStyle: 'Learning style', motivation: 'Motivation', developmentWishes: 'Development wishes',
    wishNote: 'Wish note', support: 'Support wanted', surveyVersion: 'Survey version', surveyDate: 'Survey date' } },
  gaps: { tableId: '', staffIdField: 'Staff ID', fields: { competency: 'Competency', type: 'Type', current: 'Current', expected: 'Expected' } },
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

async function findRecord(env, cfg, tableId, field, value) {
  const d = await api(env, cfg, 'POST', `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${tableId}/records/search?page_size=100`,
    { filter: { conjunction: 'and', conditions: [{ field_name: field, operator: 'is', value: [value] }] } });
  return d.items || [];
}

// Save one survey result as a new row in "Your Next Chapter results", linked to Employee information.
export async function syncResult(env, staff, summary, surveyDate) {
  const cfg = larkConfig(env);
  if (cfg.mode === 'off') return { status: 'off', note: 'Lark connector is off.' };
  if (cfg.mode === 'mock') return { status: 'mock', note: 'Mock: nothing was sent to Lark.' };
  const f = cfg.results.fields, row = {};
  const put = (k, v) => { if (f[k]) row[f[k]] = v; };
  const emp = await findRecord(env, cfg, cfg.employee.tableId, cfg.employee.staffIdField, staff.staff_id);
  if (!emp.length) return { status: 'error', note: 'No Employee record found for staff ID ' + staff.staff_id };
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

// Skill gaps for one person, read live by staff ID.
export async function readGaps(env, staffId) {
  const cfg = larkConfig(env);
  if (cfg.mode === 'off') return null;
  if (cfg.mode === 'mock') return { mock: true, gaps: [
    { competency: 'Document lifecycle control', type: 'Technical', current: 2, expected: 3 },
    { competency: 'Audit trail monitoring', type: 'Technical', current: 1, expected: 3 },
    { competency: 'Stakeholder communication', type: 'Management', current: 2, expected: 3 }] };
  const g = cfg.gaps.fields;
  const items = await findRecord(env, cfg, cfg.gaps.tableId, cfg.gaps.staffIdField, staffId);
  return { gaps: items.map((i) => ({ competency: flat(i.fields[g.competency]), type: flat(i.fields[g.type]), current: flat(i.fields[g.current]), expected: flat(i.fields[g.expected]) })) };
}
