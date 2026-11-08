/** Signed model 3 recovery fixture for a disposable layout-aware document. */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash,createHmac} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {WordCheckpointJournal,wordSaveCapsule} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {WordRoomLease,wordRecoveryStoreId} from '../examples/hdoc/editor/src/wordRoomLease.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),id=c.documentId,epoch=1,projection=c.initialProjection
assert.equal(projection.documentId,id)
const digest=(text:string)=>createHash('sha256').update(text).digest('hex'),lineage=createHmac('sha256',c.secret).update(`word-room/1:${c.origin}:${id}:${epoch}`).digest('hex').slice(0,32),journal=new WordCheckpointJournal(c.root+'/sidecar',c.origin,id,epoch,lineage,c.secret,true,true)
const request=(route:string,init:RequestInit={})=>fetch(`${c.origin}/v1/documents/${id}${route}`,{...init,headers:{Authorization:`Bearer ${c.service}`,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1','X-HCD-Collaboration-Epoch':String(epoch),'X-HCD-Collaboration-Protocol':'hcd-word-regions/2',...init.headers}})
const lease=new WordRoomLease({epoch,storeId:await wordRecoveryStoreId(c.root+'/sidecar',c.origin,c.secret),journalHashes:['none'],request}),document=new Y.Doc(),archive=new Y.Doc(),schema=wordRegionSchema()
try{
 await lease.acquire()
 const canonical=new WordRegionStore(document,schema,id,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
 const response=await request(`/revisions/${projection.revision}`);assert.equal(response.status,200);const base={revision:projection.revision,rootHash:(await response.json()).rootHash,layoutHash:projection.flowLayoutHash,digest:digest(canonical.contents())}
 const capsule=(model:WordRegionStore,actors:Array<{userId:string;displayName:string;generation:number}>)=>wordSaveCapsule(journal.scope,model,base,actors,undefined,{observation:digest(model.contents()),references:[]},3)
 let tip=await journal.initializeLayout(capsule(canonical,[]),()=>lease.assert());await lease.recordJournal(journal.knownHashes())
 if(!c.clean){
 Y.applyUpdate(archive,Y.encodeStateAsUpdate(document));const copy=new WordRegionStore(archive,schema,id,projection.flowLayout,projection.flowLayoutHash),region=projection.flowLayout.sections[0].id
 const append=(model:WordRegionStore,text:string)=>{const before=model.region(region);model.reconcile(region,before,[...before,{node:schema.nodes.paragraph.createChecked(null,schema.text(text))}])}
 append(canonical,'Shared draft from Bob');append(copy,'Archived draft from Alice')
 tip=await journal.save(capsule(canonical,[{userId:'bob',displayName:'Bob 李',generation:1}]),tip,()=>lease.assert());await lease.recordJournal(journal.knownHashes())
 if(!c.draftOnly)await journal.archiveSnapshot(capsule(copy,[{userId:'alice',displayName:'Alice 王',generation:1}]),'word-owner-lost')
 }
 console.log(JSON.stringify({signedLayoutRecovery:true,baseRevision:base.revision}))
}finally{document.destroy();archive.destroy();await lease.close()}
