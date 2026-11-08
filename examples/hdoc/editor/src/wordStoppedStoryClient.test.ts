import {test} from 'node:test'
import assert from 'node:assert/strict'
import {previewStoppedStory,applyStoppedStory} from './wordStoppedStoryClient.ts'
const session={documentId:'doc',token:'token',userId:'alice',scope:'write' as const,format:'docx',collabUrl:'ws://localhost:8090',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2' as const}
const selection={sectionId:`n_${'1'.repeat(32)}`,kind:'footer' as const,variant:'even' as const,transactionId:'2'.repeat(32)}
const review={revision:1,reviewHash:'a'.repeat(64),transactionId:selection.transactionId,section:2,kind:selection.kind,variant:selection.variant,inherited:false,affectedSections:1,blockCount:1}
test('story review binds the confirmed selection and transaction identity',async()=>{
 const old=globalThis.fetch,calls:any[]=[];globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));calls.push(body);return Response.json(body.operation==='preview'?review:{revision:2,transactionId:body.transactionId})}
 try{const signal=new AbortController().signal,actual=await previewStoppedStory(session,selection,signal);let started='';assert.deepEqual(await applyStoppedStory(session,selection,actual,signal,async action=>{started=action.body.transactionId}),{revision:2,transactionId:selection.transactionId});assert.equal(started,selection.transactionId);assert.equal(calls[1].reviewHash,review.reviewHash);await assert.rejects(applyStoppedStory(session,{...selection,kind:'header'},review,signal,async()=>{}),/stale/);assert.equal(calls.length,2)}finally{globalThis.fetch=old}
})
test('story dispatch cannot pass failed storage or an aborted durable preparation',async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected request')}
 try{const controller=new AbortController();await assert.rejects(applyStoppedStory(session,selection,review,controller.signal,async action=>{assert.equal(action.section,2);assert.equal(action.body.reviewHash,review.reviewHash);controller.abort()}));await assert.rejects(applyStoppedStory(session,selection,review,new AbortController().signal,async()=>{throw Error('quota')}),/quota/);assert.equal(calls,0)}finally{globalThis.fetch=old}
})
test('readers and forged story confirmations cannot report success',async()=>{
 const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({...review,transactionId:'3'.repeat(32)})}
 try{const signal=new AbortController().signal;await assert.rejects(previewStoppedStory({...session,scope:'read'},selection,signal));assert.equal(calls,0);await assert.rejects(previewStoppedStory(session,selection,signal),/invalid/)}finally{globalThis.fetch=old}
})
test('a dirty inherited source exposes a save-draft instruction without trusting other error bodies',async()=>{
 const old=globalThis.fetch
 try{globalThis.fetch=async()=>Response.json({code:'word-story-source-draft-pending'},{status:409});await assert.rejects(previewStoppedStory(session,selection,new AbortController().signal),/word-story-source-draft-pending/);globalThis.fetch=async()=>Response.json({code:'word-story-source-unsupported'},{status:409});await assert.rejects(previewStoppedStory(session,selection,new AbortController().signal),/word-story-source-unsupported/);globalThis.fetch=async()=>Response.json({code:'attacker-supplied'},{status:409});await assert.rejects(previewStoppedStory(session,selection,new AbortController().signal),/word-story-unavailable/)}finally{globalThis.fetch=old}
})
