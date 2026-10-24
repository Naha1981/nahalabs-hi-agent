// Viewing reminders: opt-in per tenant (Settings). Emails the account's OWN address up to
// 24h before a scheduled viewing. Same rails as approved sends: emergency stop honoured,
// paused tenants skipped, global daily email cap, email_log + audit entries. HI never
// emails the client - reminding the client stays with the agent.
import { withSystem, withTenant, auditFor } from './db.js';
import { sendMail, mailConfigured } from './mail.js';

const WINDOW_HOURS = 24;

export async function runViewingReminders({ fetchImpl = fetch, now = new Date() } = {}) {
  if (await emergency()) return { skipped: 'emergency stop' };
  if (!mailConfigured()) return { skipped: 'mail not configured' };
  const cap = Number(process.env.HI_EMAIL_DAILY_CAP || 5);
  const tenants = await withSystem((c) => c.query('SELECT id FROM tenants WHERE NOT paused AND viewing_reminders_auto').then((r) => r.rows.map((x) => x.id)));
  const out = [];
  for (const tenantId of tenants) {
    // Claim first: mark reminder_sent_at in the same statement that picks the viewings, so
    // overlapping ticks cannot double-send. A failed send releases the claim for next tick.
    const due = await withTenant(tenantId, (c) => c.query(
      `UPDATE re_viewings v SET reminder_sent_at = $1
       FROM re_properties p
       WHERE v.property_id = p.id AND v.status = 'scheduled' AND v.reminder_sent_at IS NULL
         AND v.starts_at > $1 AND v.starts_at <= $1::timestamptz + ($2 || ' hours')::interval
       RETURNING v.id, v.starts_at, p.title AS property,
         (SELECT name FROM re_contacts WHERE id = v.contact_id) AS contact,
         (SELECT email FROM users WHERE tenant_id = v.tenant_id ORDER BY created_at LIMIT 1) AS email`,
      [now, String(WINDOW_HOURS)])).then((r) => r.rows);
    for (const v of due) {
      try {
        const sentToday = await withSystem((s) => s.query("SELECT count(*)::int n FROM email_log WHERE sent_at > now() - interval '1 day'").then((r) => r.rows[0].n));
        if (sentToday >= cap) { await unclaim(tenantId, v.id); out.push({ viewing: v.id, status: 'daily cap reached' }); continue; }
        if (!v.email) { await unclaim(tenantId, v.id); out.push({ viewing: v.id, status: 'no account email' }); continue; }
        const when = new Intl.DateTimeFormat('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v.starts_at));
        const subject = `Viewing reminder: ${v.property}`;
        const text = `Reminder from HI: viewing at ${v.property}${v.contact ? ` with ${v.contact}` : ''} on ${when}.\n\nThis reminder goes to you only - confirming with the client is yours to do.`;
        const providerId = await sendMail({ to: v.email, subject, text, fetchImpl });
        await withTenant(tenantId, (c) => c.query('INSERT INTO email_log (tenant_id, to_addr, subject, provider_id) VALUES ($1,$2,$3,$4)', [tenantId, v.email, subject, providerId]));
        await auditFor(tenantId, 'system', 'viewing.reminder_sent', { viewing_id: v.id, provider_id: providerId });
        out.push({ viewing: v.id, status: 'sent' });
      } catch (e) {
        await unclaim(tenantId, v.id);
        out.push({ viewing: v.id, status: 'failed', error: String((e && e.message) || e).slice(0, 120) });
      }
    }
  }
  return out;
}

const unclaim = (tenantId, id) => withTenant(tenantId, (c) => c.query('UPDATE re_viewings SET reminder_sent_at = NULL WHERE id = $1', [id]));
async function emergency() {
  return withSystem((c) => c.query("SELECT value FROM system_flags WHERE key='emergency_stop'").then((r) => r.rows[0]?.value === 'on'));
}

// Document expiry reminders: opt-in per tenant (Settings). One digest email to the
// account's OWN address listing documents that crossed a threshold (30 days, 7 days,
// expired). Stage per document advances only forward; editing the expiry date resets it.
export async function runDocExpiryReminders({ fetchImpl = fetch, now = new Date() } = {}) {
  if (await emergency()) return { skipped: 'emergency stop' };
  if (!mailConfigured()) return { skipped: 'mail not configured' };
  const cap = Number(process.env.HI_EMAIL_DAILY_CAP || 5);
  const today = now.toISOString().slice(0, 10);
  const tenants = await withSystem((c) => c.query('SELECT id FROM tenants WHERE NOT paused AND document_reminders_auto').then((r) => r.rows.map((x) => x.id)));
  const out = [];
  for (const tenantId of tenants) {
    const plan = await withTenant(tenantId, async (c) => {
      // reset the stage when the expiry date was edited after a reminder went out
      await c.query('UPDATE vault_docs SET expiry_reminder_stage = 0, expiry_reminder_for = expires_on WHERE expires_on IS DISTINCT FROM expiry_reminder_for');
      const rows = (await c.query(
        `SELECT id, title, doc_type, expires_on::text AS expires_on, expiry_reminder_stage,
           (SELECT email FROM users WHERE tenant_id = vault_docs.tenant_id ORDER BY created_at LIMIT 1) AS email
         FROM vault_docs WHERE expires_on IS NOT NULL`)).rows;
      const due = [];
      for (const d of rows) {
        const days = Math.floor((new Date(d.expires_on + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
        let target = 0;
        if (days < 0) target = 3; else if (days <= 7) target = 2; else if (days <= 30) target = 1;
        if (target > d.expiry_reminder_stage) due.push({ ...d, target, days });
      }
      // lease ends ride the same opt-in digest (60 / 30 / ended); a changed end_date resets the stage
      await c.query('UPDATE re_leases SET lease_reminder_stage = 0, lease_reminder_for = end_date WHERE end_date IS DISTINCT FROM lease_reminder_for');
      const leases = (await c.query(
        `SELECT l.id, l.end_date::text AS end_date, l.lease_reminder_stage, p.title AS property, co.name AS tenant_name
         FROM re_leases l JOIN re_properties p ON p.id = l.property_id LEFT JOIN re_contacts co ON co.id = l.contact_id
         WHERE l.end_date IS NOT NULL AND l.status IN ('active','renewal_due')`)).rows;
      const dueLeases = [];
      for (const l of leases) {
        const days = Math.floor((new Date(l.end_date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
        let target = 0;
        if (days < 0) target = 3; else if (days <= 30) target = 2; else if (days <= 60) target = 1;
        if (target > l.lease_reminder_stage) dueLeases.push({ ...l, target, days });
      }
      return { due, dueLeases, email: rows[0]?.email };
    });
    if (!plan.due.length && !plan.dueLeases.length) continue;
    try {
      if (!plan.email) { out.push({ tenant: tenantId, status: 'no account email' }); continue; }
      const sentToday = await withSystem((s) => s.query("SELECT count(*)::int n FROM email_log WHERE sent_at > now() - interval '1 day'").then((r) => r.rows[0].n));
      if (sentToday >= cap) { out.push({ tenant: tenantId, status: 'daily cap reached' }); continue; }
      const lines = plan.due.map((d) => `- ${d.title} (${d.doc_type}): ${d.days < 0 ? 'EXPIRED' : 'expires'} ${d.expires_on}${d.days >= 0 ? ` (${d.days} day${d.days === 1 ? '' : 's'} left)` : ''}`);
      for (const l of plan.dueLeases) lines.push(`- Lease ${l.property}${l.tenant_name ? ` (${l.tenant_name})` : ''}: ${l.days < 0 ? 'ENDED' : 'ends'} ${l.end_date}${l.days >= 0 ? ` (${l.days} day${l.days === 1 ? '' : 's'} left)` : ''}`);
      const total = plan.due.length + plan.dueLeases.length;
      const subject = plan.dueLeases.length
        ? `Documents and lease ends: ${total} item${total === 1 ? '' : 's'} need attention`
        : `Document expiry: ${plan.due.length} document${plan.due.length === 1 ? '' : 's'} need attention`;
      const text = `Reminder from HI - these items in your registers need attention:\n\n${lines.join('\n')}\n\nOpen HI > Documents or Estate to update them. This went to your own address only.`;
      const providerId = await sendMail({ to: plan.email, subject, text, fetchImpl });
      await withTenant(tenantId, async (c) => {
        for (const d of plan.due) await c.query('UPDATE vault_docs SET expiry_reminder_stage = $2, expiry_reminder_for = expires_on WHERE id = $1', [d.id, d.target]);
        for (const l of plan.dueLeases) await c.query('UPDATE re_leases SET lease_reminder_stage = $2, lease_reminder_for = end_date WHERE id = $1', [l.id, l.target]);
        await c.query('INSERT INTO email_log (tenant_id, to_addr, subject, provider_id) VALUES ($1,$2,$3,$4)', [tenantId, plan.email, subject, providerId]);
      });
      await auditFor(tenantId, 'system', 'docs.expiry_reminder_sent', { docs: plan.due.length, leases: plan.dueLeases.length, provider_id: providerId });
      out.push({ tenant: tenantId, status: 'sent', count: plan.due.length + plan.dueLeases.length });
    } catch (e) {
      out.push({ tenant: tenantId, status: 'failed', error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  return out;
}
