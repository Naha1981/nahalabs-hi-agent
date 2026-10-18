// Drive Companion slice 1: browser voice turns through the shared agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.RESEND_API_KEY = 're_test_key_placeholder';
process.env.MAIL_FROM = 'HI <hi@example.test>';
process.env.GROQ_API_KEY = 'gsk_test_voice';

let db, app, script = [], seenMessages = [], ttsFails = false;
const llm = async ({ messages }) => { seenMessages.push(messages); const r = script.shift(); if (!r) return { content: 'done', tool_calls: [] }; return { model: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 }, ...r }; };
const call = (name, args, id = 'c1') => ({ content: '', tool_calls: [{ id, name, args }] });
const say = (content) => ({ content, tool_calls: [] });
const fakeFetch = async (url, opts) => {
  url = String(url);
  if (url.includes('audio/transcriptions')) return { ok: true, json: async () => ({ text: fakeTranscript }) };
  if (url.includes('audio/speech')) {
    if (ttsFails) return { ok: false, status: 400, json: async () => ({ error: 'terms' }) };
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('RIFF-fake-wav') };
  }
  throw new Error('unexpected fetch ' + url);
};
const lookup = async () => [{ address: '93.184.216.34' }];
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];
let fakeTranscript = 'remind me to phone the school at three this afternoon';

async function mk(company, email) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const res = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email, password: 'a-long-test-password-1' }) });
  const cookie = cookieOf(res);
  const dash = await app.inject({ url: '/app/agent', headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(dash.body)[1];
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  const agent = await ensureDefaultAgent(tenantId);
  return { cookie, csrf, tenantId, email, agentId: agent.id };
}
const voicePost = (u, bytes = Buffer.from('fake-audio'), extra = '') =>
  app.inject({ method: 'POST', url: `/app/voice/turn?csrf=${u.csrf}${extra}`, headers: { cookie: u.cookie, 'content-type': 'audio/webm' }, payload: bytes });

let A, B;
test.before(async () => { db = await startDb(54326); app = await buildApp({ fetchImpl: fakeFetch, llm, lookup }); A = await mk('Alpha Co', 'a@example.test'); B = await mk('Beta Co', 'b@example.test'); });
test.after(async () => { await app.close(); await db.stop(); });
test.beforeEach(() => { script = []; seenMessages = []; ttsFails = false; fakeTranscript = 'remind me to phone the school at three this afternoon'; delete process.env.VOICE_MAX_BYTES; });

test('drive page needs login and renders for a signed-in customer', async () => {
  const anon = await app.inject({ url: '/app/drive' });
  assert.equal(anon.statusCode, 302);
  const page = await app.inject({ url: '/app/drive', headers: { cookie: A.cookie } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /TALK/);
  assert.match(page.body, /\/drive\.js/);
});

test('voice turn rejects no session and bad csrf', async () => {
  const noAuth = await app.inject({ method: 'POST', url: '/app/voice/turn?csrf=x', headers: { 'content-type': 'audio/webm' }, payload: Buffer.from('x') });
  assert.equal(noAuth.statusCode, 401);
  const badCsrf = await app.inject({ method: 'POST', url: '/app/voice/turn?csrf=wrong', headers: { cookie: A.cookie, 'content-type': 'audio/webm' }, payload: Buffer.from('x') });
  assert.equal(badCsrf.statusCode, 403);
});

test('voice turn: audio -> transcript -> reminder scheduled through the shared agent -> spoken answer', async () => {
  script = [call('schedule_task', { title: 'Phone the school', instruction: 'Remind the customer to phone the school.', run_in_minutes: 180 }), say('Done. I will remind you at three this afternoon.')];
  const r = await voicePost(A);
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.transcript, 'remind me to phone the school at three this afternoon');
  assert.equal(j.answer, 'Done. I will remind you at three this afternoon.');
  assert.equal(j.tts, 'server');
  assert.equal(Buffer.from(j.audio, 'base64').toString(), 'RIFF-fake-wav');
  assert.match(j.conversationId, /^[0-9a-f-]{36}$/);
  const task = await withTenant(A.tenantId, (c) => c.query("SELECT * FROM tasks WHERE title='Phone the school'").then((x) => x.rows[0]));
  assert.ok(task, 'reminder task was created');
  // voice mode reached the model prompt
  assert.match(seenMessages[0][0].content, /hands-free/);
  // conversation continues on the second turn
  script = [say('It is at half past two.')];
  const r2 = await voicePost(A, Buffer.from('more-audio'), '&c=' + j.conversationId);
  assert.equal(r2.json().conversationId, j.conversationId);
  const msgs = await withTenant(A.tenantId, (c) => c.query('SELECT count(*)::int n FROM messages WHERE conversation_id=$1', [j.conversationId]).then((x) => x.rows[0].n));
  assert.ok(msgs >= 4, 'both turns are in the same conversation');
});

test('TTS outage falls back to client-side speech honestly', async () => {
  ttsFails = true;
  script = [say('Short answer.')];
  const r = await voicePost(A);
  const j = r.json();
  assert.equal(j.tts, 'client');
  assert.equal(j.audio, null);
});

test('empty transcript gets a retry prompt, not an agent run', async () => {
  fakeTranscript = '';
  const r = await voicePost(A);
  const j = r.json();
  assert.equal(j.status, 'empty');
  assert.equal(seenMessages.length, 0);
});

test('oversized audio is refused', async () => {
  process.env.VOICE_MAX_BYTES = '32';
  const r = await voicePost(A, Buffer.alloc(64));
  assert.equal(r.statusCode, 413);
});

test('another tenant cannot continue my voice conversation', async () => {
  script = [say('First.')];
  const r1 = await voicePost(A);
  const convId = r1.json().conversationId;
  script = [say('Second.')];
  const r2 = await voicePost(B, Buffer.from('b-audio'), '&c=' + convId);
  assert.equal(r2.statusCode, 200);
  assert.notEqual(r2.json().conversationId, convId, 'B got a fresh conversation, not A\'s');
  const leaked = await withTenant(A.tenantId, (c) => c.query("SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND content LIKE '%b-audio%'", [convId]).then((x) => x.rows[0].n));
  assert.equal(leaked, 0);
});

test('voice turn honours the platform emergency stop', async () => {
  await withSystem((c) => c.query("INSERT INTO system_flags (key,value) VALUES ('emergency_stop','on') ON CONFLICT (key) DO UPDATE SET value='on'"));
  script = [say('never')];
  const r = await voicePost(A);
  assert.equal(r.json().status, 'failed');
  assert.match(r.json().answer, /paused/i);
  await withSystem((c) => c.query("UPDATE system_flags SET value='off' WHERE key='emergency_stop'"));
});

test('audit log records the voice turn', async () => {
  script = [say('Logged.')];
  await voicePost(A);
  const rows = await withTenant(A.tenantId, (c) => c.query("SELECT * FROM audit_log WHERE action='voice.turn' ORDER BY id DESC LIMIT 1").then((x) => x.rows));
  assert.equal(rows.length, 1);
});
