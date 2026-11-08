import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {deletionReviews} from './deletionReview.ts'
import {resolveWordDeletionReview} from './wordDeletionReview.ts'

const id=(n:number)=>'n_'+n.toString(16).padStart(32,'0'),hash='a'.repeat(64),schema=wordRegionSchema()
function setup(){
 const projection:WordRegionProjection={documentId:'regional',revision:1,flowLayoutHash:hash,flowLayout:{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,sections:[{id:id(1),differentFirstPage:false,page:{},headers:{default:id(2)},footers:{}}],stories:[{id:id(2),kind:'header',sourcePart:'word/header1.xml'}]},blocks:[1,1,2].map((region,index)=>({flowRegionId:id(region),region:region===1?'body':'header',blockId:id(10+index),blockHash:hash,readOnly:false,content:{kind:'paragraph',inlines:[{text:['Target','Keep','Header'][index],nodeId:id(20+index)}]}}))}
 const a=new Y.Doc({gc:false}),model=new WordRegionStore(a,schema,'regional',projection.flowLayout,hash);model.initialize(projection)
 const b=new Y.Doc({gc:false});Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const peer=new WordRegionStore(b,schema,'regional',projection.flowLayout,hash)
 const target=model.region(id(1))[0],peerTarget=peer.region(id(1))[0]
 model.structure.remove([target.key]);peer.reconcile(id(1),peer.region(id(1)),[{key:peerTarget.key,node:peerTarget.node.type.createChecked(peerTarget.node.attrs,schema.text('Target peer',peerTarget.node.firstChild?.marks))},peer.region(id(1))[1]])
 Y.applyUpdate(a,Y.encodeStateAsUpdate(b));return{a,b,model,projection}
}
test('regional deletion review restores reviewed peer content without changing another story',()=>{
 const f=setup();try{const group=deletionReviews(f.model.structure)[0];assert.ok(group);resolveWordDeletionReview(f.model,f.projection,group,'restore');assert.match(f.model.project(id(1)).textContent,/Target peer/);assert.equal(f.model.project(id(2)).textContent,'Header');assert.equal(deletionReviews(f.model.structure).length,0)}finally{f.a.destroy();f.b.destroy()}
})
test('stale regional review cannot change the live document',()=>{
 const f=setup();try{const group=deletionReviews(f.model.structure)[0],before=Y.encodeStateAsUpdate(f.a);assert.throws(()=>resolveWordDeletionReview(f.model,f.projection,{...group,snapshot:'stale'},'delete'));assert.deepEqual(Y.encodeStateAsUpdate(f.a),before)}finally{f.a.destroy();f.b.destroy()}
})
test('confirming deletion acknowledges only the reviewed text and preserves other regions',()=>{
 const f=setup();try{const group=deletionReviews(f.model.structure)[0];resolveWordDeletionReview(f.model,f.projection,group,'delete');assert.equal(f.model.project(id(1)).textContent,'Keep');assert.equal(f.model.project(id(2)).textContent,'Header');assert.equal(deletionReviews(f.model.structure).length,0)}finally{f.a.destroy();f.b.destroy()}
})
