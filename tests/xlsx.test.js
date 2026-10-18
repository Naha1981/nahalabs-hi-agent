import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, XLSX_MIME } from '../src/xlsx.js';
import { startDb, owner } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.RESEND_API_KEY = 're_test_key_placeholder';
process.env.MAIL_FROM = 'HI <hi@example.test>';
process.env.HI_EMAIL_DAILY_CAP = '5';
process.env.SEARX_URL = 'https://searx.example.test';
delete process.env.GROQ_API_KEY;

// --- minimal ZIP reader for assertions (stored entries, sizes in local headers) ---
function unzip(buf) {
  const out = new Map();
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(off + 26), extraLen = buf.readUInt16LE(off + 28);
    const size = buf.readUInt32LE(off + 18);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const data = buf.subarray(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + size);
    out.set(name, data);
    off += 30 + nameLen + extraLen + size;
  }
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), 'end-of-central-directory present');
  return out;
}

test('buildXlsx makes a genuine xlsx zip with all required parts', () => {
  const buf = buildXlsx([{ name: 'Tenders', rows: [['Title', 'Score'], ['Cleaning & "hygiene" <tender>', 0.87], ['Rail', null]] }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts with a ZIP local header');
  const parts = unzip(buf);
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) assert.ok(parts.has(p), `missing ${p}`);
  const ct = parts.get('[Content_Types].xml').toString();
  assert.match(ct, /spreadsheetml\.sheet\.main\+xml/, 'content type declares a real workbook');
  const sheet = parts.get('xl/worksheets/sheet1.xml').toString();
  assert.ok(sheet.includes('Cleaning &amp; &quot;hygiene&quot; &lt;tender&gt;'), 'XML-escaped inline string');
  assert.ok(sheet.includes('<c r="B2"><v>0.87</v></c>'), 'numeric cell written as a number');
  assert.ok(sheet.includes('<c r="B3"/>'), 'null written as empty cell');
});

test('sheet names are sanitised and multiple sheets work', () => {
  const buf = buildXlsx([{ name: 'a/b:c*d?e[f]g', rows: [['x']] }, { rows: [['y']] }]);
  const parts = unzip(buf);
  const wb = parts.get('xl/workbook.xml').toString();
  assert.ok(wb.includes('name="a b c d e f g"'), 'illegal sheet-name chars stripped');
  assert.ok(wb.includes('name="Sheet2"'), 'fallback name for missing name');
  assert.ok(parts.has('xl/worksheets/sheet2.xml'));
});

test('buildXlsx with no sheets still returns a valid empty workbook', () => {
  const parts = unzip(buildXlsx([]));
  assert.ok(parts.get('xl/worksheets/sheet1.xml').toString().includes('<sheetData></sheetData>'));
});

// --- endpoint tests ---
const llm = async () => ({ content: 'ok', tool_calls: [] });
const fakeFetch = async (url) => { throw new Error('unexpected fetch ' + url); };
const lookup = async () => [{ address: '93.184.216.34' }];
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];

let db, app, A, keyA, keyB;
test.before(async () => {
  db = await startDb(54327);
  app = await buildApp({ fetchImpl: fakeFetch, llm, lookup });
  const mk = async (company, email) => {
    await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
    const res = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
    const cookie = cookieOf(res);
    const dash = await app.inject({ url: '/app/api-keys', headers: { cookie } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(dash.body)[1];
    const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
    return { cookie, csrf, tenantId };
  };
  A = await mk('Alpha Co', 'a@example.test');
  const B = await mk('Beta Co', 'b@example.test');
  const makeKey = async (u) => {
    const res = await app.inject({ method: 'POST', url: '/app/api-keys', headers: { cookie: u.cookie, ...H }, payload: form({ csrf: u.csrf, name: 'xlsx-test' }) });
    return /Your new key[\s\S]*?<pre>(hi_[0-9a-f]{48})<\/pre>/.exec(res.body)[1];
  };
  keyA = await makeKey(A); keyB = await makeKey(B);
  await withSystem((c) => c.query("INSERT INTO tenders (ocid, title, buyer, description, source_url, closes_at) VALUES ('ocds-1','Cleaning services for schools','Dept of Education','Three year cleaning contract','https://etenders.example.test/1', now() + interval '10 days'), ('ocds-2','Rail signalling upgrade','Transnet','Signal systems','https://etenders.example.test/2', now() + interval '10 days')"));
  await withTenant(A.tenantId, (c) => c.query("INSERT INTO matches (tenant_id, ocid, score, reasons) VALUES (current_setting('app.tenant_id')::uuid,'ocds-1',87,$1)", [JSON.stringify([{ text: 'keyword cleaning', points: 40 }])]));
  await withTenant(B.tenantId, (c) => c.query("INSERT INTO matches (tenant_id, ocid, score, reasons) VALUES (current_setting('app.tenant_id')::uuid,'ocds-2',55,$1)", [JSON.stringify([{ text: 'keyword rail', points: 30 }])]));
});
test.after(async () => { await app.close(); await db.stop(); });

test('export endpoints require a key', async () => {
  assert.equal((await app.inject({ url: '/v1/tenders/export.xlsx' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/matches/export.xlsx' })).statusCode, 401);
});

test('tenders export returns a genuine xlsx with the open tenders', async () => {
  const res = await app.inject({ url: '/v1/tenders/export.xlsx', headers: { authorization: `Bearer ${keyA}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], XLSX_MIME);
  assert.match(res.headers['content-disposition'], /attachment; filename="hi-tenders-\d{4}-\d{2}-\d{2}\.xlsx"/);
  const sheet = unzip(res.rawPayload).get('xl/worksheets/sheet1.xml').toString();
  assert.ok(sheet.includes('Cleaning services for schools') && sheet.includes('Rail signalling upgrade'), 'both tenders present');
  assert.ok(sheet.includes('OCID'), 'header row present');
});

test('matches export is tenant isolated', async () => {
  const resA = await app.inject({ url: '/v1/matches/export.xlsx', headers: { authorization: `Bearer ${keyA}` } });
  const sheetA = unzip(resA.rawPayload).get('xl/worksheets/sheet1.xml').toString();
  assert.ok(sheetA.includes('Cleaning services for schools'), 'own match present');
  assert.ok(!sheetA.includes('Rail signalling upgrade'), 'other tenant match absent');
  assert.ok(sheetA.includes('keyword cleaning'), 'match reasons included');
  const resB = await app.inject({ url: '/v1/matches/export.xlsx', headers: { authorization: `Bearer ${keyB}` } });
  const sheetB = unzip(resB.rawPayload).get('xl/worksheets/sheet1.xml').toString();
  assert.ok(sheetB.includes('Rail signalling upgrade') && !sheetB.includes('Cleaning services for schools'));
});

test('web export needs a session and serves the tenant workbook', async () => {
  assert.equal((await app.inject({ url: '/app/opportunities.xlsx' })).statusCode, 302, 'anonymous redirected to login');
  const res = await app.inject({ url: '/app/opportunities.xlsx', headers: { cookie: A.cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], XLSX_MIME);
  assert.match(res.headers['content-disposition'], /hi-opportunities-/);
  const sheet = unzip(res.rawPayload).get('xl/worksheets/sheet1.xml').toString();
  assert.ok(sheet.includes('Cleaning services for schools') && !sheet.includes('Rail signalling upgrade'));
});

test('opportunities page links the export', async () => {
  const res = await app.inject({ url: '/app', headers: { cookie: A.cookie } });
  assert.ok(res.body.includes('href="/app/opportunities.xlsx"'));
});
