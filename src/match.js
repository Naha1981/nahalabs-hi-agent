// Deterministic, explainable matching. Every score point has a stated reason.
import { withTenant, withSystem, audit } from './db.js';

const norm = (s) => String(s || '').toLowerCase();
const has = (text, term) => {
  const t = norm(term).trim();
  if (!t) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}`, 'i').test(text);
};

export function scoreTender(tender, profile, memories = []) {
  const reasons = [];
  let score = 0;
  const title = norm(tender.title) + ' ' + norm(tender.tender_no);
  const body = norm(tender.description);
  for (const kw of profile.exclude_keywords || []) {
    if (has(title, kw) || has(body, kw)) return { score: 0, reasons: [{ text: `Excluded term "${kw}"`, points: 0 }], excluded: true };
  }
  for (const kw of profile.keywords || []) {
    if (has(title, kw)) { score += 30; reasons.push({ text: `"${kw}" appears in the tender title`, points: 30 }); }
    else if (has(body, kw)) { score += 15; reasons.push({ text: `"${kw}" appears in the description`, points: 15 }); }
  }
  if ((profile.categories || []).length && tender.category && profile.categories.map(norm).includes(norm(tender.category))) {
    score += 10; reasons.push({ text: `Category "${tender.category}" is one you selected`, points: 10 });
  }
  for (const bt of profile.buyer_terms || []) {
    if (has(norm(tender.buyer), bt)) { score += 15; reasons.push({ text: `Buyer matches "${bt}"`, points: 15 }); }
  }
  // Learning from this tenant's earlier dismissals
  for (const m of memories) {
    if (m.kind === 'dismiss_buyer' && norm(tender.buyer) === norm(m.subject)) { score -= 20; reasons.push({ text: `You dismissed an earlier tender from this buyer`, points: -20 }); }
  }
  return { score: Math.max(0, Math.min(100, score)), reasons, excluded: false };
}

export async function matchTenant(tenantId, { minScore = 15, now = new Date() } = {}) {
  return withTenant(tenantId, async (c) => {
    const prof = (await c.query('SELECT * FROM profiles WHERE tenant_id = current_setting(\'app.tenant_id\')::uuid')).rows[0];
    if (!prof || !prof.keywords.length) return { matched: 0, skipped: 'no profile keywords' };
    const mem = (await c.query('SELECT kind, subject FROM memory_notes ORDER BY created_at DESC LIMIT 200')).rows;
    const open = (await c.query('SELECT * FROM tenders WHERE closes_at IS NULL OR closes_at > $1 ORDER BY closes_at NULLS LAST LIMIT 5000', [now])).rows;
    let n = 0;
    for (const t of open) {
      const { score, reasons, excluded } = scoreTender(t, prof, mem);
      if (excluded || score < minScore) continue;
      await c.query(
        `INSERT INTO matches (tenant_id, ocid, score, reasons) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3)
         ON CONFLICT (tenant_id, ocid) DO UPDATE SET score=EXCLUDED.score, reasons=EXCLUDED.reasons, updated_at=now()
         WHERE matches.status = 'new'`, [t.ocid, score, JSON.stringify(reasons)]);
      n++;
    }
    await audit(c, tenantId, 'agent:matcher', 'match.run', { considered: open.length, matched: n });
    return { matched: n, considered: open.length };
  });
}

export async function matchAllTenants(opts) {
  const ids = await withSystem((c) => c.query('SELECT id FROM tenants WHERE NOT paused').then((r) => r.rows.map((x) => x.id)));
  const out = [];
  for (const id of ids) out.push({ tenant: id, ...(await matchTenant(id, opts)) });
  return out;
}
