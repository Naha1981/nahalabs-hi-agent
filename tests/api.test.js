import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.RESEND_API_KEY = 're_test_key_placeholder';
process.env.MAIL_FROM = 'HI <hi@example.test>';
process.env.HI_EMAIL_DAILY_CAP = '5';
process.env.SEARX_URL = 'https://searx.example.test';
delete process.env.GROQ_API_KEY;

let db, app, script = [];
const llm = async ({ messages }) => { const r = script.shift(); if (!r) return { content: 'done', tool_calls: [] }; return { model: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 }, ...r }; };
const say = (content) => ({ content, tool_calls: [] });
const fakeFetch = async (url) => { throw new Error('unexpected fetch ' + url); };
const lookup = async () => [{ address: '93.184.216.34' }];
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];

async function mk(company, email) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const res = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
  const cookie = cookieOf(res);
  const dash = await app.inject({ url: '/app/api-keys', headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(dash.body)[1];
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  const agent = await ensureDefaultAgent(tenantId);
  return { cookie, csrf, tenantId, email, agentId: agent.id };
}
async function makeKey(u, name) {
  const res = await app.inject({ method: 'POST', url: '/app/api-keys', headers: { cookie: u.cookie, ...H }, payload: form({ csrf: u.csrf, name }) });
  const m = /Your new key[\s\S]*?<pre>(hi_[0-9a-f]{48})<\/pre>/.exec(res.body);
  assert.ok(m, 'key shown once in the response body');
  return m[1];
}
const api = (key, method, url, body) => app.inject({ method, url, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, payload: body ? JSON.stringify(body) : undefined });

let A, B, keyA, keyB;
test.before(async () => {
  db = await startDb(54324);
  app = await buildApp({ fetchImpl: fakeFetch, llm, lookup });
  A = await mk('Alpha Co', 'a@example.test'); B = await mk('Beta Co', 'b@example.test');
  keyA = await makeKey(A, 'CargoIQ'); keyB = await makeKey(B, 'RailWatch');
  // tenders are shared public data (one national feed), inserted with no tenant context
  await withSystem((c) => c.query("INSERT INTO tenders (ocid, title, buyer, description, source_url, closes_at) VALUES ('ocds-1','Cleaning services for schools','Dept of Education','Three year cleaning contract','https://etenders.example.test/1', now() + interval '10 days'), ('ocds-2','Rail signalling upgrade','Transnet','Signal systems','https://etenders.example.test/2', now() + interval '10 days')"));
});
test.after(async () => { await app.close(); await db.stop(); });
test.beforeEach(() => { script = []; });

test('bad and missing keys are rejected', async () => {
  assert.equal((await api('hi_' + '0'.repeat(48), 'GET', '/v1/agents')).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/agents' })).statusCode, 401);
  assert.equal((await api('not-a-key', 'GET', '/v1/agents')).statusCode, 401);
});

test('chat over the API answers and keeps a conversation', async () => {
  script = [say('Alpha sells cleaning services.')];
  const r = await api(keyA, 'POST', '/v1/chat', { message: 'What do we sell?' });
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.answer, 'Alpha sells cleaning services.');
  assert.ok(j.conversation_id && j.run_id);
});

test('memory save and recall are tenant-isolated', async () => {
  await api(keyA, 'POST', '/v1/memory', { content: 'Alpha Co sells commercial cleaning in Gauteng', kind: 'core' });
  const got = await api(keyA, 'GET', '/v1/memory?query=cleaning');
  assert.match(got.body, /commercial cleaning/);
  const other = await api(keyB, 'GET', '/v1/memory?query=cleaning');
  assert.doesNotMatch(other.body, /commercial cleaning/);
});

test('tasks can be scheduled and listed over the API', async () => {
  const r = await api(keyA, 'POST', '/v1/tasks', { title: 'Weekly tender scan', instruction: 'Find open cleaning tenders and summarise them.', every_minutes: 10080 });
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.ok(j.task_id && j.next_run_at);
  const list = await api(keyA, 'GET', '/v1/tasks');
  assert.match(list.body, /Weekly tender scan/);
  assert.doesNotMatch((await api(keyB, 'GET', '/v1/tasks')).body, /Weekly tender scan/);
});

test('tender search serves the shared national feed to any key', async () => {
  const r = await api(keyA, 'GET', '/v1/tenders?query=cleaning');
  assert.match(r.body, /Cleaning services for schools/);
  assert.doesNotMatch(r.body, /Rail signalling/);
  const rb = await api(keyB, 'GET', '/v1/tenders?query=signalling');
  assert.match(rb.body, /Rail signalling upgrade/);
});

test('browser jobs over the API are approval-gated', async () => {
  const r = await api(keyA, 'POST', '/v1/browser', { start_url: 'https://example.com', goal: 'Read the main heading', mode: 'read' });
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.status, 'proposed');
  assert.equal(j.approval_required, true);
  const ap = await withTenant(A.tenantId, (c) => c.query("SELECT kind, status FROM approvals WHERE payload->>'job_id'=$1", [j.job_id]).then((x) => x.rows[0]));
  assert.equal(ap.kind, 'browser_task');
  assert.equal(ap.status, 'proposed');
  const job = await api(keyA, 'GET', `/v1/browser/${j.job_id}`);
  assert.match(job.body, /proposed/);
  // tenant B cannot see tenant A's job
  assert.equal((await api(keyB, 'GET', `/v1/browser/${j.job_id}`)).statusCode, 404);
});

test('plans decompose, run specialist steps and combine', async () => {
  script = [
    say('{"steps":[{"title":"Find tenders","instruction":"Find open cleaning tenders","skill":"tender-analyst"},{"title":"Summarise","instruction":"Summarise the findings","skill":"writer"}]}'),
    say('Found one open cleaning tender from the Dept of Education.'),
    say('Summary drafted.'),
    say('Combined answer: one open cleaning tender fits Alpha Co.'),
  ];
  const r = await api(keyA, 'POST', '/v1/plans', { goal: 'Find open cleaning tenders for Alpha Co and summarise them' });
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.status, 'done');
  assert.match(j.answer, /Combined answer/);
  assert.equal(j.steps.length, 2);
  assert.equal(j.steps[0].skill, 'tender-analyst');
  const got = await api(keyA, 'GET', `/v1/plans/${j.plan_id}`);
  assert.match(got.body, /Combined answer/);
  assert.equal((await api(keyB, 'GET', `/v1/plans/${j.plan_id}`)).statusCode, 404);
});

test('revoked keys stop working', async () => {
  const keys = await withTenant(A.tenantId, (c) => c.query("SELECT id FROM api_keys WHERE name='CargoIQ'").then((r) => r.rows));
  await withTenant(A.tenantId, (c) => c.query("UPDATE api_keys SET status='revoked' WHERE id=$1", [keys[0].id]));
  assert.equal((await api(keyA, 'GET', '/v1/agents')).statusCode, 401);
});
