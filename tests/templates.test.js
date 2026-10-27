import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { buildApp } from '../src/server.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
delete process.env.GROQ_API_KEY;

const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];
const lookup = async () => [{ address: '93.184.216.34' }];
const llm = async () => ({ content: 'ok', tool_calls: [], model: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 } });

let db, app, cookie;
test.before(async () => {
  db = await startDb(54372);
  app = await buildApp({ llm, lookup });
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company: 'Tpl Props', email: 'tpl@example.test', password: 'a-long-test-password-1' }) });
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'tpl@example.test', password: 'a-long-test-password-1' }) });
  cookie = cookieOf(login);
});
test.after(async () => { await app.close(); await db.stop(); });

test('templates landing lists real estate as the first template', async () => {
  const r = await app.inject({ url: '/app/templates', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /<b>Templates<\/b> for your business/);
  assert.match(r.body, /<a href="\/app\/templates\/real-estate"><b>Real estate<\/b><\/a>/);
  // nav uses Templates wording and points at the landing page
  assert.match(r.body, /<a class="nl" href="\/app\/templates">Templates<\/a>/);
  assert.doesNotMatch(r.body, />Estate<\/a>/);
});

test('legacy /app/estate redirects to the real-estate template', async () => {
  const r = await app.inject({ url: '/app/estate', headers: { cookie } });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/app/templates/real-estate');
  const dash = await app.inject({ url: r.headers.location, headers: { cookie } });
  assert.equal(dash.statusCode, 200);
  assert.match(dash.body, /<b>Real estate<\/b> deals, viewings and follow-ups/);
  assert.match(dash.body, /<title>Real estate - HI by NahaLabs<\/title>/);
});

test('templates pages require sign-in', async () => {
  const r = await app.inject({ url: '/app/templates' });
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/login');
});
