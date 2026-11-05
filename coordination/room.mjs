import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
let active = 0;
export async function openTeamRoom(actors) {
  if (active >= 4) throw Error('The team is busy. Try again shortly.');
  active++;
  const child = spawn(process.env.COORDINATION_PYTHON || 'python3', [new URL('./bridge.py', import.meta.url).pathname], { stdio: ['pipe','pipe','pipe'] });
  const pending = []; let closed = false;
  const fail = () => { for (const p of pending.splice(0)) { clearTimeout(p.timer); p.reject(Error('Team coordination is unavailable.')); } };
  child.on('error', fail); child.on('exit', fail); child.stderr.resume();
  createInterface({input:child.stdout}).on('line', line => {
    const p = pending.shift(); if (!p) return;
    clearTimeout(p.timer);
    try { const j = JSON.parse(line); if(j.error) throw Error(j.error); p.resolve(j); } catch { p.reject(Error('Team coordination is unavailable.')); }
  });
  const call = p => new Promise((resolve,reject) => {
    if(closed) return reject(Error('This team job has ended.'));
    const entry = {resolve,reject,timer:setTimeout(()=>{reject(Error('Team coordination timed out.'));child.kill();},10000)};
    pending.push(entry); child.stdin.write(JSON.stringify(p)+'\n');
  });
  const close = async () => { if(closed) return; try {await call({op:'close'});} catch {} finally { closed=true; active--; child.stdin.end(); setTimeout(()=>child.kill(),1000).unref(); } };
  try {await call({op:'init',actors});} catch(e) {await close();throw e;}
  return {send:(actor,text,replyTo)=>call({op:'send',actor,text:String(text).slice(0,18000),replyTo}),read:actor=>call({op:'read',actor}),close};
}

let health;
export function teamHealth() {
  if(!health) health=(async()=>{const r=await openTeamRoom({lead:'Lead',worker:'Worker'});try{await r.send('lead','readiness');const out=await r.read('worker');return out.messages.at(-1)?.text==='readiness';}finally{await r.close();}})().catch(()=>false);
  return health;
}
