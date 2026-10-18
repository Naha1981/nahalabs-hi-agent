// Scheduled morning briefing: reads the tenant's connected calendar, inbox and
// Opportunity Desk, composes a short plain-text brief, and proposes it as an
// account_email. Sends immediately only when the tenant enabled the
// morning-brief auto-send toggle in Settings (their explicit opt-in).
import { withSystem, withTenant, audit } from './db.js';
import { mailSearch, calendarUpcoming, proposeAccountEmail } from './integrations.js';
import { decideApproval } from './core.js';

export function composeBrief({ date, events, unread, matches, approvals }) {
  const L = [];
  L.push(`Your HI morning brief - ${date}`, '');
  L.push('TODAY FROM YOUR CALENDAR');
  if (events.length) for (const e of events.slice(0, 5)) L.push(`- ${e.title}${e.start ? ' at ' + e.start : ''}`);
  else L.push('- Nothing on the calendar (or no calendar connected yet).');
  L.push('', 'INBOX');
  if (unread.length) for (const m of unread.slice(0, 5)) L.push(`- ${m.from || 'Unknown'}: ${m.subject || '(no subject)'}`);
  else L.push('- Nothing unread (or no mailbox connected yet).');
  L.push('', 'OPPORTUNITY DESK');
  if (matches.length) for (const m of matches.slice(0, 3)) L.push(`- ${m.title || m.ocid} (fit ${m.score}/100)`);
  else L.push('- No new tender matches.');
  L.push('', `APPROVALS WAITING: ${approvals}`);
  if (approvals > 0) L.push('Open HI > Approvals to decide them.');
  L.push('', 'HI by NahaLabs - nothing was sent, booked or bought without your approval.');
  return L.join('\n');
}

async function briefForTenant(t, fetchImpl) {
  const date = new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
  const [events, unread] = await Promise.all([
    calendarUpcoming(t.tenant_id, { days: 1, fetchImpl }).catch(() => []),
    mailSearch(t.tenant_id, { query: 'is:unread', max: 5, fetchImpl }).catch(() => []),
  ]);
  return withTenant(t.tenant_id, async (c) => {
    const matches = (await c.query(
      "SELECT m.ocid, m.score, t.title FROM matches m JOIN tenders t ON t.ocid=m.ocid WHERE m.status='new' ORDER BY m.score DESC, m.updated_at DESC LIMIT 3")).rows;
    const approvals = Number((await c.query("SELECT count(*)::int AS n FROM approvals WHERE status='proposed'")).rows[0].n);
    const owner = (await c.query("SELECT id, email FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];
    const integ = (await c.query("SELECT id FROM integrations WHERE status='active' ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner || !integ) return { tenant: t.tenant_id, skipped: 'no owner or no connected account' };
    const body = composeBrief({ date, events: events.filter((e) => !e.error), unread: unread.filter((m) => !m.error), matches, approvals });
    const p = await proposeAccountEmail(c, { tenantId: t.tenant_id, integrationId: integ.id, to: owner.email, subject: `Your HI morning brief - ${date}`, body, actor: 'system:morning-brief' });
    if (p.error) return { tenant: t.tenant_id, error: p.error };
    if (!t.morning_brief_auto) return { tenant: t.tenant_id, proposed: p.approval_id };
    // Tenant explicitly enabled auto-send of their own morning brief in Settings.
    const d = await decideApproval({ tenantId: t.tenant_id, userId: owner.id, userEmail: owner.email, approvalId: p.approval_id, decision: 'approve', fetchImpl });
    return { tenant: t.tenant_id, sent: !d.error, approval_id: p.approval_id, error: d.error };
  });
}

export async function buildMorningBriefs({ fetchImpl = fetch } = {}) {
  const tenants = (await withSystem((c) => c.query('SELECT id AS tenant_id, morning_brief_auto FROM tenants WHERE NOT paused'))).rows;
  const out = [];
  for (const t of tenants) out.push(await briefForTenant(t, fetchImpl).catch((e) => ({ tenant: t.tenant_id, error: String(e.message).slice(0, 120) })));
  return out;
}
