// User-connected integrations: Gmail, Outlook, Google Calendar, Outlook Calendar.
// Each customer connects their own account with OAuth. Tokens are encrypted with a server-only
// key before they touch the database. Reads are direct; every send or create goes through the
// approval queue first and is executed only after the customer approves.
import crypto from 'node:crypto';
import { withTenant, audit } from './db.js';

// ---- token encryption (server-side only) ----
function key() {
  const s = process.env.INTEGRATIONS_SECRET;
  if (!s || s.length < 32) return null;
  return crypto.createHash('sha256').update(s).digest();
}
export function integrationsConfigured() { return !!key(); }
const enc = (plain) => {
  const k = key(); if (!k || !plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const out = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), out.toString('hex')].join('.');
};
const dec = (blob) => {
  const k = key(); if (!k || !blob) return null;
  try {
    const [ivh, tagh, datah] = String(blob).split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivh, 'hex'));
    d.setAuthTag(Buffer.from(tagh, 'hex'));
    return Buffer.concat([d.update(Buffer.from(datah, 'hex')), d.final()]).toString('utf8');
  } catch { return null; }
};

// ---- provider config ----
export const PROVIDERS = {
  google: {
    label: 'Google (Gmail + Calendar)',
    scopes: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
    authUrl({ clientId, redirectUri, state }) {
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: this.scopes, access_type: 'offline', prompt: 'consent', state });
    },
    tokenUrl: 'https://oauth2.googleapis.com/token',
    configured: () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  },
  microsoft: {
    label: 'Microsoft (Outlook + Calendar)',
    scopes: 'offline_access openid email User.Read Mail.Read Mail.Send Calendars.Read Calendars.ReadWrite',
    authUrl({ clientId, redirectUri, state }) {
      return 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?' + new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: this.scopes, response_mode: 'query', state });
    },
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    configured: () => !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
  },
};

export function providerConfigured(name) { return PROVIDERS[name]?.configured() || false; }

export function authUrlFor(provider, redirectUri, state) {
  const p = PROVIDERS[provider];
  if (!p || !p.configured()) return null;
  const clientId = provider === 'google' ? process.env.GOOGLE_CLIENT_ID : process.env.MS_CLIENT_ID;
  return p.authUrl({ clientId, redirectUri, state });
}

async function tokenRequest(provider, body, fetchImpl) {
  const p = PROVIDERS[provider];
  const secret = provider === 'google' ? process.env.GOOGLE_CLIENT_SECRET : process.env.MS_CLIENT_SECRET;
  const clientId = provider === 'google' ? process.env.GOOGLE_CLIENT_ID : process.env.MS_CLIENT_ID;
  const res = await fetchImpl(p.tokenUrl, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, ...body }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('token exchange failed (' + res.status + ')');
  return res.json();
}

// Exchange the OAuth code and store the connection. Returns { account } or { error }.
export async function connectAccount({ tenantId, provider, code, redirectUri, fetchImpl = fetch }) {
  if (!PROVIDERS[provider]) return { error: 'unknown provider' };
  let tok;
  try { tok = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, fetchImpl); }
  catch (e) { return { error: 'Could not finish the connection: ' + String(e.message).slice(0, 120) }; }
  if (!tok.access_token) return { error: 'The provider did not return an access token.' };
  // Who is this account?
  let email = '';
  try {
    const meUrl = provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName';
    const me = await (await fetchImpl(meUrl, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(15000) })).json();
    email = String(me.email || me.mail || me.userPrincipalName || '').toLowerCase();
  } catch { return { error: 'Could not read the connected account address.' }; }
  if (!email) return { error: 'Could not read the connected account address.' };
  const expiresAt = tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000) : null;
  await withTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO integrations (tenant_id, provider, account_email, scopes, access_token_enc, refresh_token_enc, expires_at, status)
       VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3,$4,$5,$6,'active')
       ON CONFLICT (tenant_id, provider, account_email) DO UPDATE SET scopes=$3, access_token_enc=$4, refresh_token_enc=COALESCE($5, integrations.refresh_token_enc), expires_at=$6, status='active', updated_at=now()`,
      [provider, email, PROVIDERS[provider].scopes, enc(tok.access_token), tok.refresh_token ? enc(tok.refresh_token) : null, expiresAt]);
    await audit(c, tenantId, 'user', 'integration.connected', { provider, account: email });
  });
  return { account: email };
}

async function refreshIfNeeded(c, row, fetchImpl) {
  if (row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60000) return dec(row.access_token_enc);
  const refresh = dec(row.refresh_token_enc);
  if (!refresh) { await c.query("UPDATE integrations SET status='error', updated_at=now() WHERE id=$1", [row.id]); return null; }
  try {
    const tok = await tokenRequest(row.provider, { grant_type: 'refresh_token', refresh_token: refresh }, fetchImpl);
    const expiresAt = tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000) : null;
    await c.query('UPDATE integrations SET access_token_enc=$2, refresh_token_enc=COALESCE($3, refresh_token_enc), expires_at=$4, status=\'active\', updated_at=now() WHERE id=$1',
      [row.id, enc(tok.access_token), tok.refresh_token ? enc(tok.refresh_token) : null, expiresAt]);
    return tok.access_token;
  } catch {
    await c.query("UPDATE integrations SET status='error', updated_at=now() WHERE id=$1", [row.id]);
    return null;
  }
}

// Open a tenant transaction, refresh tokens, and run fn(client, rows with live access tokens).
async function withLiveIntegrations(tenantId, fetchImpl, fn) {
  return withTenant(tenantId, async (c) => {
    const rows = (await c.query("SELECT * FROM integrations WHERE status IN ('active','error') ORDER BY created_at")).rows;
    const live = [];
    for (const r of rows) {
      const token = await refreshIfNeeded(c, r, fetchImpl);
      if (token) live.push({ id: r.id, provider: r.provider, account: r.account_email, token });
    }
    return fn(c, live);
  });
}

const g = async (url, token, fetchImpl) => {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('provider read failed (' + res.status + ')');
  return res.json();
};

// ---- reads ----
// Convert the watch's Gmail-like time filter to Microsoft Graph OData. Graph does not understand
// Gmail's newer_than: syntax, so remove it from $search and express it as receivedDateTime.
export function outlookMailListUrl(query = '', max = 25, now = new Date()) {
  const params = new URLSearchParams();
  params.set('$top', String(Math.max(1, Math.min(50, Number(max) || 25))));
  params.set('$select', 'id,subject,from,receivedDateTime,bodyPreview');
  const age = String(query).match(/\bnewer_than:(\d+)([dhm])/i);
  if (age) {
    const unit = age[2].toLowerCase();
    const multiplier = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
    params.set('$filter', `receivedDateTime ge ${new Date(now.getTime() - Number(age[1]) * multiplier).toISOString()}`);
    params.set('$orderby', 'receivedDateTime desc');
  }
  const search = String(query).replace(/\bnewer_than:\d+[dhm]\b/ig, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (search) params.set('$search', '"' + search.replace(/"/g, String.fromCharCode(92) + '"') + '"');
  return `https://graph.microsoft.com/v1.0/me/messages?${params.toString()}`;
}

export async function mailSearch(tenantId, { query = '', max = 25, fetchImpl = fetch } = {}) {
  max = Math.max(1, Math.min(100, Number(max) || 25));
  const pageSize = Math.min(50, max);
  return withLiveIntegrations(tenantId, fetchImpl, async (c, live) => {
    const out = [];
    for (const acc of live) {
      try {
        if (acc.provider === 'google') {
          let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${pageSize}${query ? '&q=' + encodeURIComponent(query) : ''}`;
          let pages = 0;
          while (url && out.filter((m) => m.account === acc.account && m.id).length < max && pages < 5) {
            const list = await g(url, acc.token, fetchImpl);
            for (const m of (list.messages || [])) {
              if (out.filter((x) => x.account === acc.account && x.id).length >= max) break;
              const msg = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, acc.token, fetchImpl);
              const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [String(x.name).toLowerCase(), x.value]));
              out.push({ id: String(m.id), account: acc.account, provider: 'gmail', from: String(h.from || '').slice(0, 120), subject: String(h.subject || '').slice(0, 160), date: String(h.date || '').slice(0, 40), snippet: String(msg.snippet || '').slice(0, 500) });
            }
            pages++;
            url = list.nextPageToken && out.filter((m) => m.account === acc.account && m.id).length < max
              ? `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${pageSize}${query ? '&q=' + encodeURIComponent(query) : ''}&pageToken=${encodeURIComponent(list.nextPageToken)}`
              : null;
          }
        } else {
          let url = outlookMailListUrl(query, pageSize);
          let pages = 0, count = 0;
          while (url && count < max && pages < 5) {
            const j = await g(url, acc.token, fetchImpl);
            for (const m of (j.value || [])) {
              if (count >= max) break;
              out.push({ id: String(m.id || ''), account: acc.account, provider: 'outlook', from: String(m.from?.emailAddress?.address || '').slice(0, 120), subject: String(m.subject || '').slice(0, 160), date: String(m.receivedDateTime || '').slice(0, 40), snippet: String(m.bodyPreview || '').slice(0, 500) });
              count++;
            }
            pages++;
            url = j['@odata.nextLink'] && count < max ? j['@odata.nextLink'] : null;
          }
        }
      } catch (e) { out.push({ account: acc.account, provider: acc.provider === 'google' ? 'gmail' : 'outlook', error: String(e.message).slice(0, 80) }); }
    }
    return out;
  });
}

export async function calendarUpcoming(tenantId, { days = 7, fetchImpl = fetch } = {}) {
  days = Math.max(1, Math.min(30, Number(days) || 7));
  const now = new Date(), end = new Date(now.getTime() + days * 86400000);
  return withLiveIntegrations(tenantId, fetchImpl, async (c, live) => {
    const out = [];
    for (const acc of live) {
      try {
        if (acc.provider === 'google') {
          const j = await g(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&maxResults=10&singleEvents=true&orderBy=startTime`, acc.token, fetchImpl);
          for (const e of j.items || []) out.push({ account: acc.account, provider: 'google-calendar', title: String(e.summary || '').slice(0, 160), start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: String(e.location || '').slice(0, 120) });
        } else {
          const j = await g(`https://graph.microsoft.com/v1.0/me/calendarview?startdatetime=${now.toISOString()}&enddatetime=${end.toISOString()}&$top=10&$select=subject,start,end,location`, acc.token, fetchImpl);
          for (const e of j.value || []) out.push({ account: acc.account, provider: 'outlook-calendar', title: String(e.subject || '').slice(0, 160), start: e.start?.dateTime, end: e.end?.dateTime, location: String(e.location?.displayName || '').slice(0, 120) });
        }
      } catch (e) { out.push({ account: acc.account, provider: acc.provider, error: String(e.message).slice(0, 80) }); }
    }
    return out;
  });
}

// ---- approval-gated writes ----
export async function proposeAccountEmail(c, { tenantId, integrationId, to, subject, body, actor }) {
  const acc = (await c.query("SELECT id, provider, account_email FROM integrations WHERE id=$1 AND status='active'", [integrationId])).rows[0];
  if (!acc) return { error: 'That connected account is not available. Reconnect it on the Integrations page.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to || ''))) return { error: 'A valid recipient address is required.' };
  const r = (await c.query(
    "INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'account_email',$1,$2,$3) RETURNING id",
    [`Email from ${acc.account_email} to ${to}: "${String(subject).slice(0, 80)}"`, JSON.stringify({ integration_id: acc.id, to: String(to).slice(0, 200), subject: String(subject).slice(0, 200), body: String(body).slice(0, 10000) }), actor])).rows[0];
  await audit(c, tenantId, actor, 'account_email.proposed', { approval_id: r.id, to });
  return { approval_id: r.id };
}

export async function proposeCalendarEvent(c, { tenantId, integrationId, title, startsAt, endsAt, description = '', actor }) {
  const acc = (await c.query("SELECT id, provider, account_email FROM integrations WHERE id=$1 AND status='active'", [integrationId])).rows[0];
  if (!acc) return { error: 'That connected account is not available. Reconnect it on the Integrations page.' };
  const s = new Date(startsAt), e = new Date(endsAt);
  if (isNaN(s) || isNaN(e) || e <= s) return { error: 'Valid start and end times are required.' };
  const r = (await c.query(
    "INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'calendar_event',$1,$2,$3) RETURNING id",
    [`Calendar event on ${acc.account_email}: "${String(title).slice(0, 80)}" ${s.toISOString().slice(0, 16)}`, JSON.stringify({ integration_id: acc.id, title: String(title).slice(0, 200), starts_at: s.toISOString(), ends_at: e.toISOString(), description: String(description).slice(0, 2000) }), actor])).rows[0];
  await audit(c, tenantId, actor, 'calendar_event.proposed', { approval_id: r.id });
  return { approval_id: r.id };
}

// Executed by decideApproval after the customer approves. Runs inside the tenant transaction.
export async function executeConnectedApproval(c, { tenantId, approval, fetchImpl = fetch }) {
  const p = approval.payload || {};
  const row = (await c.query("SELECT * FROM integrations WHERE id=$1 AND status='active'", [p.integration_id])).rows[0];
  if (!row) return { error: 'The connected account was removed. Reconnect it and try again.' };
  const token = await refreshIfNeeded(c, row, fetchImpl);
  if (!token) return { error: 'Could not refresh the connected account. Reconnect it on the Integrations page.' };
  if (approval.kind === 'account_email') {
    if (row.provider === 'google') {
      const raw = Buffer.from(`To: ${p.to}\r\nSubject: ${p.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${p.body}`).toString('base64url');
      const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw }), signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { error: 'Gmail send failed (' + res.status + ')' };
      const j = await res.json();
      await audit(c, tenantId, approval.proposed_by, 'account_email.sent', { approval_id: approval.id, provider_id: j.id });
      return { status: 'executed', provider_id: j.id };
    }
    const res = await fetchImpl('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: { subject: p.subject, body: { contentType: 'Text', content: p.body }, toRecipients: [{ emailAddress: { address: p.to } }] } }), signal: AbortSignal.timeout(15000) });
    if (!res.ok && res.status !== 202) return { error: 'Outlook send failed (' + res.status + ')' };
    await audit(c, tenantId, approval.proposed_by, 'account_email.sent', { approval_id: approval.id });
    return { status: 'executed' };
  }
  if (approval.kind === 'calendar_event') {
    const body = row.provider === 'google'
      ? { summary: p.title, description: p.description, start: { dateTime: p.starts_at }, end: { dateTime: p.ends_at } }
      : { subject: p.title, body: { contentType: 'Text', content: p.description || '' }, start: { dateTime: p.starts_at, timeZone: 'UTC' }, end: { dateTime: p.ends_at, timeZone: 'UTC' } };
    const url = row.provider === 'google' ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events' : 'https://graph.microsoft.com/v1.0/me/events';
    const res = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { error: 'Calendar create failed (' + res.status + ')' };
    const j = await res.json();
    await audit(c, tenantId, approval.proposed_by, 'calendar_event.created', { approval_id: approval.id, provider_id: j.id });
    return { status: 'executed', provider_id: j.id };
  }
  return { error: 'unknown approval kind' };
}
