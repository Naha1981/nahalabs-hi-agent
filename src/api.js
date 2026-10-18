// Public keyed API (v1). Other NahaLabs products call HI here with a per-account bearer key.
// Keys are shown once at creation and stored only as a SHA-256 hash server-side.
// Every rule of the app applies unchanged: daily model budgets, approval gates on anything
// that leaves the account, tenant isolation. The API can draft and propose; it never sends.
import crypto from 'node:crypto';
import { withTenant, withSystem, audit } from './db.js';
import { runAgent, ensureDefaultAgent } from './agent.js';
import { ensureBuiltinSkills } from './skills.js';
import { proposeBrowserJob } from './browser.js';
import { buildXlsx, XLSX_MIME } from './xlsx.js';

const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');
export const newApiKey = () => 'hi_' + crypto.randomBytes(24).toString('hex');

const rate = new Map(); // key hash -> [windowStart, count]
function rateOk(h, max = 60) {
  const nowMin = Math.floor(Date.now() / 60000);
  const e = rate.get(h) || [nowMin, 0];
  if (e[0] !== nowMin) { e[0] = nowMin; e[1] = 0; }
  e[1]++; rate.set(h, e);
  return e[1] <= max;
}

const clip = (s, n) => String(s ?? '').slice(0, n);
const uuidOk = (x) => /^[0-9a-f-]{36}$/i.test(String(x || ''));

export function registerApi(app, { llm, fetchImpl, lookup } = {}) {
  // Bearer auth for every /v1 route.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const m = /^Bearer\s+(hi_[0-9a-f]{48})$/.exec(String(req.headers.authorization || ''));
    if (!m) return reply.code(401).send({ error: 'Missing or malformed API key. Use: Authorization: Bearer hi_...' });
    const h = hashKey(m[1]);
    const row = await withSystem((c) => c.query('SELECT * FROM api_key_lookup($1)', [h])).then((r) => r.rows[0]);
    if (!row) return reply.code(401).send({ error: 'Invalid, revoked or paused API key.' });
    if (!rateOk(h)) return reply.code(429).send({ error: 'Rate limit: 60 calls per minute per key.' });
    req.apiKey = { tenantId: row.tenant_id, keyId: row.key_id, hash: h };
    withSystem((c) => c.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [row.key_id])).catch(() => {});
  });

  app.get('/v1', async () => ({ name: 'HI API', version: 1, docs: '/developers' }));

  // --- Agents / chat ---
  app.get('/v1/agents', async (req) => {
    const agents = await withTenant(req.apiKey.tenantId, (c) => c.query('SELECT id, name, persona FROM agents ORDER BY created_at').then((r) => r.rows));
    return { agents };
  });

  app.post('/v1/chat', async (req, reply) => {
    const text = clip(req.body?.message, 4000).trim();
    if (!text) return reply.code(400).send({ error: 'message is required.' });
    const agentId = uuidOk(req.body?.agent_id) ? req.body.agent_id : (await ensureDefaultAgent(req.apiKey.tenantId)).id;
    const conversationId = uuidOk(req.body?.conversation_id) ? req.body.conversation_id : null;
    const r = await runAgent({ tenantId: req.apiKey.tenantId, userEmail: 'api', agentId, conversationId, userText: text, llm, fetchImpl, lookup });
    if (r.error) return reply.code(400).send({ error: r.error });
    return { answer: r.answer, conversation_id: r.conversationId, run_id: r.runId, status: r.status, sources: r.sources };
  });

  // --- Memory ---
  app.post('/v1/memory', async (req, reply) => {
    const content = clip(req.body?.content, 1000).trim();
    if (!content) return reply.code(400).send({ error: 'content is required.' });
    const kind = req.body?.kind === 'core' ? 'core' : 'archival';
    const agent = await ensureDefaultAgent(req.apiKey.tenantId);
    await withTenant(req.apiKey.tenantId, async (c) => {
      await c.query("INSERT INTO memories (tenant_id, agent_id, kind, content) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3)", [agent.id, kind, content]);
      await audit(c, req.apiKey.tenantId, 'api', 'memory.saved', { kind });
    });
    return { saved: true, kind };
  });

  app.get('/v1/memory', async (req) => {
    const q = clip(req.query?.query || '', 200);
    const rows = await withTenant(req.apiKey.tenantId, (c) => q
      ? c.query("SELECT kind, content, created_at FROM memories WHERE tsv @@ plainto_tsquery('english',$1) OR content ILIKE '%' || $2 || '%' ORDER BY created_at DESC LIMIT 20", [q, q.replace(/[%_]/g, '')]).then((r) => r.rows)
      : c.query('SELECT kind, content, created_at FROM memories ORDER BY created_at DESC LIMIT 20').then((r) => r.rows));
    return { memories: rows };
  });

  // --- Scheduled tasks ---
  app.get('/v1/tasks', async (req) => {
    const tasks = await withTenant(req.apiKey.tenantId, (c) => c.query('SELECT id, title, instruction, interval_minutes, next_run_at, status, last_run_at FROM tasks ORDER BY created_at DESC LIMIT 50').then((r) => r.rows));
    return { tasks };
  });

  app.post('/v1/tasks', async (req, reply) => {
    const title = clip(req.body?.title, 120).trim(), instruction = clip(req.body?.instruction, 2000).trim();
    if (!title || !instruction) return reply.code(400).send({ error: 'title and instruction are required.' });
    const every = req.body?.every_minutes == null ? null : Math.max(60, Math.min(60 * 24 * 30, Number(req.body.every_minutes) || 60));
    const inMin = Math.max(1, Math.min(60 * 24 * 365, Number(req.body?.run_in_minutes ?? every ?? 60) || 60));
    const agent = await ensureDefaultAgent(req.apiKey.tenantId);
    const r = await withTenant(req.apiKey.tenantId, async (c) => {
      if ((await c.query("SELECT count(*)::int n FROM tasks WHERE status='active'")).rows[0].n >= 10) return null;
      const row = (await c.query(
        "INSERT INTO tasks (tenant_id, agent_id, title, instruction, interval_minutes, next_run_at, created_by) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3,$4, now() + ($5 || ' minutes')::interval, 'api') RETURNING id, next_run_at",
        [agent.id, title, instruction, every, String(inMin)])).rows[0];
      await audit(c, req.apiKey.tenantId, 'api', 'task.scheduled', { task_id: row.id });
      return row;
    });
    if (!r) return reply.code(400).send({ error: 'Limit of 10 active tasks reached.' });
    return { task_id: r.id, next_run_at: r.next_run_at, every_minutes: every };
  });

  // --- Opportunity Desk: tender search and profile matches ---
  app.get('/v1/tenders', async (req) => {
    const q = clip(req.query?.query || '', 100).replace(/[%_]/g, '');
    const rows = await withTenant(req.apiKey.tenantId, (c) => q
      ? c.query(`SELECT ocid, title, buyer, closes_at, source_url FROM tenders
                 WHERE (closes_at IS NULL OR closes_at > now()) AND (title ILIKE '%'||$1||'%' OR buyer ILIKE '%'||$1||'%' OR description ILIKE '%'||$1||'%')
                 ORDER BY closes_at NULLS LAST LIMIT 20`, [q]).then((r) => r.rows)
      : c.query('SELECT ocid, title, buyer, closes_at, source_url FROM tenders WHERE closes_at IS NULL OR closes_at > now() ORDER BY closes_at NULLS LAST LIMIT 20').then((r) => r.rows));
    return { tenders: rows };
  });

  app.get('/v1/matches', async (req) => {
    const rows = await withTenant(req.apiKey.tenantId, (c) => c.query(
      `SELECT m.score, m.reasons, t.ocid, t.title, t.buyer, t.closes_at, t.source_url
       FROM matches m JOIN tenders t ON t.ocid = m.ocid WHERE m.status='new' ORDER BY m.score DESC LIMIT 20`).then((r) => r.rows));
    return { matches: rows };
  });

  app.get('/v1/tenders/export.xlsx', async (req, reply) => {
    const rows = await withTenant(req.apiKey.tenantId, (c) => c.query(
      `SELECT ocid, title, buyer, category, closes_at, source_url FROM tenders
       WHERE closes_at IS NULL OR closes_at > now() ORDER BY closes_at NULLS LAST LIMIT 5000`).then((r) => r.rows));
    const data = [['OCID', 'Title', 'Buyer', 'Category', 'Closes At', 'Source URL'],
      ...rows.map((r) => [r.ocid, r.title, r.buyer, r.category, r.closes_at ? r.closes_at.toISOString() : '', r.source_url])];
    return reply.header('content-type', XLSX_MIME)
      .header('content-disposition', `attachment; filename="hi-tenders-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .send(buildXlsx([{ name: 'Tenders', rows: data }]));
  });

  app.get('/v1/matches/export.xlsx', async (req, reply) => {
    const rows = await withTenant(req.apiKey.tenantId, (c) => c.query(
      `SELECT t.title, t.tender_no, t.buyer, t.category, m.status, m.score, m.reasons, t.closes_at, t.source_url
       FROM matches m JOIN tenders t USING (ocid) ORDER BY m.score DESC, t.closes_at NULLS LAST LIMIT 5000`).then((r) => r.rows));
    const data = [['Title', 'Tender No', 'Buyer', 'Category', 'Status', 'Score', 'Why it matched', 'Closes At', 'Source URL'],
      ...rows.map((r) => [r.title, r.tender_no, r.buyer, r.category, r.status, r.score,
        (r.reasons || []).map((x) => x.text).join('; '), r.closes_at ? r.closes_at.toISOString() : '', r.source_url])];
    return reply.header('content-type', XLSX_MIME)
      .header('content-disposition', `attachment; filename="hi-matches-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .send(buildXlsx([{ name: 'Matches', rows: data }]));
  });

  // --- Browser actions (approval-gated) ---
  app.post('/v1/browser', async (req, reply) => {
    const startUrl = String(req.body?.start_url || ''), goal = clip(req.body?.goal, 1500).trim();
    if (!startUrl || !goal) return reply.code(400).send({ error: 'start_url and goal are required.' });
    const agent = await ensureDefaultAgent(req.apiKey.tenantId);
    try {
      const r = await withTenant(req.apiKey.tenantId, (c) => proposeBrowserJob(c, { tenantId: req.apiKey.tenantId, agentId: agent.id, agentName: `api:${agent.name}`, startUrl, goal, mode: req.body?.mode, lookup }));
      if (r.error) return reply.code(400).send({ error: r.error });
      return { job_id: r.job_id, status: 'proposed', approval_required: true, note: 'The job runs only after the account owner approves it in the HI approval queue. Irreversible actions need a second approval.' };
    } catch (e) { return reply.code(400).send({ error: 'Cannot open that address: ' + clip(e.message, 80) }); }
  });

  app.get('/v1/browser/:id', async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send({ error: 'invalid job id.' });
    const j = await withTenant(req.apiKey.tenantId, (c) => c.query('SELECT id, start_url, goal, mode, status, result, created_at, finished_at FROM browser_jobs WHERE id=$1', [req.params.id]).then((r) => r.rows[0]));
    if (!j) return reply.code(404).send({ error: 'Job not found.' });
    return { job: j };
  });

  // --- Files generated by the agent ---
  app.get('/v1/files', async (req) => {
    const files = await withTenant(req.apiKey.tenantId, (c) => c.query('SELECT id, filename, mime, char_length(content) size, created_at FROM files ORDER BY created_at DESC LIMIT 50').then((r) => r.rows));
    return { files };
  });

  app.get('/v1/files/:id', async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send({ error: 'invalid file id.' });
    const f = await withTenant(req.apiKey.tenantId, (c) => c.query('SELECT id, filename, mime, content, created_at FROM files WHERE id=$1', [req.params.id]).then((r) => r.rows[0]));
    if (!f) return reply.code(404).send({ error: 'File not found.' });
    return { file: { ...f, encoding: f.mime === XLSX_MIME ? 'base64' : 'utf8' } };
  });

  // --- Plans (multi-agent) ---
  app.post('/v1/plans', async (req, reply) => {
    const goal = clip(req.body?.goal, 1500).trim();
    if (!goal) return reply.code(400).send({ error: 'goal is required.' });
    const agent = await ensureDefaultAgent(req.apiKey.tenantId);
    await ensureBuiltinSkills(req.apiKey.tenantId);
    const { runPlan } = await import('./planner.js');
    const r = await runPlan({ tenantId: req.apiKey.tenantId, userEmail: 'api', agentId: agent.id, goal, llm, fetchImpl, lookup, createdBy: 'api' });
    if (r.error) return reply.code(400).send({ error: r.error, plan_id: r.planId });
    return { plan_id: r.planId, status: r.status, answer: r.answer, steps: r.steps };
  });

  app.get('/v1/plans/:id', async (req, reply) => {
    if (!uuidOk(req.params.id)) return reply.code(400).send({ error: 'invalid plan id.' });
    const p = await withTenant(req.apiKey.tenantId, (c) => c.query('SELECT id, goal, status, steps, answer, created_at, finished_at FROM plans WHERE id=$1', [req.params.id]).then((r) => r.rows[0]));
    if (!p) return reply.code(404).send({ error: 'Plan not found.' });
    return { plan: p };
  });
}
