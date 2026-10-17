// Pulls public tender releases from National Treasury's eTenders OCDS API (licence: ODC PDDL 1.0).
import { withSystem } from './db.js';

const BASE = process.env.ETENDERS_BASE || 'https://ocds-api.etenders.gov.za';
const iso = (d) => d.toISOString().slice(0, 10);

export function mapRelease(r) {
  const t = r.tender || {};
  const docs = (t.documents || []).map((d) => ({ title: d.title, url: d.url, format: d.format, published: d.datePublished })).filter((d) => d.url);
  return {
    ocid: r.ocid,
    tender_no: t.title || t.id || null,          // eTenders puts the bid number in "title"
    title: (t.description || t.title || '').slice(0, 500),
    description: (t.description || '').slice(0, 4000),
    category: t.mainProcurementCategory || null,
    method: t.procurementMethod || null,
    buyer: r.buyer?.name || t.procuringEntity?.name || null,
    opens_at: t.tenderPeriod?.startDate || null,
    closes_at: t.tenderPeriod?.endDate || null,
    documents: docs,
    source_url: `${BASE}/api/OCDSReleases/release/${encodeURIComponent(r.ocid)}`,
  };
}

export async function fetchPage(from, to, page, fetchImpl = fetch) {
  const url = `${BASE}/api/OCDSReleases?dateFrom=${from}&dateTo=${to}&PageNumber=${page}&PageSize=100`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`eTenders API ${res.status}`);
  return res.json();
}

export async function ingest({ days = 3, maxPages = 20, fetchImpl = fetch, now = new Date() } = {}) {
  const to = iso(now), from = iso(new Date(now.getTime() - days * 86400000));
  const run = await withSystem((c) => c.query('INSERT INTO ingest_runs (date_from, date_to) VALUES ($1,$2) RETURNING id', [from, to]).then((r) => r.rows[0].id));
  let pages = 0, upserted = 0, error = null;
  try {
    for (let p = 1; p <= maxPages; p++) {
      const data = await fetchPage(from, to, p, fetchImpl);
      const rel = data.releases || [];
      if (!rel.length) break;
      pages++;
      await withSystem(async (c) => {
        for (const r of rel) {
          if (!r.ocid) continue;
          const m = mapRelease(r);
          await c.query(
            `INSERT INTO tenders (ocid,tender_no,title,description,category,method,buyer,opens_at,closes_at,documents,source_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (ocid) DO UPDATE SET tender_no=EXCLUDED.tender_no,title=EXCLUDED.title,description=EXCLUDED.description,
               category=EXCLUDED.category,method=EXCLUDED.method,buyer=EXCLUDED.buyer,opens_at=EXCLUDED.opens_at,
               closes_at=EXCLUDED.closes_at,documents=EXCLUDED.documents,fetched_at=now(),updated_at=now()`,
            [m.ocid, m.tender_no, m.title, m.description, m.category, m.method, m.buyer, m.opens_at, m.closes_at, JSON.stringify(m.documents), m.source_url]);
          upserted++;
        }
      });
      if (!data.links?.next) break;
    }
  } catch (e) { error = String(e.message || e).slice(0, 300); }
  await withSystem((c) => c.query('UPDATE ingest_runs SET finished_at=now(), pages=$2, upserted=$3, error=$4 WHERE id=$1', [run, pages, upserted, error]));
  return { from, to, pages, upserted, error };
}
