export function mailConfigured() { return !!process.env.RESEND_API_KEY && !!process.env.MAIL_FROM; }

export async function sendMail({ to, subject, text, fetchImpl = fetch }) {
  if (!mailConfigured()) throw new Error('email sending is not configured');
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`mail provider ${res.status}: ${String(j.message || j.name || '').slice(0, 120)}`);
  return j.id || null;
}
