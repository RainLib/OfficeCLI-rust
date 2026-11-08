import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {Session} from './api.ts'
import {I18nProvider} from './i18n.tsx'
import {WordTopologyRecovery,WordTopologyOutcome,topologyMatchesExpected,topologyMatchesAction} from './WordTopologyRecovery.tsx'
import {WordCheckpointClientError} from './wordCheckpointRecoveryClient.ts'
import {wordTopologyRecovery,wordTopologyDetails,cancelUnpreparedTopology} from './wordTopologyRecoveryClient.ts'
const session:Session={documentId:'doc',token:'private',userId:'alice',scope:'write',format:'docx',collabUrl:'wss://collab.example',collaborationEpoch:2,collaborationProtocol:'hcd-word-regions/2'},id='a'.repeat(32),signal=()=>new AbortController().signal
test('inspects a topology request and resumes only its exact reviewed ID',async()=>{
 const old=globalThis.fetch,calls:unknown[]=[];try{globalThis.fetch=async(url,init)=>{assert.match(String(url),/word-topology-recovery$/);calls.push(JSON.parse(String(init?.body)));return Response.json({transactionId:id,kind:'story',baseRevision:2,revision:calls.length===1?2:3,status:calls.length===1?'pending':'confirmed'})};assert.equal((await wordTopologyRecovery(session,'inspect',signal())).kind,'story');assert.equal((await wordTopologyRecovery(session,'resume',signal(),id)).revision,3);assert.deepEqual(calls,[{operation:'inspect',epoch:2},{operation:'resume',epoch:2,transactionId:id}])}finally{globalThis.fetch=old}
})
test('unverified replies or failures after dispatch stay uncertain',async()=>{
 const old=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({transactionId:id,kind:'layout',baseRevision:2,revision:3,status:'pending'});await assert.rejects(wordTopologyRecovery(session,'resume',signal(),id),e=>e instanceof WordCheckpointClientError&&e.uncertain);globalThis.fetch=async()=>new Response('',{status:403});await assert.rejects(wordTopologyRecovery(session,'resume',signal(),id),e=>e instanceof WordCheckpointClientError&&e.uncertain);await assert.rejects(wordTopologyRecovery({...session,scope:'read'},'resume',signal(),id),e=>e instanceof WordCheckpointClientError&&!e.uncertain)}finally{globalThis.fetch=old}
})
test('compatibility view requires an explicit check',()=>{const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordTopologyRecovery,{session})}));assert.match(html,/检查待确认的更改/);assert.doesNotMatch(html,/确认并核对更改/)})
test('change details paginate and reject a mismatched transaction or malformed values',async()=>{
 const old=globalThis.fetch,review={transactionId:id,kind:'layout' as const,baseRevision:2,revision:2,status:'pending' as const};let malicious=false
 try{globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.transactionId,id);return Response.json({transactionId:malicious?'b'.repeat(32):id,kind:'layout',offset:body.offset,total:21,changes:Array.from({length:body.offset===0?20:1},(_,index)=>({section:body.offset+index+1,field:'widthTwips',before:12000,after:12240}))})};assert.equal((await wordTopologyDetails(session,review,0,signal())).changes.length,20);assert.equal((await wordTopologyDetails(session,review,20,signal())).changes.length,1);malicious=true;await assert.rejects(wordTopologyDetails(session,review,0,signal()));await assert.rejects(wordTopologyDetails(session,review,1,signal()))}finally{globalThis.fetch=old}
})

test('an older topology receipt cannot stand in for the uncertain transaction',()=>{
 const review={transactionId:'a'.repeat(32),kind:'layout' as const,baseRevision:7,revision:8,status:'confirmed' as const}
 assert.equal(topologyMatchesExpected(review,'b'.repeat(32)),false);assert.equal(topologyMatchesExpected(review,'a'.repeat(32)),true);assert.equal(topologyMatchesExpected(review,null),true)
})

test('only an exact sealed unprepared identity can clear an uncertain attempt',async()=>{
 const old=globalThis.fetch;let calls=0
 try{globalThis.fetch=async(url,init)=>{calls++;assert.match(String(url),/word-topology-cancel$/);assert.deepEqual(JSON.parse(String(init?.body)),{epoch:2,transactionId:id});return Response.json({transactionId:id,status:'not-prepared'})};assert.equal((await cancelUnpreparedTopology(session,id,signal())).status,'not-prepared');globalThis.fetch=async()=>Response.json({transactionId:'b'.repeat(32),status:'not-prepared'});await assert.rejects(cancelUnpreparedTopology(session,id,signal()));await assert.rejects(cancelUnpreparedTopology({...session,scope:'read'},id,signal()));assert.equal(calls,1)}finally{globalThis.fetch=old}
 const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordTopologyRecovery,{session,expectedTransactionId:id})}));assert.match(html,/检查并取消未准备的请求/)
})

test('link recovery requires a matching head and distinguishes historical confirmation without treating it as installation',async()=>{
 const old=globalThis.fetch;let answer:any={transactionId:id,kind:'link',baseRevision:2,revision:2,headRevision:3,status:'pending'}
 try{
  globalThis.fetch=async(_url,init)=>{assert.equal(new Headers(init?.headers).get('X-HCD-Word-Link-Version'),'1');return Response.json(answer)}
  assert.equal((await wordTopologyRecovery(session,'inspect',signal())).kind,'link')
  answer={...answer,revision:3,headRevision:4,status:'historical'};assert.equal((await wordTopologyRecovery(session,'resume',signal(),id)).status,'historical')
  for(const change of [{headRevision:3},{headRevision:2},{headRevision:undefined},{revision:2},{kind:'story'}]){
   const previous=answer;answer={...answer,...change};await assert.rejects(wordTopologyRecovery(session,'resume',signal(),id),e=>e instanceof WordCheckpointClientError&&e.uncertain);answer=previous
  }
  answer={...answer,headRevision:3,status:'confirmed'};assert.equal((await wordTopologyRecovery(session,'resume',signal(),id)).status,'confirmed')
 }finally{globalThis.fetch=old}
})
test('link details reject forged retention, invalid sources and mixed story-copy fields',async()=>{
 const old=globalThis.fetch,review={transactionId:id,kind:'link' as const,baseRevision:2,revision:2,status:'pending' as const,headRevision:2}
 const row={operation:'link',section:2,kind:'footer',variant:'default',sourceSection:1,contentChanged:true,retained:true};let change:any=row
 try{
  globalThis.fetch=async()=>Response.json({transactionId:id,kind:'link',offset:0,total:1,changes:[change]})
  assert.equal((await wordTopologyDetails(session,review,0,signal())).changes.length,1)
  for(const patch of [{retained:false},{sourceSection:2},{sourceSection:0},{contentChanged:undefined},{blockCount:2},{operation:'story'}]){change={...row,...patch};await assert.rejects(wordTopologyDetails(session,review,0,signal()))}
 }finally{globalThis.fetch=old}
})

test('topology confirmation also matches the retained kind and base revision',()=>{
 const review={transactionId:id,kind:'story' as const,baseRevision:2,revision:3,status:'confirmed' as const},action={kind:'resume' as const,baseRevision:2,topologyKind:'story' as const,body:{epoch:2,operation:'resume' as const,transactionId:id}}
 assert.equal(topologyMatchesAction(review,action),true)
 assert.equal(topologyMatchesAction({...review,kind:'layout'},action),false)
 assert.equal(topologyMatchesAction({...review,baseRevision:1},action),false)
 assert.equal(topologyMatchesAction({...review,transactionId:'b'.repeat(32)},action),false)
})


test('advancing a recovery queue never labels the next request with the previous outcome',()=>{
 const first='a'.repeat(32),second='b'.repeat(32),confirmed={transactionId:first,kind:'story' as const,baseRevision:2,revision:3,status:'confirmed' as const}
 const render=(expected:string|null,result:typeof confirmed|null,cancelled:string|null)=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordTopologyOutcome,{expectedTransactionId:expected,confirmed:result,cancelled})}))
 assert.match(render(first,confirmed,null),/版本 r3/)
 assert.equal(render(second,confirmed,null),'')
 assert.match(render(null,confirmed,null),/版本 r3/)
 assert.match(render(first,null,first),/已取消/)
 assert.equal(render(second,null,first),'')
 assert.match(render(null,null,first),/已取消/)
})
