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
  const currentRef = `page:${pageId}`;
  if (p.account_ref !== currentRef) {
    return fail(p.account_ref && !p.account_ref.endsWith('unconfigured')
      ? 'the connected page changed since this draft was made - review and re-draft for the new page'
      : 'no page was connected when this draft was made - connect it, then re-draft so you review against the real page');
  }
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
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isInteger(budget)) return fail('daily budget must be a whole number of cents');
  // The draft is bound to the ads account that was connected when it was made.
  // If the connected account changed (or first appeared) after drafting, the
  // owner must re-review against the new account - never silently switch.
  const currentRef = String(p.network) === 'meta'
    ? `meta:${process.env.META_AD_ACCOUNT_ID || 'unconfigured'}`
    : `google:${String(process.env.GOOGLE_ADS_CUSTOMER_ID || 'unconfigured').replace(/-/g, '')}`;
  if (p.account_ref !== currentRef) {
    return fail(p.account_ref && !p.account_ref.endsWith('unconfigured')
      ? 'the ads account changed since this draft was made - review and re-draft for the new account'
      : 'the ads account was not connected when this draft was made - connect it, then re-draft so you review against the real account');
  }
  if (String(p.network) === 'meta') {
    // HARD CAPABILITY GATE: Meta request shapes are not yet verified against
    // official Meta documentation (developers.facebook.com unreachable from
    // the build environment). Credentials alone must never enable unverified
    // external calls, so execution additionally requires the explicit ops
    // switch HI_META_ADS_API_VERIFIED=1, set only after the exact requests are
    // checked against Meta's official Marketing API docs. The approved draft
    // is retained on the approval row; nothing is sent while gated.
    if (process.env.HI_META_ADS_API_VERIFIED !== '1') {
      return fail('Meta ad execution is not switched on: the exact request shapes are not verified against official Meta documentation yet. Nothing was sent and no campaign exists - this draft is kept in your approvals, and can be re-drafted once Meta support is verified.');
    }
    return executeMetaChain(c, { tenantId, approval, payload: p, fetchImpl, fail });
  }
  if (String(p.network) === 'google') return executeGoogleChain(c, { tenantId, approval, payload: p, fetchImpl, fail });
  return fail('unsupported ads network');
}

// Records each created resource on the approval payload as it happens, so a
// later failure leaves evidence of exactly what exists in the ads account.
async function recordCreated(c, approvalId, key, value) {
  await c.query("UPDATE approvals SET payload = jsonb_set(payload, '{created}', COALESCE(payload->'created','{}'::jsonb) || jsonb_build_object($2::text, to_jsonb($3::text))) WHERE id=$1", [approvalId, key, value]);
}

// Full Meta chain: campaign -> ad set (budget lives here) -> creative -> ad,
// every object PAUSED. UNVERIFIED against current Meta docs - unreachable
// behind the capability gate in executeAdCampaign until the exact request
// shapes are checked against official Meta Marketing API documentation.
// Cleanup deletes ONLY the objects created by this attempt (tracked in
// `created`), never pre-existing account objects; anything not deleted is
// named in the failure reason, audited, and recorded on the approval payload
// for durable reconciliation - there is no blind re-run.
async function executeMetaChain(c, { tenantId, approval, payload: p, fetchImpl, fail }) {
  const acct = process.env.META_AD_ACCOUNT_ID, token = process.env.META_ADS_TOKEN, pageId = process.env.META_PAGE_ID;
  if (!acct || !token || !pageId) return fail('the Meta ads account is not connected yet - no campaign exists until it is');
  if (!p.link) return fail('ad drafts need a destination link before anything is created');
  const base = `https://graph.facebook.com/v21.0/act_${acct}`;
  const post = async (url, body) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, access_token: token }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('meta http ' + res.status + ' on ' + url.split('/').pop());
    return (await res.json())?.id;
  };
  const del = async (id) => { try { await fetchImpl(`https://graph.facebook.com/v21.0/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: token }), signal: AbortSignal.timeout(15000) }); } catch { /* best effort */ } };
  const created = [];
  try {
    const name = String(p.headline || 'HI campaign').slice(0, 100);
    const campaign = await post(`${base}/campaigns`, { name, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [] });
    if (!campaign) throw new Error('campaign create returned no id');
    created.push(campaign); await recordCreated(c, approval.id, 'meta_campaign', campaign);
    const adset = await post(`${base}/adsets`, {
      name: name + ' - ad set', campaign_id: campaign, daily_budget: Math.round(budgetOf(p)),
      billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: { geo_locations: { countries: ['ZA'] } }, status: 'PAUSED',
    });
    if (!adset) throw new Error('ad set create returned no id');
    created.push(adset); await recordCreated(c, approval.id, 'meta_adset', adset);
    const creative = await post(`${base}/adcreatives`, {
      name: name + ' - creative',
      object_story_spec: { page_id: pageId, link_data: { message: String(p.body || ''), link: p.link, name: String(p.headline || ''), call_to_action: { type: 'LEARN_MORE', value: { link: p.link } } } },
    });
    if (!creative) throw new Error('creative create returned no id');
    created.push(creative); await recordCreated(c, approval.id, 'meta_creative', creative);
    const ad = await post(`https://graph.facebook.com/v21.0/act_${acct}/ads`, { name: name + ' - ad', adset_id: adset, creative: { creative_id: creative }, status: 'PAUSED' });
    if (!ad) throw new Error('ad create returned no id');
    created.push(ad); await recordCreated(c, approval.id, 'meta_ad', ad);
  } catch (e) {
    for (const id of [...created].reverse()) await del(id);
    const err = String(e?.message || e).slice(0, 120);
    await audit(c, tenantId, 'system', 'ads.chain_failed', { approval_id: approval.id, network: 'meta', created_ids: [...created], cleanup: 'attempted', error: err });
    return fail(err + (created.length ? ` (cleanup attempted for: ${created.join(', ')})` : ''));
  }
  await audit(c, tenantId, approval.proposed_by, 'ads.campaign_created', { approval_id: approval.id, network: 'meta', ids: created });
  return { ok: true };
}

const budgetOf = (p) => Number(p.daily_budget_cents);

// Full Google chain per the verified REST examples (v26 is the current
// version per developers.google.com/google-ads/api/docs/upgrade): budget ->
// campaign -> ad group -> responsive search ad, all PAUSED. RSA requires 3
// headlines and 2 descriptions, so the draft must carry them; anything less
// fails closed instead of inventing words. On failure created resources are
// removed best-effort and named otherwise.
async function executeGoogleChain(c, { tenantId, approval, payload: p, fetchImpl, fail }) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN, customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const managerId = String(process.env.GOOGLE_ADS_MANAGER_CUSTOMER_ID || '').replace(/-/g, '');
  if (!devToken || !customerId) return fail('the Google Ads account is not connected yet - developer token and customer ID are not configured');
  const headlines = [p.headline, p.headline_2, p.headline_3].map((h) => String(h || '').trim()).filter(Boolean);
  const descriptions = [p.body, p.description_2].map((d) => String(d || '').trim()).filter(Boolean);
  if (headlines.length < 3 || descriptions.length < 2) return fail('Google search ads need exactly 3 headlines and 2 descriptions - re-draft with headline_2, headline_3 and description_2 so every word is approved');
  if (headlines.some((h) => h.length > 30)) return fail('a headline is over Google\'s 30-character limit - re-draft with shorter headlines; HI never trims approved words');
  if (descriptions.some((d) => d.length > 90)) return fail('a description is over Google\'s 90-character limit - re-draft with shorter descriptions; HI never trims approved words');
  if (!p.link) return fail('ad drafts need a destination link before anything is created');
  const integ = (await c.query("SELECT id, access_token_enc FROM integrations WHERE provider='google' AND status='active' AND scopes ILIKE '%adwords%' ORDER BY created_at LIMIT 1")).rows[0];
  const token = integ ? dec(integ.access_token_enc) : null;
  if (!token) return fail('no Google account is connected with the ads permission yet - connect one in Integrations first');
  const version = process.env.GOOGLE_ADS_API_VERSION || '26';  // v26 (Latest), released 2026-10-14, sunset Nov 2027 - verified 26 Oct 2026 against developers.google.com/google-ads/api/docs/upgrade and /docs/sunset-dates; re-verify when the account is connected
  const headers = { 'content-type': 'application/json', 'developer-token': devToken, authorization: 'Bearer ' + token, ...(managerId ? { 'login-customer-id': managerId } : {}) };
  const base = `https://googleads.googleapis.com/v${version}/customers/${customerId}`;
  const micros = Math.round(Number(p.daily_budget_cents) * 10000);  // cents -> micros (1 currency unit = 1e6 micros)
  const mutate = async (resource, create) => {
    const res = await fetchImpl(`${base}/${resource}:mutate`, { method: 'POST', headers, signal: AbortSignal.timeout(15000), body: JSON.stringify({ operations: [{ create }] }) });
    if (!res.ok) throw new Error(resource + ' http ' + res.status);
    const rn = (await res.json())?.results?.[0]?.resourceName;
    if (!rn) throw new Error(resource + ' returned no resource name');
    return rn;
  };
  const remove = async (resource, rn) => { try { await fetchImpl(`${base}/${resource}:mutate`, { method: 'POST', headers, signal: AbortSignal.timeout(15000), body: JSON.stringify({ operations: [{ remove: rn }] }) }); } catch { /* best effort */ } };
  const name = ('HI: ' + String(p.headline || 'campaign')).slice(0, 100);
  const created = [];
  try {
    const budget = await mutate('campaignBudgets', { name, amountMicros: micros, deliveryMethod: 'STANDARD', explicitlyShared: false });
    created.push(['campaignBudgets', budget]); await recordCreated(c, approval.id, 'google_budget', budget);
    const campaign = await mutate('campaigns', {
      name, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget, targetSpend: {},
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST', negativeGeoTargetType: 'PRESENCE_OR_INTEREST' },
    });
    created.push(['campaigns', campaign]); await recordCreated(c, approval.id, 'google_campaign', campaign);
    const adGroup = await mutate('adGroups', { name: name + ' - ad group', campaign, status: 'PAUSED', type: 'SEARCH_STANDARD' });
    created.push(['adGroups', adGroup]); await recordCreated(c, approval.id, 'google_adgroup', adGroup);
    const ad = await mutate('adGroupAds', {
      adGroup, status: 'PAUSED',
      ad: { responsiveSearchAd: { headlines: headlines.map((t) => ({ text: t })), descriptions: descriptions.map((t) => ({ text: t })) }, finalUrls: [p.link] },
    });
    created.push(['adGroupAds', ad]); await recordCreated(c, approval.id, 'google_ad', ad);
  } catch (e) {
    for (const [resource, rn] of [...created].reverse()) await remove(resource, rn);
    const err = String(e?.message || e).slice(0, 120);
    await audit(c, tenantId, 'system', 'ads.chain_failed', { approval_id: approval.id, network: 'google', created_ids: created.map(([, rn]) => rn), cleanup: 'attempted', error: err });
    return fail(err + (created.length ? ` (cleanup attempted for: ${created.map(([, rn]) => rn).join(', ')})` : ''));
  }
  await audit(c, tenantId, approval.proposed_by, 'ads.campaign_created', { approval_id: approval.id, network: 'google', ids: created.map(([, rn]) => rn) });
  return { ok: true };
}
