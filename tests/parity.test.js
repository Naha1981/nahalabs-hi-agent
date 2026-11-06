import test from 'node:test';import assert from 'node:assert/strict';
import {startDb} from './helpers.js';import {buildApp} from '../src/server.js';import {withTenant,withSystem} from '../src/db.js';
import {deckJson,buildPptx,PPTX_MIME} from '../src/pptx.js';import {saveFile} from '../src/files.js';
import {teamMembers,groupRound,mentionMembers} from '../src/team-workspace.js';import {runAgent} from '../src/agent.js';
process.env.SESSION_SECRET='local-parity-tests-session-secret';process.env.SIGNUP_RATE_MAX='100';
const H={'content-type':'application/x-www-form-urlencoded'},form=x=>new URLSearchParams(x).toString();
let db,app,cookie,tid;
const seen=[];
const llm=async({messages})=>{seen.push(messages);return{content:'PARITY_STUB_ANSWER',tool_calls:[],model:'labelled-test-double',usage:{prompt_tokens:1,completion_tokens:1}};};
test.before(async()=>{
 db=await startDb(54642);app=await buildApp({llm});
 await app.inject({method:'POST',url:'/signup',headers:H,payload:form({company:'Parity QA',email:'parity@example.test',password:'synthetic-local-only-password-9'})});
 const r=await app.inject({method:'POST',url:'/login',headers:H,payload:form({email:'parity@example.test',password:'synthetic-local-only-password-9'})});
 cookie=r.headers['set-cookie'].toString().split(';')[0];
 tid=(await withSystem(c=>c.query('SELECT tenant_id FROM users WHERE email=$1',['parity@example.test']))).rows[0].tenant_id;
 await app.inject({url:'/app/agent',headers:{cookie}}); // seeds the default agent
});
test.after(async()=>{await app.close();await db.stop();});

test('pptx: outline validation and a genuine PPTX container',async()=>{
 assert.match(deckJson('not json').error,/must be JSON/);
 assert.match(deckJson('{"slides":[]}').error,/at least one slide/);
 assert.equal(deckJson(JSON.stringify({slides:[{heading:'x'.repeat(500),bullets:['a']}]})).deck.slides[0].heading.length,120);
 const d=deckJson(JSON.stringify({title:'Launch plan',slides:[{heading:'Steps',bullets:['one','two']}]}));
 const buf=await buildPptx(d.deck);
 assert.equal(buf.slice(0,2).toString(),'PK');
 assert.ok(buf.length>5000);
});

test('pptx: saved file downloads as a real attachment',async()=>{
 const agent=(await withTenant(tid,c=>c.query('SELECT id FROM agents LIMIT 1'))).rows[0];
 const saved=await withTenant(tid,c=>saveFile(c,{tenantId:tid,agentId:agent.id,filename:'qa deck',format:'pptx',content:JSON.stringify({title:'QA Deck',slides:[{heading:'S1',bullets:['b1']}]}),actor:'agent:HI'}));
 assert.ok(saved.id);assert.ok(saved.filename.endsWith('.pptx'));
 const dl=await app.inject({url:'/app/files/'+saved.id+'/download',headers:{cookie}});
 assert.equal(dl.statusCode,200);
 assert.equal(dl.headers['content-type'],PPTX_MIME);
 assert.match(dl.headers['content-disposition'],/attachment; filename="qa deck.pptx"/);
 assert.equal(dl.rawPayload.slice(0,2).toString(),'PK');
});

test('legal pages are public, branded HI, and free of the retired name',async()=>{
 for(const path of ['/privacy','/terms']){
  const r=await app.inject({url:path});
  assert.equal(r.statusCode,200);
  assert.match(r.body,/NahaLabs \(Pty\) Ltd/);
  assert.match(r.body,/ai-solutions@nahalabs.co.za/);
  assert.doesNotMatch(r.body,/grokbot|maitis/i);
 }
 const home=await app.inject({url:'/'});
 assert.match(home.body,/href="\/privacy"/);
 assert.match(home.body,/href="\/terms"/);
 assert.doesNotMatch(home.body,/NahaMind/i);
});

test('chat modes reach the system prompt; unknown modes fall back to normal',async()=>{
 const agent=(await withTenant(tid,c=>c.query('SELECT id FROM agents LIMIT 1'))).rows[0];
 for(const mode of ['fast','think','fun']){
  seen.length=0;
  const r=await runAgent({tenantId:tid,userEmail:'parity@example.test',agentId:agent.id,userText:'Say hi',llm,chatMode:mode});
  assert.equal(r.status,'done');
  const label=mode==='fast'?'Fast mode':mode==='think'?'Think mode':'Fun mode';
  assert.match(seen[0][0].content,new RegExp(label));
 }
 seen.length=0;
 await runAgent({tenantId:tid,userEmail:'parity@example.test',agentId:agent.id,userText:'Say hi',llm,chatMode:'bogus'});
 assert.doesNotMatch(seen[0][0].content,/Fast mode|Think mode|Fun mode/);
});

test('@Name addressing restricts the team round to mentioned teammates',async()=>{
 const members=await teamMembers(tid);
 const coder=members.find(m=>m.name==='Coder'),chief=members.find(m=>m.name==='Chief of Staff');
 assert.deepEqual(mentionMembers('hey @coder look at this',members),[coder.id]);
 assert.deepEqual(mentionMembers('@Chief of Staff please',members),[chief.id]);
 assert.deepEqual(mentionMembers('no mention here',members),[]);
 seen.length=0;
 const r=await groupRound({tenantId:tid,userText:'@Coder review this plan please',memberIds:members.map(m=>m.id),llm});
 assert.equal(r.status,'done');
 assert.equal(seen.length,1);
 assert.match(seen[0][0].content,/You are Coder/);
 const saved=await withTenant(tid,c=>c.query("SELECT steps FROM messages WHERE conversation_id=$1 AND role='system'",[r.conversationId]));
 assert.deepEqual(saved.rows[0].steps[0].members,[coder.id]);
});
test('pages: create, edit, delete, tenant-isolated',async()=>{
 const page=await app.inject({url:'/app/pages',headers:{cookie}});
 assert.match(page.body,/Notes and working documents/);
 const csrf=/name="csrf" value="([^"]+)"/.exec(page.body)[1];
 const c=await app.inject({method:'POST',url:'/app/pages',headers:{...H,cookie},payload:form({csrf,title:'QA Note',body:'first version'})});
 assert.equal(c.statusCode,302);
 let rows=await withTenant(tid,c=>c.query("SELECT id FROM pages WHERE title='QA Note'"));
 assert.equal(rows.rowCount,1);
 const id=rows.rows[0].id;
 await app.inject({method:'POST',url:'/app/pages/'+id+'/update',headers:{...H,cookie},payload:form({csrf,title:'QA Note',body:'second version'})});
 rows=await withTenant(tid,c=>c.query('SELECT body FROM pages WHERE id=$1',[id]));
 assert.equal(rows.rows[0].body,'second version');
 const listed=await app.inject({url:'/app/pages',headers:{cookie}});
 assert.match(listed.body,/second version/);
 await app.inject({method:'POST',url:'/app/pages/'+id+'/delete',headers:{...H,cookie},payload:form({csrf})});
 rows=await withTenant(tid,c=>c.query('SELECT id FROM pages WHERE id=$1',[id]));
 assert.equal(rows.rowCount,0);
});

test('proactive routine: per-tenant seed, stranger never sees another tenant\'s data',async()=>{
 const email2='stranger-b@example.test';
 await app.inject({method:'POST',url:'/signup',headers:H,payload:form({company:'Stranger B',email:email2,password:'synthetic-local-only-password-9'})});
 const tidB=(await withSystem(c=>c.query('SELECT tenant_id FROM users WHERE email=$1',[email2]))).rows[0].tenant_id;
 const {ensureDefaultAgent,runDueTasks}=await import('../src/agent.js');
 await ensureDefaultAgent(tid);await ensureDefaultAgent(tidB);
 await withTenant(tid,c=>c.query("INSERT INTO memory_notes(tenant_id,kind,subject,detail) VALUES(current_setting('app.tenant_id')::uuid,'core','PRIVATE_A_MARKER','owner secret')"));
 const tA=await withTenant(tid,c=>c.query("SELECT id FROM tasks WHERE created_by='system' AND title='Proactive check'"));
 const tB=await withTenant(tidB,c=>c.query("SELECT id FROM tasks WHERE created_by='system' AND title='Proactive check'"));
 assert.equal(tA.rowCount,1);assert.equal(tB.rowCount,1);
 assert.notEqual(tA.rows[0].id,tB.rows[0].id);
 await withTenant(tidB,c=>c.query("UPDATE tasks SET next_run_at=now()-interval '1 minute' WHERE id=$1",[tB.rows[0].id]));
 seen.length=0;
 await runDueTasks({llm});
 assert.doesNotMatch(JSON.stringify(seen),/PRIVATE_A_MARKER/);
 const runs=await withTenant(tidB,c=>c.query('SELECT count(*)::int n FROM runs WHERE task_id=$1',[tB.rows[0].id]));
 assert.equal(runs.rows[0].n,1);
});
