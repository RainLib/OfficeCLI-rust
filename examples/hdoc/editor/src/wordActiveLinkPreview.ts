/** Read-only, live-room link review. No nonce preparation, promotion or room
 * replacement is authorized by this response. Both affected stories stay put. */
import {createHash} from 'node:crypto'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import type {WordRegionProjection} from './wordRegionStore.ts'
import {planWordStoryLink,readWordLinkSelection,type WordLinkSelection,type WordLinkTransaction} from './wordLinkPlan.ts'
import {activeWordStorySource} from './wordActiveStorySource.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
type Options={room:WordSaveCoordinator;journal:WordCheckpointJournal;selection:WordLinkSelection;actor:{userId:string;displayName:string};assertOwnership:()=>void;authorize:()=>Promise<WordTopologyMember>;request:(route:string,init?:RequestInit)=>Promise<Response>;assertHeld?:()=>void}
export async function previewActiveWordLink(options:Options){
 const {room,journal}=options,selection=readWordLinkSelection(options.selection),actor={userId:options.actor.userId,displayName:options.actor.displayName},revision=room.state().revision,base=room.model.layoutState()
 const guard=()=>{options.assertOwnership();if(options.assertHeld)options.assertHeld();else room.assertAcceptingPackets();const current=room.state();if(!room.isLayoutAwareLive()||!room.ownsJournal(journal)||current.problem||current.revision!==revision||room.model.layoutState().layoutHash!==base.layoutHash)throw Error('word-link-review-changed')}
 const authorize=async()=>{requireTopologyMember(await options.authorize(),actor,actor);guard()}
 const json=async(route:string,init?:RequestInit,limit=16*1024*1024)=>{
  const signal=AbortSignal.timeout(30000);guard()
  const response=await awaitRecoveryResponse(()=>options.request(route,{...init,signal}),signal);guard()
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('word-link-preflight-unavailable')}
  const bytes=await readBoundedResponse(response,limit,signal,'word-link-response-limit');guard();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
 }
 await authorize();if(await journal.topologyAbandoned(selection.transactionId))throw Error('word-topology-cancelled');guard()
 const plan=planWordStoryLink(base.layout,selection),[projection,record]=await Promise.all([json(`/editor?revision=${revision}`),json(`/revisions/${revision}`)]) as [WordRegionProjection,{revision:number;rootHash:string}]
 if(projection.documentId!==journal.scope.documentId||projection.revision!==revision||projection.flowLayoutHash!==base.layoutHash||record.revision!==revision||!/^[a-f0-9]{64}$/.test(record.rootHash??''))throw Error('word-link-baseline-invalid')
 const source=activeWordStorySource(room,projection,[plan.retainedStoryId,...(plan.inheritedStoryId?[plan.inheritedStoryId]:[])],guard)
 try{
  source.assertReady()
  const transaction:WordLinkTransaction={schemaVersion:'hcd-word-story-link/1',documentId:journal.scope.documentId,transactionId:selection.transactionId,expectedRevision:revision,actor,link:{baseLayoutHash:base.layoutHash,sectionId:selection.sectionId,kind:selection.kind,variant:selection.variant,expectedDirectStoryId:plan.retainedStoryId}}
  const native=await json('/word/link-preflight',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Story-Version':'1','X-HCD-Word-Link-Version':'1'},body:JSON.stringify({coordinatorId:journal.scope.lineage,transaction})},1024*1024)
  if(!native||Object.keys(native).sort().join(',')!=='affected,baseLayoutHash,candidateLayoutHash,documentId,inheritedStoryId,retainedStoryId,reviewHash,revision,rootHash,schemaVersion,transactionId'||native.schemaVersion!=='hcd-word-link-preflight/1'||native.documentId!==journal.scope.documentId||native.transactionId!==selection.transactionId||native.revision!==revision||native.rootHash!==record.rootHash||native.baseLayoutHash!==base.layoutHash||!/^[a-f0-9]{64}$/.test(native.reviewHash??'')||!/^[a-f0-9]{64}$/.test(native.candidateLayoutHash??'')||native.candidateLayoutHash===base.layoutHash||native.retainedStoryId!==plan.retainedStoryId||native.inheritedStoryId!==plan.inheritedStoryId||!Array.isArray(native.affected)||native.affected.length!==plan.affected.length||native.affected.some((item:any,index:number)=>!item||Object.keys(item).sort().join(',')!=='afterStoryId,beforeStoryId,sectionId'||item.sectionId!==plan.affected[index].sectionId||item.beforeStoryId!==plan.affected[index].beforeStoryId||item.afterStoryId!==plan.affected[index].afterStoryId))throw Error('word-link-preflight-invalid')
  await authorize();source.assertReady()
  const reviewHash=createHash('sha256').update(JSON.stringify(['hcd-active-link-review/1',journal.scope.documentId,journal.scope.epoch,journal.scope.lineage,record.rootHash,transaction,native.reviewHash])).digest('hex')
  return{schemaVersion:'hcd-word-link-preview/1' as const,revision,selection,transaction,pending:{request:transaction,actor:{...actor,generation:1},candidateLayoutHash:native.candidateLayoutHash,reviewHash:native.reviewHash},reviewHash,nativeReviewHash:native.reviewHash,candidateLayoutHash:native.candidateLayoutHash,summary:{inheritedSection:plan.inheritedStoryId===null?null:(base.layout.sections.slice(0,plan.section-1).map((section,index)=>section[selection.kind==='header'?'headers':'footers'][selection.variant]!==undefined?index+1:null).filter(value=>value!==null).at(-1)??null),affectedSectionNumbers:plan.affected.map((_item,index)=>plan.section+index),section:plan.section,retainedStoryId:plan.retainedStoryId,inheritedStoryId:plan.inheritedStoryId,affectedSections:plan.affected.length,contentChanges:plan.affected.length>0}}
 }finally{source.dispose()}
}
