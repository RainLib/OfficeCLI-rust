/** A reviewed story candidate is regenerated from the native source before
 * it enters the durable journal. The host owns the stopped-room gate. */
import {createHash} from 'node:crypto'
import {inspectStoppedWordLayout} from './wordStoppedLayout.ts'
import {readBoundedResponse} from './boundedResponse.ts'
import {submitPreparedWordStory,promoteStoppedWordStory} from './wordStoryRecovery.ts'
import {WordRecoveryError} from './wordRecoveryReview.ts'
import {requireSavedStorySource} from './wordStoryDraftGuard.ts'
import type {WordCheckpointJournal,WordPendingStory} from './wordCheckpointJournal.ts'

type Lease={assert:()=>void;renew:()=>Promise<void>;recordJournal:(hashes:readonly string[])=>Promise<void>}
type Selection={sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';transactionId:string}
type Options={journal:WordCheckpointJournal;lease:Lease;request:(route:string,init?:RequestInit)=>Promise<Response>;assertStopped:()=>void;authorizeMember:()=>Promise<void>;actor:{userId:string;displayName:string}}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const validSelection=(s:Selection)=>!!s&&/^n_[a-f0-9]{32}$/.test(s.sectionId)&&['header','footer'].includes(s.kind)&&['default','first','even'].includes(s.variant)&&/^[a-f0-9]{32}$/.test(s.transactionId)
async function candidate(options:Options,selection:Selection){
 if(!validSelection(selection))throw new WordRecoveryError('word-recovery-invalid',400)
 const {journal,lease,request,authorizeMember,assertStopped,actor}=options,guard=()=>{assertStopped();lease.assert()}
 const baseline=await inspectStoppedWordLayout(options);guard();if(await journal.topologyAbandoned(selection.transactionId))throw new WordRecoveryError('word-topology-cancelled');guard();const index=baseline.layout.sections.findIndex(section=>section.id===selection.sectionId)
 if(index<0)throw new WordRecoveryError('word-recovery-invalid',400)
 const bindings=(i:number)=>selection.kind==='header'?baseline.layout.sections[i].headers:baseline.layout.sections[i].footers
 if(bindings(index)[selection.variant]!==undefined)throw new WordRecoveryError('word-recovery-review-changed')
 let inherited:string|null=null;for(let i=index-1;i>=0;i--){const value=bindings(i)[selection.variant];if(value!==undefined){inherited=value;break}}
 if(inherited)await requireSavedStorySource(journal,route=>request(route),guard,inherited,baseline.reviewHash);guard()
 const intent={sectionId:selection.sectionId,kind:selection.kind,variant:selection.variant,expectedInheritedStoryId:inherited}
 const story={id:`n_${selection.transactionId}`,kind:selection.kind,sourcePart:`word/hcd-${selection.transactionId}.xml`}
 const response=await request('/word/story-preflight',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Story-Version':'1'},body:JSON.stringify({coordinatorId:journal.scope.lineage,expectedRevision:baseline.revision,actor,intent:{baseLayoutHash:baseline.layoutHash,...intent},story})})
 if(!response.ok){
  if(response.status===422){try{const failure=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,4096,AbortSignal.timeout(30_000),'word-story-error-limit')));if(typeof failure.error==='string'&&failure.error.includes('Word story contains content that cannot be copied safely'))throw new WordRecoveryError('word-story-source-unsupported')}catch(error){if(error instanceof WordRecoveryError)throw error}}
  throw new WordRecoveryError('word-story-preflight-unavailable')
 }
 const preview=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,1024*1024,AbortSignal.timeout(30_000),'word-story-preflight-limit')));guard()
 const saved=await journal.load();guard()
 if(!saved||saved.hash!==baseline.reviewHash||preview.revision!==baseline.revision||preview.rootHash!==saved.capsule.base.rootHash||preview.baseLayoutHash!==baseline.layoutHash||!/^[a-f0-9]{64}$/.test(preview.candidateHash??'')||!Array.isArray(preview.blocks)||preview.blocks.length<1||preview.blocks.length>10000||!preview.copyChoices||!Array.isArray(preview.copyChoices.referenceIds)||!Array.isArray(preview.copyChoices.extensions)||preview.copyChoices.extensions.length||!Array.isArray(preview.impact?.affectedSectionIds)||preview.impact.inheritedStoryId!==inherited)throw new WordRecoveryError('word-story-preflight-invalid')
 const pending:WordPendingStory={actor:{...actor,generation:1},request:{documentId:journal.scope.documentId,transactionId:selection.transactionId,expectedRevision:baseline.revision,baseLayoutHash:baseline.layoutHash,candidateHash:preview.candidateHash,actor},intent,story,blocks:preview.blocks,copyChoices:preview.copyChoices}
 const reviewHash=digest(['hcd-stopped-story-review/1',baseline.reviewHash,pending])
 await authorizeMember();guard();if((await journal.load())?.hash!==baseline.reviewHash)throw new WordRecoveryError('word-recovery-review-changed')
 return{pending,reviewHash,baseline,index,impact:preview.impact}
}
export async function previewStoppedWordStory(options:Options,selection:Selection){
 const value=await candidate(options,selection)
 return{revision:value.baseline.revision,reviewHash:value.reviewHash,transactionId:selection.transactionId,section:value.index+1,kind:selection.kind,variant:selection.variant,inherited:value.pending.intent.expectedInheritedStoryId!==null,affectedSections:value.impact.affectedSectionIds.length,blockCount:value.pending.blocks.length}
}
export async function applyStoppedWordStory(options:Options,selection:Selection,reviewHash:string){
 const value=await candidate(options,selection),guard=()=>{options.assertStopped();options.lease.assert()}
 if(value.reviewHash!==reviewHash)throw new WordRecoveryError('word-recovery-review-changed')
 await options.authorizeMember();guard();await options.journal.prepareStory(value.pending,value.baseline.reviewHash,guard);guard()
 await submitPreparedWordStory({...options,protocol:'hcd-word-regions/2'});guard()
 const result=await promoteStoppedWordStory({...options,protocol:'hcd-word-regions/2'});guard()
 return{revision:result.capsule.base.revision,transactionId:selection.transactionId}
}
