// Scheduled morning briefing: reads the tenant's connected calendar, inbox and
// Opportunity Desk, composes a short plain-text brief, and proposes it as an
// account_email. Sends immediately only when the tenant enabled the
// morning-brief auto-send toggle in Settings (their explicit opt-in).
import { withSystem, withTenant, audit } from './db.js';
import { mailSearch, calendarUpcoming, proposeAccountEmail } from './integrations.js';
import { decideApproval } from './core.js';
import { estateAttention } from './attention.js';

export function composeBrief({ date, events, unread, matches, approvals, estate = { followups: [], viewings: [] }, deskActive = true }) {
  const L = [];
  L.push(`Your HI morning brief - ${date}`, '');
  L.push('TODAY FROM YOUR CALENDAR');
  if (events.length) for (const e of events.slice(0, 5)) L.push(`- ${e.title}${e.start ? ' at ' + e.start : ''}`);
  else L.push('- Nothing on the calendar (or no calendar connected yet).');
  const attn = estate.attention || [];
  if (estate.viewings.length || estate.followups.length || attn.length) {
    L.push('', 'ESTATE TODAY');
    for (const v of estate.viewings.slice(0, 5)) L.push(`- Viewing ${v.property}${v.contact ? ' with ' + v.contact : ''} at ${v.time}`);
    for (const f of estate.followups.slice(0, 5)) L.push(`- Due: ${f.next_action} - ${f.property}${f.contact ? ' (' + f.contact + ')' : ''}${f.date < todayIso() ? ' (due ' + f.date + ')' : ''}`);
    for (const x of attn.slice(0, 3)) L.push(`- Needs attention: ${x.text}`);
  }
  L.push('', 'INBOX');
  if (unread.length) for (const m of unread.slice(0, 5)) L.push(`- ${m.from || 'Unknown'}: ${m.subject || '(no subject)'}`);
  else L.push('- Nothing unread (or no mailbox connected yet).');
  if (deskActive) {
    L.push('', 'OPPORTUNITY DESK');
    if (matches.length) for (const m of matches.slice(0, 3)) L.push(`- ${m.title || m.ocid} (fit ${m.score}/100)`);
    else L.push('- No new tender matches.');
  }
  L.push('', `APPROVALS WAITING: ${approvals}`);
  if (approvals > 0) L.push('Open HI > Approvals to decide them.');
  L.push('', 'HI by NahaLabs - nothing was sent, booked or bought without your approval.');
  return L.join('\n');
}

const todayIso = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });

// The brief is a morning product: it only drafts between 05:00 and 11:59 South Africa
// time, and at most once per account per local day, however often the external cron
// calls job=all. South Africa keeps UTC+2 all year, so the local day start is fixed.
const BRIEF_WINDOW = { from: 5, to: 12 };
export function briefWindowOpen(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', hour: 'numeric', hour12: false }).format(now));
  return hour >= BRIEF_WINDOW.from && hour < BRIEF_WINDOW.to;
}

async function briefForTenant(t, fetchImpl, now = new Date()) {
  if (!briefWindowOpen(now)) return { tenant: t.tenant_id, skipped: 'outside the morning window' };
  const dayStart = new Date(`${todayIso(now)}T00:00:00+02:00`);
  const date = new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' });
  const [events, unread] = await Promise.all([
    calendarUpcoming(t.tenant_id, { days: 1, fetchImpl }).catch(() => []),
    mailSearch(t.tenant_id, { query: 'is:unread', max: 5, fetchImpl }).catch(() => []),
  ]);
  return withTenant(t.tenant_id, async (c) => {
    const matches = (await c.query(
      "SELECT m.ocid, m.score, t.title FROM matches m JOIN tenders t ON t.ocid=m.ocid WHERE m.status='new' ORDER BY m.score DESC, m.updated_at DESC LIMIT 3")).rows;
    // Estate pipeline: due follow-ups (today and overdue) plus today's viewings.
    const estate = {
      followups: (await c.query(`SELECT d.next_action, d.next_action_date::text AS date, p.title AS property, co.name AS contact
        FROM re_deals d JOIN re_properties p ON p.id=d.property_id LEFT JOIN re_contacts co ON co.id=d.contact_id
        WHERE d.stage NOT IN ('registered','fallen_through') AND d.next_action_date IS NOT NULL AND d.next_action_date <= CURRENT_DATE
        ORDER BY d.next_action_date LIMIT 5`)).rows,
      viewings: (await c.query(`SELECT to_char(v.starts_at, 'HH24:MI') AS time, p.title AS property, co.name AS contact
        FROM re_viewings v JOIN re_properties p ON p.id=v.property_id LEFT JOIN re_contacts co ON co.id=v.contact_id
        WHERE v.status='scheduled' AND v.starts_at::date = CURRENT_DATE ORDER BY v.starts_at LIMIT 5`)).rows,
    };
    // The Opportunity Desk section only appears for tenants who told HI what to look
    // for (profile keywords) - matching itself already skips tenants without keywords.
    estate.attention = await estateAttention(c);
    const deskActive = Boolean((await c.query('SELECT COALESCE(array_length(keywords,1),0) > 0 AS active FROM profiles LIMIT 1')).rows[0]?.active);
    const approvals = Number((await c.query("SELECT count(*)::int AS n FROM approvals WHERE status='proposed'")).rows[0].n);
    // One brief per account per local day, whatever its approval outcome: a rejected
    // brief is not redrafted until tomorrow.
    const existing = (await c.query("SELECT id FROM approvals WHERE kind='account_email' AND proposed_by='system:morning-brief' AND created_at >= $1 ORDER BY created_at DESC LIMIT 1", [dayStart])).rows[0];
    if (existing) return { tenant: t.tenant_id, skipped: 'already drafted today', approval_id: existing.id };
    const owner = (await c.query("SELECT id, email FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];
    const integ = (await c.query("SELECT id FROM integrations WHERE status='active' ORDER BY created_at LIMIT 1")).rows[0];
    if (!owner || !integ) return { tenant: t.tenant_id, skipped: 'no owner or no connected account' };
    const body = composeBrief({ date, events: events.filter((e) => !e.error), unread: unread.filter((m) => !m.error), matches, approvals, estate, deskActive });
    const p = await proposeAccountEmail(c, { tenantId: t.tenant_id, integrationId: integ.id, to: owner.email, subject: `Your HI morning brief - ${date}`, body, actor: 'system:morning-brief' });
    if (p.error) return { tenant: t.tenant_id, error: p.error };
    if (!t.morning_brief_auto) return { tenant: t.tenant_id, proposed: p.approval_id };
    // Tenant explicitly enabled auto-send of their own morning brief in Settings.
    const d = await decideApproval({ tenantId: t.tenant_id, userId: owner.id, userEmail: owner.email, approvalId: p.approval_id, decision: 'approve', fetchImpl });
    return { tenant: t.tenant_id, sent: !d.error, approval_id: p.approval_id, error: d.error };
  });
}

export async function buildMorningBriefs({ fetchImpl = fetch, now = new Date() } = {}) {
  const tenants = (await withSystem((c) => c.query('SELECT id AS tenant_id, morning_brief_auto FROM tenants WHERE NOT paused'))).rows;
  const out = [];
  for (const t of tenants) out.push(await briefForTenant(t, fetchImpl, now).catch((e) => ({ tenant: t.tenant_id, error: String(e.message).slice(0, 120) })));
  return out;
}
