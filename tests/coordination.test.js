import test from 'node:test';
import assert from 'node:assert/strict';
import {startDb} from './helpers.js';
import {buildApp} from '../src/server.js';
import {withSystem,withTenant} from '../src/db.js';
import {ensureDefaultAgent} from '../src/agent.js';
import {runPlan} from '../src/planner.js';
process.env.SESSION_SECRET='coordination-isolated-test-session';process.env.HI_INVITE_CODES='coordination-test';process.env.SIGNUP_RATE_MAX='100';
let db,app;
test.before(async()=>{db=await startDb(54638);app=await buildApp({llm:async()=>({content:'test'})});});
test.after(async()=>{await app.close();await db.stop();});
test('real user signup and real private worker transport, persisted tenant results',async()=>{
 const headers={'content-type':'application/x-www-form-urlencoded'};
 const email='coordination@example.test';
 const r=await app.inject({method:'POST',url:'/signup',headers,payload:new URLSearchParams({invite:'coordination-test',company:'Isolated transport QA',email,password:'isolated-qa-only-password-9'}).toString()});assert.equal(r.statusCode,302);
 const tid=(await withSystem(c=>c.query('SELECT tenant_id FROM users WHERE email=$1',[email]))).rows[0].tenant_id;
 const agent=await ensureDefaultAgent(tid);let calls=0;
 const llm=async({messages})=>{
 calls++;
 if(calls===1)return{content:JSON.stringify({steps:[{title:'Research',instruction:'Return the QA marker FIRST_WORKER_ONLY'},{title:'Writer',instruction:'Use the research marker in a draft'}]})};
 if(calls===2)return{content:'FIRST_WORKER_ONLY research result'};
 if(calls===3){assert.match(JSON.stringify(messages),/FIRST_WORKER_ONLY/);return{content:'Second worker draft based on FIRST_WORKER_ONLY'};}
 assert.match(JSON.stringify(messages),/Second worker draft/);return{content:'Combined QA report. Nothing sent.'};
 };
 const out=await runPlan({tenantId:tid,userEmail:email,agentId:agent.id,goal:'Prepare a draft report, no sending',llm});
 assert.equal(out.coordination,'private-room');assert.equal(out.status,'done');assert.equal(out.steps.length,2);
 const saved=await withTenant(tid,c=>c.query('SELECT answer,steps FROM plans WHERE id=$1',[out.planId]));assert.match(saved.rows[0].answer,/Nothing sent/);assert.match(JSON.stringify(saved.rows[0].steps),/FIRST_WORKER_ONLY/);
});
