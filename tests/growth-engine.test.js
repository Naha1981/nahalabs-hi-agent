import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb } from './helpers.js';
import { withTenant, withSystem } from '../src/db.js';
import { ensureDefaultAgent } from '../src/agent.js';
import { runTool } from '../src/tools.js';

let db, A, B;

async function makeTenant(company, email) {
  const tenantId = await withSystem(async (c) => {
    const t = (await c.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [company])).rows[0].id;
    await c.query('INSERT INTO users (tenant_id,email,pw_hash) VALUES ($1,$2,$3)', [t,email,'test-only-password-hash']);
    return t;
  });
  const agent = await ensureDefaultAgent(tenantId);
  return { tenantId, agentId: agent.id, email };
}
const act = (u, name, args) => withTenant(u.tenantId, (c) => runTool(name, args, {
  c, tenantId: u.tenantId, userEmail: u.email, agentId: u.agentId,
  agentName: 'growth-test', principal: 'owner', sources: [], steps: []
}));

test.before(async () => {
  db = await startDb(54671);
  A = await makeTenant('Alpha Realty Test','alpha-growth@example.test');
  B = await makeTenant('Beta Realty Test','beta-growth@example.test');
});
test.after(async () => { await db.stop(); });

test('prospects deduplicate, preserve source links and score transparently', async () => {
  const first = await act(A,'growth_add_prospect',{
    agency_name:'Alpha Sandton Realty',agent_name:'Sipho Mokoena',role:'Estate Agent',
    suburb:'Sandton Central',market_scope:'core_sandton',
    public_email:'sipho@alpha.example.test',public_phone:'+27 82 123 4567',
    website_url:'https://alpha.example.test/agents/sipho',
    source_urls:['https://alpha.example.test/agents/sipho?utm_source=demo','https://alpha.example.test/listings/101'],
    opportunity_evidence:'Two active public listings have photos and written descriptions but no property video link on the sampled pages.',
    relevance_score:18,inventory_score:16,marketing_gap_score:20,contactability_score:15,pilot_fit_score:20,
    verification_notes:'Public pages found; re-check before outreach.'
  });
  assert.match(first,/priority score 89\/100/);
  const row1=(await withTenant(A.tenantId,c=>c.query("SELECT * FROM growth_prospects WHERE public_email='sipho@alpha.example.test'"))).rows[0];
  assert.equal(row1.verification_status,'unverified');
  assert.equal(row1.priority_score,89);
  assert.equal(row1.market_scope,'core_sandton');
  assert.equal(row1.source_urls.length,2);

  const dup=await act(A,'growth_add_prospect',{
    agency_name:'Different agency label from the same verified email',agent_name:'Sipho Mokoena',
    suburb:'Sandton Central',market_scope:'core_sandton',
    public_email:'SIPHO@ALPHA.EXAMPLE.TEST',
    source_urls:['https://alpha.example.test/agents/sipho?utm_campaign=second-source'],
    opportunity_evidence:'Second source checked; no direct video observed in the sampled listing pages.'
  });
  assert.match(dup,/Existing prospect enriched/);
  const rows=await withTenant(A.tenantId,c=>c.query("SELECT id,source_urls FROM growth_prospects WHERE public_email='sipho@alpha.example.test'"));
  assert.equal(rows.rowCount,1);
  assert.equal(rows.rows[0].id,row1.id);
  assert.equal(rows.rows[0].source_urls.length,3);
});

test('listing mandates default safely, canonical URLs deduplicate, campaigns await permission', async () => {
  const prospect=(await withTenant(A.tenantId,c=>c.query("SELECT id FROM growth_prospects WHERE public_email='sipho@alpha.example.test'"))).rows[0];
  const denied=await act(A,'growth_add_listing',{
    listing_url:'https://property.example.test/listing/101',
    source_urls:['https://property.example.test/listing/101'],
    prospect_id:prospect.id,suburb:'Sandton Central',listing_status:'active',
    mandate_status:'verified',mandate_evidence:''
  });
  assert.match(denied,/requires explicit mandate wording/);

  const ok=await act(A,'growth_add_listing',{
    listing_url:'https://property.example.test/listing/101?utm_source=portal',
    source_urls:['https://property.example.test/listing/101'],
    prospect_id:prospect.id,suburb:'Sandton Central',property_type:'Apartment',
    advertised_price:'R 3 200 000',features:'Three bedrooms; balcony',
    listing_status:'active',mandate_status:'not_stated',
    marketing_gap:'No vertical video is linked in the listing page.'
  });
  assert.match(ok,/mandate not_stated/);
  const duplicate=await act(A,'growth_add_listing',{
    listing_url:'https://property.example.test/listing/101?utm_campaign=another',
    source_urls:['https://agency.example.test/property/101'],
    prospect_id:prospect.id,suburb:'Sandton Central',listing_status:'unknown',
    mandate_status:'not_stated'
  });
  assert.match(duplicate,/Existing listing enriched/);
  const list=await withTenant(A.tenantId,c=>c.query("SELECT * FROM growth_listings WHERE listing_url='https://property.example.test/listing/101'"));
  assert.equal(list.rowCount,1);
  assert.equal(list.rows[0].mandate_status,'not_stated');
  assert.equal(list.rows[0].source_urls.length,2);

  const camp=await act(A,'growth_create_campaign',{
    campaign_name:'Sandton 101 pilot draft',listing_id:list.rows[0].id,prospect_id:prospect.id,
    deliverables:['Premium property poster','Vertical video brief','Three social captions','Viewing enquiry workflow'],
    asset_manifest:['copy is a draft; no actual photographs supplied']
  });
  assert.match(camp,/awaiting_authorisation/);
  const campaign=(await withTenant(A.tenantId,c=>c.query("SELECT * FROM growth_campaigns WHERE name='Sandton 101 pilot draft'"))).rows[0];
  assert.equal(campaign.status,'awaiting_authorisation');
  assert.equal(campaign.authorisation_status,'pending');
  assert.deepEqual(campaign.deliverables.slice(0,2),['Premium property poster','Vertical video brief']);

  const metric=await act(A,'growth_record_metric',{
    campaign_id:campaign.id,metric_name:'video_views',metric_value:0,
    evidence_note:'No video published; this is an initial baseline record, not a result.'
  });
  assert.match(metric,/verified=false/);
  const metricRow=(await withTenant(A.tenantId,c=>c.query('SELECT * FROM growth_metrics WHERE campaign_id=$1',[campaign.id]))).rows[0];
  assert.equal(metricRow.verified,false);
  assert.equal(metricRow.verification_status,'unverified');
});

test('opt-outs are terminal for agent-tool updates; CSV exports neutralise formulas and RLS isolates tenants', async () => {
  const formula=await act(A,'growth_add_prospect',{
    agency_name:'=HYPERLINK("https://evil.example.test","click")',
    agent_name:'CSV formula probe',suburb:'Bryanston',market_scope:'surrounding',
    public_email:'csv-probe@example.test',source_urls:['https://agency.example.test/team'],
    opportunity_evidence:'Public agency team page; marketing gap not yet verified.'
  });
  assert.match(formula,/Prospect saved/);
  const row=(await withTenant(A.tenantId,c=>c.query("SELECT id FROM growth_prospects WHERE public_email='csv-probe@example.test'"))).rows[0];
  const opted=await act(A,'growth_update_prospect',{prospect_id:row.id,outreach_status:'opted_out',outreach_evidence:'Contact explicitly asked not to receive further marketing.'});
  assert.match(opted,/No message was sent/);
  const reopen=await act(A,'growth_update_prospect',{prospect_id:row.id,outreach_status:'draft_ready',outreach_draft:'Hello'});
  assert.match(reopen,/opted out and cannot be reactivated/);

  const exported=await act(A,'growth_export_csv',{dataset:'prospects',limit:500});
  assert.match(exported,/Export saved as/);
  const file=(await withTenant(A.tenantId,c=>c.query("SELECT content FROM files WHERE filename LIKE 'sandton-prospects-%' ORDER BY created_at DESC LIMIT 1"))).rows[0];
  assert.ok(file.content.includes("'=HYPERLINK"),'spreadsheet formula cells should be prefixed safely');

  const isolated=await withTenant(B.tenantId,c=>c.query('SELECT count(*)::int n FROM growth_prospects'));
  const isolatedListings=await withTenant(B.tenantId,c=>c.query('SELECT count(*)::int n FROM growth_listings'));
  assert.equal(isolated.rows[0].n,0);
  assert.equal(isolatedListings.rows[0].n,0);
  const notOwner=await act(B,'growth_record_metric',{campaign_id:'00000000-0000-0000-0000-000000000001',metric_name:'sales',metric_value:1,evidence_note:'test'});
  assert.match(notOwner,/campaign not found in this account/);
});
