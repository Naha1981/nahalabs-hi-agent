// Agent file generation: the agent can save CSV, Markdown, plain-text or genuine XLSX
// deliverables into the account, and the customer downloads them from the Files page or
// reads them over the API. XLSX bytes are stored base64 in the same content column, so
// downloads and API reads mark them with encoding: 'base64'.
import { withTenant, audit } from './db.js';
import { buildXlsx, XLSX_MIME } from './xlsx.js';

export const FILE_TYPES = {
  csv: { ext: '.csv', mime: 'text/csv' },
  md: { ext: '.md', mime: 'text/markdown' },
  txt: { ext: '.txt', mime: 'text/plain' },
  xlsx: { ext: '.xlsx', mime: XLSX_MIME, binary: true },
};

const cellVal = (cell) => {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : '';
  if (typeof cell === 'object') return JSON.stringify(cell).slice(0, 1000);
  return String(cell).slice(0, 1000);
};

// Accepts {"sheets":[{name, rows}]}, [{name, rows}] or [[cell, ...]] for a single sheet.
function sheetJson(content) {
  let v;
  try { v = JSON.parse(content); } catch { return { error: 'xlsx content must be JSON: {"sheets":[{"name":"Sheet1","rows":[["Heading 1","Heading 2"],["value",1]]}]}' }; }
  const sheets = Array.isArray(v?.sheets) ? v.sheets : (Array.isArray(v) && v.length && v.every((s) => s && Array.isArray(s.rows)) ? v : [{ name: 'Sheet1', rows: v }]);
  if (!sheets.length || sheets.length > 20) return { error: 'xlsx needs 1 to 20 sheets.' };
  const clean = [];
  for (const s of sheets) {
    const rows = Array.isArray(s?.rows) ? s.rows : (Array.isArray(s) ? s : null);
    if (!Array.isArray(rows) || !rows.every((r) => Array.isArray(r))) return { error: 'every sheet needs rows: arrays of cells, e.g. [["A","B"],[1,2]].' };
    if (rows.length > 5000) return { error: 'a sheet is limited to 5000 rows.' };
    if (rows.some((r) => r.length > 100)) return { error: 'a row is limited to 100 cells.' };
    clean.push({ name: typeof s?.name === 'string' ? s.name : undefined, rows: rows.map((r) => r.map(cellVal)) });
  }
  return { sheets: clean };
}

export async function saveFile(c, { tenantId, agentId, filename, format, content, actor }) {
  const type = FILE_TYPES[String(format || '').toLowerCase()];
  if (!type) return { error: 'format must be csv, md, txt or xlsx.' };
  let stored;
  if (type.binary) {
    const parsed = sheetJson(String(content || '').slice(0, 400000));
    if (parsed.error) return parsed;
    stored = buildXlsx(parsed.sheets).toString('base64');
  } else {
    stored = String(content || '').slice(0, 200000);
    if (!stored.trim()) return { error: 'content is empty.' };
  }
  const base = String(filename || 'file').replace(/[^A-Za-z0-9 _\-().]/g, '').trim().slice(0, 100) || 'file';
  const name = base.toLowerCase().endsWith(type.ext) ? base : base + type.ext;
  if ((await c.query("SELECT count(*)::int n FROM files WHERE created_at > now() - interval '1 day'")).rows[0].n >= 30) return { error: 'Daily file limit reached (30).' };
  const row = (await c.query('INSERT INTO files (tenant_id, agent_id, filename, mime, content, created_by) VALUES (current_setting(\'app.tenant_id\')::uuid,$1,$2,$3,$4,$5) RETURNING id, filename', [agentId, name, type.mime, stored, actor || 'agent'])).rows[0];
  await audit(c, tenantId, actor || 'agent', 'file.created', { file_id: row.id, filename: name });
  return { id: row.id, filename: name };
}
