import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { runDueTasks, ensureDefaultAgent } from '../src/agent.js';
import { splitDump, fallbackSplit } from '../src/dump.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests';
delete process.env.GROQ_API_KEY;

const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];
const lookup = async () => [{ address: '93.184.216.34' }];
const say = (content) => ({ content, tool_calls: [], model: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 } });
const llm = async () => say('Task done: looked at it and recorded the outcome.');

let db, app, A, B;
test.before(async () => {
  db = await startDb(54371);
  app = await buildApp({ llm, lookup });
  const mk = async (company, email) => {
    await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
    const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
    const cookie = cookieOf(login);
    const dash = await app.inject({ url: '/app/agent', headers: { cookie } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(dash.body)[1];
    const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
    const agent = await ensureDefaultAgent(tenantId);
    return { cookie, csrf, tenantId, email, agentId: agent.id };
  };
  A = await mk('Dump Alpha', 'alpha@dump.test');
  B = await mk('Dump Beta', 'beta@dump.test');
});
test.after(async () => { await app.close(); await db.stop(); });

test('fallbackSplit: paragraphs, bullets, sentences; caps at 8; never empty on text', () => {
  assert.equal(fallbackSplit('').length, 0);
  assert.deepEqual(fallbackSplit('one thing only')[0].title, 'one thing only');
  const paras = fallbackSplit('Follow up the Sandton quote\n\nRenew CIPC\n\nAsk Sipho about Saturday');
  assert.equal(paras.length, 3);
  assert.equal(paras[1].title, 'Renew CIPC');
  const bullets = fallbackSplit('- first task\n- second task\n1. third task');
  assert.equal(bullets.length, 3);
  assert.equal(bullets[2].title, 'third task');
  const many = fallbackSplit(Array.from({ length: 12 }, (_, i) => `task ${i + 1}`).join('\n'));
  assert.equal(many.length, 8);
});

test('splitDump: model JSON is validated and used; bad model output falls back', async () => {
  process.env.GROQ_API_KEY = 'test-key-not-used';
  try {
    const good = async () => ({ content: 'Here you go: [{"title":"Chase quote","instruction":"Follow up the Sandton quote with the client"},{"title":"Renew CIPC","instruction":"Renew the CIPC registration"}] thanks', tool_calls: [], model: 'stub', usage: { prompt_tokens: 3, completion_tokens: 4 } });
    const r1 = await splitDump({ raw: 'x', tenantId: A.tenantId, llm: good });
    assert.equal(r1.via, 'model');
    assert.equal(r1.items.length, 2);
    assert.equal(r1.items[0].title, 'Chase quote');
    const usage = await withTenant(A.tenantId, (c) => c.query("SELECT prompt_tokens FROM model_usage WHERE model='stub'"));
    assert.equal(usage.rows[0].prompt_tokens, 3);

    const bad = async () => ({ content: 'I cannot do that', tool_calls: [] });
    const r2 = await splitDump({ raw: 'first\n\nsecond', tenantId: A.tenantId, llm: bad });
    assert.equal(r2.via, 'fallback');
    assert.equal(r2.items.length, 2);

    const junk = async () => ({ content: '[{"title":""},{"nope":1}]', tool_calls: [] });
    const r3 = await splitDump({ raw: 'only task', tenantId: A.tenantId, llm: junk });
    assert.equal(r3.via, 'fallback');
    assert.equal(r3.items[0].title, 'only task');
  } finally { delete process.env.GROQ_API_KEY; }
});

test('journey: dump -> preview -> start -> agent works -> review -> reviewed', async () => {
  // 1. The box is on the page, nav included
  let r = await app.inject({ url: '/app/dump', headers: { cookie: A.cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /Everything on your mind, in one go/);
  assert.match(r.body, /Needs your input/);
  assert.match(r.body, /Waiting for your review/);
  assert.match(r.body, /Agent is working on/);

  // 2. Submit a dump (model off -> deterministic split), lands on the review page
  const raw = 'Follow up the Sandton quote\n\nAsk Sipho about the Saturday viewing\n\nFind three electricians for the Midrand job';
  r = await app.inject({ method: 'POST', url: '/app/dump', headers: { ...H, cookie: A.cookie }, payload: form({ csrf: A.csrf, raw }) });
  assert.equal(r.statusCode, 302);
  const loc = r.headers.location;
  assert.match(loc, /^\/app\/dump\/[0-9a-f-]{36}$/);
  r = await app.inject({ url: loc, headers: { cookie: A.cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /3 tasks/);
  assert.match(r.body, /Follow up the Sandton quote/);
  assert.match(r.body, /Ask Sipho about the Saturday viewing/);
  assert.match(r.body, /Start now/);
  assert.match(r.body, /Save for later/);

  // 3. Start two of the three (untick the third by omitting its checkbox)
  const payload = new URLSearchParams();
  payload.append('csrf', A.csrf);
  payload.append('title', 'Chase the Sandton quote');
  payload.append('instruction', 'Follow up the Sandton quote with the client');
  payload.append('include', '0');
  payload.append('title', 'Ask Sipho about Saturday');
  payload.append('instruction', 'Ask Sipho about the Saturday viewing');
  payload.append('include', '1');
  payload.append('title', 'Find three electricians');
  payload.append('instruction', 'Find three electricians for the Midrand job');
  payload.append('action', 'start');
  r = await app.inject({ method: 'POST', url: loc, headers: { ...H, cookie: A.cookie }, payload: payload.toString() });
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.location, /Started%202%20tasks/);

  const tasks = await withTenant(A.tenantId, (c) => c.query('SELECT title, interval_minutes, status, dump_id FROM tasks WHERE dump_id IS NOT NULL ORDER BY created_at'));
  assert.equal(tasks.rows.length, 2);
  assert.equal(tasks.rows[0].interval_minutes, null);
  assert.ok(tasks.rows[0].dump_id);
  const dump = await withTenant(A.tenantId, (c) => c.query('SELECT status FROM dumps'));
  assert.equal(dump.rows[0].status, 'started');

  // 4. The queued work shows on the Active list
  r = await app.inject({ url: '/app/dump', headers: { cookie: A.cookie } });
  assert.match(r.body, /Chase the Sandton quote/);
  assert.match(r.body, /queued/);

  // 5. The due-task runner picks both up; results land in Waiting for your review
  const out = await runDueTasks({ llm, lookup });
  assert.equal(out.length, 2);
  r = await app.inject({ url: '/app/dump', headers: { cookie: A.cookie } });
  assert.match(r.body, /Task done: looked at it and recorded the outcome./);
  assert.match(r.body, /Mark reviewed/);

  // 6. Review clears the bucket
  const runId = (await withTenant(A.tenantId, (c) => c.query("SELECT id FROM runs WHERE status='done' AND reviewed_at IS NULL LIMIT 1"))).rows[0].id;
  r = await app.inject({ method: 'POST', url: `/app/runs/${runId}/review`, headers: { ...H, cookie: A.cookie }, payload: form({ csrf: A.csrf }) });
  assert.equal(r.statusCode, 302);
  const left = await withTenant(A.tenantId, (c) => c.query("SELECT count(*)::int n FROM runs WHERE status='done' AND reviewed_at IS NULL"));
  assert.equal(left.rows[0].n, 1); // second run still awaiting review

  // 7. Tenant B sees none of A's dump, tasks or runs
  r = await app.inject({ url: '/app/dump', headers: { cookie: B.cookie } });
  assert.equal(r.statusCode, 200);
  assert.doesNotMatch(r.body, /Chase the Sandton quote/);   // A's started task title
  assert.doesNotMatch(r.body, /Ask Sipho about Saturday/);  // A's started task title
  assert.doesNotMatch(r.body, /Task done: looked at it/);   // A's run result
  r = await app.inject({ url: loc, headers: { cookie: B.cookie } });
  assert.equal(r.statusCode, 302); // redirected away, not shown
  const otherRun = (await withTenant(A.tenantId, (c) => c.query("SELECT id FROM runs WHERE status='done' AND reviewed_at IS NULL LIMIT 1"))).rows[0].id;
  r = await app.inject({ method: 'POST', url: `/app/runs/${otherRun}/review`, headers: { ...H, cookie: B.cookie }, payload: form({ csrf: B.csrf }) });
  const stillThere = await withTenant(A.tenantId, (c) => c.query('SELECT reviewed_at FROM runs WHERE id=$1', [otherRun]));
  assert.equal(stillThere.rows[0].reviewed_at, null); // B could not review A's run
});

test('journey: save for later keeps a startable draft; delete archives it', async () => {
  let r = await app.inject({ method: 'POST', url: '/app/dump', headers: { ...H, cookie: A.cookie }, payload: form({ csrf: A.csrf, raw: 'One saved idea' }) });
  const loc = r.headers.location;
  const payload = new URLSearchParams();
  payload.append('csrf', A.csrf);
  payload.append('title', 'One saved idea');
  payload.append('instruction', 'One saved idea');
  payload.append('include', '0');
  payload.append('action', 'save');
  r = await app.inject({ method: 'POST', url: loc, headers: { ...H, cookie: A.cookie }, payload: payload.toString() });
  assert.match(r.headers.location, /Saved%20for%20later/);
  r = await app.inject({ url: '/app/dump', headers: { cookie: A.cookie } });
  assert.match(r.body, /Saved for later/);
  assert.match(r.body, /One saved idea/);
  const d = await withTenant(A.tenantId, (c) => c.query("SELECT id, status FROM dumps WHERE raw='One saved idea'"));
  assert.equal(d.rows[0].status, 'draft');
  r = await app.inject({ method: 'POST', url: `/app/dump/${d.rows[0].id}/delete`, headers: { ...H, cookie: A.cookie }, payload: form({ csrf: A.csrf }) });
  assert.match(r.headers.location, /Deleted/);
  const gone = await withTenant(A.tenantId, (c) => c.query("SELECT status FROM dumps WHERE raw='One saved idea'"));
  assert.equal(gone.rows[0].status, 'archived');
});
