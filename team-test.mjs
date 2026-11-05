import test from 'node:test';
import assert from 'node:assert/strict';
import {openTeamRoom} from './coordination/room.mjs';
test('real room routes threads, isolation, authority boundaries and cleanup',async()=>{
 const a=await openTeamRoom({lead:'Lead',worker:'Writer'}),b=await openTeamRoom({lead:'Lead',worker:'Writer'});
 try{
 const root=await a.send('lead','Draft only. No send permission.');
 assert.equal((await a.read('worker')).messages[0].text,'Draft only. No send permission.');
 const sent=await a.send('worker','<script>untrusted</script>',root.id);
 const m=(await a.read('lead')).messages.at(-1);
 assert.equal(m.replyTo,root.id);assert.equal(m.id,sent.id);assert.equal(m.text,'<script>untrusted</script>');
 assert.deepEqual((await b.read('worker')).messages,[]);
 await assert.rejects(a.send('outsider','cannot impersonate'));
 }finally{await a.close();await b.close();}
 await assert.rejects(a.read('lead'));
});
