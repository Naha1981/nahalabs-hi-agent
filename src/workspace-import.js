// Explicit selected-work import. No tokens, passwords, connections or active schedules.
import {createHash} from 'node:crypto';
import {withTenant,audit} from './db.js';
export function inspectWorkspace(raw){
 if(typeof raw==='string'){if(raw.length>60000)throw Error('Export is too large. Import a smaller selection.');raw=JSON.parse(raw);}
 if(!raw||raw.format!=='nahamind-selected-work-v1')throw Error('Use a selected-work export.');
 const data={bots:[],skills:[],chats:[]};
 for(const b of (Array.isArray(raw.bots)?raw.bots:[]).slice(0,10)){const name=String(b.name||'').trim().slice(0,40),persona=String(b.job||b.role||'').trim().slice(0,500);if(name&&persona)data.bots.push({name,persona});}
 for(const s of (Array.isArray(raw.skills)?raw.skills:[]).slice(0,10)){const name=String(s.name||'').toLowerCase().replace(/[^a-z0-9-]+/g,'-').slice(0,36),task=String(s.task||'').slice(0,1800);if(name.length>1&&task.length>=20)data.skills.push({name,task});}
 for(const c of (Array.isArray(raw.chats)?raw.chats:[]).slice(0,10)){const messages=[];for(const m of (c.messages||[]).slice(-60)){if(m.role==='groupchat'){for(const t of (m.thread||[]).slice(-30))messages.push({role:t.from==='You'?'user':'assistant',text:(t.from==='You'?'':String(t.from).slice(0,60)+': ')+String(t.text||'').slice(0,4000)});}else if(['user','assistant'].includes(m.role)&&typeof(m.text||m.content)==='string')messages.push({role:m.role,text:String(m.text||m.content).slice(0,4000)});}if(messages.length)data.chats.push({title:String(c.title||'Imported chat').slice(0,60),messages});}
 const bytes=JSON.stringify(data);if(bytes.length>60000)throw Error('Export is too large. Import a smaller selection.');
 return{...data,hash:createHash('sha256').update(bytes).digest('hex')};
}
export async function importWorkspace(tenantId,raw){const data=inspectWorkspace(raw);return withTenant(tenantId,async c=>{
 await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[tenantId]);
 const old=await c.query("SELECT id FROM memory_notes WHERE kind='workspace_import' AND subject=$1",[data.hash]);if(old.rowCount)return{duplicate:true};
 const total=(await c.query('SELECT count(*)::int n FROM agents')).rows[0].n;if(total+data.bots.length>20)throw Error('Team limit reached. Import fewer teammates.');
 let agent=(await c.query("SELECT id FROM agents WHERE name='HI' ORDER BY created_at LIMIT 1")).rows[0];if(!agent)agent=(await c.query("INSERT INTO agents(tenant_id,name,persona) VALUES(current_setting('app.tenant_id')::uuid,'HI','Your AI employee') RETURNING id")).rows[0];
 for(const b of data.bots)await c.query("INSERT INTO agents(tenant_id,name,persona) VALUES(current_setting('app.tenant_id')::uuid,$1,$2) ON CONFLICT(tenant_id,name) DO NOTHING",[b.name,b.persona]);
 if((await c.query('SELECT count(*)::int n FROM skills')).rows[0].n+data.skills.length>20)throw Error('Skill limit reached. Import fewer skills.');
 for(const s of data.skills)await c.query("INSERT INTO skills(tenant_id,name,description,instructions,tools) VALUES(current_setting('app.tenant_id')::uuid,$1,'Imported draft workflow',$2,'[\"recall\",\"create_file\"]') ON CONFLICT(tenant_id,name) DO NOTHING",['import-'+s.name,s.task]);
 for(const x of data.chats){const conv=(await c.query("INSERT INTO conversations(tenant_id,agent_id,title) VALUES(current_setting('app.tenant_id')::uuid,$1,$2) RETURNING id",[agent.id,'Imported: '+x.title])).rows[0];for(const m of x.messages)await c.query("INSERT INTO messages(tenant_id,conversation_id,role,content) VALUES(current_setting('app.tenant_id')::uuid,$1,$2,$3)",[conv.id,m.role,m.text]);}
 await c.query("INSERT INTO memory_notes(tenant_id,kind,subject,detail) VALUES(current_setting('app.tenant_id')::uuid,'workspace_import',$1,'Selected-work import; no credentials or active schedules')",[data.hash]);await audit(c,tenantId,'user','workspace.import',{bots:data.bots.length,skills:data.skills.length,chats:data.chats.length});return{bots:data.bots.length,skills:data.skills.length,chats:data.chats.length};
 });}
