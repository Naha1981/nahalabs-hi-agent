import {readChatStream} from './chat-stream.js';
// Server-only free fallback. Caller owns tenant authorization and budgets.
// Never rotates around provider throttling, credential failures or policy denials.
export function freeChatEnabled(env=process.env){return env.MODEL_ENABLED!=='false'&&!!(env.GROQ_API_KEY||(env.OPENROUTER_API_KEY&&env.OPENROUTER_FREE_ONLY==='true'&&env.OPENROUTER_DATA_USE_APPROVED==='true'));}
export async function freeChat({messages,tools=[],env=process.env,fetchImpl=fetch,maxTokens=1200,jsonMode=false,onDelta}){
 if(!freeChatEnabled(env))throw new Error('AI is not available. Please try again later.');
 if(!Array.isArray(messages)||JSON.stringify(messages).length>100000||!Array.isArray(tools)||tools.length>60)throw new Error('Invalid AI request.');
 const defs=tools.map(t=>({type:'function',function:t}));
 const routes=[];
 if(env.GROQ_API_KEY)routes.push({provider:'Groq',url:'https://api.groq.com/openai/v1/chat/completions',key:env.GROQ_API_KEY,model:env.AGENT_MODEL||'openai/gpt-oss-120b'});
 if(env.OPENROUTER_API_KEY&&env.OPENROUTER_FREE_ONLY==='true'&&env.OPENROUTER_DATA_USE_APPROVED==='true')routes.push({provider:'OpenRouter',url:'https://openrouter.ai/api/v1/chat/completions',key:env.OPENROUTER_API_KEY,model:'openrouter/free'});
 const attempts=[];
 for(const r of routes){
  let res;
  try{res=await fetchImpl(r.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+r.key},body:JSON.stringify({model:r.model,messages,...(onDelta?{stream:true,stream_options:{include_usage:true}}:{}),temperature:.3,max_tokens:Math.min(1200,maxTokens),...(defs.length?{tools:defs,tool_choice:'auto'}:{}),...(jsonMode?{response_format:{type:'json_object'}}:{}),...(r.provider==='OpenRouter'?{provider:{max_price:{prompt:0,completion:0},require_parameters:true,data_collection:'deny',zdr:true},reasoning:{exclude:true}}:{store:false})}),signal:AbortSignal.timeout(20000)})}catch{attempts.push({provider:r.provider,status:'unavailable'});continue}
  if(res.status===429){const e=new Error('model http 429');e.retryAfter=Math.min(3600,Math.max(1,Number(res.headers.get('retry-after'))||60));throw e;}
  if([400,401,403,413].includes(res.status))throw new Error('AI request is unavailable. Please try again later.');
  if(!res.ok){attempts.push({provider:r.provider,status:res.status});continue}
  let j;try{j=onDelta?await readChatStream(res,onDelta):await res.json()}catch{if(onDelta)throw new Error('Reply stream interrupted. Your message is saved.');attempts.push({provider:r.provider,status:'invalid'});continue}
  const choice=j.choices?.[0],m=choice?.message;
  if(!m||!['stop','tool_calls'].includes(choice.finish_reason)){attempts.push({provider:r.provider,status:'incomplete'});continue}
  const calls=[];let invalid=false;
  for(const t of m.tool_calls||[]){let args;try{args=JSON.parse(t.function?.arguments||'{}')}catch{invalid=true;break}if(!t.id||!tools.some(x=>x.name===t.function?.name)||!args||typeof args!=='object'||Array.isArray(args)){invalid=true;break}calls.push({id:t.id,name:t.function.name,args})}
  if(invalid||(!String(m.content||'').trim()&&!calls.length)){attempts.push({provider:r.provider,status:'invalid'});continue}
  if(jsonMode){try{JSON.parse(m.content)}catch{attempts.push({provider:r.provider,status:'invalid-json'});continue}}
  return{content:m.content||'',tool_calls:calls,usage:j.usage,model:r.model,provider:r.provider,attempts};
 }
 throw new Error('AI is temporarily unavailable. Please try again later.');
}
