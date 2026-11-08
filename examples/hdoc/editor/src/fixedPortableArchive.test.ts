import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {Session} from './api.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import type {FixedImageChoice} from './fixedImageFiles.ts'
import {fixedImageHash} from './fixedImageFiles.ts'
import {createFixedPortableArchive,openFixedPortableArchive} from './fixedPortableArchive.ts'

const session:Session={documentId:'doc',userId:'alice',token:'secret-token',apiUrl:'https://api.example/v1/documents',scope:'write',format:'pptx'}
const source='a'.repeat(64),base='https://editor.example/',geometry={x:1,y:2,width:20,height:10,unit:'pt' as const},picture={nodeId:'pic',visualHash:'b'.repeat(64),geometry}
const choiceBytes=new TextEncoder().encode('local original'),stagedBytes=new TextEncoder().encode('staged image')
async function fixture(){const localHash=await fixedImageHash(choiceBytes),assetHash=await fixedImageHash(stagedBytes),choice:FixedImageChoice={version:1,id:'00000000-0000-4000-8000-000000000000',name:'a.png',extension:'png',hash:localHash,bytes:Uint8Array.from(choiceBytes),base:picture,revision:1,phase:'staged'},state:FixedDraftState={version:3,texts:[],images:[['pic',{base:picture,revision:1,geometry,assetHash}]],attempt:null};return{choice,state,localHash,assetHash}}
const open=(bytes:Uint8Array,overrides:Partial<{session:Session;sourceHash:string;base:string}>={})=>openFixedPortableArchive(bytes,{session,sourceHash:source,base,...overrides})
const mutate=(bytes:Uint8Array,edit:(value:any)=>void)=>{const obj=JSON.parse(new TextDecoder().decode(bytes));edit(obj);return new TextEncoder().encode(JSON.stringify(obj))}

test('portable archive includes pending originals and staged draft bytes without credentials',async()=>{
 const {state,choice,localHash,assetHash}=await fixture();let reads=0
 const bytes=await createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async hash=>{reads++;assert.equal(hash,assetHash);return stagedBytes}})
 assert.equal(reads,1);assert.doesNotMatch(new TextDecoder().decode(bytes),/secret-token/)
 const result=await open(bytes);assert.deepEqual(result.state,{...state,uploadInterrupted:false});assert.equal(result.choices[0].phase,'chosen');assert.deepEqual(result.choices[0].bytes,choiceBytes);assert.deepEqual(result.resources.get(localHash),choiceBytes);assert.deepEqual(result.resources.get(assetHash),stagedBytes)
})
test('scope mismatch, changed bytes, duplicate resources and unreferenced resources are rejected',async()=>{
 const {state,choice}=await fixture(),bytes=await createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>stagedBytes})
 for(const opts of [{session:{...session,userId:'bob'}},{session:{...session,documentId:'other'}},{session:{...session,apiUrl:'https://other.example/api'}},{sourceHash:'f'.repeat(64)}])await assert.rejects(open(bytes,opts))
 await assert.rejects(open(mutate(bytes,v=>{v.resources[0].base64='A'+v.resources[0].base64.slice(1)})))
 await assert.rejects(open(mutate(bytes,v=>{v.resources.push(v.resources[0])})))
 await assert.rejects(open(mutate(bytes,v=>{v.choices=[]})))
 await assert.rejects(open(mutate(bytes,v=>{v.choices[0].phase='linked'})))
})
test('missing or incorrect server resources fail rather than making an incomplete archive',async()=>{
 const {state,choice}=await fixture()
 await assert.rejects(createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>{throw Error('expired')}}),/expired/)
 await assert.rejects(createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>new Uint8Array([1])}),/integrity/)
})
test('archive captures one fixed snapshot even if editing continues while reading assets',async()=>{
 const {state,choice,assetHash}=await fixture();let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r)
 const promise=createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>{started();await gate;return stagedBytes}});await entered;state.images[0][1].geometry.width=55;choice.bytes[0]=0;release()
 const result=await open(await promise);assert.equal(result.state.images[0][1].geometry.width,20);assert.equal(result.resources.get(assetHash)?.length,stagedBytes.length);assert.equal(new TextDecoder().decode(result.choices[0].bytes),'local original')
})
test('unrepresentable collaboration alternatives are rejected instead of silently omitted',async()=>{
 const {state,choice}=await fixture();state.images[0][1].collaborationConflict=true;state.images[0][1].alternatives=[{intentId:'peer',geometry,assetHash:'f'.repeat(64)}]
 await assert.rejects(createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>stagedBytes}),/conflict/)
 delete state.images[0][1].collaborationConflict;delete state.images[0][1].alternatives
 const bytes=await createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>stagedBytes})
 await assert.rejects(open(mutate(bytes,v=>{const draft=JSON.parse(v.draft);draft.state.images[0][1].alternatives=[];v.draft=JSON.stringify(draft)})),/conflict/)
})
test('every choice is independently checked even when another choice references the same hash',async()=>{
 const {state,choice}=await fixture(),bad={...choice,id:'10000000-0000-4000-8000-000000000000',bytes:new Uint8Array([1,2,3])}
 await assert.rejects(createFixedPortableArchive({session,sourceHash:source,base,state,choices:[bad,choice],readAsset:async()=>stagedBytes}),/integrity/)
})
test('unrecognized transient fields never enter the portable file',async()=>{
 const {state,choice}=await fixture();(choice.base as any).preview='private-preview-token';(choice.base.geometry as any).credentials='private-geometry-secret';(state.images[0][1] as any).extraSecret='private-state-secret'
 const bytes=await createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>stagedBytes});const serialized=new TextDecoder().decode(bytes);assert.doesNotMatch(serialized,/private-preview-token|private-geometry-secret|private-state-secret/);assert.equal((await open(bytes)).choices.length,1)
})
test('an unidentified interrupted upload cannot be represented as complete recovery',async()=>{
 const {state,choice}=await fixture();state.uploadInterrupted=true
 await assert.rejects(createFixedPortableArchive({session,sourceHash:source,base,state,choices:[choice],readAsset:async()=>stagedBytes}),/interrupted/)
})
test('workbook in-cell input roundtrips as a private buffer and unsupported images are rejected',async()=>{
 const workbook={...session,format:'xlsx'},run={nodeId:'cell-a1',nodeHash:'c'.repeat(64),text:'Original'},buffer={base:run,revision:2,initial:'Original',text:'Unfinished input',sheetId:'sheet-1',row:0,column:0},state:FixedDraftState={version:4,texts:[],images:[],attempt:null,workbookBuffer:buffer}
 const bytes=await createFixedPortableArchive({session:workbook,sourceHash:source,base,state,choices:[],readAsset:async()=>{throw Error('unexpected')}}),restored=await open(bytes,{session:workbook})
 assert.deepEqual(restored.state.workbookBuffer,buffer);assert.equal(restored.state.texts.length,0)
 const {choice}=await fixture();await assert.rejects(createFixedPortableArchive({session:workbook,sourceHash:source,base,state,choices:[choice],readAsset:async()=>stagedBytes}),/unsupported-images/)
})
test('workbook portable archive preserves an exact pending blank creation',async()=>{
 const workbook={...session,format:'xlsx'},blankAttempt={documentId:'doc',patchId:'grid-pending',baseRevision:2,sourceSha256:source,cells:[{sheetId:'s_'+'d'.repeat(32),sheetPart:'xl/worksheets/sheet1.xml',sheetName:'Sheet 1',row:3,column:2,text:'Pending 😀',nodeId:'n_'+'e'.repeat(32)}]},state:FixedDraftState={version:5,texts:[],images:[],attempt:null,blankAttempt}
 const bytes=await createFixedPortableArchive({session:workbook,sourceHash:source,base,state,choices:[],readAsset:async()=>{throw Error('unexpected')}})
 const restored=await open(bytes,{session:workbook});assert.deepEqual(restored.state.blankAttempt,blankAttempt)
 await assert.rejects(open(bytes,{session:{...workbook,userId:'bob'}}))
})
