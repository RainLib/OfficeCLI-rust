/** Synthetic signed-log fixture; never uses a real user document or token. */
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,createHmac} from 'node:crypto'
import * as Y from 'yjs'
import {WordCheckpointJournal,wordSaveCapsule} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {wordLinkRequestHash,wordLinkPendingHash,type WordPendingLink} from './wordLinkProof.ts'
export const linkId=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
export const linkHash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex')
export async function wordLinkFixture(){
 const root=await mkdtemp(join(tmpdir(),'hcd-link-journal-')),api='http://native.invalid/v1',secret='link-test-secret-'.repeat(3),lineage='e'.repeat(32),document=new Y.Doc(),schema=wordRegionSchema()
 const layout={schemaVersion:'hcd-flow-layout/2' as const,evenAndOddHeaders:true,sections:[1,2,3].map(n=>({id:linkId(n),differentFirstPage:false,page:{widthTwips:12240},headers:n===1?{default:linkId(4)}:n===2?{default:linkId(5)}:{},footers:{}})),stories:[4,5].map(n=>({id:linkId(n),kind:'header' as const,sourcePart:`word/header${n}.xml`}))}
 const previous:WordRegionProjection={documentId:'doc',revision:1,flowLayout:layout,flowLayoutHash:'a'.repeat(64),blocks:[1,2,3,4,5].map((n,i)=>({flowRegionId:linkId(n),region:n<=3?'body':'header',blockId:linkId(100+i),blockHash:'1'.repeat(64),readOnly:false,content:{kind:'paragraph',inlines:[{nodeId:linkId(200+i),text:`Region ${n}`}]}}))}
 const next=structuredClone(previous);next.revision=2;next.flowLayoutHash='b'.repeat(64);delete next.flowLayout.sections[1].headers.default
 const journal=new WordCheckpointJournal(root,api,'doc',1,lineage,secret,true,true,true),model=new WordRegionStore(document,schema,'doc',layout,previous.flowLayoutHash);model.initialize(previous)
 const base={revision:1,rootHash:'c'.repeat(64),layoutHash:previous.flowLayoutHash,digest:linkHash(model.contents())}
 let tip=await journal.initializeLayout(wordSaveCapsule(journal.scope,model,base,[],undefined,{observation:wordDraftObservation(model),references:[]},3),()=>{})
 const actor={userId:'alice',displayName:'Alice 王',generation:1},pending:WordPendingLink={actor,request:{schemaVersion:'hcd-word-story-link/1',documentId:'doc',transactionId:'d'.repeat(32),expectedRevision:1,actor:{userId:actor.userId,displayName:actor.displayName},link:{baseLayoutHash:previous.flowLayoutHash,sectionId:linkId(2),kind:'header',variant:'default',expectedDirectStoryId:linkId(5)}},candidateLayoutHash:next.flowLayoutHash,reviewHash:'f'.repeat(64)}
 const record={documentId:'doc',revision:2,parentRevision:1,patchBaseRevision:1,patchId:'word-story-link-'+pending.request.transactionId,patchHash:wordLinkRequestHash(pending.request),rootHash:'d'.repeat(64),structuralChange:true,wordLayoutChange:true,layoutUpgrade:false,authorId:actor.userId,authorName:actor.displayName}
 const signHash=(initialUpdateHash:string,journalHash:string)=>{
  const r=pending.request,p:any={schemaVersion:'hcd-word-link-receipt/1',documentId:'doc',epoch:1,coordinatorId:lineage,journalHash,expectedRevision:1,revision:2,transactionId:r.transactionId,requestHash:record.patchHash,pendingHash:wordLinkPendingHash(pending),rootHash:record.rootHash,layoutHash:next.flowLayoutHash,reviewHash:pending.reviewHash,initialUpdateHash}
  p.signature=createHmac('sha256',secret).update(JSON.stringify(['hcd-word-link-receipt/1',journal.scope.apiHash,'doc',1,lineage,journalHash,1,2,r.transactionId,p.requestHash,p.pendingHash,p.rootHash,r.link.baseLayoutHash,p.layoutHash,p.reviewHash,p.initialUpdateHash])).digest('base64url');return p
 }
 const edit=(region:number,value:string)=>{const blocks=model.region(linkId(region)),first=blocks[0],node=first.node.type.createChecked(first.node.attrs,schema.text(value,first.node.firstChild?.marks));model.reconcile(linkId(region),blocks,blocks.map(block=>block.key===first.key?{key:block.key,node}:block))}
 return{root,api,secret,lineage,journal,document,model,previous,next,base,record,pending,sign:(update:Uint8Array,tip:string)=>signHash(linkHash(update),tip),signHash,edit,get tip(){return tip},saveDraft:async()=>{tip=await journal.save(wordSaveCapsule(journal.scope,model,base,[actor],undefined,{observation:wordDraftObservation(model),references:[]},3),tip);return tip},reopen:(allow=true)=>new WordCheckpointJournal(root,api,'doc',1,lineage,secret,true,true,allow),close:async()=>{document.destroy();await rm(root,{recursive:true,force:true})}}
}
