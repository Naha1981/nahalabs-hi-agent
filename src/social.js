// Social posts and ad campaign drafts. Nothing here runs without an approved item in
// the approval queue, and execution fails closed until the owner connects the real
// account (credentials arrive as environment config once the owner's Meta/Google
// apps exist - HI never invents connections, metrics or results).
import { audit } from './db.js';
import { dec } from './integrations.js';

export async function executeSocialPost(c, { tenantId, approval, fetchImpl = fetch }) {
  const p = approval.payload || {};
  const network = String(p.network || '');
  const text = String(p.text || '');
  const fail = async (error) => { await audit(c, tenantId, 'system', 'social.post_blocked', { approval_id: approval.id, reason: error }); return { error }; };
  if (!['facebook', 'instagram'].includes(network)) return fail('unsupported network');
  if (!text.trim()) return fail('post text is empty');
  const pageId = process.env.META_PAGE_ID, token = process.env.META_PAGE_TOKEN;
  if (!pageId || !token) return fail('the Facebook/Instagram account is not connected yet - connect it in Integrations first');
  try {
    if (network === 'facebook') {
      const res = await fetchImpl(`https://graph.facebook.com/v21.0/${pageId}/feed`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text.slice(0, 3000), ...(p.link ? { link: p.link } : {}), access_token: token }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return fail('facebook http ' + res.status);
    } else {
      if (!p.media_url) return fail('instagram posts need an image or video link');
      const igId = process.env.META_IG_USER_ID;
      if (!igId) return fail('the Instagram business account is not linked yet');
      const mk = await fetchImpl(`https://graph.facebook.com/v21.0/${igId}/media`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image_url: p.media_url, caption: text.slice(0, 2200), access_token: token }),
        signal: AbortSignal.timeout(15000),
      });
      if (!mk.ok) return fail('instagram media http ' + mk.status);
      const container = (await mk.json())?.id;
      const pub = await fetchImpl(`https://graph.facebook.com/v21.0/${igId}/media_publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creation_id: container, access_token: token }),
        signal: AbortSignal.timeout(15000),
      });
      if (!pub.ok) return fail('instagram publish http ' + pub.status);
    }
  } catch (e) { return fail(String(e?.message || e).slice(0, 120)); }
  await audit(c, tenantId, approval.proposed_by, 'social.post_sent', { approval_id: approval.id, network });
  return { ok: true };
}

export async function executeAdCampaign(c, { tenantId, approval, fetchImpl = fetch }) {
  const p = approval.payload || {};
  const fail = async (error) => { await audit(c, tenantId, 'system', 'ads.campaign_blocked', { approval_id: approval.id, reason: error }); return { error }; };
  const budget = Number(p.daily_budget_cents);
  if (!Number.isFinite(budget) || budget <= 0) return fail('daily budget is missing');
  if (String(p.network) === 'google') return executeGoogleAdCampaign(c, { tenantId, approval, payload: p, fetchImpl, fail });
  if (String(p.network) !== 'meta') return fail('unsupported ads network');
  const acct = process.env.META_AD_ACCOUNT_ID, token = process.env.META_ADS_TOKEN;
  if (!acct || !token) return fail('the Meta ads account is not connected yet - no campaign exists until it is');
  // Created PAUSED: money moves only when the owner activates it in their own Ads Manager.
  try {
    const res = await fetchImpl(`https://graph.facebook.com/v21.0/act_${acct}/campaigns`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: String(p.headline || 'HI campaign').slice(0, 100), objective: 'OUTCOME_TRAFFIC',
        status: 'PAUSED', special_ad_categories: [], daily_budget: Math.round(budget),
        access_token: token,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return fail('meta ads http ' + res.status);
  } catch (e) { return fail(String(e?.message || e).slice(0, 120)); }
  await audit(c, tenantId, approval.proposed_by, 'ads.campaign_created', { approval_id: approval.id });
  return { ok: true };
}

// Google Ads, per Google's own REST examples (developers.google.com/google-ads/api/rest/examples):
// create the budget, then the campaign referencing it, always PAUSED. Needs a
// developer token and customer ID in platform config plus the tenant's Google
// account connected with the ads (adwords) scope; every missing piece fails
// closed with the reason named. login-customer-id is sent only when a manager
// account is configured.
async function executeGoogleAdCampaign(c, { tenantId, approval, payload: p, fetchImpl, fail }) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN, customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const managerId = String(process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID || '').replace(/-/g, '');
  if (!devToken || !customerId) return fail('the Google Ads account is not connected yet - developer token and customer ID are not configured');
  const integ = (await c.query("SELECT id, access_token_enc, expires_at FROM integrations WHERE provider='google' AND status='active' AND scopes ILIKE '%adwords%' ORDER BY created_at LIMIT 1")).rows[0];
  const token = integ ? dec(integ.access_token_enc) : null;
  if (!token) return fail('no Google account is connected with the ads permission yet - connect one in Integrations first');
  const version = process.env.GOOGLE_ADS_API_VERSION || '18';
  const headers = { 'content-type': 'application/json', 'developer-token': devToken, authorization: 'Bearer ' + token, ...(managerId ? { 'login-customer-id': managerId } : {}) };
  const micros = Math.round(Number(p.daily_budget_cents) * 10000);  // cents -> micros (1 currency unit = 1e6 micros)
  const base = `https://googleads.googleapis.com/v${version}/customers/${customerId}`;
  try {
    const b = await fetchImpl(`${base}/campaignBudgets:mutate`, {
      method: 'POST', headers, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ operations: [{ create: { name: ('HI: ' + String(p.headline || 'campaign')).slice(0, 100), amountMicros: micros, deliveryMethod: 'STANDARD', explicitlyShared: false } }] }),
    });
    if (!b.ok) return fail('google ads budget http ' + b.status);
    const budgetName = (await b.json())?.results?.[0]?.resourceName;
    if (!budgetName) return fail('google ads budget returned no resource name');
    const camp = await fetchImpl(`${base}/campaigns:mutate`, {
      method: 'POST', headers, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ operations: [{ create: {
        name: ('HI: ' + String(p.headline || 'campaign')).slice(0, 100), status: 'PAUSED',
        advertisingChannelType: 'SEARCH', campaignBudget: budgetName, targetSpend: {},
        geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST', negativeGeoTargetType: 'PRESENCE_OR_INTEREST' },
      } }] }),
    });
    if (!camp.ok) return fail('google ads campaign http ' + camp.status);
  } catch (e) { return fail(String(e?.message || e).slice(0, 120)); }
  await audit(c, tenantId, approval.proposed_by, 'ads.campaign_created', { approval_id: approval.id, network: 'google' });
  return { ok: true };
}
