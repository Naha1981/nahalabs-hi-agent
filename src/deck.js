// Mandate pitch deck: a self-contained, printable HTML file for the seller, built only
// from facts on record (property details, the agency's own name, real matching-buyer
// counts). No invented stats, no platform branding - it is the agent's document.
export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildMandateDeck({ agency, property, matchCount }) {
  const price = property.asking_price || '';
  const facts = [];
  if (property.bedrooms != null) facts.push(`${property.bedrooms} bedroom${property.bedrooms === 1 ? '' : 's'}`);
  if (property.suburb) facts.push(property.suburb);
  const slide = (inner) => `<section class="slide">${inner}</section>`;
  const slides = [
    slide(`<p class="kicker">Selling proposal</p><h1>${escHtml(property.title)}</h1>${price ? `<p class="price">${escHtml(price)}</p>` : ''}<p class="mut">Prepared by ${escHtml(agency)}</p>`),
    slide(`<h2>The property</h2><ul>${facts.length ? facts.map((f) => `<li>${escHtml(f)}</li>`).join('') : '<li>Details to be confirmed with you</li>'}</ul>${property.notes ? `<p class="mut">${escHtml(property.notes).slice(0, 400)}</p>` : ''}`),
    slide(`<h2>The plan</h2><ol><li>Professional presentation of your listing</li><li>Direct outreach to qualified buyers on our books</li><li>Portal and buyer-network exposure</li><li>Weekly feedback after every viewing</li></ol>`),
    slide(`<h2>Buyers already looking</h2><p class="big">${matchCount}</p><p class="mut">${matchCount === 1 ? 'buyer on our books matches' : 'buyers on our books match'} this property on budget, bedrooms and area today.</p>`),
    slide(`<h2>Next step</h2><p>A sole mandate lets us put this plan behind your sale fully.</p><p class="mut">${escHtml(agency)}</p>`),
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mandate proposal - ${escHtml(property.title)}</title><style>
body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;background:#f4f4f5;color:#18181b}
.slide{box-sizing:border-box;min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:8vh 10vw;background:#fff;border-bottom:1px solid #e4e4e7}
h1{font-size:44px;margin:8px 0;letter-spacing:-0.02em}h2{font-size:30px;margin:0 0 18px;letter-spacing:-0.02em}
.kicker{text-transform:uppercase;letter-spacing:0.12em;color:#71717a;font-size:13px;font-weight:600}
.price{font-size:28px;font-weight:700}.big{font-size:72px;font-weight:800;margin:0}
.mut{color:#52525b}li{font-size:18px;margin:8px 0}
@media print{.slide{page-break-after:always;border:0}}
</style></head><body>${slides.join('')}</body></html>`;
}
