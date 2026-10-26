// WhatsApp connector. Engine-agnostic: inbound arrives at /internal/wa/inbound (shared secret), replies go through an adapter.
// Rules: reply-only to saved contacts who messaged first; unknown senders are logged and ignored; no outbound-first messages;
// per-contact and per-tenant caps; paused tenant or emergency stop silences it. Approval-first: a drafted
// reply is never sent automatically - it waits in Approvals and decideApproval executes the send.
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
  const r = await runAgent({ tenantId, userEmail: gate.email, agentId: ch.agent_id, conversationId: gate.conversationId, userText: `WhatsApp message from ${gate.contact.name || 'a saved contact'}: ${gate.body}`, llm, fetchImpl, lookup, principal: 'external_contact' });
  if (r.error) return { status: 200, ignored: r.error };
  const reply = String(r.answer).replace(/\*\*/g, '*').slice(0, 1500);
  // Approval-first: a reply to an external contact is never sent automatically. The
  // draft is stored as a proposal and waits in Approvals; decideApproval executes the
  // send through executeWhatsAppReply, which re-checks channel, contact, caps and age.
  const approvalId = await withTenant(tenantId, async (c) => {
    const msg = (await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status, conversation_id) VALUES (current_setting('app.tenant_id')::uuid,$1,'out',$2,'proposed',$3) RETURNING id", [fromN, reply, r.conversationId])).rows[0];
    const ap = (await c.query(
      "INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'whatsapp_reply',$1,$2,'agent:whatsapp') RETURNING id",
      [`WhatsApp reply to ${gate.contact.name || fromN} (${fromN}): "${reply.slice(0, 80)}"`,
       JSON.stringify({ wa_message_id: msg.id, channel_id: ch.id, engine: ch.engine, from: toN, to: fromN, body: reply })])).rows[0];
    await audit(c, tenantId, 'agent:whatsapp', 'wa.reply_proposed', { approval_id: ap.id, to: fromN });
    return ap.id;
  });
  return { status: 200, proposed: true, approval_id: approvalId, reply };
}

export { makeAdapter } from './wa-send.js';

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
