// Phone bridge: the agent can propose tasks for the customer's paired Android phone.
// Every task is a proposal first - nothing reaches the phone until the customer approves
// it in the queue, exactly like browser jobs and sends. The customer's own bridge app
// (running on their machine next to their phone) polls for approved tasks over the keyed
// API and posts results back. HI never talks to the phone directly.
import { audit } from './db.js';

export async function proposePhoneTask(c, { tenantId, agentName, instruction }) {
  const text = String(instruction || '').trim().slice(0, 800);
  if (!text) return { error: 'instruction is empty.' };
  if (/password|passcode|\bpin\b|cvv|card number|one.?time code|\botp\b/i.test(text)) return { error: 'Phone tasks cannot use passwords, card numbers or codes.' };
  const open = (await c.query("SELECT count(*)::int n FROM approvals WHERE kind='phone_task' AND status IN ('proposed','approved') AND created_at > now() - interval '1 day'")).rows[0].n;
  if (open >= Number(process.env.PHONE_MAX_TASKS_PER_TENANT_DAY || 10)) return { error: 'Daily phone task limit reached for your account.' };
  const ap = (await c.query("INSERT INTO approvals (tenant_id, kind, summary, payload, proposed_by) VALUES (current_setting('app.tenant_id')::uuid,'phone_task',$1,$2,$3) RETURNING id",
    [`Run on your paired phone: ${text.slice(0, 140)}`, JSON.stringify({ instruction: text }), `agent:${agentName}`])).rows[0];
  await audit(c, tenantId, `agent:${agentName}`, 'phone.proposed', { approval_id: ap.id });
  return { approval_id: ap.id };
}
