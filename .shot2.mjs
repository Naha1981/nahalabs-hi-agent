import { startDb } from '/tmp/hi-repo/tests/helpers.js';
import { buildApp } from '/tmp/hi-repo/src/server.js';
import { withTenant, withSystem } from '/tmp/hi-repo/src/db.js';
import { enc } from '/tmp/hi-repo/src/integrations.js';
import puppeteer from 'puppeteer-core';

process.env.HI_INVITE_CODES='invite-shot'; process.env.SIGNUP_RATE_MAX='100'; process.env.CRON_SECRET='cron-shot';
process.env.SESSION_SECRET='session-secret-for-shots'; process.env.INTEGRATIONS_SECRET='integrations-secret-for-shots-0123456789';
delete process.env.GROQ_API_KEY;
const db = await startDb(54353);
const app = await buildApp({ llm: async () => ({ content: 'stub', tool_calls: [], model: 'stub' }), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
await app.listen({ port: 4601, host: '127.0.0.1' });
const form = (o) => new URLSearchParams(o).toString();
const H = { 'content-type': 'application/x-www-form-urlencoded' };
await app.inject({ method: 'POST', url: '/signup', headers: H, payload: form({ invite: 'invite-shot', company: 'Sandton Estates', email: 'owner@example.test', password: 'a-long-test-password-1' }) });
const login = await app.inject({ method: 'POST', url: '/login', headers: H, payload: form({ email: 'owner@example.test', password: 'a-long-test-password-1' }) });
const cookie = (login.cookies?.[0]) || null;
const setCookie = login.headers['set-cookie'];
console.error('login status', login.statusCode, 'cookie?', !!setCookie);
const tid = (await withSystem((c) => c.query('SELECT tenant_id FROM users WHERE email=$1', ['owner@example.test']))).rows[0].tenant_id;
await withTenant(tid, async (c) => {
  const link = (await c.query("INSERT INTO stripe_links (tenant_id, label, signing_secret_enc) VALUES (current_setting('app.tenant_id')::uuid,'NahaLabs store',$1) RETURNING id", [enc('whsec_shotsecret123')])).rows[0];
  await c.query("INSERT INTO stripe_events (tenant_id, link_id, event_id, payment_ref, type, amount_cents, currency, description) VALUES (current_setting('app.tenant_id')::uuid,$1,'evt_shot1','pi_1','payment_intent.succeeded',125000,'ZAR','Invoice 1042'),(current_setting('app.tenant_id')::uuid,$1,'evt_shot2','pi_2','charge.succeeded',42000,'ZAR','Retainer')", [link.id]);
  await c.query("INSERT INTO agents (tenant_id, name, persona) VALUES (current_setting('app.tenant_id')::uuid,'HI','A calm, practical AI employee.')");
  await c.query("INSERT INTO wa_channels (tenant_id, agent_id, number) SELECT current_setting('app.tenant_id')::uuid, id, '27821110001' FROM agents LIMIT 1");
  await c.query("INSERT INTO wa_contacts (tenant_id, phone, name) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','Sam Mokoena')");
  const ad = JSON.stringify({ network: 'meta', headline: 'Kyalami cottage to let', headline_2: 'Garden cottage, R12,500', headline_3: 'View this Saturday', body: 'Two-bedroom garden cottage in Kyalami, available 1 December.', description_2: 'Book your viewing today. Water included, prepaid electricity.', audience: 'Sandton, 25-45', daily_budget_cents: 15000, currency: 'ZAR', link: 'https://example.test/listing', account_ref: 'meta:act_88421099' });
  await c.query("INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'ad_campaign_draft','Ad draft (meta): Kyalami cottage to let - R150.00/day, paused until you activate it in your ads account',$1,'agent:hi')", [ad]);
  const soc = JSON.stringify({ network: 'instagram', text: 'Kyalami garden cottage available 1 December - R12,500/m. Two bedrooms, prepaid electricity, water included. Viewings this Saturday. #KyalamiRentals', media_url: 'https://example.test/cottage.jpg', account_ref: 'page:101293844552' });
  await c.query("INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'social_post','Social post (instagram): Kyalami garden cottage available 1 December...',$1,'agent:hi')", [soc]);
  const msg = (await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status) VALUES (current_setting('app.tenant_id')::uuid,'27829990001','out','Good afternoon Sam - the Kyalami unit is still available at R12,500/m. Would Thursday 14:00 work for a viewing?','proposed') RETURNING id")).rows[0];
  const ch = (await c.query('SELECT id, engine FROM wa_channels LIMIT 1')).rows[0];
  await c.query("INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'whatsapp_reply',$1,$2,'agent:whatsapp')",
    ['WhatsApp reply to Sam Mokoena (27829990001): "Good afternoon Sam - the Kyalami unit is still available at R12,500/m. Would Thur..."',
     JSON.stringify({ wa_message_id: msg.id, channel_id: ch.id, engine: ch.engine, from: '27821110001', to: '27829990001', body: 'x' })]);
});
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
const [name, ...rest] = cookieHeader.split(';')[0].split('=');
await page.setCookie({ name, value: rest.join('='), domain: '127.0.0.1' });
const shots = [
  
  ['/app/approvals', 'ap4-desktop', 1280], ['/app/approvals', 'ap4-mobile', 390],
  
];
for (const [url, name2, w] of shots) {
  await page.setViewport({ width: w, height: 900 });
  await page.goto('http://127.0.0.1:4601' + url, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: `/downloads/${name2}.png`, fullPage: true });
  console.error('shot', name2, page.url());
}
await browser.close(); await app.close(); await db.stop();
console.error('DONE');
