import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {copyMappedBatchCell,readMappedBatchCell,stageMappedBatchDraft} from './workbookBatchMappedCopy.ts'
import type {Session} from './api.ts'
import {TextDraftStore} from './textDrafts.ts'
const session:Session={documentId:'doc',userId:'alice',scope:'write',format:'xlsx',token:'secret',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),sheetId='s_'+'b'.repeat(32),nodeId='n_'+'c'.repeat(32),text='Peer 😀',nodeHash=createHash('sha256').update(text).digest('hex'),cell={sheetId,row:2,column:1,text:'My value'}
const reviewed={cell,mapped:{nodeId,text,truncated:false,editable:true}}
const node={documentId:'doc',revision:1,nodeId,nodeHash,text,source:{nodeKind:'cell',part:'xl/worksheets/sheet1.xml',paragraphId:'B3',editable:true}}
function mock(){let head=1,changed=false,current:any=node;const old=globalThis.fetch;globalThis.fetch=async url=>String(url).endsWith('/head')?Response.json({documentId:'doc',revision:head,sourceSha256:source}):String(url).endsWith('/grid/cells/compare')?Response.json({documentId:'doc',revision:1,rootHash:'d'.repeat(64),sourceSha256:source,cells:[{sheetId,row:3,column:2,mapped:{nodeId,text:changed?'changed':text,truncated:false,editable:true}}]}):Response.json(current);return{head:(n:number)=>{head=n},change:()=>{changed=true},node:(n:unknown)=>{current=n},restore:()=>{globalThis.fetch=old}}}
test('mapped copy checks the reviewed head, coordinate and hash before staging',async()=>{
 const f=mock();let staged:any=null
 try{await copyMappedBatchCell({session,source,revision:1,reviewed,signal:new AbortController().signal,guard:()=>true,stage:async(...args)=>{staged=args}});assert.deepEqual(staged,[{nodeId,nodeHash,text},1,'My value'])
  staged=null;f.change();await assert.rejects(copyMappedBatchCell({session,source,revision:1,reviewed,signal:new AbortController().signal,guard:()=>true,stage:async()=>{staged=true}}),/changed/);assert.equal(staged,null)
 }finally{f.restore()}
})
test('changed head, damaged node, revocation and cancellation never stage a draft',async()=>{
 const f=mock();let staged=0,allowed=true;const options={session,source,revision:1,reviewed,signal:new AbortController().signal,guard:()=>allowed,stage:async()=>{staged++}}
 try{f.head(2);await assert.rejects(copyMappedBatchCell(options),/changed/);f.head(1);f.node({...node,nodeHash:'0'.repeat(64)});await assert.rejects(copyMappedBatchCell(options),/invalid/);f.node(node);allowed=false;await assert.rejects(copyMappedBatchCell(options),/unavailable/);const abort=new AbortController();abort.abort();await assert.rejects(copyMappedBatchCell({...options,signal:abort.signal}));assert.equal(staged,0)}finally{f.restore()}
})
test('truncated comparisons require the reviewed full text before copying',async()=>{
 const old=globalThis.fetch,long='😀'.repeat(1100)+'end',hash=createHash('sha256').update(long).digest('hex'),preview={cell,mapped:{nodeId,text:'😀'.repeat(1000),truncated:true,editable:true}};let staged=0,head=1
 globalThis.fetch=async url=>String(url).endsWith('/head')?Response.json({documentId:'doc',revision:head,sourceSha256:source}):String(url).endsWith('/grid/cells/compare')?Response.json({documentId:'doc',revision:1,rootHash:'d'.repeat(64),sourceSha256:source,cells:[{sheetId,row:3,column:2,mapped:preview.mapped}]}):Response.json({...node,text:long,nodeHash:hash})
 const input={session,source,revision:1,reviewed:preview,signal:new AbortController().signal,guard:()=>true,stage:async()=>{staged++}}
 try{assert.equal((await readMappedBatchCell(input)).text,long);await assert.rejects(copyMappedBatchCell(input),/changed/);await assert.rejects(copyMappedBatchCell({...input,reviewedFull:long+'changed'}),/changed/);head=2;await assert.rejects(copyMappedBatchCell({...input,reviewedFull:long}),/changed/);assert.equal(staged,0);head=1;await copyMappedBatchCell({...input,reviewedFull:long});assert.equal(staged,1)}finally{globalThis.fetch=old}
})

test('interrupted copy can confirm the identical local draft without overwriting another draft',async()=>{
 const texts=new TextDraftStore(),run={nodeId,nodeHash,text},signal=new AbortController().signal;let flushes=0
 const args={texts,run,revision:1,text:'My value',signal,guard:()=>true,flush:async()=>{if(++flushes===1)throw Error('disk unavailable')}}
 await assert.rejects(stageMappedBatchDraft(args),/disk unavailable/);assert.equal(texts.get(nodeId)?.text,'My value')
 await stageMappedBatchDraft(args);assert.equal(flushes,2);assert.equal(texts.get(nodeId)?.text,'My value')
 texts.edit(run,1,'Different local value');await assert.rejects(stageMappedBatchDraft(args),/existing-draft/);assert.equal(texts.get(nodeId)?.text,'Different local value');assert.equal(flushes,2)
})
test('copy confirmation rejects a changed draft or revoked access during the flush',async()=>{
 const texts=new TextDraftStore(),run={nodeId,nodeHash,text},signal=new AbortController().signal;let allowed=true
 const args={texts,run,revision:1,text:'My value',signal,guard:()=>allowed,flush:async()=>{texts.edit(run,1,'Later value')}}
 await assert.rejects(stageMappedBatchDraft(args),/changed/);assert.equal(texts.get(nodeId)?.text,'Later value')
 texts.discard(nodeId);await assert.rejects(stageMappedBatchDraft({...args,flush:async()=>{allowed=false}}),/unavailable/);assert.equal(texts.get(nodeId)?.text,'My value')
})
test('copy retries reject stale or remotely conflicted drafts even when their text matches',async()=>{
 const texts=new TextDraftStore(),run={nodeId,nodeHash,text},signal=new AbortController().signal
 const args={texts,run,revision:1,text:'My value',signal,guard:()=>true,flush:async()=>{throw Error('must not flush')}}
 texts.restore([[nodeId,{base:run,revision:1,text:'My value',remote:{...run,nodeHash:'0'.repeat(64),text:'New peer value'}}]])
 await assert.rejects(stageMappedBatchDraft(args),/existing-draft/);assert.equal(texts.get(nodeId)?.remote?.text,'New peer value')
})
