import {useEffect,useRef,useState} from 'react'
import * as Y from 'yjs'
import {api,stageImageAsset,type Session} from './api.ts'
import {nodeResourceJournalIdentity} from './nodeResourceJournal.ts'
import {SemanticImageFiles,type SemanticImageChoice} from './semanticImageFiles.ts'
import {semanticImageTaskBlocked} from './semanticImageTaskBoundary.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {SemanticImageFileClient} from './semanticImageFileClient.ts'
import type {LocalDraftJournal} from './localDrafts.ts'
import type {CollaborativeImageDraftStore} from './collaborativeImages.ts'
import type {PositionedImage} from './imageDrafts.ts'
import {semanticImageScopeMatches} from './semanticImageScope.ts'

/** Device tasks are private and never auto-replayed on open. */
export function useSemanticImageTasks(input:{session:Session;userId:string;localJournal:LocalDraftJournal|null;document:Y.Doc;images:CollaborativeImageDraftStore;ready:()=>boolean;readyAfterApply:()=>boolean;synchronize:(signal:AbortSignal)=>Promise<boolean>}){
 const latest=useRef(input);latest.current=input
 const runtime=useRef<{files:SemanticImageFiles|null;client:SemanticImageFileClient|null;loading:boolean;problem:boolean;running:number;choices:SemanticImageChoice[];sequence:number;alive:boolean;inScope:()=>boolean;channel?:BroadcastChannel}>({files:null,client:null,loading:!!input.localJournal,problem:!input.localJournal&&input.session.scope!=='read',running:0,choices:[],sequence:0,alive:true,inScope:()=>false})
 const [,render]=useState(0),[retry,setRetry]=useState(0);const emit=()=>render(value=>value+1)
 async function refresh(){const state=runtime.current;if(!state.inScope()||!state.files)return true;const sequence=++state.sequence
  try{const choices=await state.files.list();if(state.inScope()&&sequence===state.sequence){state.choices=choices;state.loading=false;state.problem=false;emit()}return !state.inScope()||choices.length>0}
  catch{if(state.inScope()&&sequence===state.sequence){state.loading=false;state.problem=true;emit()}return true}
 }
 useEffect(()=>{
  let live=true,files:SemanticImageFiles|undefined,client:SemanticImageFileClient|undefined,channel:BroadcastChannel|undefined
  const state={files:null,client:null,loading:!!input.localJournal,problem:false,running:0,choices:[],sequence:0,alive:true,inScope:()=>false} as typeof runtime.current;runtime.current=state;emit()
  const bound={session:{...input.session},userId:input.userId,document:input.document,localJournal:input.localJournal}
  const inScope=()=>live&&state.alive&&runtime.current===state&&semanticImageScopeMatches(bound,latest.current)
  state.inScope=inScope
  const current=()=>{if(!inScope())throw new Error('semantic-image-choice-unavailable');return latest.current}
  if(!input.localJournal){state.problem=input.session.scope!=='read';emit();return}
  void(async()=>{const name=await nodeResourceJournalIdentity(bound.session,bound.userId,location.href);files=await SemanticImageFiles.open(name);if(!inScope()){await files.close();return}
   client=new SemanticImageFileClient(files,input.document,{ready:()=>inScope()&&latest.current.ready(),readyAfterApply:()=>inScope()&&latest.current.readyAfterApply(),apply:(capture,hash,id)=>current().images.applyCapturedReplacement(capture,hash,id),flush:()=>current().localJournal!.flush(),synchronize:signal=>current().synchronize(signal),verify:async(choice,signal)=>{
    const result=await(await api(current().session,`/images/${encodeURIComponent(choice.base.nodeId)}`,{signal})).json() as {image:PositionedImage|null};if(!result.image||result.image.nodeId!==choice.base.nodeId||result.image.visualHash!==choice.base.visualHash)throw new Error('semantic-image-choice-target-changed')
   },stage:(choice,signal)=>stageImageAsset(current().session,choice.extension,new Blob([Uint8Array.from(choice.bytes)]),signal,choice.hash)})
   if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel(name+'-images');channel.onmessage=()=>{void refresh()}}
   state.files=files;state.client=client;state.channel=channel;await refresh()
  })().catch(()=>{if(inScope()){state.loading=false;state.problem=true;emit()}})
  const focus=()=>{void refresh()};window.addEventListener('focus',focus)
  return()=>{live=false;state.alive=false;window.removeEventListener('focus',focus);channel?.close();client?.dispose();void files?.close()}
 },[input.session.documentId,input.session.userId,input.session.apiUrl,input.session.collabUrl,input.session.collaborationProtocol,input.session.collaborationEpoch,input.session.flowLayoutVersion,input.session.format,input.userId,input.localJournal,input.document,retry])
 async function capture(){const s=runtime.current;if(!s.inScope()||s.loading||s.problem||s.running||!s.files)throw new Error('recoveryArchiveFileBusy');const files=await s.files.list();if(!s.inScope()||s.loading||s.problem||s.running)throw new Error('recoveryArchiveFileBusy');return files}
 async function importChoices(choices:readonly SemanticImageChoice[]){const state=runtime.current;if(!navigator.locks||!state.inScope()||!state.files||state.loading||state.problem||state.running)throw new Error('recoveryArchiveFileBusy');state.running++;emit()
  try{return await state.files.importChoices(choices)}finally{state.running--;if(state.inScope()){state.channel?.postMessage('changed');await refresh();emit()}}
 }
 async function run<T>(work:(client:SemanticImageFileClient,state:typeof runtime.current)=>Promise<T>){const state=runtime.current;if(!state.inScope()||!state.client||state.loading||state.problem)throw new Error('semantic-image-choice-unavailable');state.running++;emit()
  try{return await work(state.client,state)}finally{state.running--;if(state.inScope()){state.channel?.postMessage('changed');await refresh();emit()}}
 }
 return {capture,importChoices,isBusy:()=>{const s=runtime.current;return !s.inScope()||s.loading||s.problem||s.running>0||!s.files},choices:runtime.current.inScope()?runtime.current.choices:[],loading:runtime.current.loading,problem:runtime.current.problem,busy:runtime.current.running>0,pending:()=>{const s=runtime.current;return !s.inScope()||s.loading||s.problem||s.running>0||s.choices.length>0},checkPending:async()=>{const s=runtime.current;if(!s.inScope())return true;if(!s.files&&latest.current.session.scope==='read')return false;if(!s.files)return true;return semanticImageTaskBlocked(s,()=>s.inScope(),refresh)},refresh,retry:()=>setRetry(value=>value+1),choose:(file:File,image:PositionedImage,revision:number)=>run(async(client,state)=>{const capture=latest.current.images.captureReplacement(image,revision);const choice=await client.choose(file,capture);if(state.inScope())state.channel?.postMessage('changed');await client.resume(choice.id)}),resume:(id:string)=>run(client=>client.resume(id)),cancel:(id:string)=>run(client=>client.cancel(id)),discardUncertain:(id:string)=>run(client=>client.discardUncertain(id)),download:async(choice:SemanticImageChoice)=>{const s=runtime.current;if(!s.inScope())throw new Error('semantic-image-choice-unavailable');if(await imageFileHash(choice.bytes)!==choice.hash)throw new Error('semantic-image-choice-integrity');if(!s.inScope())throw new Error('semantic-image-choice-unavailable');const url=URL.createObjectURL(new Blob([Uint8Array.from(choice.bytes)])),a=document.createElement('a');a.href=url;a.download=choice.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}}
}
