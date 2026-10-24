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
