// Brief building, approval queue, vault alerts, emergency stop. All tenant access goes through withTenant (RLS).
import { withTenant, withSystem, audit } from './db.js';
import { sendMail } from './mail.js';
import { applyBrowserDecision } from './browser.js';
import { executeConnectedApproval } from './integrations.js';

const fmtDate = (d) => d ? new Date(d).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }) : 'not stated';

export async function emergencyStopped() {
  const r = await withSystem((c) => c.query("SELECT value FROM system_flags WHERE key='emergency_stop'"));
  return r.rows[0]?.value === 'on';
}
export async function setEmergencyStop(on) {
  await withSystem(async (c) => {
    await c.query("INSERT INTO system_flags (key,value) VALUES ('emergency_stop',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()", [on ? 'on' : 'off']);
    await audit(c, null, 'system', on ? 'emergency_stop.on' : 'emergency_stop.off', {});
  });
}

export async function vaultAlerts(c, now = new Date()) {
  const r = await c.query("SELECT title, doc_type, expires_on FROM vault_docs WHERE expires_on IS NOT NULL AND expires_on <= ($1::date + 30) ORDER BY expires_on", [now]);
  return r.rows.map((d) => ({ ...d, expired: new Date(d.expires_on) < new Date(now.toISOString().slice(0, 10)) }));
}

export function renderBrief({ company, items, alerts, now = new Date() }) {
  const lines = [`HI Opportunity Desk - brief for ${company || 'your business'}`, `Prepared ${fmtDate(now)} (South Africa time).`, ''];
  if (alerts.length) {
    lines.push('DOCUMENTS NEEDING ATTENTION');
    for (const a of alerts) lines.push(`- ${a.title} (${a.doc_type}): ${a.expired ? 'EXPIRED' : 'expires'} ${String(a.expires_on).slice(0, 10)}`);
    lines.push('');
  }
  lines.push(items.length ? 'OPEN OPPORTUNITIES MATCHED TO YOUR PROFILE' : 'No new open opportunities matched your profile today.');
  items.forEach((it, i) => {
    lines.push('', `${i + 1}. ${it.title}`, `   Bid no: ${it.tender_no || 'n/a'} | Buyer: ${it.buyer || 'n/a'} | Closes: ${fmtDate(it.closes_at)}`,
      `   Match score ${it.score}/100: ${it.reasons.map((r) => r.text).join('; ')}`);
    if (it.ai_note) lines.push(`   AI note (unverified): ${it.ai_note}`);
    lines.push(`   Source: ${it.source_url}`);
    for (const d of (it.documents || []).slice(0, 3)) lines.push(`   Bid document: ${d.url}`);
  });
  lines.push('', 'Confirm every requirement in the official bid documents before you bid. HI only reads public tender data and does not submit anything for you.');
  return lines.join('\n');
}

export async function buildBrief(tenantId, { now = new Date(), maxItems = 10 } = {}) {
  if (await emergencyStopped()) return { skipped: 'emergency stop' };
  return withTenant(tenantId, async (c) => {
    const t = (await c.query('SELECT paused FROM tenants WHERE id = current_setting(\'app.tenant_id\')::uuid')).rows[0];
    if (!t || t.paused) return { skipped: 'tenant paused' };
    const pending = await c.query("SELECT 1 FROM approvals WHERE kind='send_brief' AND status='proposed' LIMIT 1");
    if (pending.rowCount) return { skipped: 'a brief is already waiting for approval' };
    const prof = (await c.query('SELECT company_name FROM profiles LIMIT 1')).rows[0];
    const m = await c.query(
      `SELECT m.ocid, m.score, m.reasons, m.ai_note, t.title, t.tender_no, t.buyer, t.closes_at, t.documents, t.source_url
       FROM matches m JOIN tenders t USING (ocid)
       WHERE m.status='new' AND (t.closes_at IS NULL OR t.closes_at > $1)
       ORDER BY m.score DESC, t.closes_at NULLS LAST LIMIT $2`, [now, maxItems]);
    const alerts = await vaultAlerts(c, now);
    if (!m.rowCount && !alerts.length) return { skipped: 'nothing to report' };
    const body = renderBrief({ company: prof?.company_name, items: m.rows, alerts, now });
    const subject = `HI Opportunity Desk: ${m.rowCount} matched ${m.rowCount === 1 ? 'opportunity' : 'opportunities'}`;
    const brief = (await c.query("INSERT INTO briefs (tenant_id, subject, body_text, items) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3) RETURNING id", [subject, body, JSON.stringify(m.rows.map((r) => r.ocid))])).rows[0];
    const ap = (await c.query(
      "INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'send_brief',$1,$2,'agent:briefer') RETURNING id",
      [`Send the brief "${subject}" to your account email`, JSON.stringify({ brief_id: brief.id })])).rows[0];
    await audit(c, tenantId, 'agent:briefer', 'brief.proposed', { brief_id: brief.id, approval_id: ap.id, items: m.rowCount });
    return { brief_id: brief.id, approval_id: ap.id };
  });
}

export async function decideApproval({ tenantId, userId, userEmail, approvalId, decision, fetchImpl = fetch, now = new Date() }) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('bad decision');
  return withTenant(tenantId, async (c) => {
    const ap = (await c.query('SELECT * FROM approvals WHERE id=$1 FOR UPDATE', [approvalId])).rows[0];
    if (!ap) return { error: 'not found' };
    if (ap.status !== 'proposed') return { error: `already ${ap.status}` };
    if (decision === 'reject') {
      await c.query("UPDATE approvals SET status='rejected', decided_by=$2, decided_at=now() WHERE id=$1", [approvalId, userId]);
      if (ap.kind === 'send_brief') await c.query("UPDATE briefs SET status='rejected' WHERE id=$1", [ap.payload.brief_id]);
      if (ap.kind.startsWith('browser_')) await applyBrowserDecision(c, { tenantId, approval: ap, decision: 'reject', fetchImpl });
      await audit(c, tenantId, `user:${userId}`, 'approval.rejected', { approval_id: approvalId });
      return { status: 'rejected' };
    }
    await c.query("UPDATE approvals SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1", [approvalId, userId]);
    await audit(c, tenantId, `user:${userId}`, 'approval.approved', { approval_id: approvalId, kind: ap.kind });
    if (ap.kind.startsWith('browser_')) {
      const stopped0 = (await c.query("SELECT value FROM system_flags WHERE key='emergency_stop'")).rows[0]?.value === 'on';
      const paused0 = (await c.query("SELECT paused FROM tenants WHERE id = current_setting('app.tenant_id')::uuid")).rows[0].paused;
      if (stopped0 || paused0) { await c.query("UPDATE approvals SET status='cancelled' WHERE id=$1", [approvalId]); return { status: 'cancelled', reason: stopped0 ? 'emergency stop is on' : 'tenant is paused' }; }
      return applyBrowserDecision(c, { tenantId, approval: ap, decision: 'approve', fetchImpl });
    }
    if (['account_email', 'calendar_event'].includes(ap.kind)) {
      const stoppedC = (await c.query("SELECT value FROM system_flags WHERE key='emergency_stop'")).rows[0]?.value === 'on';
      const pausedC = (await c.query('SELECT paused FROM tenants WHERE id = current_setting(\'app.tenant_id\')::uuid')).rows[0].paused;
      if (stoppedC || pausedC) { await c.query("UPDATE approvals SET status='cancelled' WHERE id=$1", [approvalId]); return { status: 'cancelled', reason: stoppedC ? 'emergency stop is on' : 'tenant is paused' }; }
      const r = await executeConnectedApproval(c, { tenantId, approval: ap, fetchImpl });
      if (r.error) { await c.query("UPDATE approvals SET status='failed' WHERE id=$1", [approvalId]); return { status: 'failed', reason: r.error }; }
      await c.query("UPDATE approvals SET status='executed' WHERE id=$1", [approvalId]);
      return { status: 'executed' };
    }
    if (!['send_brief', 'send_email'].includes(ap.kind)) return { status: 'approved' };
    // Execute only after approval. Re-check stops at execution time.
    const stopped = (await c.query("SELECT value FROM system_flags WHERE key='emergency_stop'")).rows[0]?.value === 'on';
    const t = (await c.query('SELECT paused FROM tenants WHERE id = current_setting(\'app.tenant_id\')::uuid')).rows[0];
    if (stopped || t.paused) {
      await c.query("UPDATE approvals SET status='cancelled' WHERE id=$1", [approvalId]);
      await audit(c, tenantId, 'system', 'send.blocked', { reason: stopped ? 'emergency stop' : 'tenant paused' });
      return { status: 'cancelled', reason: stopped ? 'emergency stop is on' : 'tenant is paused' };
    }
    // Lock the account row so concurrent approvals cannot both pass the count check:
  // the per-account cap is exact. The platform ceiling below is a backstop across
  // accounts and can be overshot by the number of sends executing at the same instant.
    await c.query("SELECT id FROM tenants WHERE id = current_setting('app.tenant_id')::uuid FOR UPDATE");
    // Two independent limits: a per-account daily cap and a separate platform-wide daily ceiling.
    const tenantCap = Number(process.env.HI_EMAIL_DAILY_CAP || 5);
    const platformCap = Number(process.env.HI_EMAIL_PLATFORM_DAILY_CAP || 50);
    // email_log is deliberately not RLS-scoped, so filter explicitly: this count is per account.
    const sentToday = (await c.query("SELECT count(*)::int n FROM email_log WHERE tenant_id = current_setting('app.tenant_id')::uuid AND sent_at > now() - interval '1 day'")).rows[0].n;
    if (sentToday >= tenantCap) {
      await c.query("UPDATE approvals SET status='failed' WHERE id=$1", [approvalId]);
      await audit(c, tenantId, 'system', 'send.blocked', { reason: 'daily email cap reached', cap: tenantCap });
      return { status: 'failed', reason: 'daily email cap reached' };
    }
    // email_log holds every account's rows; the platform ceiling deliberately reads the whole table through system scope.
    const platform = await withSystem((s) => s.query("SELECT count(*)::int n FROM email_log WHERE sent_at > now() - interval '1 day'").then((r) => r.rows[0].n));
    if (platform >= platformCap) {
      await c.query("UPDATE approvals SET status='failed' WHERE id=$1", [approvalId]);
      await audit(c, tenantId, 'system', 'send.blocked', { reason: 'platform daily email limit reached', cap: platformCap });
      return { status: 'failed', reason: 'platform daily email limit reached' };
    }
    const isBrief = ap.kind === 'send_brief';
    const brief = isBrief ? (await c.query('SELECT * FROM briefs WHERE id=$1', [ap.payload.brief_id])).rows[0] : { id: null, subject: ap.payload.subject, body_text: ap.payload.body };
    // v1: outbound email goes to the approving user's own address only, whatever the payload says
    if (!isBrief && String(ap.payload.to).toLowerCase() !== String(userEmail).toLowerCase()) {
      await c.query("UPDATE approvals SET status='failed' WHERE id=$1", [approvalId]);
      await audit(c, tenantId, 'system', 'send.blocked', { reason: 'recipient is not the account address' });
      return { status: 'failed', reason: 'recipient is not your account address' };
    }
    try {
      const id = await sendMail({ to: userEmail, subject: brief.subject, text: brief.body_text, fetchImpl });
      await c.query("INSERT INTO email_log (tenant_id, to_addr, subject, provider_id) VALUES ($1,$2,$3,$4)", [tenantId, userEmail, brief.subject, id]);
      if (isBrief) await c.query("UPDATE briefs SET status='sent' WHERE id=$1", [brief.id]);
      await c.query("UPDATE approvals SET status='executed' WHERE id=$1", [approvalId]);
      await audit(c, tenantId, isBrief ? 'agent:briefer' : ap.proposed_by, isBrief ? 'brief.sent' : 'email.sent', { brief_id: brief.id, approval_id: approvalId, provider_id: id });
      return { status: 'executed' };
    } catch (e) {
      if (isBrief) await c.query("UPDATE briefs SET status='failed' WHERE id=$1", [brief.id]);
      await c.query("UPDATE approvals SET status='failed' WHERE id=$1", [approvalId]);
      await audit(c, tenantId, 'agent:briefer', 'brief.failed', { error: String(e.message).slice(0, 200) });
      return { status: 'failed', reason: String(e.message).slice(0, 200) };
    }
  });
}

export async function buildBriefsForAll(opts) {
  const ids = await withSystem((c) => c.query('SELECT id FROM tenants WHERE NOT paused').then((r) => r.rows.map((x) => x.id)));
  const out = [];
  for (const id of ids) out.push({ tenant: id, ...(await buildBrief(id, opts)) });
  return out;
}
