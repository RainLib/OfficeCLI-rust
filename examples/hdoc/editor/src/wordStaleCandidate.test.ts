import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {buildWordStaleCandidate} from './wordStaleCandidate.ts'

const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),hash=(s:string)=>createHash('sha256').update(s).digest('hex'),schema=wordRegionSchema()
function fixture(){
 const projection:WordRegionProjection={documentId:'doc',revision:1,flowLayoutHash:hash('layout'),flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{},footers:{}}],stories:[]},blocks:[1,2].map(n=>({flowRegionId:id(1),blockId:id(n+10),blockHash:hash('block'),region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:`Text ${n}`,nodeId:id(n+20)}]}}))}
 const docs:Y.Doc[]=[],make=()=>{const doc=new Y.Doc();docs.push(doc);return new WordRegionStore(doc,schema,'doc',projection.flowLayout,projection.flowLayoutHash)},base=make();base.initialize(projection)
 const fork=()=>{const model=make();Y.applyUpdate(model.document,Y.encodeStateAsUpdate(base.document));return model},draft=fork(),head=fork()
 const edit=(model:WordRegionStore,index:number,text:string)=>{const before=model.region(id(1)),node=before[index].node,after=before.map((item,i)=>i===index?{key:item.key,node:node.type.createChecked(node.attrs,schema.text(text,node.firstChild?.marks))}:item);model.reconcile(id(1),before,after)}
 return{projection,base,draft,head,edit,make,close:()=>docs.forEach(doc=>doc.destroy())}
}
test('staged candidate keeps disjoint latest and draft blocks without mutating either input',()=>{
 const f=fixture();try{f.edit(f.draft,0,'Draft 😀');f.edit(f.head,1,'Peer');const beforeDraft=Y.encodeStateAsUpdate(f.draft.document),beforeHead=Y.encodeStateAsUpdate(f.head.document),built=buildWordStaleCandidate(f.base,f.draft,f.head,false)
  try{assert.equal(built.candidate.project(id(1)).textContent,'Draft 😀Peer');assert.deepEqual(Y.encodeStateAsUpdate(f.draft.document),beforeDraft);assert.deepEqual(Y.encodeStateAsUpdate(f.head.document),beforeHead);assert.deepEqual(built.candidate.capture().regions[0].blocks.map(block=>block.blockId),[id(11),id(12)])}finally{built.document.destroy()}
 }finally{f.close()}
})
test('conflicts and unknown objects refuse a staged candidate',()=>{
 const f=fixture();try{f.edit(f.draft,0,'Draft');f.edit(f.head,0,'Peer');assert.throws(()=>buildWordStaleCandidate(f.base,f.draft,f.head,false),/word-stale-conflict/);assert.throws(()=>buildWordStaleCandidate(f.base,f.draft,f.head,true),/word-stale-unsupported/)
 }finally{f.close()}
})
test('unchanged source runs can be rebound to new canonical text identities',()=>{
 const f=fixture();try{f.edit(f.draft,0,'Draft');const projection=structuredClone(f.projection);projection.revision=2;projection.blocks[0].content.inlines[0].nodeId=id(99);projection.blocks[1].content.inlines[0].text='Peer elsewhere';const head=f.make();head.initialize(projection);const before=Y.encodeStateAsUpdate(f.draft.document),built=buildWordStaleCandidate(f.base,f.draft,head,false)
  try{const blocks=built.candidate.capture().regions[0].blocks;assert.equal(blocks[0].content.inlines[0].text,'Draft');assert.equal(blocks[0].content.inlines[0].nodeId,id(99));assert.equal(blocks[1].content.inlines[0].text,'Peer elsewhere');assert.deepEqual(Y.encodeStateAsUpdate(f.draft.document),before)}finally{built.document.destroy()}
 }finally{f.close()}
})
test('ambiguous or unknown source identities are not rebound by position',()=>{
 const f=fixture();try{f.edit(f.draft,0,'Draft');const projection=structuredClone(f.projection);projection.revision=2;projection.blocks[0].content.inlines=[{text:'Text',nodeId:id(98)},{text:' 1',nodeId:id(99)}];const head=f.make();head.initialize(projection);assert.throws(()=>buildWordStaleCandidate(f.base,f.draft,head,false),/word-stale-source-ambiguous/)
 }finally{f.close()}
})
test('unprojected shared metadata and unknown schema fields cannot be dropped by staging',()=>{
 for(const field of ['unrecognized-map','hcd-node-edits/1/intents','hcdImageReceipts','hcdSchema']){
  const f=fixture();try{f.edit(f.draft,0,'Draft');f.edit(f.head,1,'Peer');f.draft.document.getMap(field).set(field==='hcdSchema'?'unknown':'retained','value');const before=Y.encodeStateAsUpdate(f.draft.document);assert.throws(()=>buildWordStaleCandidate(f.base,f.draft,f.head,false),/word-stale-unprojected-state/);assert.deepEqual(Y.encodeStateAsUpdate(f.draft.document),before)}finally{f.close()}
 }
})
