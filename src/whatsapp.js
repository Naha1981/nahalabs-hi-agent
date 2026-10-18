// WhatsApp connector. Engine-agnostic: inbound arrives at /internal/wa/inbound (shared secret), replies go through an adapter.
// Rules: reply-only to saved contacts who messaged first; unknown senders are logged and ignored; no outbound-first messages;
// per-contact and per-tenant caps; paused tenant or emergency stop silences it.
import { withTenant, withSystem, audit } from './db.js';
import { runAgent } from './agent.js';
import { emergencyStopped } from './core.js';

export const normalisePhone = (p) => String(p || '').replace(/[^0-9]/g, '').replace(/^0(\d{9})$/, '27$1');

export async function handleInbound({ to, from, text, externalId, llm, fetchImpl, lookup, adapter }) {
  const toN = normalisePhone(to), fromN = normalisePhone(from);
  if (!/^[0-9]{8,15}$/.test(toN) || !/^[0-9]{8,15}$/.test(fromN)) return { status: 400, reason: 'bad number' };
  if (await emergencyStopped()) return { status: 200, ignored: 'emergency stop' };
  const ch = (await withSystem((c) => c.query('SELECT * FROM wa_channel_lookup($1)', [toN]))).rows[0];
  if (!ch) return { status: 200, ignored: 'no active channel' };
  const tenantId = ch.tenant_id;
  const gate = await withTenant(tenantId, async (c) => {
    if (externalId && (await c.query('SELECT 1 FROM wa_messages WHERE external_id=$1', [externalId])).rowCount) return { dup: true };
    const contact = (await c.query('SELECT * FROM wa_contacts WHERE phone=$1', [fromN])).rows[0];
    const body = String(text || '').slice(0, 2000);
    if (!contact) {
      await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status, external_id) VALUES (current_setting('app.tenant_id')::uuid,$1,'in',$2,'ignored',$3)", [fromN, body.slice(0, 200), externalId || null]);
      await audit(c, tenantId, 'system', 'wa.ignored_unknown_sender', {});
      return { ignored: 'sender is not a saved contact' };
    }
    const recent = (await c.query("SELECT count(*)::int n FROM wa_messages WHERE phone=$1 AND direction='in' AND status<>'ignored' AND created_at > now() - interval '1 hour'", [fromN])).rows[0].n;
    const daily = (await c.query("SELECT count(*)::int n FROM wa_messages WHERE direction='out' AND created_at > now() - interval '1 day'")).rows[0].n;
    if (recent >= 20 || daily >= Number(process.env.WA_MAX_REPLIES_PER_TENANT_DAY || 100)) return { ignored: 'rate limit' };
    await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status, external_id) VALUES (current_setting('app.tenant_id')::uuid,$1,'in',$2,'received',$3)", [fromN, body, externalId || null]);
    const prev = (await c.query("SELECT conversation_id FROM wa_messages WHERE phone=$1 AND conversation_id IS NOT NULL AND created_at > now() - interval '12 hours' ORDER BY id DESC LIMIT 1", [fromN])).rows[0];
    const owner = (await c.query('SELECT email FROM users ORDER BY created_at LIMIT 1')).rows[0];
    return { contact, body, conversationId: prev?.conversation_id || null, email: owner?.email };
  });
  if (gate.dup) return { status: 200, ignored: 'duplicate' };
  if (gate.ignored) return { status: 200, ignored: gate.ignored };
  const r = await runAgent({ tenantId, userEmail: gate.email, agentId: ch.agent_id, conversationId: gate.conversationId, userText: `WhatsApp message from ${gate.contact.name || 'a saved contact'}: ${gate.body}`, llm, fetchImpl, lookup });
  if (r.error) return { status: 200, ignored: r.error };
  const reply = String(r.answer).replace(/\*\*/g, '*').slice(0, 1500);
  await withTenant(tenantId, (c) => c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status, conversation_id) VALUES (current_setting('app.tenant_id')::uuid,$1,'out',$2,'queued',$3)", [fromN, reply, r.conversationId]));
  let sent = 'queued';
  try { if (adapter) { await adapter({ engine: ch.engine, from: toN, to: fromN, text: reply }); sent = 'sent'; } } catch { sent = 'failed'; }
  await withTenant(tenantId, async (c) => { await c.query("UPDATE wa_messages SET status=$2 WHERE tenant_id=current_setting('app.tenant_id')::uuid AND direction='out' AND status='queued' AND phone=$1", [fromN, sent]); await audit(c, tenantId, 'agent:whatsapp', 'wa.replied', { status: sent }); });
  return { status: 200, replied: true, delivery: sent, reply };
}

// Default adapter. The simulator keeps replies in wa_messages only. A real engine plugs in here once a number is linked.
export function makeAdapter(fetchImpl = fetch) {
  return async ({ engine, from, to, text }) => {
    if (engine === 'simulator') return;
    if (engine === 'own_engine') {
      const url = process.env.WA_ENGINE_URL, key = process.env.WA_ENGINE_KEY;
      if (!url || !key) throw new Error('engine not configured');
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ from, to, text }), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('engine http ' + res.status);
      return;
    }
    if (engine === 'meta_cloud') {
      // Official WhatsApp Business Platform (Meta Cloud API). Text replies only; no templates here.
      const phoneId = process.env.WA_META_PHONE_NUMBER_ID, token = process.env.WA_META_TOKEN;
      if (!phoneId || !token) throw new Error('meta_cloud not configured');
      const res = await fetchImpl(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4000) } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('meta_cloud http ' + res.status);
      return;
    }
    throw new Error('engine not supported yet');
  };
}

// Parse a Meta Cloud API webhook payload into our inbound shape. Only text messages;
// everything else (statuses, reactions, media) is skipped. to = our WABA display number.
export function parseMetaWebhook(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry?.changes || []) {
      const v = change?.value || {};
      const to = String(v?.metadata?.display_phone_number || '');
      for (const m of v?.messages || []) {
        if (m?.type !== 'text') continue;
        out.push({ to, from: String(m.from || ''), text: String(m.text?.body || ''), externalId: m.id ? String(m.id).slice(0, 80) : null });
      }
    }
  }
  return out;
}
