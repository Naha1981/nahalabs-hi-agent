// Agent file generation: the agent can save CSV, Markdown or plain-text deliverables into the
// account, and the customer downloads them from the Files page or reads them over the API.
import { withTenant, audit } from './db.js';

export const FILE_TYPES = {
  csv: { ext: '.csv', mime: 'text/csv' },
  md: { ext: '.md', mime: 'text/markdown' },
  txt: { ext: '.txt', mime: 'text/plain' },
};

export async function saveFile(c, { tenantId, agentId, filename, format, content, actor }) {
  const type = FILE_TYPES[String(format || '').toLowerCase()];
  if (!type) return { error: 'format must be csv, md or txt.' };
  const text = String(content || '').slice(0, 200000);
  if (!text.trim()) return { error: 'content is empty.' };
  const base = String(filename || 'file').replace(/[^A-Za-z0-9 _\-().]/g, '').trim().slice(0, 100) || 'file';
  const name = base.toLowerCase().endsWith(type.ext) ? base : base + type.ext;
  if ((await c.query("SELECT count(*)::int n FROM files WHERE created_at > now() - interval '1 day'")).rows[0].n >= 30) return { error: 'Daily file limit reached (30).' };
  const row = (await c.query('INSERT INTO files (tenant_id, agent_id, filename, mime, content, created_by) VALUES (current_setting(\'app.tenant_id\')::uuid,$1,$2,$3,$4,$5) RETURNING id, filename', [agentId, name, type.mime, text, actor || 'agent'])).rows[0];
  await audit(c, tenantId, actor || 'agent', 'file.created', { file_id: row.id, filename: name });
  return { id: row.id, filename: name };
}
