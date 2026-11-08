import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {CollaborativeImageDraftStore,imageIntents,type SharedImageDraft} from './collaborativeImages.ts'
import {compareRecoveryImageFields,type RecoveryImageBaselineReport} from './recoveryImageBaselines.ts'
import {commitRecoveryImage} from './recoveryImageCommit.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {SemanticHistory} from './semanticHistory.ts'

async function fixture(){
 const document=new Y.Doc(),store=new CollaborativeImageDraftStore(document),bytes=Uint8Array.of(1,2,3),assetHash=await imageFileHash(bytes),geometry={unit:'pt' as const,x:0,y:0,width:20,height:10},base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),assetHash:'c'.repeat(64),geometry}
 const draft:SharedImageDraft={intentId:'11111111-1111-4111-8111-111111111111',clientId:7,ancestors:[],base,revision:1,geometry:{...geometry,width:25},assetHash,touched:['width','assetHash']}
 const saved={...base,visualHash:'d'.repeat(64),geometry:{...geometry,y:3}}
 const reviewed:RecoveryImageBaselineReport={headRevision:2,rootHash:'e'.repeat(64),items:[{intentId:draft.intentId,nodeId:base.nodeId,revision:1,baseline:'verified',current:'changed',saved,fields:compareRecoveryImageFields(draft,saved)}]}
 const history=new SemanticHistory(store,new Y.UndoManager(document.getXmlFragment('default')),()=>false,async()=>({image:saved,revision:2}));history.connect()
 const input={document,store,draft,reviewed,choices:{},resources:new Map([[assetHash,bytes]]),stamp:await imageFileHash(Y.encodeStateAsUpdate(document)),signal:new AbortController().signal,canWrite:()=>true,authorize:async()=>{},loadBaseline:async()=>structuredClone(reviewed),pin:async()=>{}}
 return{input,document,store,history,bytes,assetHash,saved,close(){history.dispose();document.destroy()}}
}
test('confirmed recovery pins bytes and creates one undoable local intent on the current baseline',async()=>{
 const f=await fixture();let pins=0,authorizations=0
 try{
  const result=await commitRecoveryImage({...f.input,authorize:async()=>{authorizations++},pin:async(hash,bytes)=>{pins++;assert.equal(hash,f.assetHash);assert.deepEqual(bytes,f.bytes)}})
  assert.equal(result,true);assert.equal(pins,1);assert.equal(authorizations,2)
  const [intent]=imageIntents(f.document);assert.equal(intent.clientId,f.document.clientID);assert.notEqual(intent.intentId,f.input.draft.intentId);assert.equal(intent.base.visualHash,f.saved.visualHash);assert.equal(intent.geometry.y,3);assert.equal(intent.geometry.width,25);assert.equal(intent.assetHash,f.assetHash)
  await f.history.step('undo');assert.equal(imageIntents(f.document).length,0)
 }finally{f.close()}
})
test('remote changes during staging and a moving head cannot commit an image intent',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const arrived=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r)
 try{
  const work=commitRecoveryImage({...f.input,pin:async()=>{entered();await gate}});await arrived
  f.document.getMap('other').set('peer','new');release();await assert.rejects(work,/recoveryArchiveChanged/);assert.deepEqual(imageIntents(f.document),[])
 }finally{release();f.close()}
 const g=await fixture();let count=0
 try{await assert.rejects(commitRecoveryImage({...g.input,loadBaseline:async()=>{const value=structuredClone(g.input.reviewed);if(++count===2)value.rootHash='f'.repeat(64);return value}}),/recoveryArchiveChanged/);assert.deepEqual(imageIntents(g.document),[])}finally{g.close()}
})
test('write access is checked after staging before a new intent is created',async()=>{
 const f=await fixture();let canWrite=true
 try{await assert.rejects(commitRecoveryImage({...f.input,canWrite:()=>canWrite,pin:async()=>{canWrite=false}}),/recoveryArchiveReadOnly/);assert.deepEqual(imageIntents(f.document),[])}finally{f.close()}
})
for(const heldDigest of [1,3])test(`cancellation during digest ${heldDigest} leaves the image and document unchanged`,async()=>{
 const f=await fixture(),subtle=crypto.subtle,original=subtle.digest.bind(subtle),controller=new AbortController(),before=Y.encodeStateAsUpdate(f.document)
 let calls=0,pins=0,release!:()=>void,entered!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<void>(resolve=>{entered=resolve})
 Object.defineProperty(subtle,'digest',{configurable:true,value:async(...args:Parameters<SubtleCrypto['digest']>)=>{if(++calls===heldDigest){entered();await gate}return original(...args)}})
 try{
  const work=commitRecoveryImage({...f.input,signal:controller.signal,pin:async()=>{pins++}});await held;controller.abort(Error('cancelled'))
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await assert.rejects(Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('stalled cancellation')),1000)})]),/cancelled/)}finally{clearTimeout(timer)}
  release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(pins,0);assert.deepEqual(Y.encodeStateAsUpdate(f.document),before);assert.deepEqual(imageIntents(f.document),[])
 }finally{release();delete (subtle as unknown as {digest?:unknown}).digest;f.close()}
})
