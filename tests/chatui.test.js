import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { buildApp } from '../src/server.js';
import { withTenant } from '../src/db.js';

process.env.HI_INVITE_CODES = 'invite-test-code';
process.env.SIGNUP_RATE_MAX = '100';
process.env.SESSION_SECRET = 'session-secret-for-tests';
delete process.env.GROQ_API_KEY;

const H = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (res) => (res.headers['set-cookie'] || '').toString().split(';')[0];
const llm = async () => ({ content: 'ok', tool_calls: [], model: 'stub', usage: { prompt_tokens: 1, completion_tokens: 1 } });

let db, app, cookie, tenantId, agentId, convId;
test.before(async () => {
  db = await startDb(54391);
  app = await buildApp({ llm });
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company: 'Chat Co', email: 'chat@example.test', password: 'a-long-test-password-1' }) });
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'chat@example.test', password: 'a-long-test-password-1' }) });
  cookie = cookieOf(login);
  await app.inject({ url: '/app/agent', headers: { cookie } }); // creates the default agent
  tenantId = (await import('../src/db.js').then((m) => m.withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', ['chat@example.test'])))).rows[0].tenant_id;
  await withTenant(tenantId, async (c) => {
    agentId = (await c.query('SELECT id FROM agents LIMIT 1')).rows[0].id;
    convId = (await c.query("INSERT INTO conversations (tenant_id, agent_id, title) VALUES (current_setting('app.tenant_id')::uuid,$1,'t') RETURNING id", [agentId])).rows[0].id;
    await c.query("INSERT INTO messages (tenant_id, conversation_id, role, content) VALUES (current_setting('app.tenant_id')::uuid,$1,'user','Find me mining tenders')", [convId]);
    await c.query("INSERT INTO messages (tenant_id, conversation_id, role, content, sources, steps) VALUES (current_setting('app.tenant_id')::uuid,$1,'assistant',$2,$3,$4)", [convId,
      'Here are **two** open tenders. *Sources:* see https://etenders.gov.za/a-very-long-url/path/that/would/run/off/the/screen?x=1',
      JSON.stringify([{ title: 'Coal transport for mines', url: 'https://etenders.gov.za/tender/1' }, { title: 'https://cipc.co.za/raw', url: 'https://cipc.co.za/raw' }]),
      JSON.stringify([{ type: 'tool', name: 'find_tenders' }, { type: 'tenders', items: [{ title: 'Mining services contract', buyer: 'Eskom', closes: '2026-11-15T10:00:00Z', url: 'https://etenders.gov.za/tender/2' }] }])]);
    await c.query("INSERT INTO messages (tenant_id, conversation_id, role, content) VALUES (current_setting('app.tenant_id')::uuid,$1,'assistant',$2)", [convId, '### Quick steps\n***\n| Item | Detail |\n| --- | --- |\n| Form | CIPC 1 |']);
    await c.query("INSERT INTO approvals (tenant_id, kind, summary, status, proposed_by, payload) VALUES (current_setting('app.tenant_id')::uuid,'browser_task','Open example.com and read the title','proposed','agent:HI','{}')");
  });
});
test.after(async () => { await app.close(); await db.stop(); });

test('chat renders bubbles, markdown, source chips, collapsed steps, tender and approval cards', async () => {
  const r = await app.inject({ url: `/app/agent?agent=${agentId}&c=${convId}`, headers: { cookie } });
  assert.equal(r.statusCode, 200);
  // bubbles with clear roles
  assert.match(r.body, /<div class="turn me"><div class="who">You<\/div>/);
  assert.match(r.body, /<div class="turn hi"><div class="who"><span class="av">HI<\/span>/);
  // markdown rendered, not raw
  assert.match(r.body, /<b>two<\/b>/);
  assert.match(r.body, /<i>Sources:<\/i>/);
  assert.doesNotMatch(r.body, /\*\*two\*\*/);
  // bare long URL becomes a short domain link, never the raw string
  assert.match(r.body, />etenders\.gov\.za<\/a>/);
  assert.doesNotMatch(r.body, />[^<]*a-very-long-url/); // raw URL never shows as visible text
  // source chip with title + domain
  assert.match(r.body, /<a class="src" href="https:\/\/etenders\.gov\.za\/tender\/1"[^>]*><span class="no">1<\/span><span>Coal transport for mines<\/span><span class="dom">etenders\.gov\.za<\/span>/);
  // a source whose title is just its URL falls back to the bare domain, never a raw URL
  assert.match(r.body, /<a class="src" href="https:\/\/cipc\.co\.za\/raw"[^>]*><span class="no">2<\/span><span>cipc\.co\.za<\/span>/);
  assert.doesNotMatch(r.body, /<span>https:\/\//);
  // tool activity collapsed
  assert.match(r.body, /<details class="worked"><summary>Worked: 1 step<\/summary>/);
  assert.match(r.body, /Searched tenders/);
  // tender card
  assert.match(r.body, /<div class="tcard"><div class="tt">Mining services contract<\/div><div class="tm">Buyer: Eskom/);
  // approval card with in-chat buttons posting back to the conversation
  assert.match(r.body, /<div class="appr"><div class="asum">Open example\.com and read the title<\/div>/);
  assert.match(r.body, /<input type="hidden" name="back" value="\/app\/agent\?agent=/);
  assert.match(r.body, /<button name="decision" value="approve">Approve<\/button>/);
  // headings become bold, rules stripped, tables become real tables
  assert.match(r.body, /<b>Quick steps<\/b>/);
  assert.doesNotMatch(r.body, /###/);
  assert.doesNotMatch(r.body, /\*\*\*/);
  assert.match(r.body, /<table class="mdt"><tr><th>Item<\/th><th>Detail<\/th><\/tr><tr><td>Form<\/td><td>CIPC 1<\/td><\/tr><\/table>/);
  // mobile tab bar: 5 short tabs, Templates removed
  const tabs = r.body.match(/<nav class="tabs">.*<\/nav>/s)[0];
  assert.equal((tabs.match(/<a href=/g) || []).length, 5);
  assert.doesNotMatch(tabs, /Templates/);
});

test('approval from chat redirects back to the conversation', async () => {
  const id = (await withTenant(tenantId, (c) => c.query("SELECT id FROM approvals WHERE status='proposed' LIMIT 1"))).rows[0].id;
  const dash = await app.inject({ url: '/app/agent', headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(dash.body)[1];
  const r = await app.inject({ method: 'POST', url: `/app/approvals/${id}`, headers: { ...H, cookie }, payload: form({ csrf, decision: 'reject', back: `/app/agent?agent=${agentId}&c=${convId}` }) });
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.location, new RegExp(`^/app/agent\\?agent=${agentId}&c=${convId}`));
});
