import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { buildApp } from '../src/server.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { normalisePhone, parseMetaWebhook, makeAdapter } from '../src/whatsapp.js';
import { decideApproval } from '../src/core.js';
import { createHmac } from 'node:crypto';

process.env.HI_INVITE_CODES = 'invite-test-code'; process.env.SIGNUP_RATE_MAX = '100'; process.env.CRON_SECRET = 'cron-test-secret-value';
process.env.SESSION_SECRET = 'session-secret-for-tests'; process.env.WA_INBOUND_SECRET = 'wa-secret-for-tests'; delete process.env.GROQ_API_KEY;
process.env.WA_META_VERIFY_TOKEN = 'meta-verify-for-tests'; process.env.WA_META_APP_SECRET = 'meta-app-secret-for-tests';
process.env.WA_META_PHONE_NUMBER_ID = '1234567890'; process.env.WA_META_TOKEN = 'meta-token-for-tests';
const H = { 'content-type': 'application/x-www-form-urlencoded' }; const form = (o) => new URLSearchParams(o).toString();
let db, app, A, B, calls = 0;
const llm = async () => { calls++; return { content: 'Hello from HI', tool_calls: [], model: 'stub' }; };
async function mk(company, email, num) {
  await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company, email, password: 'a-long-test-password-1' }) });
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', [email]))).rows[0].tenant_id;
  const agent = await ensureDefaultAgent(tenantId);
  await withTenant(tenantId, (c) => c.query("INSERT INTO wa_channels (tenant_id, agent_id, number) VALUES (current_setting('app.tenant_id')::uuid,$1,$2)", [agent.id, num]));
  return { tenantId, agentId: agent.id };
}
const inbound = (b, secret = 'wa-secret-for-tests') => app.inject({ method: 'POST', url: '/internal/wa/inbound', headers: { 'x-wa-secret': secret, 'content-type': 'application/json' }, payload: JSON.stringify(b) });
const rows = (u) => withTenant(u.tenantId, (c) => c.query('SELECT phone, direction, status FROM wa_messages ORDER BY id')).then((r) => r.rows);

test.before(async () => { db = await startDb(54325); app = await buildApp({ llm }); A = await mk('Alpha', 'a@example.test', '27821110001'); B = await mk('Beta', 'b@example.test', '27821110002');
  await withTenant(A.tenantId, (c) => c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','Sipho')")); });
test.after(async () => { await app.close(); await db.stop(); });

test('phone normalisation', () => { assert.equal(normalisePhone('082 123 4567'), '27821234567'); assert.equal(normalisePhone('+27 82 123 4567'), '27821234567'); });

test('inbound needs the shared secret', async () => {
  assert.equal((await inbound({ to: '27821110001', from: '27829990001', text: 'hi' }, 'nope')).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/internal/wa/inbound', payload: {} })).statusCode, 401);
});

test('saved contact gets a reply; reply is stored; duplicates are ignored', async () => {
  const r = await inbound({ to: '27821110001', from: '27829990001', text: 'What tenders closed today?', id: 'm1' });
  const j = r.json(); assert.equal(j.proposed, true); assert.equal(j.reply, 'Hello from HI'); assert.ok(j.approval_id);
  const before = calls; const dup = (await inbound({ to: '27821110001', from: '27829990001', text: 'again', id: 'm1' })).json();
  assert.equal(dup.ignored, 'duplicate'); assert.equal(calls, before);
  assert.deepEqual((await rows(A)).map((m) => m.direction + ':' + m.status), ['in:received', 'out:proposed']);
});

test('unknown senders are logged and ignored, never answered; no cross-tenant routing', async () => {
  const before = calls;
  const r = (await inbound({ to: '27821110001', from: '27720000000', text: 'hello?', id: 'u1' })).json();
  assert.match(r.ignored, /not a saved contact/); assert.equal(calls, before);
  assert.ok((await rows(A)).some((m) => m.phone === '27720000000' && m.status === 'ignored'));
  // Beta's channel does not know Alpha's contact
  assert.match((await inbound({ to: '27821110002', from: '27829990001', text: 'hi', id: 'x1' })).json().ignored, /not a saved contact/);
  assert.equal((await rows(B)).filter((m) => m.direction === 'out').length, 0);
  assert.match((await inbound({ to: '27829998888', from: '27829990001', text: 'hi' })).json().ignored, /no active channel/);
});

test('paused tenant, emergency stop and rate limits silence replies; outreach lines cannot be channels', async () => {
  await withSystem((c) => c.query('UPDATE tenants SET paused=true WHERE id=$1', [A.tenantId]));
  assert.match((await inbound({ to: '27821110001', from: '27829990001', text: 'hi', id: 'p1' })).json().ignored, /no active channel/);
  await withSystem((c) => c.query('UPDATE tenants SET paused=false WHERE id=$1', [A.tenantId]));
  await withSystem((c) => c.query("INSERT INTO system_flags (key,value) VALUES ('emergency_stop','on') ON CONFLICT (key) DO UPDATE SET value='on'"));
  assert.match((await inbound({ to: '27821110001', from: '27829990001', text: 'hi', id: 'p2' })).json().ignored, /emergency/);
  await withSystem((c) => c.query("UPDATE system_flags SET value='off' WHERE key='emergency_stop'"));
  process.env.WA_MAX_REPLIES_PER_TENANT_DAY = '1';
  assert.match((await inbound({ to: '27821110001', from: '27829990001', text: 'hi', id: 'p3' })).json().ignored, /rate limit/);
  delete process.env.WA_MAX_REPLIES_PER_TENANT_DAY;
  for (const n of ['27672347593', '27610000000']) await assert.rejects(withTenant(A.tenantId, (c) => c.query("INSERT INTO wa_channels (tenant_id, agent_id, number) VALUES (current_setting('app.tenant_id')::uuid,$1,$2)", [A.agentId, n])));
});

test('tenant isolation on WhatsApp tables', async () => {
  for (const t of ['wa_channels', 'wa_contacts', 'wa_messages']) assert.ok((await withTenant(B.tenantId, (c) => c.query(`SELECT tenant_id FROM ${t}`))).rows.every((r) => r.tenant_id === B.tenantId), t);
  await assert.rejects(withTenant(B.tenantId, (c) => c.query("INSERT INTO wa_contacts (tenant_id, phone) VALUES ($1,'27821230000')", [A.tenantId])));
});

test('meta_cloud adapter posts a text message to the Graph API', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url: String(url), opts }); return { ok: true, status: 200 }; };
  const adapter = makeAdapter(fetchImpl);
  await adapter({ engine: 'meta_cloud', from: '27821110001', to: '27829990001', text: 'Your brief is ready' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  assert.equal(seen[0].opts.headers.authorization, 'Bearer meta-token-for-tests');
  const body = JSON.parse(seen[0].opts.body);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.to, '27829990001');
  assert.equal(body.text.body, 'Your brief is ready');
  const bad = makeAdapter(async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => bad({ engine: 'meta_cloud', from: '1', to: '2', text: 'x' }), /meta_cloud http 401/);
});

test('meta webhook GET verifies with the token', async () => {
  const ok = await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=meta-verify-for-tests&hub.challenge=abc123' });
  assert.equal(ok.statusCode, 200); assert.equal(ok.body, 'abc123');
  assert.equal((await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123' })).statusCode, 403);
});

test('meta webhook POST verifies the signature and delivers inbound text', async () => {
  const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '27821110001' },
    messages: [{ id: 'wamid.test1', from: '27829990001', type: 'text', text: { body: 'Any new matches?' } }, { id: 'st1', type: 'reaction' }] } }] }] });
  const sign = (secret, data) => 'sha256=' + createHmac('sha256', secret).update(data).digest('hex');
  assert.equal((await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('wrong-secret', payload) }, payload })).statusCode, 401);
  const r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign('meta-app-secret-for-tests', payload) }, payload });
  assert.equal(r.statusCode, 200); assert.equal(r.json().received, 1, 'reaction skipped');
  const msgs = await rows(A);
  assert.ok(msgs.some((m) => m.direction === 'in' && m.phone === '27829990001'), 'inbound stored');
  assert.ok(msgs.some((m) => m.direction === 'out' && m.status === 'proposed'), 'reply proposed, not sent');
});

const ownerOf = async (u) => (await withTenant(u.tenantId, (c) => c.query("SELECT id, email FROM users WHERE role='owner' ORDER BY created_at LIMIT 1"))).rows[0];
const proposeOne = async (u, num, id) => {
  const j = (await inbound({ to: num, from: '27829990001', text: 'price?', id })).json();
  assert.equal(j.proposed, true, JSON.stringify(j));
  return j.approval_id;
};

test('approving a whatsapp_reply sends it (simulator), rejecting never sends', async () => {
  const owner = await ownerOf(A);
  const ap1 = await proposeOne(A, '27821110001', 'ap1');
  const d1 = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: ap1, decision: 'approve' });
  assert.equal(d1.status, 'executed', JSON.stringify(d1));
  assert.ok((await rows(A)).some((m) => m.direction === 'out' && m.status === 'sent'));
  const ap2 = await proposeOne(A, '27821110001', 'ap2');
  const d2 = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: ap2, decision: 'reject' });
  assert.equal(d2.status, 'rejected');
  const m2 = (await rows(A)).filter((m) => m.direction === 'out');
  assert.equal(m2.filter((m) => m.status === 'rejected').length, 1);
  assert.equal((await withTenant(A.tenantId, (c) => c.query("SELECT status FROM approvals WHERE id=$1", [ap2]))).rows[0].status, 'rejected');
});

test('meta_cloud engine sends only after approval, through the Graph API', async () => {
  await withTenant(A.tenantId, (c) => c.query("UPDATE wa_channels SET engine='meta_cloud'"));
  const owner = await ownerOf(A);
  const ap = await proposeOne(A, '27821110001', 'mc1');
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url: String(url), opts }); return { ok: true, status: 200 }; };
  const d = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: ap, decision: 'approve', fetchImpl });
  assert.equal(d.status, 'executed', JSON.stringify(d));
  assert.equal(seen.length, 1, 'Graph API called exactly once, only after approval');
  assert.equal(seen[0].url, 'https://graph.facebook.com/v21.0/1234567890/messages');
  await withTenant(A.tenantId, (c) => c.query("UPDATE wa_channels SET engine='simulator'"));
});

test('emergency stop cancels at decision time; stale replies fail closed', async () => {
  const owner = await ownerOf(A);
  const sentBefore = (await withTenant(A.tenantId, (c) => c.query("SELECT count(*)::int n FROM wa_messages WHERE direction='out' AND status='sent'"))).rows[0].n;
  const ap1 = await proposeOne(A, '27821110001', 'es1');
  await withSystem((c) => c.query("INSERT INTO system_flags (key,value) VALUES ('emergency_stop','on') ON CONFLICT (key) DO UPDATE SET value='on'"));
  const d1 = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: ap1, decision: 'approve' });
  assert.equal(d1.status, 'cancelled');
  await withSystem((c) => c.query("UPDATE system_flags SET value='off' WHERE key='emergency_stop'"));
  assert.equal((await withTenant(A.tenantId, (c) => c.query("SELECT status FROM approvals WHERE id=$1", [ap1]))).rows[0].status, 'cancelled');
  assert.equal((await withTenant(A.tenantId, (c) => c.query("SELECT count(*)::int n FROM wa_messages WHERE direction='out' AND status='sent'"))).rows[0].n, sentBefore, 'the cancelled reply was never sent');
  const ap2 = await proposeOne(A, '27821110001', 'st1');
  await withTenant(A.tenantId, (c) => c.query("UPDATE wa_messages SET created_at = now() - interval '25 hours' WHERE direction='out' AND status='proposed'"));
  const d2 = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: ap2, decision: 'approve' });
  assert.equal(d2.status, 'failed');
  assert.match(d2.reason, /too old/);
});

test('parseMetaWebhook ignores statuses and non-text', () => {
  assert.deepEqual(parseMetaWebhook({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '2782' }, statuses: [{ id: 'x' }] } }] }] }), []);
  assert.deepEqual(parseMetaWebhook({}), []);
});

test('decision-time guards: paused channel, removed contact, daily cap, double approval', async () => {
  const owner = await ownerOf(A);
  // Paused channel: the proposal exists, but the send fails closed at decision time.
  const apCh = await proposeOne(A, '27821110001', 'g1');
  await withTenant(A.tenantId, (c) => c.query("UPDATE wa_channels SET status='paused'"));
  const dCh = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: apCh, decision: 'approve' });
  assert.equal(dCh.status, 'failed'); assert.match(dCh.reason, /no longer active/);
  await withTenant(A.tenantId, (c) => c.query("UPDATE wa_channels SET status='active'"));
  // Removed contact: same fail-closed shape.
  const apCt = await proposeOne(A, '27821110001', 'g2');
  await withTenant(A.tenantId, (c) => c.query("DELETE FROM wa_contacts WHERE phone='27829990001'"));
  const dCt = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: apCt, decision: 'approve' });
  assert.equal(dCt.status, 'failed'); assert.match(dCt.reason, /contact was removed/);
  await withTenant(A.tenantId, (c) => c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','Sam') ON CONFLICT DO NOTHING"));
  // Daily cap reached: fail closed, message stays unsent.
  const apCap = await proposeOne(A, '27821110001', 'g3');
  // Cap check counts sent in last day; force it by stuffing sent rows up to the cap.
  const cap = Number(process.env.WA_MAX_REPLIES_PER_TENANT_DAY || 100);
  await withTenant(A.tenantId, async (c) => {
    await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status) SELECT current_setting('app.tenant_id')::uuid, '27829990001', 'out', 'x', 'sent' FROM generate_series(1, $1)", [cap]);
  });
  const dCap = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: apCap, decision: 'approve' });
  assert.equal(dCap.status, 'failed'); assert.match(dCap.reason, /limit reached/);
  await withTenant(A.tenantId, (c) => c.query("DELETE FROM wa_messages WHERE direction='out' AND status='sent' AND body='x'"));
  // Double approval: the second decision cannot re-send.
  const apDbl = await proposeOne(A, '27821110001', 'g4');
  const d1 = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: apDbl, decision: 'approve' });
  assert.equal(d1.status, 'executed', JSON.stringify(d1));
  const sentN = (await withTenant(A.tenantId, (c) => c.query("SELECT count(*)::int n FROM wa_messages WHERE direction='out' AND status='sent'"))).rows[0].n;
  const d2 = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: apDbl, decision: 'approve' });
  assert.notEqual(d2.status, 'executed', 'second approve is a no-op: ' + JSON.stringify(d2));
  assert.equal((await withTenant(A.tenantId, (c) => c.query("SELECT count(*)::int n FROM wa_messages WHERE direction='out' AND status='sent'"))).rows[0].n, sentN, 'sent count unchanged');
});

test('paused tenant: proposals cancel at decision time and never send', async () => {
  const owner = await ownerOf(A);
  const ap = await proposeOne(A, '27821110001', 'pt1');
  await withSystem((c) => c.query('UPDATE tenants SET paused=true WHERE id=$1', [A.tenantId]));
  const d = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: ap, decision: 'approve' });
  assert.equal(d.status, 'cancelled', JSON.stringify(d));
  assert.equal((await withTenant(A.tenantId, (c) => c.query("SELECT status FROM wa_messages WHERE id=(SELECT (payload->>'wa_message_id')::bigint FROM approvals WHERE id=$1)", [ap]))).rows[0].status, 'failed');
  await withSystem((c) => c.query('UPDATE tenants SET paused=false WHERE id=$1', [A.tenantId]));
});

test('approvals page shows the exact full words and number; approving sends exactly that text', async () => {
  const long = 'Good afternoon Sam. Thank you for asking about the Kyalami garden cottage. It is still available at R12,500 per month, water included, electricity prepaid, available from 1 December. I can offer Thursday 14:00 or Saturday 10:30 for a viewing. Please tell me which suits you. ENDMARKER-ZEBRA-7721';
  const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'a@example.test', password: 'a-long-test-password-1' }) });
  const cookie = (login.headers['set-cookie'] || '').toString().split(';')[0];
  const apId = await withTenant(A.tenantId, async (c) => {
    const msg = (await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','out',$1,'proposed') RETURNING id", [long])).rows[0];
    const ch = (await c.query('SELECT id, engine FROM wa_channels LIMIT 1')).rows[0];
    return (await c.query("INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'whatsapp_reply',$1,$2,'agent:whatsapp') RETURNING id",
      [`WhatsApp reply to Sipho (27829990001): "${long.slice(0, 80)}..."`, JSON.stringify({ wa_message_id: msg.id, channel_id: ch.id, engine: ch.engine, from: '27821110001', to: '27829990001', body: long })])).rows[0].id;
  });
  const page = await app.inject({ url: '/app/approvals', headers: { cookie } });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('ENDMARKER-ZEBRA-7721'), 'the full untruncated message is on the page, not the 80-char summary');
  assert.ok(page.body.includes(long), 'every word shown exactly as it will be sent');
  assert.ok(page.body.includes('To: 27829990001'), 'the resolved recipient number is shown');
  const owner = await ownerOf(A);
  const d = await decideApproval({ tenantId: A.tenantId, userId: owner.id, userEmail: owner.email, approvalId: apId, decision: 'approve' });
  assert.equal(d.status, 'executed', JSON.stringify(d));
  const sent = (await withTenant(A.tenantId, (c) => c.query("SELECT body FROM wa_messages WHERE direction='out' AND status='sent' ORDER BY id DESC LIMIT 1"))).rows[0];
  assert.equal(sent.body, long, 'the sent body is byte-identical to what the page showed');
});

const mkOwnerLink = (tenantId, code, phone = null, expires = "+15 minutes") => withTenant(tenantId, (c) => c.query(
  "INSERT INTO wa_owner_links (tenant_id, phone, code_hash, code_expires_at) VALUES (current_setting('app.tenant_id')::uuid, $1, encode(digest($2,'sha256'),'hex'), now() + interval '" + expires.replace('+','').replace('-','-') + "') ON CONFLICT (tenant_id) DO UPDATE SET phone=EXCLUDED.phone, code_hash=EXCLUDED.code_hash, code_expires_at=EXCLUDED.code_expires_at, status='pending'",
  [phone, code.toUpperCase()]));

test('owner line: one-time code claim binds the number; wrong phone and expired codes fail', async () => {
  await mkOwnerLink(A.tenantId, 'ABC123');
  // Expired code for tenant B never claims
  await mkOwnerLink(B.tenantId, 'ZZZ999', null, '-1 minute');
  const r0 = (await inbound({ to: '27821110002', from: '27820000001', text: 'HI-ZZZ999', id: 'oc0' })).json();
  assert.equal(r0.ignored, 'unknown sender', 'expired code cannot claim');
  // Claim from the owner's phone on tenant A's line
  const r1 = (await inbound({ to: '27821110001', from: '27820000009', text: 'hi-abc123', id: 'oc1' })).json();
  assert.equal(r1.proposed, true, 'link confirmation drafted approval-first: ' + JSON.stringify(r1));
  const link = (await withTenant(A.tenantId, (c) => c.query('SELECT phone, status FROM wa_owner_links'))).rows[0];
  assert.equal(link.phone, '27820000009'); assert.equal(link.status, 'active');
  // A different phone cannot reuse anything; code is cleared after claim
  const r2 = (await inbound({ to: '27821110001', from: '27820000008', text: 'HI-ABC123', id: 'oc2' })).json();
  assert.equal(r2.ignored, 'unknown sender', 'consumed code does not re-claim');
});

test('owner line: a number already linked to one tenant cannot be claimed into another (collision fails closed)', async () => {
  // 27820000009 is the active owner line of tenant A (bound in the earlier test).
  const pre = (await withTenant(A.tenantId, (c) => c.query("SELECT phone, status FROM wa_owner_links"))).rows[0];
  assert.equal(pre.phone, '27820000009'); assert.equal(pre.status, 'active');
  // Tenant B issues a fresh code; the same number tries to claim it on B's line.
  await mkOwnerLink(B.tenantId, 'B22222');
  const r = await inbound({ to: '27821110002', from: '27820000009', text: 'HI-B22222', id: 'oc-collide' });
  assert.equal(r.statusCode, 200, 'webhook stays clean, no 500: ' + r.body);
  assert.equal(r.json().ignored, 'unknown sender', 'collision is refused like any wrong code');
  const bLink = (await withTenant(B.tenantId, (c) => c.query("SELECT status, phone FROM wa_owner_links"))).rows[0];
  assert.equal(bLink.status, 'pending', "B's link was not activated");
  assert.equal(bLink.phone, null, "B's link did not take the number");
  const aLink = (await withTenant(A.tenantId, (c) => c.query("SELECT phone, status FROM wa_owner_links"))).rows[0];
  assert.equal(aLink.status, 'active', "A's binding is untouched");
});

test('owner line: owner principal replies draft approval-first; auto-reply opt-in sends directly; STOP HI revokes', async () => {
  // Bound from the previous test at 27820000009 on tenant A
  const r1 = (await inbound({ to: '27821110001', from: '27820000009', text: 'Any viewings today?', id: 'om1' })).json();
  assert.equal(r1.owner, true); assert.equal(r1.proposed, true, 'default is approval-first even for the owner');
  // Opt in to auto-reply on the owner line
  await withTenant(A.tenantId, (c) => c.query('UPDATE wa_owner_links SET auto_reply=true'));
  const r2 = (await inbound({ to: '27821110001', from: '27820000009', text: 'And tomorrow?', id: 'om2' })).json();
  assert.equal(r2.owner, true); assert.equal(r2.sent, true, 'explicit opt-in replies directly: ' + JSON.stringify(r2));
  // Revocation from the bound number
  const r3 = (await inbound({ to: '27821110001', from: '27820000009', text: 'STOP HI', id: 'om3' })).json();
  assert.equal(r3.revoked, true);
  const link = (await withTenant(A.tenantId, (c) => c.query('SELECT status FROM wa_owner_links'))).rows[0];
  assert.equal(link.status, 'revoked');
  // After revocation the number is an ordinary unknown sender
  const r4 = (await inbound({ to: '27821110001', from: '27820000009', text: 'hello?', id: 'om4' })).json();
  assert.equal(r4.ignored, 'sender is not a saved contact');
});

test('owner line end-to-end through Settings: create code, claim from WhatsApp, toggle auto-reply, unlink', async () => {
  // Tenant C so the earlier tests' revoked link on A cannot collide
  const login = await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-test-code', company: 'Gamma', email: 'g@example.test', password: 'a-long-test-password-1' }) });
  const res = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'g@example.test', password: 'a-long-test-password-1' }) });
  const cookie = (res.headers['set-cookie'] || '').toString().split(';')[0];
  const page1 = await app.inject({ url: '/app/settings', headers: { cookie } });
  const csrf = /name="csrf" value="([^"]+)"/.exec(page1.body)[1];
  assert.ok(page1.body.includes('Create a linking code'), 'card offers linking before any link');
  const make = await app.inject({ method: 'POST', url: '/app/settings/wa-owner/code', headers: { ...H, cookie }, payload: form({ csrf }) });
  assert.equal(make.statusCode, 302, make.body.slice(0,300));
  const m = /Your linking code: HI-([A-Z0-9]{6})/.exec(decodeURIComponent(make.headers.location || ''));
  assert.ok(m, 'code shown once in the redirect flash: ' + make.headers.location);
  const tenantId = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', ['g@example.test']))).rows[0].tenant_id;
  const agent = await ensureDefaultAgent(tenantId);
  await withTenant(tenantId, (c) => c.query("INSERT INTO wa_channels (tenant_id, agent_id, number) VALUES (current_setting('app.tenant_id')::uuid,$1,'27821110003')", [agent.id]));
  const r1 = (await inbound({ to: '27821110003', from: '27820000007', text: `HI-${m[1]}`, id: 'e2e1' })).json();
  assert.equal(r1.proposed, true, 'confirmation drafted: ' + JSON.stringify(r1));
  const page2 = await app.inject({ url: '/app/settings', headers: { cookie } });
  assert.ok(page2.body.includes('Linked number: <b>27820000007</b>'), 'settings shows the linked number');
  const auto = await app.inject({ method: 'POST', url: '/app/settings/wa-owner/auto', headers: { ...H, cookie }, payload: form({ csrf, on: 'true' }) });
  assert.equal(auto.statusCode, 302);
  const link = (await withTenant(tenantId, (c) => c.query('SELECT auto_reply FROM wa_owner_links'))).rows[0];
  assert.equal(link.auto_reply, true);
  const r2 = (await inbound({ to: '27821110003', from: '27820000007', text: 'What is waiting for me?', id: 'e2e2' })).json();
  assert.equal(r2.sent, true, 'auto-reply opted in sends directly');
  const un = await app.inject({ method: 'POST', url: '/app/settings/wa-owner/unlink', headers: { ...H, cookie }, payload: form({ csrf }) });
  assert.equal(un.statusCode, 302);
  const link2 = (await withTenant(tenantId, (c) => c.query('SELECT status FROM wa_owner_links'))).rows[0];
  assert.equal(link2.status, 'revoked');
});
