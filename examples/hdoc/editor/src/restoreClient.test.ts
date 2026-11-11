import test from 'node:test'
import assert from 'node:assert/strict'
import {installRestoreHandoff,prepareRestoreSubmission,restoreIntentForSelection,type RestoreSubmission} from './restoreClient.ts'
test('a prepared restore is replayed only for the same target and the head just read',()=>{
 const pending:RestoreSubmission={requestId:'a'.repeat(32),target:2,expectedRevision:4,fromEpoch:1}
 assert.equal(restoreIntentForSelection(pending,2,4),pending)
 assert.equal(restoreIntentForSelection(null,2,4),null)
 assert.equal(restoreIntentForSelection(pending,5,4),null)
 assert.equal(restoreIntentForSelection(pending,2,5),null)
 assert.equal(restoreIntentForSelection(pending,5,9),null)
})
test('a matching prepared restore is submitted without saving while the room is paused',async()=>{
 const pending:RestoreSubmission={requestId:'a'.repeat(32),target:2,expectedRevision:4,fromEpoch:1}
 let saved=0
 const replayed=await prepareRestoreSubmission(pending,2,4,async()=>{saved++;throw new Error('word-restore-paused')},1)
 assert.equal(replayed,pending);assert.equal(saved,0)
 const created=await prepareRestoreSubmission(pending,5,9,async()=>{saved++;return 9},3)
 assert.equal(saved,1);assert.equal(created.target,5);assert.equal(created.expectedRevision,9);assert.notEqual(created.requestId,pending.requestId);assert.match(created.requestId,/^[a-f0-9]{32}$/)
 await assert.rejects(prepareRestoreSubmission(pending,5,8,async()=>9,3),/restoreComparisonChanged/)
})
test('handoff locks before asynchronous flush and ignores stale ready/release after teardown',async()=>{
 let listener:((value:{payload:string})=>void)|undefined,finish!:()=>void
 const sent:string[]=[],events:string[]=[],provider={on:(_event:string,cb:any)=>{listener=cb},off:()=>{listener=undefined},sendStateless:(value:string)=>sent.push(value)}
 const cleanup=installRestoreHandoff(provider,{freeze:()=>events.push('locked'),ready:async()=>{events.push('flush');await new Promise<void>(resolve=>{finish=resolve});return true},release:()=>events.push('released'),committed:epoch=>events.push(`epoch:${epoch}`)})
 const send=(type:string,requestId='a'.repeat(32),extra={})=>listener?.({payload:JSON.stringify({type,requestId,...extra})})
 send('hcd-restore-prepare');assert.deepEqual(events,['locked','flush']);send('hcd-restore-release','b'.repeat(32));assert.equal(events.includes('released'),false)
 send('hcd-restore-release');finish();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(sent.length,0);assert.equal(events.at(-1),'released')
 send('hcd-restore-committed','a'.repeat(32),{collaborationEpoch:3});assert.equal(events.at(-1),'epoch:3');cleanup();assert.equal(listener,undefined)
})
test('private upload failure attests not ready and cannot silently release the lock',async()=>{
 let receive:any;const sent:string[]=[],events:string[]=[]
 const provider={on:(_event:string,cb:any)=>{receive=cb},off:()=>{},sendStateless:(s:string)=>sent.push(s)}
 const clean=installRestoreHandoff(provider,{freeze:()=>events.push('locked'),ready:async()=>false,release:()=>events.push('released'),committed:()=>{}})
 receive({payload:JSON.stringify({type:'hcd-restore-prepare',requestId:'a'.repeat(32)})});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(JSON.parse(sent[0]).ready,false);assert.deepEqual(events,['locked']);clean()
})

test('inline version restore declares its model and only accepts the reviewed target in the same model',async t=>{
 const {submitRestore,RestoreClientError}=await import('./restoreClient.ts'),{inlineProtocol}=await import('./collaborationProtocol.ts')
 const submission={requestId:'a'.repeat(32),expectedRevision:8,target:3,fromEpoch:2},session={documentId:'doc',token:'private',apiUrl:'/v1/documents',collabUrl:'ws://127.0.0.1:8768',format:'docx',scope:'write' as const,collaborationProtocol:inlineProtocol,collaborationEpoch:2}
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let wrong:Record<string,unknown>={}
 globalThis.fetch=async(url,init)=>{assert.match(String(url),/restore\/3$/);const headers=new Headers(init?.headers);assert.equal(headers.get('x-hcd-node-edits-version'),'7');assert.equal(headers.get('x-hcd-inline-containers-version'),'1');assert.equal(headers.get('x-hcd-extension-version'),'3');assert.equal(headers.get('x-hcd-custom-marks-version'),'1');assert.deepEqual(JSON.parse(String(init?.body)),{requestId:submission.requestId,expectedRevision:8,fromEpoch:2});return Response.json({requestId:submission.requestId,revision:9,restoredFrom:3,collaborationEpoch:3,collaborationProtocol:inlineProtocol,...wrong})}
 assert.equal((await submitRestore(session,submission,AbortSignal.timeout(1000))).revision,9)
 for(const altered of [{restoredFrom:4},{collaborationProtocol:'hcd-semantic-blocks/3'},{collaborationEpoch:4}]){wrong=altered;await assert.rejects(submitRestore(session,submission,AbortSignal.timeout(1000)),(error:unknown)=>error instanceof RestoreClientError&&error.uncertain)}
})

test('layout version restore declares the word-regions model and only accepts a layout receipt',async t=>{
 const {submitRestore,RestoreClientError}=await import('./restoreClient.ts'),{wordLayoutProtocol}=await import('./collaborationProtocol.ts')
 const submission={requestId:'d'.repeat(32),expectedRevision:6,target:2,fromEpoch:1},session={documentId:'doc',token:'private',apiUrl:'/v1/documents',collabUrl:'ws://127.0.0.1:8768',format:'docx',scope:'write' as const,collaborationProtocol:wordLayoutProtocol,collaborationEpoch:1}
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let wrong:Record<string,unknown>={}
 globalThis.fetch=async(url,init)=>{assert.match(String(url),/restore\/2$/);const headers=new Headers(init?.headers);assert.equal(headers.get('x-hcd-node-edits-version'),'7');assert.equal(headers.get('x-hcd-word-regions-version'),'2');assert.equal(headers.get('x-hcd-word-layout-version'),'1');assert.equal(headers.get('x-hcd-inline-containers-version'),null);assert.deepEqual(JSON.parse(String(init?.body)),{requestId:submission.requestId,expectedRevision:6,fromEpoch:1});return Response.json({requestId:submission.requestId,revision:7,restoredFrom:2,collaborationEpoch:2,collaborationProtocol:wordLayoutProtocol,...wrong})}
 assert.equal((await submitRestore(session,submission,AbortSignal.timeout(1000))).revision,7)
 for(const altered of [{restoredFrom:3},{collaborationProtocol:'hcd-semantic-blocks/3'},{collaborationEpoch:3}]){wrong=altered;await assert.rejects(submitRestore(session,submission,AbortSignal.timeout(1000)),(error:unknown)=>error instanceof RestoreClientError&&error.uncertain)}
})
test('a committed frame clears the round even when the close never lands',async()=>{
 let receive:any
 const sent:string[]=[],events:string[]=[]
 const provider={on:(_event:string,cb:any)=>{receive=cb},off:()=>{},sendStateless:(s:string)=>sent.push(s)}
 const clean=installRestoreHandoff(provider,{freeze:()=>events.push('locked'),ready:async()=>true,release:()=>events.push('released'),committed:epoch=>events.push(`epoch:${epoch}`)})
 const send=(type:string,requestId:string,extra={})=>receive({payload:JSON.stringify({type,requestId,...extra})})
 send('hcd-restore-prepare','a'.repeat(32));await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(JSON.parse(sent[0]).ready,true)
 send('hcd-restore-committed','a'.repeat(32),{collaborationEpoch:4});assert.equal(events.at(-1),'epoch:4')
 // The 4409 close that normally follows the commit never reached this
 // connection; a later round must still be locked and answered, not swallowed.
 send('hcd-restore-prepare','b'.repeat(32));await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(sent.length,2);assert.equal(JSON.parse(sent[1]).requestId,'b'.repeat(32));assert.equal(JSON.parse(sent[1]).ready,true)
 clean()
})
