// Runs on an ephemeral GitHub Actions runner. No secrets besides the one-job token. Talks only to the HI server.
import { chromium } from 'playwright-core';
const { JOB_ID, JOB_TOKEN, BASE_URL, START_URL } = process.env;
const api = async (path, body) => {
  const res = await fetch(`${BASE_URL}/internal/browser/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: JOB_ID, token: JOB_TOKEN, ...body }), signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${path} http ${res.status}`);
  return res.json();
};
const observe = (page) => page.evaluate(() => {
  const els = []; let i = 0;
  for (const e of document.querySelectorAll('a[href],button,input,select,textarea,[role=button]')) {
    const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    e.setAttribute('data-hi-idx', String(i));
    const label = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.getAttribute('title') || e.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    els.push({ i, tag: e.tagName.toLowerCase(), type: e.getAttribute('type') || (e.tagName === 'BUTTON' ? 'submit' : ''), label, name: e.getAttribute('name') || e.getAttribute('autocomplete') || '', value: (['text','search','email','tel','url','number',''].includes(e.getAttribute('type') || '') && /^(input|textarea)$/.test(e.tagName.toLowerCase())) ? String(e.value || '').slice(0, 60) : (e.tagName === 'SELECT' ? String(e.value || '').slice(0, 40) : (e.checked ? 'checked' : '')) });
    if (++i >= 60) break;
  }
  return { url: location.href, title: document.title, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 2500), elements: els };
});
const shot = async (page) => (await page.screenshot({ type: 'jpeg', quality: 45, fullPage: false })).toString('base64');
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, acceptDownloads: false, permissions: [] });
const page = await ctx.newPage();
try {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  for (let n = 0; n < 24; n++) {
    await page.waitForTimeout(800);
    const obs = await observe(page);
    let { action } = await api('step', { observation: obs, screenshot: await shot(page) });
    if (action.type === 'wait') {
      const until = Date.now() + 6 * 60 * 1000; action = null;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 5000));
        const p = await api('poll', {});
        if (p.state === 'approved') { action = p.action; break; }
        if (p.state === 'stopped') break;
      }
      if (!action) break;
    }
    if (action.type === 'done') break;
    if (action.type === 'goto') await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    else if (action.type === 'scroll') await page.mouse.wheel(0, 700);
    else if (action.type === 'type') await page.locator(`[data-hi-idx="${action.index}"]`).first().fill(action.text, { timeout: 8000 });
    else if (action.type === 'click') { await page.locator(`[data-hi-idx="${action.index}"]`).first().click({ timeout: 8000 }); await page.waitForLoadState('domcontentloaded').catch(() => {}); }
  }
  // final state back to the server so the last screenshot is stored
  const obs = await observe(page);
  await api('finish', { observation: obs, screenshot: await shot(page) }).catch(() => {});
} finally { await browser.close(); }
