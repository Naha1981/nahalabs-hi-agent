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

// Stripe amounts are in the smallest currency unit (cents for ZAR/USD/EUR). Each
// event type names the paid amount differently: payment intents use amount_received,
// charges use amount (with amount_refunded tracked separately), checkout sessions
// use amount_total.
const AMOUNT_FIELD = { 'payment_intent.succeeded': 'amount_received', 'charge.succeeded': 'amount', 'checkout.session.completed': 'amount_total' };
const money = (type, o) => ({ amount_cents: o?.[AMOUNT_FIELD[type]] ?? null, currency: String(o?.currency || '').toUpperCase(), description: String(o?.description || '').slice(0, 200) });

// One payment fires several event types (checkout.session.completed, then
// payment_intent.succeeded, then charge.succeeded). Record the money once, keyed by
// the payment reference the objects share.
const paymentRef = (type, o) => String((type === 'payment_intent.succeeded' ? o?.id : o?.payment_intent) || o?.id || '').slice(0, 80) || null;
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
  const obj = event.data?.object || {};
  if (obj.refunded === true || (event.type === 'checkout.session.completed' && obj.payment_status && obj.payment_status !== 'paid')) {
    return { status: 200, ignored: 'not a completed payment' };
  }
  const m = money(event.type, obj);
  const ref = paymentRef(event.type, obj);
  const tenantId = link.tenant_id;
  const r = await withTenant(tenantId, async (c) => {
    if (ref && (await c.query('SELECT 1 FROM stripe_events WHERE link_id=$1 AND payment_ref=$2', [link.id, ref])).rowCount) return { dup: true, same_payment: true };
    let ins;
    try {
      ins = await c.query(
        "INSERT INTO stripe_events (tenant_id, link_id, event_id, payment_ref, type, amount_cents, currency, description) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (link_id, event_id) DO NOTHING RETURNING id",
        [link.id, String(event.id).slice(0, 80), ref, event.type, m.amount_cents, m.currency, m.description]);
    } catch (e) {
      if (String(e?.code) === '23505') return { dup: true, same_payment: true };  // concurrent delivery of another event type for the same payment
      throw e;
    }
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
    // Functional approval first: the notification waits in Approvals like any other
    // email. The Settings toggle opts the tenant into receiving these proposals; it
    // never sends on its own. (The morning brief's automatic send is a separate,
    // specific grant and is not reused here.)
    return { recorded: true, approval_pending: p.approval_id };
  });
  return { status: 200, ...r };
}
