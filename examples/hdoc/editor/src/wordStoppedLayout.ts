/** Layout changes for a stopped /2 room. The caller holds the document gate,
 * native owner lease and current member authorization throughout. */
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {WordCheckpointJournal,wordSaveCapsule,type WordLayoutPending} from './wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema,type WordRegionProjection} from './wordRegionStore.ts'
import {wordDraftObservation} from './wordDraftObservation.ts'
import {readWordLayout} from './wordRegions.ts'
import {matchesWordLayoutTransition} from './wordLayoutTransition.ts'
import {readBoundedResponse} from './boundedResponse.ts'
import {submitPreparedWordLayout,promoteRecoveredWordLayout} from './wordLayoutRecovery.ts'
import {WordRecoveryError} from './wordRecoveryReview.ts'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type Options={journal:WordCheckpointJournal;lease:Lease;request:(route:string,init?:RequestInit)=>Promise<Response>;assertStopped:()=>void;authorizeMember:()=>Promise<void>}
const json=async(response:Response)=>{if(!response.ok)throw new WordRecoveryError('word-layout-preflight-unavailable');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,16*1024*1024,AbortSignal.timeout(30_000),'word-layout-response-limit')))}
/** Establish a clean baseline only when the native lease is bound to no
 * journal and there are no archived recovery copies. Never replace a draft. */
async function initializeStoppedLayout(options:Options){
 const {journal,lease,request,assertStopped,authorizeMember}=options,guard=()=>{assertStopped();lease.assert()}
 guard();if(await journal.load()|| (await journal.recoverySnapshots()).length)throw new WordRecoveryError('word-owner-recovery-required');guard()
 const head=await request('/revisions?limit=1').then(json),revision=head.headRevision
 if(!Number.isSafeInteger(revision)||revision<0)throw new WordRecoveryError('word-layout-baseline-invalid')
 const [record,projection]=await Promise.all([request(`/revisions/${revision}`).then(json),request(`/editor?revision=${revision}`,{headers:{'X-HCD-Word-Bootstrap':'1'}}).then(json)]) as [any,WordRegionProjection]
 guard();if(record.revision!==revision||typeof record.rootHash!=='string'||!/^[a-f0-9]{64}$/.test(record.rootHash)||projection.documentId!==journal.scope.documentId||projection.revision!==revision)throw new WordRecoveryError('word-layout-baseline-invalid')
 const document=new Y.Doc()
 try{
  const model=new WordRegionStore(document,wordRegionSchema(),journal.scope.documentId,projection.flowLayout,projection.flowLayoutHash);model.initialize(projection)
  const base={revision,rootHash:record.rootHash,layoutHash:projection.flowLayoutHash,digest:createHash('sha256').update(model.contents()).digest('hex')}
  const capsule=wordSaveCapsule(journal.scope,model,base,[],undefined,{observation:wordDraftObservation(model),references:[]},3)
  await authorizeMember();guard();if((await request('/revisions?limit=1').then(json)).headRevision!==revision||await journal.load()||(await journal.recoverySnapshots()).length)throw new WordRecoveryError('word-recovery-review-changed')
  guard();await journal.initializeLayout(capsule,guard);guard();await lease.recordJournal(journal.knownHashes());guard()
 }finally{document.destroy()}
}
export async function inspectStoppedWordLayout(options:Options){
 const {journal,lease,request,assertStopped,authorizeMember}=options,guard=()=>{assertStopped();lease.assert()};guard();let saved=await journal.load();guard()
 if(!saved){await initializeStoppedLayout(options);saved=await journal.load();guard()}
 if(!saved||saved.capsule.version!==3||saved.capsule.pending)throw new WordRecoveryError('word-layout-pending-unresolved')
 const handled=new Set(saved.capsule.recoveries??[]);for(const archive of await journal.recoverySnapshots())if(!handled.has(archive.id)&&!journal.snapshotRecorded(archive.capsule))throw new WordRecoveryError('word-owner-recovery-required')
 const revision=saved.capsule.base.revision,[head,record,value]=await Promise.all([request('/revisions?limit=1').then(json),request(`/revisions/${revision}`).then(json),request(`/word/layout?revision=${revision}`).then(json)]);guard()
 const layout=readWordLayout(value,revision,2)
 if(head.headRevision!==revision||record.revision!==revision||record.rootHash!==saved.capsule.base.rootHash||value.layoutHash!==saved.capsule.base.layoutHash)throw new WordRecoveryError('word-layout-baseline-invalid')
 await authorizeMember();const latest=await journal.load();guard();if(latest?.hash!==saved.hash)throw new WordRecoveryError('word-recovery-review-changed')
 // The first durable record can survive a lost owner-record response. Its
 // signed, clean genesis is safe to bind again after checking the baseline.
 if(journal.knownHashes().length===2){await lease.recordJournal(journal.knownHashes());guard()}
 return{revision,layoutHash:value.layoutHash as string,reviewHash:saved.hash,layout}
}
export async function applyStoppedWordLayout(options:Options,pending:WordLayoutPending,reviewHash:string){
 const {journal,lease,request,assertStopped,authorizeMember}=options,guard=()=>{assertStopped();lease.assert()}
 const baseline=await inspectStoppedWordLayout(options);guard()
 if(await journal.topologyAbandoned(pending.request.transactionId))throw new WordRecoveryError('word-topology-cancelled')
 guard();if(baseline.reviewHash!==reviewHash||baseline.revision!==pending.request.expectedRevision||baseline.layoutHash!==pending.request.edits.baseLayoutHash)throw new WordRecoveryError('word-recovery-review-changed')
 const response=await request('/word/layout-preflight',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'6','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({coordinatorId:journal.scope.lineage,transaction:pending.request})}),preview=await json(response);guard()
 const current=await journal.load();guard();if(!current||current.hash!==reviewHash||preview.revision!==baseline.revision||preview.rootHash!==current.capsule.base.rootHash||preview.baseLayoutHash!==baseline.layoutHash)throw new WordRecoveryError('word-recovery-review-changed')
 const next=readWordLayout({layout:preview.layout,layoutHash:'0'.repeat(64),revision:baseline.revision},baseline.revision,2)
 if(!matchesWordLayoutTransition(baseline.layout,next,pending.request))throw new WordRecoveryError('word-layout-preflight-invalid')
 await authorizeMember();guard();await journal.prepareLayout(pending,reviewHash,guard);guard()
 await submitPreparedWordLayout({...options,protocol:'hcd-word-regions/2'});guard()
 const result=await promoteRecoveredWordLayout({...options,protocol:'hcd-word-regions/2'});guard()
 return{revision:result.capsule.base.revision,transactionId:pending.request.transactionId}
}
