// WhatsApp send execution, in its own module so core.js can execute approved replies
// without a circular import through whatsapp.js.
import { audit } from './db.js';

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

// Executed by decideApproval after the customer approves a whatsapp_reply approval.
// Runs inside the tenant transaction and re-checks everything that may have changed
// since the reply was drafted: channel still active, contact still saved, daily cap,
// and the reply is still fresh.
export async function executeWhatsAppReply(c, { tenantId, approval, fetchImpl = fetch }) {
  const p = approval.payload || {};
  const fail = async (error) => {
    if (p.wa_message_id) await c.query("UPDATE wa_messages SET status='failed' WHERE id=$1", [p.wa_message_id]);
    await audit(c, tenantId, 'system', 'wa.reply_blocked', { approval_id: approval.id, reason: error });
    return { error };
  };
  const msg = (await c.query("SELECT * FROM wa_messages WHERE id=$1 AND direction='out' FOR UPDATE", [p.wa_message_id])).rows[0];
  if (!msg || msg.status !== 'proposed') return { error: 'reply is no longer waiting' };
  if (new Date(msg.created_at).getTime() < Date.now() - 24 * 3600 * 1000) return fail('reply is too old to send (drafted more than 24 hours ago)');
  const ch = (await c.query("SELECT * FROM wa_channels WHERE id=$1 AND status='active'", [p.channel_id])).rows[0];
  if (!ch) return fail('the WhatsApp number is no longer active');
  const contact = (await c.query('SELECT 1 FROM wa_contacts WHERE phone=$1', [msg.phone])).rows[0];
  if (!contact) return fail('the contact was removed');
  const daily = (await c.query("SELECT count(*)::int n FROM wa_messages WHERE direction='out' AND status='sent' AND created_at > now() - interval '1 day'")).rows[0].n;
  if (daily >= Number(process.env.WA_MAX_REPLIES_PER_TENANT_DAY || 100)) return fail('daily WhatsApp reply limit reached');
  try {
    await makeAdapter(fetchImpl)({ engine: ch.engine, from: p.from, to: msg.phone, text: msg.body });
  } catch (e) {
    return fail(String(e?.message || e).slice(0, 120));
  }
  await c.query("UPDATE wa_messages SET status='sent' WHERE id=$1", [msg.id]);
  await audit(c, tenantId, approval.proposed_by, 'wa.reply_sent', { approval_id: approval.id, to: msg.phone });
  return { ok: true };
}
