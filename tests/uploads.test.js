import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { runTool } from '../src/tools.js';
import { saveUpload, listUploads, readUpload, uploadTypeFor, MAX_UPLOAD_BYTES } from '../src/uploads.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.SEARX_URL = 'https://searx.example.test';
delete process.env.GROQ_API_KEY;

let db, app, A, B, AGENT_A;
const llm = async () => ({ content: 'done', tool_calls: [] });
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];

// --- byte builders: real PDF with correct xref, real stored-zip DOCX --------

function pdfBytes(lines) {
  const enc = (s) => Buffer.from(s, 'latin1');
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const textOps = lines.map((l, i) => `BT /F1 14 Tf 50 ${740 - i * 20} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(textOps)} >>\nstream\n${textOps}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Root 1 0 R /Size ${objs.length + 1} >>\nstartxref\n${xrefAt}\n%%EOF`;
  return enc(out);
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function docxBytes(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  const documentXml = Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`, 'utf8');
  const contentTypes = Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, 'utf8');
  const files = [['[Content_Types].xml', contentTypes], ['word/document.xml', documentXml]];
  const parts = []; const central = []; let pos = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0, 6); head.writeUInt16LE(0, 8); head.writeUInt16LE(0, 10);
    head.writeUInt32LE(crc32(data), 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(n.length, 26); head.writeUInt16LE(0, 28);
    parts.push(head, n, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12);
    cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(pos, 42);
    central.push(Buffer.concat([cd, n]));
    pos += head.length + n.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(pos, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function multipart(filename, mime, bytes, csrf) {
  const boundary = '----hitestboundary';
  const head = csrf ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n`) : Buffer.from('');
  const body = Buffer.concat([
    head,
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="doc"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body };
}
async function csrfOf(cookie) {
  const page = await app.inject({ url: '/app/files', headers: { cookie } });
  const m = page.body.match(/name="csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

// --- suite -------------------------------------------------------------------

test.before(async () => {
  db = await startDb(54330);
  app = await buildApp({ llm });
  for (const [company, email] of [['Alpha Co', 'a@example.test'], ['Beta Co', 'b@example.test']]) {
    await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
    const res = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
    const cookie = cookieOf(res);
    if (company === 'Alpha Co') { A = { cookie }; } else { B = { cookie }; }
  }
  const o = owner(db.ownerUrl); await o.connect();
  const t = await o.query("SELECT id FROM tenants WHERE name IN ('Alpha Co','Beta Co') ORDER BY name");
  A.tenantId = t.rows[0].id; B.tenantId = t.rows[1].id;
  AGENT_A = (await o.query('INSERT INTO agents (tenant_id, name) VALUES ($1,$2) RETURNING id', [A.tenantId, 'hi'])).rows[0].id;
  await o.end();
});
test.after(async () => { await app.close(); await db.stop(); });

const call = (tenantId, name, args) =>
  withTenant(tenantId, (c) => runTool(name, args, { c, tenantId, agentId: AGENT_A, agentName: 'hi', userEmail: 'a@b.c', sources: [], steps: [], mode: 'chat' }));

test('save and read plain text and csv uploads', async () => {
  const t = await saveUpload(A.tenantId, { filename: 'notes.txt', mime: 'text/plain', buffer: Buffer.from('Purchaser: Sipho Dube\nPrice: R1,250,000') });
  assert.ok(t.id);
  assert.equal(t.has_extract, true);
  const c = await saveUpload(A.tenantId, { filename: 'ledger.csv', mime: 'text/csv', buffer: Buffer.from('stage,amount\noffer,1250000') });
  assert.equal(c.has_extract, true);
  const back = await readUpload(A.tenantId, { filename: 'notes.txt' });
  assert.match(back.extract, /Sipho Dube/);
  assert.match((await readUpload(A.tenantId, { filename: 'ledger.csv' })).extract, /1250000/);
  const list = await listUploads(A.tenantId);
  assert.deepEqual(list.map((r) => r.filename).sort(), ['ledger.csv', 'notes.txt']);
  assert.ok(list.every((r) => r.has_extract));
});

test('extracts text from a real PDF', async () => {
  const bytes = pdfBytes(['Offer to Purchase', 'Purchase price: R1,250,000', 'Purchaser: Sipho Dube']);
  const row = await saveUpload(A.tenantId, { filename: 'offer.pdf', mime: 'application/pdf', buffer: bytes });
  assert.equal(row.has_extract, true);
  const back = await readUpload(A.tenantId, { id: row.id });
  assert.match(back.extract || '', /1,250,000/);
  assert.match(back.extract || '', /Sipho Dube/);
});

test('extracts text from a real DOCX (stored zip)', async () => {
  const bytes = docxBytes(['FICA pack for Thandi Mokoena', 'ID verified 12 March 2026']);
  const row = await saveUpload(A.tenantId, { filename: 'fica.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes });
  assert.equal(row.has_extract, true);
  assert.match((await readUpload(A.tenantId, { filename: 'fica.docx' })).extract || '', /Thandi Mokoena/);
});

test('type allowlist: png rejected, pdf/docx/txt/csv accepted', async () => {
  assert.equal(uploadTypeFor('photo.png', 'image/png'), null);
  assert.equal(uploadTypeFor('x.exe', 'application/octet-stream'), null);
  assert.ok(uploadTypeFor('offer.pdf', 'application/pdf'));
  assert.ok(uploadTypeFor('pack.docx', 'application/octet-stream')); // extension fallback
  assert.equal(MAX_UPLOAD_BYTES, 8 * 1024 * 1024);
  // wrong type over HTTP: redirect with explanatory flash, nothing stored
  const csrf = await csrfOf(A.cookie);
  const mp = multipart('photo.png', 'image/png', Buffer.from('fakepng'), csrf);
  const up = await app.inject({ method: 'POST', url: '/app/uploads', headers: { ...mp.headers, cookie: A.cookie }, payload: mp.payload });
  assert.equal(up.statusCode, 302);
  assert.match(up.headers.location, /not%20supported|not\+supported/);
  assert.equal((await readUpload(A.tenantId, { filename: 'photo.png' })), null);
  // over the 8 MB cap over HTTP: redirect with the size flash, nothing stored
  const big = multipart('big.pdf', 'application/pdf', Buffer.alloc(MAX_UPLOAD_BYTES + 64, 0x25), csrf);
  const bigUp = await app.inject({ method: 'POST', url: '/app/uploads', headers: { ...big.headers, cookie: A.cookie }, payload: big.payload });
  assert.equal(bigUp.statusCode, 302);
  assert.match(bigUp.headers.location, /8%20MB|8\+MB/);
  assert.equal((await readUpload(A.tenantId, { filename: 'big.pdf' })), null);
});

test('tenant isolation: Beta cannot list or read Alpha uploads (RLS)', async () => {
  const listB = await listUploads(B.tenantId);
  assert.deepEqual(listB, []);
  const r = await readUpload(B.tenantId, { filename: 'offer.pdf' });
  assert.equal(r, null);
  const count = await withTenant(B.tenantId, async (c) => (await c.query('SELECT count(*)::int AS n FROM uploads')).rows[0].n);
  assert.equal(count, 0);
});

test('agent tools: list_uploads and read_upload with boundary label', async () => {
  const list = await call(A.tenantId, 'list_uploads', {});
  assert.match(list, /offer\.pdf/);
  const doc = await call(A.tenantId, 'read_upload', { filename: 'offer.pdf' });
  assert.match(doc, /^CUSTOMER DOCUMENT/);
  assert.match(doc, /1,250,000/);
  // Beta gets a clean not-found, never Alpha's content
  const none = await call(B.tenantId, 'read_upload', { filename: 'offer.pdf' });
  assert.match(none, /No uploaded document/);
});

test('http: upload form on Files page, multipart upload, appears in list', async () => {
  const page = await app.inject({ url: '/app/files', headers: { cookie: A.cookie } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /action="\/app\/uploads"/);
  const csrf = await csrfOf(A.cookie);
  const mp = multipart('mandate.txt', 'text/plain', Buffer.from('Sole mandate for 12 Oak Street'), csrf);
  const up = await app.inject({ method: 'POST', url: '/app/uploads', headers: { ...mp.headers, cookie: A.cookie }, payload: mp.payload });
  assert.equal(up.statusCode, 302);
  assert.match(up.headers.location, /Uploaded/);
  // wrong csrf is refused
  const bad = multipart('evil.txt', 'text/plain', Buffer.from('x'), 'wrong-token');
  const badUp = await app.inject({ method: 'POST', url: '/app/uploads', headers: { ...bad.headers, cookie: A.cookie }, payload: bad.payload });
  assert.equal(badUp.statusCode, 403);
  assert.equal((await readUpload(A.tenantId, { filename: 'evil.txt' })), null);
  const again = await app.inject({ url: '/app/files', headers: { cookie: A.cookie } });
  assert.match(again.body, /mandate\.txt/);
  // logged-out uploads bounce to login
  const anon = await app.inject({ method: 'POST', url: '/app/uploads', headers: mp.headers, payload: mp.payload });
  assert.equal(anon.statusCode, 302);
});
