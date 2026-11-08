/** Read-only preflight against a live layout-aware owner. Never reload its
 * shared journal or pause members merely to inspect a possible story copy. */
import {createHash} from 'node:crypto'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {wordStoryPendingHash,type WordCheckpointJournal,type WordPendingStory} from './wordCheckpointJournal.ts'
import type {WordRegionProjection} from './wordRegionStore.ts'
import {activeWordStorySource} from './wordActiveStorySource.ts'
import {readWordLayout} from './wordRegions.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {readBoundedResponse} from './boundedResponse.ts'

export type ActiveStorySelection={sectionId:string;kind:'header'|'footer';variant:'default'|'first'|'even';transactionId:string}
type Options={room:WordSaveCoordinator;journal:WordCheckpointJournal;selection:ActiveStorySelection;actor:{userId:string;displayName:string};assertOwnership:()=>void;authorize:()=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>;assertHeld?:()=>void}
export function readActiveStorySelection(value:unknown):ActiveStorySelection{
 const v=value as ActiveStorySelection
 if(!v||Object.keys(v).sort().join(',')!=='kind,sectionId,transactionId,variant'||!/^n_[a-f0-9]{32}$/.test(v.sectionId)||!/^[a-f0-9]{32}$/.test(v.transactionId)||!['header','footer'].includes(v.kind)||!['default','first','even'].includes(v.variant))throw Error('word-story-selection-invalid')
 return{sectionId:v.sectionId,kind:v.kind,variant:v.variant,transactionId:v.transactionId}
}
export async function previewActiveWordStory(options:Options){
 const {room,journal}=options,selection=readActiveStorySelection(options.selection),actor={...options.actor}
 const initial=room.state(),layoutState=room.model.layoutState(),revision=initial.revision,layoutHash=layoutState.layoutHash
 const guard=()=>{
  options.assertOwnership();if(options.assertHeld)options.assertHeld();else room.assertAcceptingPackets()
  const current=room.state()
  if(!room.isLayoutAwareLive()||!room.ownsJournal(journal)||current.problem||current.revision!==revision||room.model.layoutState().layoutHash!==layoutHash)throw Error('word-story-review-changed')
 }
 const authorize=async()=>{requireTopologyMember(await options.authorize(),actor,actor);guard()}
 const json=async(route:string,init?:RequestInit,limit=16*1024*1024)=>{
  guard();const response=await options.request(route,init);guard()
  if(!response.ok){
   if(response.status===422){const error=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,4096,AbortSignal.timeout(30000),'word-story-response-limit')));guard();if(typeof error.error==='string'&&error.error.includes('Word story contains content that cannot be copied safely'))throw Error('word-story-source-unsupported')}
   throw Error('word-story-preflight-unavailable')
  }
  const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,limit,AbortSignal.timeout(30000),'word-story-response-limit')));guard();return result
 }
 await authorize()
 if(await journal.topologyAbandoned(selection.transactionId))throw Error('word-topology-cancelled');guard()
 const layout=layoutState.layout,index=layout.sections.findIndex(s=>s.id===selection.sectionId)
 if(index<0)throw Error('word-story-selection-invalid')
 const bindings=(i:number)=>selection.kind==='header'?layout.sections[i].headers:layout.sections[i].footers
 if(bindings(index)[selection.variant]!==undefined)throw Error('word-story-already-independent')
 let inherited:string|null=null
 for(let i=index-1;i>=0;i--){const value=bindings(i)[selection.variant];if(value!==undefined){inherited=value;break}}
 const affectedSections:string[]=[]
 for(let i=index;i<layout.sections.length;i++){if(i>index&&bindings(i)[selection.variant]!==undefined)break;affectedSections.push(layout.sections[i].id)}
 const projection=await json(`/editor?revision=${revision}`) as WordRegionProjection,record=await json(`/revisions/${revision}`)
 readWordLayout({layout:projection.flowLayout,layoutHash:projection.flowLayoutHash,revision:projection.revision},revision,2)
 if(projection.documentId!==journal.scope.documentId||projection.flowLayoutHash!==layoutHash||record.revision!==revision||!/^[a-f0-9]{64}$/.test(record.rootHash??''))throw Error('word-story-baseline-invalid')
 const source=activeWordStorySource(room,projection,inherited?[inherited]:[],guard),sourceReady=()=>source.assertReady()
 try{
  sourceReady()
  const intent={sectionId:selection.sectionId,kind:selection.kind,variant:selection.variant,expectedInheritedStoryId:inherited},story={id:`n_${selection.transactionId}`,kind:selection.kind,sourcePart:`word/hcd-${selection.transactionId}.xml`}
  const preview=await json('/word/story-preflight',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Story-Version':'1'},body:JSON.stringify({coordinatorId:journal.scope.lineage,expectedRevision:revision,actor,intent:{baseLayoutHash:layoutHash,...intent},story})},1024*1024)
  if(preview.revision!==revision||preview.rootHash!==record.rootHash||preview.baseLayoutHash!==layoutHash||!/^[a-f0-9]{64}$/.test(preview.candidateHash??'')||!Array.isArray(preview.blocks)||!preview.blocks.length||preview.blocks.length>10000||preview.blocks.some((b:any)=>b.flowRegionId!==story.id||b.region!==selection.kind)||!preview.copyChoices||!Array.isArray(preview.copyChoices.referenceIds)||!Array.isArray(preview.copyChoices.extensions)||preview.copyChoices.extensions.length||preview.impact?.inheritedStoryId!==inherited||JSON.stringify(preview.impact.affectedSectionIds)!==JSON.stringify(affectedSections))throw Error('word-story-preflight-invalid')
  const pending:WordPendingStory={actor:{...actor,generation:1},request:{documentId:journal.scope.documentId,transactionId:selection.transactionId,expectedRevision:revision,baseLayoutHash:layoutHash,candidateHash:preview.candidateHash,actor},intent,story,blocks:preview.blocks,copyChoices:preview.copyChoices}
  if(Buffer.byteLength(JSON.stringify(pending))>900*1024)throw Error('word-story-response-limit')
  await authorize();sourceReady()
  const reviewHash=createHash('sha256').update(JSON.stringify(['hcd-active-story-review/1',journal.scope.documentId,journal.scope.epoch,journal.scope.lineage,record.rootHash,wordStoryPendingHash(pending)])).digest('hex')
  return{schemaVersion:'hcd-word-story-preview/1' as const,revision,reviewHash,selection,pending,summary:{section:index+1,inherited:inherited!==null,affectedSections:affectedSections.length,blockCount:pending.blocks.length}}
 }finally{source.dispose()}
}
