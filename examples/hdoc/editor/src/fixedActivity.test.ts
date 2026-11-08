import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFixedActivity} from './fixedActivity.ts'
const session={documentId:'fixed-doc',format:'pptx',scope:'read' as const,token:'local-fixture-token',apiUrl:'http://localhost/v1/documents'},id='n_'+'a'.repeat(32)
test('cross-page activity reads the authenticated immutable node, bounds Unicode preview and rejects mixed scopes',async()=>{
 const saved=globalThis.fetch;let calls=0
 try{globalThis.fetch=async(url,init)=>{calls++;assert.equal(String(url),`http://localhost/v1/documents/fixed-doc/text/${id}?revision=7`);assert.equal((init!.headers as Record<string,string>).Authorization,'Bearer local-fixture-token');assert.equal(init?.method,undefined);return Response.json({documentId:'fixed-doc',revision:7,nodeId:id,text:'😀'.repeat(80)})};assert.equal(Array.from(await readFixedActivity(session,7,id,new AbortController().signal)).length,64)
 for(const patch of [{documentId:'other'},{revision:8},{nodeId:'b'.repeat(32)}]){globalThis.fetch=async()=>Response.json({documentId:'fixed-doc',revision:7,nodeId:id,text:'not displayed',...patch});await assert.rejects(readFixedActivity(session,7,id,new AbortController().signal),/fixedActivityInvalid/)}
 const before=calls;await assert.rejects(readFixedActivity(session,7,'../invalid',new AbortController().signal));assert.equal(calls,before)
 }finally{globalThis.fetch=saved}
})
test('a late activity response cannot escape cancellation or stale-session cleanup',async()=>{const saved=globalThis.fetch,controller=new AbortController();let finish!:((value:Response)=>void);try{globalThis.fetch=()=>new Promise(resolve=>finish=resolve);const request=readFixedActivity(session,7,id,controller.signal);controller.abort();finish(Response.json({documentId:'fixed-doc',revision:7,nodeId:id,text:'late'}));await assert.rejects(request)}finally{globalThis.fetch=saved}})
