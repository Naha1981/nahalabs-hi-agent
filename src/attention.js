// Escalation surfacing for the estate desk: overdue follow-ups, stalled deals and
// stale listings, derived read-only from recorded data. Nothing is sent anywhere -
// items are shown on the Estate page and through estate_list attention.
export const ESTATE_OPEN_STAGES = ['enquiry', 'viewing', 'offer', 'otp_signed', 'bond_pending', 'transfer_attorneys'];

const dateFmt = (d) => {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export async function estateAttention(c) {
  const items = [];
  const overdue = (await c.query(
    `SELECT p.title AS property, co.name AS contact, d.next_action, d.next_action_date,
            (current_date - d.next_action_date)::int AS days_overdue
     FROM re_deals d JOIN re_properties p ON p.id=d.property_id LEFT JOIN re_contacts co ON co.id=d.contact_id
     WHERE d.stage = ANY($1) AND d.next_action <> '' AND d.next_action_date IS NOT NULL AND d.next_action_date < current_date - 3
     ORDER BY d.next_action_date LIMIT 10`, [ESTATE_OPEN_STAGES])).rows;
  for (const r of overdue) {
    items.push({ kind: 'overdue', text: `${r.property}${r.contact ? ` (${r.contact})` : ''}: "${r.next_action}" was due ${dateFmt(r.next_action_date)} - ${r.days_overdue} days overdue` });
  }
  const stalled = (await c.query(
    `SELECT p.title AS property, co.name AS contact, (current_date - d.updated_at::date)::int AS days_idle
     FROM re_deals d JOIN re_properties p ON p.id=d.property_id LEFT JOIN re_contacts co ON co.id=d.contact_id
     WHERE d.stage = ANY($1) AND d.updated_at < now() - interval '14 days'
       AND (d.next_action = '' OR d.next_action_date IS NULL OR d.next_action_date >= current_date - 3)
     ORDER BY d.updated_at LIMIT 10`, [ESTATE_OPEN_STAGES])).rows;
  for (const r of stalled) {
    items.push({ kind: 'stalled', text: `${r.property}${r.contact ? ` (${r.contact})` : ''}: no movement on this deal in ${r.days_idle} days` });
  }
  const stale = (await c.query(
    `SELECT p.title, (current_date - p.created_at::date)::int AS days_listed
     FROM re_properties p
     WHERE p.status IN ('active','sole_mandate') AND p.created_at < now() - interval '21 days'
       AND NOT EXISTS (SELECT 1 FROM re_viewings v WHERE v.property_id = p.id AND v.starts_at > now() - interval '14 days')
     ORDER BY p.created_at LIMIT 10`)).rows;
  for (const r of stale) {
    items.push({ kind: 'stale_listing', text: `${r.title}: ${r.days_listed} days on market, no viewing in the last 14 days` });
  }
  // Rent arrears: recorded payments vs rent due since lease start. Month-granular and
  // labelled "recorded" - HI only knows payments the agent told it about.
  const arrears = (await c.query(
    `SELECT p.title AS property, co.name AS tenant_name, l.rent_cents, l.start_date,
            GREATEST(0, (EXTRACT(YEAR FROM age(current_date, l.start_date)) * 12 + EXTRACT(MONTH FROM age(current_date, l.start_date)))::int + 1) AS months_due,
            COALESCE((SELECT sum(pay.amount_cents) FROM re_lease_payments pay WHERE pay.lease_id = l.id), 0)::bigint AS paid_cents
     FROM re_leases l JOIN re_properties p ON p.id = l.property_id LEFT JOIN re_contacts co ON co.id = l.contact_id
     WHERE l.status = 'active' AND l.rent_cents IS NOT NULL AND l.start_date IS NOT NULL AND l.start_date <= current_date
     ORDER BY l.start_date LIMIT 20`)).rows;
  for (const r of arrears) {
    const expected = Number(r.rent_cents) * r.months_due;
    const shortfall = expected - Number(r.paid_cents);
    if (shortfall > 0) {
      const fmt = (x) => 'R' + Math.round(x / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      items.push({ kind: 'rent_arrears', text: `${r.property}${r.tenant_name ? ` (${r.tenant_name})` : ''}: recorded rent payments ${fmt(r.paid_cents)} of ${fmt(expected)} due since ${dateFmt(r.start_date)} - ${fmt(shortfall)} short` });
    }
  }
  // Maintenance requests sitting unresolved.
  const maint = (await c.query(
    `SELECT m.title, m.priority, p.title AS property, (current_date - m.reported_on)::int AS days_open
     FROM re_maintenance m JOIN re_properties p ON p.id = m.property_id
     WHERE m.status IN ('open','in_progress') AND m.reported_on < current_date - 14
     ORDER BY m.reported_on LIMIT 10`)).rows;
  for (const r of maint) {
    items.push({ kind: 'maintenance_open', text: `${r.property}: maintenance "${r.title}" ${r.status === 'in_progress' ? 'in progress' : 'open'} ${r.days_open} days${r.priority === 'urgent' ? ' (urgent)' : ''}` });
  }
  return items;
}
