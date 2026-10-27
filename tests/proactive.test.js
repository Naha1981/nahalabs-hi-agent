import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { runDueTasks, ensureDefaultAgent, nextInWindow, PROACTIVE_TASK_TITLE } from '../src/agent.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
delete process.env.GROQ_API_KEY;

const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];
const lookup = async () => [{ address: '93.184.216.34' }];
const SAST = (h, m = 0, day = 0) => new Date(Date.UTC(2026, 9, 27 + day, h - 2, m)); // SAST wall time -> Date

test('nextInWindow clamps into the 9-22 SAST window and stays at least one interval out', () => {
  assert.equal(nextInWindow(SAST(10), 180, 9, 22).toISOString(), SAST(13).toISOString()); // inside: unchanged
  assert.equal(nextInWindow(SAST(20, 30), 180, 9, 22).toISOString(), SAST(9, 0, 1).toISOString()); // past 22: next day 09:00
  assert.equal(nextInWindow(SAST(5, 30), 180, 9, 22).toISOString(), SAST(9).toISOString()); // before 9: today 09:00
  for (const h of [0, 3, 6, 9, 12, 15, 18, 21, 23]) {
    const n = nextInWindow(SAST(h), 180, 9, 22);
    assert.ok(n - SAST(h) >= 180 * 60000, `hour ${h} closer than one interval`);
    const wall = new Date(n.getTime() + 2 * 3600000).getUTCHours();
    assert.ok(wall >= 9 && wall < 22, `hour ${h} lands at ${h === 23 ? wall : wall} SAST`);
  }
  assert.equal(nextInWindow(SAST(23), 60, null, null).toISOString(), SAST(0, 0, 1).toISOString()); // no window
});

let db, app, A, findings;
const llm = async ({ messages }) => {
  const sys = String(messages?.[0]?.content || '');
  if (sys.includes('unattended scheduled run')) {
    return { content: findings.length ? findings.shift() : 'NOTHING_NEEDED', tool_calls: [], model: 'stub', usage: { prompt_tokens: 5, completion_tokens: 5 } };
  }
  return { content: 'ok', tool_calls: [], model: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 } };
};

test.before(async () => {
  db = await startDb(54373);
  findings = [];
  app = await buildApp({ llm, lookup });
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company: 'Pro Props', email: 'pro@example.test', password: 'a-long-test-password-1' }) });
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'pro@example.test', password: 'a-long-test-password-1' }) });
  A = { cookie: cookieOf(login) };
  await app.inject({ url: '/app/agent', headers: { cookie: A.cookie } });
  A.tenantId = (await withSystem((c) => c.query("SELECT tenant_id FROM users WHERE email='pro@example.test'"))).rows[0].tenant_id;
});
test.after(async () => { await app.close(); await db.stop(); });

const makeDue = () => withTenant(A.tenantId, (c) => c.query("UPDATE tasks SET next_run_at = now() - interval '1 minute' WHERE created_by='system'"));

test('default proactive check exists once, windowed, posting to chat', async () => {
  await ensureDefaultAgent(A.tenantId); await ensureDefaultAgent(A.tenantId); // idempotent
  const rows = (await withTenant(A.tenantId, (c) => c.query("SELECT * FROM tasks WHERE created_by='system'"))).rows;
  assert.equal(rows.length, 1);
  const t = rows[0];
  assert.equal(t.title, PROACTIVE_TASK_TITLE);
  assert.equal(t.interval_minutes, 180);
  assert.equal(t.window_start, 9); assert.equal(t.window_end, 22);
  assert.equal(t.post_to_chat, true);
  assert.ok(new Date(t.next_run_at) >= new Date(Date.now() + 180 * 60000 - 5000));
});

test('a finding posts one note to the Proactive notes chat and reschedules inside the window', async () => {
  findings.push('Morning - the Oak Street deal needs bank docs from Sipho by Friday, and you have a viewing tomorrow at 10:00. I can draft the follow-up email.');
  await makeDue();
  const before = Date.now();
  const out = await runDueTasks({ llm, lookup, now: new Date() });
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'done');
  const conv = (await withTenant(A.tenantId, (c) => c.query("SELECT id FROM conversations WHERE title='Proactive notes'"))).rows[0];
  assert.ok(conv);
  const msgs = (await withTenant(A.tenantId, (c) => c.query("SELECT role, content FROM messages WHERE conversation_id=$1 AND role='assistant'", [conv.id]))).rows;
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, /Oak Street/);
  // run recorded against the task and linked to the chat
  const run = (await withTenant(A.tenantId, (c) => c.query('SELECT result, conversation_id FROM runs ORDER BY created_at DESC LIMIT 1'))).rows[0];
  assert.match(run.result, /Oak Street/);
  assert.equal(run.conversation_id, conv.id);
  // rescheduled at least ~3h out and inside the window
  const t = (await withTenant(A.tenantId, (c) => c.query("SELECT next_run_at FROM tasks WHERE created_by='system'"))).rows[0];
  assert.ok(new Date(t.next_run_at) - before >= 180 * 60000 - 5000);
  const wallH = new Date(new Date(t.next_run_at).getTime() + 2 * 3600000).getUTCHours();
  assert.ok(wallH >= 9 && wallH < 22);
});

test('a quiet check posts nothing and the history says so plainly', async () => {
  await makeDue();
  const out = await runDueTasks({ llm, lookup, now: new Date() });
  assert.equal(out[0].status, 'done');
  const conv = (await withTenant(A.tenantId, (c) => c.query("SELECT id FROM conversations WHERE title='Proactive notes'"))).rows[0];
  const msgs = (await withTenant(A.tenantId, (c) => c.query("SELECT count(*)::int n FROM messages WHERE conversation_id=$1", [conv.id]))).rows[0];
  assert.equal(msgs.n, 1); // still only the earlier finding
  const run = (await withTenant(A.tenantId, (c) => c.query('SELECT result FROM runs ORDER BY created_at DESC LIMIT 1'))).rows[0];
  assert.equal(run.result, 'Checked in - nothing needed your attention.');
});

test('tasks page shows buckets in plain words and the task thread lists runs', async () => {
  let r = await app.inject({ url: '/app/tasks', headers: { cookie: A.cookie } });
  assert.match(r.body, /<b>Active<\/b>/);
  assert.match(r.body, /<b>Scheduled<\/b>/);
  assert.match(r.body, /Proactive check/);
  assert.match(r.body, /every 3 h, 09:00-22:00/);
  const id = (await withTenant(A.tenantId, (c) => c.query("SELECT id FROM tasks WHERE created_by='system'"))).rows[0].id;
  assert.match(r.body, new RegExp(`href="/app/tasks/${id}"`));
  r = await app.inject({ url: `/app/tasks/${id}`, headers: { cookie: A.cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /<h2>Thread<\/h2>/);
  assert.match(r.body, /Oak Street/);
  assert.match(r.body, /Checked in - nothing needed your attention/);
  assert.match(r.body, /every 3 h, 09:00-22:00 SAST/);
  // thread reads top-down: the finding (earlier) comes before the quiet check (later)
  assert.ok(r.body.indexOf('Oak Street') < r.body.indexOf('Checked in - nothing needed'));
});

test('tasks page buckets: up next, scheduled and resolved land in their own folders', async () => {
  const agent = (await withTenant(A.tenantId, (c) => c.query('SELECT id FROM agents LIMIT 1'))).rows[0].id;
  await withTenant(A.tenantId, async (c) => {
    await c.query("INSERT INTO tasks (tenant_id, agent_id, title, instruction, next_run_at) VALUES (current_setting('app.tenant_id')::uuid,$1,'Phone the school','Call about the concert', now() + interval '1 day')", [agent]);
    await c.query("INSERT INTO tasks (tenant_id, agent_id, title, instruction, next_run_at, status) VALUES (current_setting('app.tenant_id')::uuid,$1,'Old one-off','Did a thing', NULL, 'done')", [agent]);
  });
  const r = await app.inject({ url: '/app/tasks', headers: { cookie: A.cookie } });
  const names = ['Active', 'Up next', 'Scheduled', 'Resolved', 'New task'];
  const sec = (name) => { const i = r.body.indexOf(`<b>${name}</b>`); if (i < 0) return ''; const rest = r.body.slice(i + name.length + 7); const next = names.map((n) => rest.indexOf(`<b>${n}</b>`)).filter((x) => x >= 0); return next.length ? rest.slice(0, Math.min(...next)) : rest; };
  assert.match(sec('Up next'), /Phone the school/);
  assert.doesNotMatch(sec('Up next'), /Proactive check/);
  assert.match(sec('Scheduled'), /Proactive check/);
  assert.match(sec('Resolved'), /Old one-off/);
  assert.doesNotMatch(sec('Active'), /Phone the school/);
});

test('scheduled-task run conversations stay out of Recent conversations', async () => {
  const agent = (await withTenant(A.tenantId, (c) => c.query('SELECT id FROM agents LIMIT 1'))).rows[0].id;
  await withTenant(A.tenantId, (c) => c.query(`INSERT INTO conversations (tenant_id, agent_id, title) VALUES (current_setting('app.tenant_id')::uuid,$1,'Scheduled task "Proactive check": Check in for the owner')`, [agent]));
  const r = await app.inject({ url: '/app/agent', headers: { cookie: A.cookie } });
  assert.doesNotMatch(r.body, /Scheduled task \"Proactive check\": Check in for the owner<\/a>/);
  assert.match(r.body, /Proactive notes/); // the real notes conversation still shows
});

test('history page is tenant-scoped and sign-in gated', async () => {
  const id = (await withTenant(A.tenantId, (c) => c.query("SELECT id FROM tasks WHERE created_by='system'"))).rows[0].id;
  const noauth = await app.inject({ url: `/app/tasks/${id}` });
  assert.equal(noauth.statusCode, 302);
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company: 'Other Co', email: 'other@example.test', password: 'a-long-test-password-1' }) });
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'other@example.test', password: 'a-long-test-password-1' }) });
  const r = await app.inject({ url: `/app/tasks/${id}`, headers: { cookie: cookieOf(login) } });
  assert.equal(r.statusCode, 302); // not theirs: redirected away with a flash
  assert.match(r.headers.location, /not%20available/);
});
