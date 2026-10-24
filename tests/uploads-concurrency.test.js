import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { saveUpload, MAX_UPLOAD_BYTES } from '../src/uploads.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.SEARX_URL = 'https://searx.example.test';
delete process.env.GROQ_API_KEY;

let db, o, A, B;
test.before(async () => {
  db = await startDb(54361);
  o = owner(db.ownerUrl); await o.connect();
  A = (await o.query("INSERT INTO tenants (name) VALUES ('Concurrency A') RETURNING id")).rows[0].id;
  B = (await o.query("INSERT INTO tenants (name) VALUES ('Concurrency B') RETURNING id")).rows[0].id;
});
test.after(async () => { await o.end(); await db.stop(); });

const txt = (n) => Buffer.from('x'.repeat(n));
const attempt = (tenantId, name, buf) =>
  saveUpload(tenantId, { filename: name, mime: 'text/plain', buffer: buf }).then(() => 'ok').catch((e) => e.code || 'ERR');

test('tenant quota admission is atomic under concurrent same-tenant uploads', async () => {
  process.env.HI_UPLOAD_TENANT_QUOTA_BYTES = '1000';
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(A, `race-a-${i}.txt`, txt(200))));
    assert.deepEqual([...results].sort(), ['TENANT_QUOTA', 'TENANT_QUOTA', 'TENANT_QUOTA', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const used = (await o.query('SELECT COALESCE(SUM(size_bytes),0)::bigint AS s FROM uploads WHERE tenant_id=$1', [A])).rows[0].s;
    assert.equal(Number(used), 1000, 'stored bytes never exceed the tenant quota, exactly 5 x 200 admitted');
  } finally { delete process.env.HI_UPLOAD_TENANT_QUOTA_BYTES; }
});

test('global budget admission is atomic under concurrent cross-tenant uploads', async () => {
  // the ledger already holds 1000 bytes from the previous test; cap the total at 2000
  await o.query('UPDATE upload_budget SET budget_bytes = 2000 WHERE id=1');
  try {
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => attempt(A, `race-g-a-${i}.txt`, txt(200))),
      ...Array.from({ length: 4 }, (_, i) => attempt(B, `race-g-b-${i}.txt`, txt(200))),
    ]);
    assert.equal(results.filter((r) => r === 'ok').length, 5);
    assert.equal(results.filter((r) => r === 'GLOBAL_BUDGET').length, 3);
    const led = (await o.query('SELECT bytes_used FROM upload_budget WHERE id=1')).rows[0].bytes_used;
    const sum = (await o.query('SELECT COALESCE(SUM(size_bytes),0) AS s FROM uploads')).rows[0].s;
    assert.equal(Number(led), 2000, 'ledger never overshoots the shared budget');
    assert.equal(String(led), String(sum), 'ledger matches stored bytes after the race');
  } finally { await o.query('UPDATE upload_budget SET budget_bytes = 134217728 WHERE id=1'); }
});

test('the cap is server-owned: no caller-side setting can widen it', async () => {
  await o.query('UPDATE upload_budget SET budget_bytes = 3000 WHERE id=1'); // 2000 in use
  process.env.HI_UPLOAD_GLOBAL_BUDGET_BYTES = '999999999'; // stale env var must be ignored
  try {
    assert.equal(await attempt(A, 'cap-1.txt', txt(800)), 'ok');
    assert.equal(await attempt(A, 'cap-2.txt', txt(800)), 'GLOBAL_BUDGET'); // 2800 + 800 > 3000
  } finally {
    delete process.env.HI_UPLOAD_GLOBAL_BUDGET_BYTES;
    await o.query('UPDATE upload_budget SET budget_bytes = 134217728 WHERE id=1');
  }
});

test('a failed insert rolls the global reservation back', async () => {
  const before = (await o.query('SELECT bytes_used FROM upload_budget WHERE id=1')).rows[0].bytes_used;
  const ghost = '00000000-0000-0000-0000-000000000000'; // no such tenant: FK fails at INSERT
  const err = await saveUpload(ghost, { filename: 'ghost.txt', mime: 'text/plain', buffer: txt(64) }).then(() => null).catch((e) => e);
  assert.ok(err && err.code !== 'GLOBAL_BUDGET' && err.code !== 'TENANT_QUOTA', 'fails at the insert, not admission');
  const after = (await o.query('SELECT bytes_used FROM upload_budget WHERE id=1')).rows[0].bytes_used;
  assert.equal(String(after), String(before), 'reservation rolled back with the failed transaction');
});

test('saveUpload itself enforces the 8 MB cap and rejects empty buffers', async () => {
  assert.equal(await attempt(A, 'empty.txt', Buffer.alloc(0)), 'UPLOAD_SIZE');
  assert.equal(await attempt(A, 'huge.txt', Buffer.alloc(MAX_UPLOAD_BYTES + 1)), 'UPLOAD_SIZE');
});
