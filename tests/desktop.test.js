import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, owner } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { setEmergencyStop } from '../src/core.js';
import { sanitizeDesktopAction, redactDesktopLabel } from '../src/desktop.js';

process.env.HI_INVITE_CODES = 'desktop-test-invite';
process.env.SIGNUP_RATE_MAX = '100';
process.env.CRON_SECRET = 'desktop-cron-secret-test';
process.env.SESSION_SECRET = 'desktop-session-secret-test';
process.env.DESKTOP_MAX_RECORDINGS_PER_TENANT_DAY = '100';
process.env.DESKTOP_MAX_TASKS_PER_TENANT_DAY = '100';
delete process.env.GROQ_API_KEY;

let db, app, A, B, keyA, keyB, script = [];
const say = (content) => ({ content, tool_calls: [] });
const call = (name, args, id = 'desktop-tool-call') => ({ content: '', tool_calls: [{ id, name, args }] });
const llm = async () => {
  const next = script.shift();
  return next || say('done');
};
const fetchImpl = async (url) => { throw new Error('unexpected external request: ' + url); };
const lookup = async () => [{ address: '93.184.216.34' }];
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];
const api = (key, method, url, body) => app.inject({
  method, url,
  headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
  payload: body === undefined ? undefined : JSON.stringify(body),
});

async function makeTenant(company, email) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({
    invite: 'desktop-test-invite', company, email, password: 'a-long-test-password-123',
  }) });
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-123' }) });
  const cookie = cookieOf(login);
  const dash = await app.inject({ url: '/app/api-keys', headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(dash.body)[1];
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  const agent = await ensureDefaultAgent(tenantId);
  const make = await app.inject({ method: 'POST', url: '/app/api-keys', headers: { cookie, ...H }, payload: form({ csrf, name: 'desktop-test' }) });
  const key = /Your new key[\s\S]*?<pre>(hi_[0-9a-f]{48})<\/pre>/.exec(make.body)?.[1];
  assert.ok(key, 'API key was created for test tenant');
  return { tenantId, agentId: agent.id, cookie, csrf, email, key };
}

const target = {
  window_title: 'Invoice application',
  process_name: 'invoice.exe',
  control_name: 'Invoice number',
  control_type: 'Edit',
  automation_id: 'invoice-number',
  class_name: 'TextBox',
  sensitive: false,
  rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.05 },
};

let recordingA, workerA;
test.before(async () => {
  db = await startDb(54324);
  app = await buildApp({ fetchImpl, llm, lookup });
  A = await makeTenant('Alpha Desktop Co', 'alpha-desktop@example.test');
  B = await makeTenant('Beta Desktop Co', 'beta-desktop@example.test');
  keyA = A.key; keyB = B.key;
});
test.after(async () => { await app.close(); await db.stop(); });
test.beforeEach(() => { script = []; });

test('recorder allowlists actions and never persists actual typed text', async () => {
  const started = await api(keyA, 'POST', '/v1/desktop/recordings', { title: 'Prepare Invoice' });
  assert.equal(started.statusCode, 201);
  recordingA = JSON.parse(started.body).recording;
  const privateValue = 'NEVER-STORE-THIS-918273';
  const action = await api(keyA, 'POST', '/v1/desktop/recordings/' + recordingA.id + '/actions', {
    action: { type: 'type', parameter: 'input_1', text: privateValue, target },
  });
  assert.equal(action.statusCode, 200);
  await api(keyA, 'POST', '/v1/desktop/recordings/' + recordingA.id + '/actions', {
    action: { type: 'click', text: privateValue, target: { ...target, control_type: 'Button', control_name: 'Save draft' } },
  });
  const stored = await withTenant(A.tenantId, (c) => c.query('SELECT actions FROM desktop_recordings WHERE id=$1', [recordingA.id]).then((r) => r.rows[0].actions));
  assert.equal(JSON.stringify(stored).includes(privateValue), false);
  assert.equal(stored[0].text, undefined);
  assert.equal(stored.length, 2);
  const stopped = await api(keyA, 'POST', '/v1/desktop/recordings/' + recordingA.id + '/stop', {});
  assert.equal(stopped.statusCode, 200);
  assert.equal(JSON.parse(stopped.body).status, 'stopped');
});

test('recording actions reject passwords and redact UI labels', async () => {
  assert.throws(() => sanitizeDesktopAction({
    type: 'type', parameter: 'input_1',
    target: { ...target, control_name: 'Password', sensitive: true },
  }), /sensitive fields/);
  assert.throws(() => sanitizeDesktopAction({
    type: 'type', parameter: 'input_1', text: 'secret',
    target: { ...target, control_name: 'Password' },
  }), /sensitive fields/);
  assert.equal(redactDesktopLabel('Contact: owner@example.test'), 'Contact: [redacted]');
  const started = await api(keyA, 'POST', '/v1/desktop/recordings', { title: 'Empty workflow' });
  const id = JSON.parse(started.body).recording.id;
  const pending = await api(keyA, 'POST', '/v1/desktop/recordings/' + id + '/publish', { name: 'empty-workflow', description: 'empty' });
  assert.equal(pending.statusCode, 400, 'active recording cannot be published');
  await api(keyA, 'POST', '/v1/desktop/recordings/' + id + '/stop', {});
  const empty = await api(keyA, 'POST', '/v1/desktop/recordings/' + id + '/publish', { name: 'empty-workflow', description: 'empty' });
  assert.equal(empty.statusCode, 400, 'empty recording cannot become a runnable skill');
  await api(keyA, 'POST', '/v1/desktop/recordings/' + id + '/stop', {});
});

test('publishes a tenant-scoped HI skill, and other tenants cannot inspect it', async () => {
  const published = await api(keyA, 'POST', '/v1/desktop/recordings/' + recordingA.id + '/publish', {
    name: 'prepare-invoice', description: 'Prepare an invoice in the desktop application',
  });
  assert.equal(published.statusCode, 201);
  const skill = JSON.parse(published.body).skill;
  assert.equal(skill.name, 'prepare-invoice');
  assert.deepEqual(skill.tools, ['desktop_task']);
  const listedA = JSON.parse((await api(keyA, 'GET', '/v1/desktop/skills')).body).skills;
  assert.ok(listedA.some((item) => item.name === 'prepare-invoice'));
  const listedB = JSON.parse((await api(keyB, 'GET', '/v1/desktop/skills')).body).skills;
  assert.equal(listedB.some((item) => item.name === 'prepare-invoice'), false);
  assert.equal((await api(keyB, 'POST', '/v1/desktop/recordings/' + recordingA.id + '/actions', { action: { type: 'click', target } })).statusCode, 404);
});

test('desktop task waits for HI approval, is atomically claimed once and checks worker identity', async () => {
  script = [
    call('desktop_task', { skill_name: 'prepare-invoice' }),
    say('The desktop skill is waiting in the approval queue.'),
  ];
  const chat = await api(keyA, 'POST', '/v1/chat', { message: 'Run my desktop skill prepare-invoice' });
  assert.equal(chat.statusCode, 200);
  const approval = await withTenant(A.tenantId, (c) => c.query("SELECT id,status,payload FROM approvals WHERE kind='desktop_task' ORDER BY created_at DESC LIMIT 1").then((r) => r.rows[0]));
  assert.equal(approval.status, 'proposed');
  workerA = '6c13d4f6-62e6-48b2-80d9-7a7a6b1d8f22';
  const before = await api(keyA, 'POST', '/v1/desktop/tasks/claim', { worker_id: workerA });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(JSON.parse(before.body).task, null);
  const approve = await app.inject({
    method: 'POST', url: '/app/approvals/' + approval.id, headers: { ...H, cookie: A.cookie },
    payload: form({ csrf: A.csrf, decision: 'approve' }),
  });
  assert.equal(approve.statusCode, 302);
  const claim = await api(keyA, 'POST', '/v1/desktop/tasks/claim', { worker_id: workerA });
  assert.equal(claim.statusCode, 200);
  const task = JSON.parse(claim.body).task;
  assert.equal(task.skill_name, 'prepare-invoice');
  assert.equal(task.actions.length, 2);
  assert.equal(task.worker_id, workerA);
  const allowed = await api(keyA, 'POST', '/v1/desktop/tasks/' + task.id + '/check', { worker_id: workerA });
  assert.equal(JSON.parse(allowed.body).allowed, true);
  await setEmergencyStop(true);
  const stopped = await api(keyA, 'POST', '/v1/desktop/tasks/' + task.id + '/check', { worker_id: workerA });
  assert.equal(JSON.parse(stopped.body).allowed, false);
  await setEmergencyStop(false);
  const wrongWorker = await api(keyA, 'POST', '/v1/desktop/tasks/' + task.id + '/result', {
    worker_id: 'b6b37ac0-329e-4d19-9b6a-ae7dbb99f59b', status: 'executed', summary: 'done',
  });
  assert.equal(wrongWorker.statusCode, 403);
  const otherTenantClaim = JSON.parse((await api(keyB, 'POST', '/v1/desktop/tasks/claim', { worker_id: '5e44f58d-7fbb-4c0c-83fc-cb2d36ce35a1' })).body).task;
  assert.equal(otherTenantClaim, null);
  const finish = await api(keyA, 'POST', '/v1/desktop/tasks/' + task.id + '/result', {
    worker_id: workerA, status: 'executed', summary: 'Completed 2 steps.',
  });
  assert.equal(finish.statusCode, 200);
  assert.equal(JSON.parse(finish.body).status, 'executed');
  const secondClaim = JSON.parse((await api(keyA, 'POST', '/v1/desktop/tasks/claim', { worker_id: workerA })).body).task;
  assert.equal(secondClaim, null);
});
