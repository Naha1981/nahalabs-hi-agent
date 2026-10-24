// Customer document uploads (Slice 2): the customer uploads an OTP, FICA pack, lease or
// sheet; HI stores it tenant-isolated and reads the text so document workflows (deal
// milestones, tracker extraction) work from the document itself, not retyped text.
// Extraction honesty: extract is the document's own text only - no interpretation here.
import { withTenant, auditFor } from './db.js';

export const UPLOAD_TYPES = {
  'application/pdf': { ext: '.pdf', label: 'PDF' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: '.docx', label: 'Word document' },
  'text/plain': { ext: '.txt', label: 'Text file' },
  'text/markdown': { ext: '.md', label: 'Markdown' },
  'text/csv': { ext: '.csv', label: 'CSV' },
};
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EXTRACT_CAP = 100000;

export function uploadTypeFor(filename, mime) {
  if (UPLOAD_TYPES[mime]) return mime;
  const f = String(filename || '').toLowerCase();
  for (const [m, t] of Object.entries(UPLOAD_TYPES)) if (f.endsWith(t.ext)) return m;
  return null;
}

export async function extractText(mime, buffer) {
  try {
    if (mime === 'application/pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const r = await parser.getText();
      await parser.destroy();
      return String(r.text || '').slice(0, EXTRACT_CAP);
    }
    if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = await import('mammoth');
      const r = await mammoth.extractRawText({ buffer });
      return String(r.value || '').slice(0, EXTRACT_CAP);
    }
    return buffer.toString('utf8').slice(0, EXTRACT_CAP);
  } catch {
    return null;
  }
}

export async function saveUpload(tenantId, { filename, mime, buffer }, actor = 'customer') {
  const extract = await extractText(mime, buffer);
  const row = await withTenant(tenantId, async (c) => {
    const r = await c.query(
      'INSERT INTO uploads (tenant_id, filename, mime, size_bytes, content, extract) VALUES (NULLIF(current_setting(\'app.tenant_id\', true), \'\')::uuid, $1, $2, $3, $4, $5) RETURNING id, filename, mime, size_bytes, (extract IS NOT NULL) AS has_extract, created_at',
      [String(filename).slice(0, 200), mime, buffer.length, buffer, extract]
    );
    return r.rows[0];
  });
  await auditFor(tenantId, actor, 'upload.saved', { id: row.id, filename: row.filename, mime, bytes: buffer.length, has_extract: extract !== null });
  return { ...row, has_extract: extract !== null };
}

export const listUploads = (tenantId) =>
  withTenant(tenantId, (c) => c.query('SELECT id, filename, mime, size_bytes, (extract IS NOT NULL) AS has_extract, created_at FROM uploads ORDER BY created_at DESC LIMIT 50').then((r) => r.rows));

export async function readUpload(tenantId, { id, filename }) {
  const row = await withTenant(tenantId, async (c) => {
    if (id) return (await c.query('SELECT id, filename, mime, size_bytes, extract, created_at FROM uploads WHERE id=$1', [id])).rows[0];
    return (await c.query('SELECT id, filename, mime, size_bytes, extract, created_at FROM uploads WHERE lower(filename)=lower($1) ORDER BY created_at DESC LIMIT 1', [String(filename || '')])).rows[0];
  });
  return row || null;
}
