// WhatsApp connector. Engine-agnostic: inbound arrives at /internal/wa/inbound (shared secret), replies go through an adapter.
// Rules: reply-only to saved contacts who messaged first; unknown senders are logged and ignored; no outbound-first messages;
// per-contact and per-tenant caps; paused tenant or emergency stop silences it. Approval-first: a drafted
// reply is never sent automatically - it waits in Approvals and decideApproval executes the send.
import { withTenant, withSystem, audit } from './db.js';
import { runAgent } from './agent.js';
import { emergencyStopped } from './core.js';
import { makeAdapter } from './wa-send.js';

export const normalisePhone = (p) => String(p || '').replace(/[^0-9]/g, '').replace(/^0(\d{9})$/, '27$1');

export async function handleInbound({ to, from, text, externalId, llm, fetchImpl, lookup, adapter }) {
  const toN = normalisePhone(to), fromN = normalisePhone(from);
  if (!/^[0-9]{8,15}$/.test(toN) || !/^[0-9]{8,15}$/.test(fromN)) return { status: 400, reason: 'bad number' };
  if (await emergencyStopped()) return { status: 200, ignored: 'emergency stop' };
  const ch = (await withSystem((c) => c.query('SELECT * FROM wa_channel_lookup($1)', [toN]))).rows[0];
  if (!ch) return { status: 200, ignored: 'no active channel' };
  const tenantId = ch.tenant_id;
  // Owner line: a number linked from the authenticated Settings session with a
  // one-time code gets the owner assistant, never the external-contact principal.
  const ownerLink = (await withSystem((c) => c.query('SELECT * FROM wa_owner_lookup($1)', [fromN]))).rows[0];
  if (ownerLink && ownerLink.tenant_id === ch.tenant_id) {
    return handleOwner({ ch, fromN, body: String(text || '').slice(0, 2000), externalId, llm, fetchImpl, lookup, autoReply: ownerLink.auto_reply });
  }
  const gate = await withTenant(tenantId, async (c) => {
    if (externalId && (await c.query('SELECT 1 FROM wa_messages WHERE external_id=$1', [externalId])).rowCount) return { dup: true };
    const contact = (await c.query('SELECT * FROM wa_contacts WHERE phone=$1', [fromN])).rows[0];
    const body = String(text || '').slice(0, 2000);
    if (!contact) {
      const claim = /^\s*HI-?([A-Z0-9]{6})\s*$/i.exec(body.trim());
      if (claim) {
        let claimed = null;
        try {
          claimed = (await withSystem((c2) => c2.query('SELECT wa_owner_claim($1, $2) AS tenant_id', [claim[1].toUpperCase(), fromN]))).rows[0]?.tenant_id;
        } catch (e) {
          // One number can only be the active owner line of one tenant; a second
          // claim from a number already linked elsewhere violates the partial
          // unique index. Fail closed and quietly, like any wrong code.
          if (String(e?.code) !== '23505') throw e;
        }
        if (claimed && claimed === tenantId) return { ownerClaim: true };
        return { ignored: 'unknown sender' };
      }
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
  if (gate.ownerClaim) {
    // The number just proved it holds the one-time code from the authenticated
    // Settings session. Confirm the link; the confirmation drafts like any reply.
    const r = await proposeReply({ ch, tenantId: ch.tenant_id, fromN, reply: 'Your WhatsApp is now linked to your HI account. Message me here any time - replies draft into your Approvals until you switch on auto-reply in Settings.', llm, fetchImpl });
    return { status: 200, ...r };
  }
  const r = await runAgent({ tenantId, userEmail: gate.email, agentId: ch.agent_id, conversationId: gate.conversationId, userText: `WhatsApp message from ${gate.contact.name || 'a saved contact'}: ${gate.body}`, llm, fetchImpl, lookup, principal: 'external_contact' });
  if (r.error) return { status: 200, ignored: r.error };
  const reply = String(r.answer).replace(/\*\*/g, '*').slice(0, 1500);
  return { status: 200, ...(await proposeReply({ ch, tenantId, fromN, reply, conversationId: r.conversationId, label: gate.contact.name || fromN })) };
}

// Approval-first: a drafted reply is stored as a proposal and waits in Approvals;
// decideApproval executes the send through executeWhatsAppReply, which re-checks
// channel, contact, caps and age. Used for external contacts and the owner line
// alike (owner auto-reply is the explicit opt-in exception, handled in handleOwner).
async function proposeReply({ ch, tenantId, fromN, reply, conversationId = null, label = null }) {
  const approvalId = await withTenant(tenantId, async (c) => {
    const msg = (await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status, conversation_id) VALUES (current_setting('app.tenant_id')::uuid,$1,'out',$2,'proposed',$3) RETURNING id", [fromN, reply, conversationId])).rows[0];
    const ap = (await c.query(
      "INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'whatsapp_reply',$1,$2,'agent:whatsapp') RETURNING id",
      [`WhatsApp reply to ${label || fromN} (${fromN}): "${reply.slice(0, 80)}"`,
       JSON.stringify({ wa_message_id: msg.id, channel_id: ch.id, engine: ch.engine, from: ch.number, to: fromN, body: reply })])).rows[0];
    await audit(c, tenantId, 'agent:whatsapp', 'wa.reply_proposed', { approval_id: ap.id, to: fromN });
    return ap.id;
  });
  return { proposed: true, approval_id: approvalId, reply };
}

// The owner's own linked line: full assistant (owner principal, owner tools).
// Replies draft approval-first unless the owner explicitly switched on auto-reply
// in Settings; "STOP HI" from the bound number revokes the link immediately.
async function handleOwner({ ch, fromN, body, externalId, llm, fetchImpl, lookup, autoReply }) {
  const tenantId = ch.tenant_id;
  if (/^\s*stop\s+hi\s*$/i.test(body)) {
    await withTenant(tenantId, async (c) => {
      await c.query("UPDATE wa_owner_links SET status='revoked' WHERE phone=$1 AND status='active'", [fromN]);
      await audit(c, tenantId, 'system', 'wa.owner_revoked', { via: 'whatsapp keyword' });
    });
    return { status: 200, owner: true, revoked: true };
  }
  const gate = await withTenant(tenantId, async (c) => {
    if (externalId && (await c.query('SELECT 1 FROM wa_messages WHERE external_id=$1', [externalId])).rowCount) return { dup: true };
    const daily = (await c.query("SELECT count(*)::int n FROM wa_messages WHERE direction='out' AND created_at > now() - interval '1 day'")).rows[0].n;
    if (daily >= Number(process.env.WA_MAX_REPLIES_PER_TENANT_DAY || 100)) return { ignored: 'rate limit' };
    await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status, external_id) VALUES (current_setting('app.tenant_id')::uuid,$1,'in',$2,'received',$3)", [fromN, body, externalId || null]);
    const prev = (await c.query('SELECT conversation_id FROM wa_messages WHERE phone=$1 AND conversation_id IS NOT NULL ORDER BY id DESC LIMIT 1', [fromN])).rows[0];
    const owner = (await c.query("SELECT email FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];
    return { conversationId: prev?.conversation_id || null, email: owner?.email };
  });
  if (gate.dup) return { status: 200, ignored: 'duplicate' };
  if (gate.ignored) return { status: 200, ignored: gate.ignored };
  const r = await runAgent({ tenantId, userEmail: gate.email, agentId: ch.agent_id, conversationId: gate.conversationId, userText: body, llm, fetchImpl, lookup, principal: 'owner' });
  if (r.error) return { status: 200, ignored: r.error };
  const reply = String(r.answer).replace(/\*\*/g, '*').slice(0, 1500);
  if (!autoReply) return { status: 200, owner: true, ...(await proposeReply({ ch, tenantId, fromN, reply, conversationId: r.conversationId, label: 'you (owner line)' })) };
  // Owner opted into direct replies on their own line; the same caps and audit apply.
  try {
    await makeAdapter(fetchImpl)({ engine: ch.engine, from: ch.number, to: fromN, text: reply });
  } catch (e) {
    return { status: 200, owner: true, ...(await proposeReply({ ch, tenantId, fromN, reply, conversationId: r.conversationId, label: 'you (owner line)' })) , send_error: String(e?.message || e).slice(0, 120) };
  }
  await withTenant(tenantId, async (c) => {
    await c.query("INSERT INTO wa_messages (tenant_id, phone, direction, body, status, conversation_id) VALUES (current_setting('app.tenant_id')::uuid,$1,'out',$2,'sent',$3)", [fromN, reply, r.conversationId]);
    await audit(c, tenantId, 'agent:whatsapp', 'wa.owner_reply_sent', { to: fromN });
  });
  return { status: 200, owner: true, sent: true, reply };
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
