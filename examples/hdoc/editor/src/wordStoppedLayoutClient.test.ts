import test from 'node:test'
import assert from 'node:assert/strict'
import {inspectStoppedLayout,stoppedLayoutSubmit} from './wordStoppedLayoutClient.ts'
import type {Session} from './api.ts'
const session={documentId:'doc',token:'token',userId:'alice',scope:'write',format:'docx',collabUrl:'ws://localhost:1234',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'} as Session
const snapshot={revision:1,layoutHash:'a'.repeat(64),reviewHash:'b'.repeat(64),layout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,stories:[],sections:[{id:`n_${'1'.repeat(32)}`,differentFirstPage:false,page:{},headers:{},footers:{}}]}}
test('stopped page requests bind the reviewed draft and verify the exact transaction receipt',async()=>{
 const original=globalThis.fetch,calls:any[]=[]
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));calls.push(body);return Response.json(body.operation==='inspect'?snapshot:{transactionId:body.transactionId,revision:2})}
 try{const signal=new AbortController().signal,value=await inspectStoppedLayout(session,signal),intent={schemaVersion:'hcd-word-layout-edits/1' as const,baseLayoutHash:value.layoutHash,changes:[{sectionId:value.layout.sections[0].id,field:'widthTwips' as const,expected:null,value:11906}]};assert.deepEqual(await stoppedLayoutSubmit(session,value,signal,async()=>{},async()=>{})({revision:1,intent}),{revision:2});assert.equal(calls[1].reviewHash,snapshot.reviewHash);assert.match(calls[1].transactionId,/^[a-f0-9]{32}$/);await assert.rejects(stoppedLayoutSubmit(session,value,signal,async()=>{},async()=>{})({revision:2,intent}),/stale/);assert.equal(calls.length,2)}finally{globalThis.fetch=original}
})
test('layout dispatch waits for durable preparation and cancellation after preparation sends nothing',async()=>{
 const original=globalThis.fetch;let calls=0,release!:()=>void,entered!:()=>void
 globalThis.fetch=async()=>{calls++;throw Error('unexpected request')}
 try{const controller=new AbortController(),started=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve}),value={...snapshot,layout:snapshot.layout as any},intent={schemaVersion:'hcd-word-layout-edits/1' as const,baseLayoutHash:value.layoutHash,changes:[{sectionId:section(),field:'widthTwips' as const,expected:null,value:11906}]};const result=stoppedLayoutSubmit(session,value,controller.signal,async action=>{assert.equal(action.sections[0].number,1);entered();await hold},async()=>{})({revision:1,intent});await started;assert.equal(calls,0);controller.abort();release();await assert.rejects(result);assert.equal(calls,0);await assert.rejects(stoppedLayoutSubmit(session,value,new AbortController().signal,async()=>{throw Error('quota')},async()=>{})({revision:1,intent}),/quota/);assert.equal(calls,0)}finally{globalThis.fetch=original}
})
const section=()=>`n_${'1'.repeat(32)}`
test('readers and forged receipts cannot report a successful layout save',async()=>{
 const original=globalThis.fetch;let count=0;globalThis.fetch=async()=>{count++;return Response.json({transactionId:'0'.repeat(32),revision:2})}
 try{const signal=new AbortController().signal;await assert.rejects(inspectStoppedLayout({...session,scope:'read'},signal));assert.equal(count,0);const value={...snapshot,layout:snapshot.layout as any};let uncertain='';await assert.rejects(stoppedLayoutSubmit(session,value,signal,async action=>{uncertain=action.body.transactionId},async()=>{})({revision:1,intent:{schemaVersion:'hcd-word-layout-edits/1',baseLayoutHash:value.layoutHash,changes:[{sectionId:value.layout.sections[0].id,field:'widthTwips' as const,expected:null,value:11906}]}}),/invalid/);assert.match(uncertain,/^[a-f0-9]{32}$/);assert.notEqual(uncertain,'0'.repeat(32))}finally{globalThis.fetch=original}
})
