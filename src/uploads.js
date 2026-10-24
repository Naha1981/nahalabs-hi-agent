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
export const DEFAULT_TENANT_UPLOAD_QUOTA = 25 * 1024 * 1024;
export const tenantUploadQuota = () => {
  const v = Number(process.env.HI_UPLOAD_TENANT_QUOTA_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_TENANT_UPLOAD_QUOTA;
};
export const uploadBytesUsed = (tenantId) =>
  withTenant(tenantId, (c) => c.query('SELECT COALESCE(SUM(size_bytes),0)::bigint AS used FROM uploads').then((r) => Number(r.rows[0].used)));
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
  // Size gate lives here too, not only in the HTTP route: any future caller is bounded.
  if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_UPLOAD_BYTES) {
    const e = new Error('file must be between 1 byte and 8 MB'); e.code = 'UPLOAD_SIZE'; throw e;
  }
  const row = await withTenant(tenantId, async (c) => {
    // Per-tenant admission lock: serializes this tenant's admissions until commit/rollback,
    // so the quota SUM below cannot race a concurrent same-tenant upload (TOCTOU fix).
    // Keyed by hashtext: collisions only mean harmless extra serialization.
    await c.query("SELECT pg_advisory_xact_lock(hashtext(current_setting('app.tenant_id', true)))");
    // Global admission via the SECURITY DEFINER ledger function: the app role can only ask
    // for admission, never read or write the counter, and the cap is read from the ledger
    // row (server-owned), not from anything the caller controls. The row lock serializes
    // concurrent admissions; any failure rolls the reservation back with everything else.
    const g = await c.query('SELECT upload_budget_admit($1) AS ok', [buffer.length]);
    if (!g.rows[0].ok) { const e = new Error('global upload storage budget reached'); e.code = 'GLOBAL_BUDGET'; throw e; }
    // Per-tenant admission (RLS scopes the SUM to this tenant; the advisory lock above
    // makes the check + insert atomic against other admissions for this tenant).
    const t = await c.query('SELECT COALESCE(SUM(size_bytes),0)::bigint AS used FROM uploads');
    if (Number(t.rows[0].used) + buffer.length > tenantUploadQuota()) { const e = new Error('tenant upload quota reached'); e.code = 'TENANT_QUOTA'; throw e; }
    // Extraction runs only after both admissions pass: a refused upload costs no parse CPU.
    // Note: the global ledger row lock is held for the parse - admissions across tenants
    // serialize for sub-second parse of files up to 8 MB, acceptable at this scale.
    const extract = await extractText(mime, buffer);
    const r = await c.query(
      'INSERT INTO uploads (tenant_id, filename, mime, size_bytes, content, extract) VALUES (NULLIF(current_setting(\'app.tenant_id\', true), \'\')::uuid, $1, $2, $3, $4, $5) RETURNING id, filename, mime, size_bytes, (extract IS NOT NULL) AS has_extract, created_at',
      [String(filename).slice(0, 200), mime, buffer.length, buffer, extract]
    );
    return r.rows[0];
  });
  await auditFor(tenantId, actor, 'upload.saved', { id: row.id, filename: row.filename, mime, bytes: buffer.length, has_extract: row.has_extract });
  return row;
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
