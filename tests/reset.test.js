// Forgot-password by email link (Resend), end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests';
process.env.RESEND_API_KEY = 're_test_key_placeholder';
process.env.MAIL_FROM = 'HI <hi@example.test>';
process.env.PUBLIC_BASE_URL = 'https://hi.example.test';
delete process.env.GROQ_API_KEY;

let db, app, sent = [];
const llm = async () => ({ content: 'ok', tool_calls: [] });
const fakeFetch = async (url, opts) => {
  if (String(url).includes('api.resend.com/emails')) { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ id: 'mail-1' }) }; }
  throw new Error('unexpected fetch ' + url);
};
const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];

test.before(async () => {
  db = await startDb(54328);
  app = await buildApp({ fetchImpl: fakeFetch, llm });
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company: 'Alpha', email: 'Thabiso@Example.Test', password: 'old-password-12345' }) });
});
test.after(async () => { await app.close(); await db.stop(); });
test.beforeEach(() => { sent = []; });

test('forgot page renders and login links to it', async () => {
  const login = await app.inject({ url: '/login' });
  assert.ok(login.body.includes('href="/forgot"'));
  assert.equal((await app.inject({ url: '/forgot' })).statusCode, 200);
});

test('unknown email gets the same message and no mail is sent', async () => {
  const r = await app.inject({ method: 'POST', url: '/forgot', headers: H, remoteAddress: '10.0.0.2', payload: form({ email: 'nobody@example.test' }) });
  assert.equal(r.statusCode, 302);
  assert.ok(r.headers.location.startsWith('/forgot?m='));
  assert.equal(sent.length, 0);
});

test('reset link is emailed, raw token is never stored, and the flow changes the password', async () => {
  const r = await app.inject({ method: 'POST', url: '/forgot', headers: H, remoteAddress: '10.0.0.3', payload: form({ email: 'thabiso@example.test' }) });
  assert.equal(r.statusCode, 302);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0], 'thabiso@example.test');
  const m = /https:\/\/hi\.example\.test\/reset\/([A-Za-z0-9_-]{20,})/.exec(sent[0].text);
  assert.ok(m, 'email contains a reset link');
  const token = m[1];
  const stored = await withSystem((c) => c.query('SELECT token_hash FROM password_resets'));
  assert.ok(!stored.rows.some((x) => x.token_hash === token), 'raw token not stored');

  assert.equal((await app.inject({ url: '/reset/not-a-real-token' })).body.includes('expired'), true);
  const page = await app.inject({ url: `/reset/${token}` });
  assert.ok(page.body.includes('Choose a new password'));

  const weak = await app.inject({ method: 'POST', url: `/reset/${token}`, headers: H, payload: form({ password: 'short' }) });
  assert.ok(weak.body.includes('at least 12 characters'));

  // an existing session proves the reset kills old sessions
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'thabiso@example.test', password: 'old-password-12345' }) });
  const oldCookie = cookieOf(login);
  const ok = await app.inject({ method: 'POST', url: `/reset/${token}`, headers: H, payload: form({ password: 'new-password-67890' }) });
  assert.ok(ok.headers.location.startsWith('/login?m='));
  assert.equal((await app.inject({ url: '/app', headers: { cookie: oldCookie } })).statusCode, 302, 'old session killed');

  const oldTry = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'thabiso@example.test', password: 'old-password-12345' }) });
  assert.ok(oldTry.headers.location.startsWith('/login?m='), 'old password rejected');
  const newTry = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'Thabiso@Example.Test', password: 'new-password-67890' }) });
  assert.equal(newTry.headers.location, '/app/agent', 'new password works (email case-insensitive)');

  const reuse = await app.inject({ url: `/reset/${token}` });
  assert.ok(reuse.body.includes('expired'), 'token is single-use');
});

test('forgot is rate limited', async () => {
  let last;
  for (let i = 0; i < 5; i++) last = await app.inject({ method: 'POST', url: '/forgot', headers: H, remoteAddress: '10.0.0.9', payload: form({ email: 'nobody@example.test' }) });
  assert.equal(last.statusCode, 302);
  last = await app.inject({ method: 'POST', url: '/forgot', headers: H, remoteAddress: '10.0.0.9', payload: form({ email: 'nobody@example.test' }) });
  assert.equal(last.statusCode, 429);
});
