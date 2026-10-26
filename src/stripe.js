// Stripe payment-received notifications. Each tenant links their own Stripe account in
// Settings: HI gives them a unique webhook URL, they paste it into their own Stripe
// dashboard with the signing secret Stripe shows. HI verifies the Stripe signature on
// every delivery and records payment receipts; it never creates charges, customers or
// payouts. Immediate emails go only to the account owner's own address and only when
// the tenant switched the notification toggle on (same opt-in shape as the morning
// brief); otherwise receipts show in Settings and the next morning brief.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withSystem, withTenant, audit } from './db.js';
import { dec, proposeAccountEmail } from './integrations.js';
import { decideApproval } from './core.js';

const TOLERANCE_SEC = 300; // Stripe's recommended timestamp tolerance
const NOTIFY_TYPES = new Set(['payment_intent.succeeded', 'charge.succeeded', 'checkout.session.completed']);

export function verifyStripeSignature(rawBody, header, secret, toleranceSec = TOLERANCE_SEC, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = String(header).split(',').map((kv) => kv.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v).filter(Boolean);
  if (!Number.isFinite(t) || !v1s.length) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac('sha256', String(secret)).update(`${t}.${rawBody}`).digest();
  return v1s.some((v1) => { try { return timingSafeEqual(Buffer.from(v1, 'hex'), expected); } catch { return false; } });
}

// Stripe amounts are in the smallest currency unit (cents for ZAR/USD/EUR).
const money = (o) => ({ amount_cents: o?.amount_received ?? o?.amount ?? o?.amount_total ?? null, currency: String(o?.currency || '').toUpperCase(), description: String(o?.description || '').slice(0, 200) });
export const fmtMoney = (amountCents, currency) => (amountCents == null ? 'an amount' : `${currency || ''} ${(amountCents / 100).toFixed(2)}`.trim());

export async function handleStripeWebhook({ token, rawBody, sigHeader, fetchImpl = fetch }) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) return { status: 404, error: 'unknown endpoint' };
  const link = (await withSystem((c) => c.query('SELECT * FROM stripe_link_lookup($1)', [token]))).rows[0];
  if (!link) return { status: 404, error: 'unknown endpoint' };
  const secret = dec(link.signing_secret_enc);
  if (!secret) return { status: 503, error: 'signing secret not set yet' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  if (!verifyStripeSignature(body, sigHeader, secret)) return { status: 401, error: 'bad signature' };
  let event; try { event = JSON.parse(body.toString('utf8')); } catch { return { status: 400, error: 'bad json' } };
  if (!event?.id || !NOTIFY_TYPES.has(event?.type)) return { status: 200, ignored: 'not a payment receipt type' };
  const m = money(event.data?.object);
  const tenantId = link.tenant_id;
  const r = await withTenant(tenantId, async (c) => {
    const ins = await c.query(
      "INSERT INTO stripe_events (tenant_id, link_id, event_id, type, amount_cents, currency, description) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3,$4,$5,$6) ON CONFLICT (link_id, event_id) DO NOTHING RETURNING id",
      [link.id, String(event.id).slice(0, 80), event.type, m.amount_cents, m.currency, m.description]);
    if (!ins.rowCount) return { dup: true };
    await audit(c, tenantId, 'system', 'stripe.payment_received', { type: event.type, amount_cents: m.amount_cents, currency: m.currency });
    if (!link.stripe_notifications_auto) return { recorded: true, emailed: false };
    const owner = (await c.query("SELECT id, email FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];
    const integ = (await c.query("SELECT id FROM integrations WHERE status='active' ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner || !integ) return { recorded: true, emailed: false, reason: 'no connected email account' };
    const p = await proposeAccountEmail(c, {
      tenantId, integrationId: integ.id, to: owner.email,
      subject: `Payment received - ${fmtMoney(m.amount_cents, m.currency)}`,
      body: `Your Stripe account received ${fmtMoney(m.amount_cents, m.currency)}${m.description ? ` (${m.description})` : ''}.\n\nRecorded by HI. Switch this notification off any time in Settings > Payments (Stripe).\n\nHI by NahaLabs - nothing was sent, booked or bought without your approval.`,
      actor: 'system:stripe',
    });
    if (p.error) return { recorded: true, emailed: false, reason: p.error };
    return { recorded: true, approval_id: p.approval_id, owner };
  });
  // Auto-decide in its own transaction after the proposal committed, mirroring the
  // morning-brief opt-in path; the usual stops, caps and connected-account checks apply.
  if (r.approval_id && r.owner) {
    const d = await decideApproval({ tenantId, userId: r.owner.id, userEmail: r.owner.email, approvalId: r.approval_id, decision: 'approve', fetchImpl });
    const { owner, ...rest } = r;
    return { status: 200, ...rest, emailed: !d.error, reason: d.error || rest.reason };
  }
  const { owner, ...rest } = r;
  return { status: 200, ...rest };
}
