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
  return items;
}
