// Multi-agent planner: the lead agent breaks a goal into steps, specialist workers
// (the same persistent agent working under a named skill) execute them one at a time,
// and the lead combines the results. Workers run through runAgent, so every tool rule,
// approval gate and budget applies to them unchanged.
import { withTenant, audit } from './db.js';
import { chat, agentModelEnabled } from './gateway.js';
import { getSkill } from './skills.js';
import { emergencyStopped } from './core.js';

const MAX_PLAN_STEPS = 4;

function parseSteps(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    return (Array.isArray(parsed.steps) ? parsed.steps : [])
      .map((s) => ({ title: String(s.title || '').slice(0, 120).trim(), instruction: String(s.instruction || '').slice(0, 1000).trim(), skill: String(s.skill || '').toLowerCase().trim() || null }))
      .filter((s) => s.title && s.instruction)
      .slice(0, MAX_PLAN_STEPS);
  } catch { return []; }
}

export async function runPlan({ tenantId, userEmail, agentId, goal, llm = chat, fetchImpl = fetch, lookup, now = new Date(), createdBy = 'user' }) {
  if (await emergencyStopped()) return { error: 'HI is paused platform-wide right now.' };
  if (!agentModelEnabled() && llm === chat) return { error: 'The AI model is not configured on this server yet.' };
  goal = String(goal || '').slice(0, 1500).trim();
  if (!goal) return { error: 'A goal is required.' };
  const { runAgent } = await import('./agent.js'); // lazy: agent.js calls back into this module for the run_plan tool

  const planId = await withTenant(tenantId, async (c) => {
    const r = (await c.query("INSERT INTO plans (tenant_id, agent_id, goal, created_by) VALUES (current_setting('app.tenant_id')::uuid,$1,$2,$3) RETURNING id", [agentId, goal, createdBy])).rows[0];
    await audit(c, tenantId, 'agent:planner', 'plan.created', { plan_id: r.id });
    return r.id;
  });

  // 1. Decompose the goal into steps, each assigned to a specialist skill.
  let steps = [];
  try {
    const skillRows = await withTenant(tenantId, (c) => c.query('SELECT name, description FROM skills WHERE enabled ORDER BY name').then((r) => r.rows));
    const sys = [
      'You are the planning brain of an AI employee platform. Break the customer goal into at most ' + MAX_PLAN_STEPS + ' concrete steps for specialist workers.',
      'Reply with JSON only, no other text: {"steps":[{"title":"short name","instruction":"exactly what the worker should do and deliver","skill":"one of the skills below or null"}]}.',
      'Available skills: ' + (skillRows.map((s) => `${s.name} (${s.description})`).join('; ') || 'none - use null'),
      'Keep steps independent enough to run one after another. Do not plan steps that send, buy, book or submit anything: workers can only draft and propose, the customer approves.',
    ].join('\n');
    const out = await llm({ messages: [{ role: 'system', content: sys }, { role: 'user', content: goal }], tools: [] });
    await withTenant(tenantId, (c) => c.query("INSERT INTO model_usage (tenant_id, provider, model, prompt_tokens, completion_tokens) VALUES (current_setting('app.tenant_id')::uuid,'agent',$1,$2,$3)", [out.model || 'unknown', out.usage?.prompt_tokens || 0, out.usage?.completion_tokens || 0]));
    steps = parseSteps(out.content);
  } catch (e) { steps = []; }
  if (!steps.length) {
    await withTenant(tenantId, (c) => c.query("UPDATE plans SET status='failed', answer='Could not break that goal into steps. Try a simpler or more specific goal.', finished_at=now() WHERE id=$1", [planId]));
    return { planId, error: 'Could not break that goal into steps. Try a simpler or more specific goal.' };
  }
  await withTenant(tenantId, (c) => c.query("UPDATE plans SET status='running', steps=$2 WHERE id=$1", [planId, JSON.stringify(steps)]));

  // 2. Execute each step with its specialist skill. Earlier results feed later steps.
  const results = [];
  for (const [i, s] of steps.entries()) {
    const skill = s.skill ? await getSkill(tenantId, s.skill) : null;
    const stepText = [
      `Step ${i + 1} of ${steps.length} for the goal: ${goal}`,
      `Your step: ${s.title}`,
      `What to do: ${s.instruction}`,
      results.length ? 'Results from earlier steps:\n' + results.map((r, j) => `${j + 1}. ${r.title}: ${String(r.answer).slice(0, 600)}`).join('\n') : '',
      'Deliver a short, concrete result for this step. Do not ask questions.',
    ].filter(Boolean).join('\n');
    const r = await runAgent({ tenantId, userEmail, agentId, conversationId: null, userText: stepText, mode: 'task', llm, fetchImpl, lookup, now, skill, depth: 1 });
    results.push({ title: s.title, skill: skill ? skill.name : null, status: r.error ? 'failed' : r.status, answer: String(r.answer || r.error || '').slice(0, 3000) });
    await withTenant(tenantId, (c) => c.query('UPDATE plans SET steps=$2 WHERE id=$1', [planId, JSON.stringify(steps.map((st, j) => ({ ...st, status: j < results.length ? results[j].status : 'pending', result: j < results.length ? results[j].answer.slice(0, 600) : null })))]));
  }

  // 3. Combine worker results into one answer.
  let answer = '';
  try {
    const out = await llm({ messages: [
      { role: 'system', content: 'You are the lead agent of an AI employee. Combine the worker results into one clear answer to the original goal. Plain short paragraphs and dash bullets. Say plainly what could not be done or verified. Never claim something was sent, bought, booked or submitted.' },
      { role: 'user', content: `Goal: ${goal}\n\nWorker results:\n${results.map((r, i) => `${i + 1}. ${r.title} [${r.status}]\n${r.answer.slice(0, 1500)}`).join('\n\n')}` },
    ], tools: [] });
    await withTenant(tenantId, (c) => c.query("INSERT INTO model_usage (tenant_id, provider, model, prompt_tokens, completion_tokens) VALUES (current_setting('app.tenant_id')::uuid,'agent',$1,$2,$3)", [out.model || 'unknown', out.usage?.prompt_tokens || 0, out.usage?.completion_tokens || 0]));
    answer = String(out.content || '').slice(0, 6000);
  } catch { answer = results.map((r, i) => `${i + 1}. ${r.title}\n${r.answer}`).join('\n\n'); }
  if (!answer) answer = 'The plan finished but produced no summary. Check the individual step results on the Plans page.';

  const failed = results.some((r) => r.status === 'failed');
  await withTenant(tenantId, async (c) => {
    await c.query("UPDATE plans SET status=$2, answer=$3, finished_at=now() WHERE id=$1", [planId, failed ? 'failed' : 'done', answer]);
    await audit(c, tenantId, 'agent:planner', 'plan.finished', { plan_id: planId, status: failed ? 'failed' : 'done', steps: results.length });
  });
  return { planId, answer, steps: results, status: failed ? 'failed' : 'done' };
}
