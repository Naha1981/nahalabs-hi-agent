// Progressive enhancement: ordinary forms keep working without JavaScript.
(() => {
 const form = document.querySelector('#compose'); if (!form || !window.ReadableStream) return;
 const textarea = form.querySelector('textarea');
 document.querySelectorAll('[data-starter]').forEach(button => button.addEventListener('click', () => { textarea.value = button.dataset.starter; textarea.focus(); }));
 textarea.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(min-width: 900px)').matches) { e.preventDefault(); form.requestSubmit(); } });
 form.addEventListener('submit', async e => {
  e.preventDefault(); if (form.dataset.busy || !form.reportValidity()) return;
  const text = textarea.value.trim(); if (!text) return;
  form.dataset.busy = 'true'; const button = form.querySelector('button[type=submit]'); button.disabled = true;
  const thread = document.querySelector('#thread'); const empty = document.querySelector('.work-empty'); if (empty) empty.hidden = true;
  const turn = (who, label, text) => { const el = document.createElement('div'); el.className = 'turn ' + who; const name = document.createElement('div'); name.className='who'; name.textContent=label; const bubble=document.createElement('div'); bubble.className='bub'; bubble.textContent=text; el.append(name,bubble);thread.append(el);return bubble; };
  turn('me','You',text);const answer = turn('hi','HI',''); const status=document.querySelector('#chat-status');status.textContent='Working on your request';
  let redirecting=false;
  try {
   const response = await fetch(form.action, {method:'POST', headers:{Accept:'application/x-ndjson'}, body:new URLSearchParams(new FormData(form))});
   if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('Could not save your message. Check your connection or sign in again.');
   const reader=response.body.getReader(),decoder=new TextDecoder(); let buffer='',doneEvent=false;
   while (true) {
    const {done,value}=await reader.read(); if(done)break; buffer+=decoder.decode(value,{stream:true});
    let end;while((end=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const event=JSON.parse(line);
     if(event.type==='delta'){answer.textContent+=event.text;status.textContent='Replying';}
     if(event.type==='progress'){answer.textContent='';status.textContent=event.text;}
     if(event.type==='error')throw new Error(event.text);
     if(event.type==='done'){doneEvent=true;redirecting=true;textarea.value='';location.assign(event.url);}
    }
   }
   if(!doneEvent)throw new Error('The connection ended before confirmation. Check History before trying again.');
  } catch(error) { status.textContent=error.message; answer.textContent=answer.textContent || 'The reply could not finish. Your draft is still in the message box.'; }
  finally { if(!redirecting){delete form.dataset.busy;button.disabled=false;} }
 });
})();
