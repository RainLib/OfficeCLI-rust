import {withDeviceFileLock} from './regionalFileBoundary.ts'
import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {NodeResourceJournal,nodeResourceJournalIdentity} from './nodeResourceJournal.ts'
import {WordNodeResourceClient,InlineNodeResourceClient,NodeResourceClient,type NodeResourceCache} from './wordNodeResources.ts'
import type {LocalDraftJournal} from './localDrafts.ts'
import type {Session} from './api.ts'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
import {ordinaryNodeResourceModel,inlineNodeResourceModel,type ResourceNodePayload} from './nodeResourceModel.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import {inlineProtocol,structuralProtocol} from './collaborationProtocol.ts'
import {semanticImageScopeMatches} from './semanticImageScope.ts'
const noop=()=>()=>{},zero=()=>0
type ResourceHost={session:Session;userId:string;localJournal:LocalDraftJournal|null;registry:Pick<NodeExtensionRegistry,'archiveResource'>;ready:()=>boolean}
type ResourceMode<P extends ResourceNodePayload>={protocol:Session['collaborationProtocol'];open:(name:string)=>Promise<NodeResourceJournal<P>>;create:(options:{cache:NodeResourceCache<P>;registry:ResourceHost['registry'];ready:()=>boolean;available:()=>boolean;notify:()=>void})=>NodeResourceClient<P>}
const ordinary:ResourceMode<ExtensionNodePayload>={protocol:structuralProtocol,open:NodeResourceJournal.open,create:options=>new WordNodeResourceClient(options)}
const inline:ResourceMode<ResourceNodePayload>={protocol:inlineProtocol,open:NodeResourceJournal.openInline,create:options=>new InlineNodeResourceClient(options)}
const editorOrdinary:ResourceMode<ResourceNodePayload>={protocol:structuralProtocol,open:name=>NodeResourceJournal.openEditor(name,structuralProtocol),create:options=>new NodeResourceClient(options,ordinaryNodeResourceModel)}
export function useSemanticNodeResources(host:ResourceHost){return useNodeResources(host,ordinary)}
export function useInlineNodeResources(host:ResourceHost){return useNodeResources(host,inline)}
/** Effective authority selects the runtime parser, never the payload's own
 * declaration. Ordinary rooms still reject envelope3 in the wider UI type. */
export function useEditorNodeResources(host:ResourceHost){return useNodeResources(host,host.session.collaborationProtocol===inlineProtocol?inline:editorOrdinary)}
function useNodeResources<P extends ResourceNodePayload>({session,userId,localJournal,registry,ready}:ResourceHost,mode:ResourceMode<P>){
 const latest=useRef({registry,ready,session,userId,localJournal});latest.current={registry,ready,session,userId,localJournal}
 const runtime=useRef<{client:NodeResourceClient<P>|null;loading:boolean;problem:boolean;inScope:()=>boolean;name?:string}>({client:null,loading:!!localJournal,problem:false,inScope:()=>false})
 const [version,render]=useState(0),[retry,setRetry]=useState(0)
 useEffect(()=>{
  let live=true,owned:NodeResourceJournal<P>|undefined,client:NodeResourceClient<P>|undefined,channel:BroadcastChannel|undefined
  const bound={session:{...session},userId,document:registry,localJournal},inScope=()=>live&&semanticImageScopeMatches(bound,{...latest.current,document:latest.current.registry})
  runtime.current={client:null,loading:!!localJournal,problem:false,inScope};render(value=>value+1)
  if(!localJournal)return
  void(async()=>{
   if(session.collaborationProtocol!==mode.protocol)throw new Error('word-node-resource-protocol')
   const name=await nodeResourceJournalIdentity(bound.session,userId,location.href),journal=await mode.open(name);owned=journal
   if(!inScope()){await journal.close();return}
   channel=typeof BroadcastChannel==='undefined'?undefined:new BroadcastChannel(name)
   const cache={repairNodeResources:journal.repairNodeResources,importNodeResources:journal.importNodeResources,pendingNodeResources:journal.pendingNodeResources,putNodeResource:journal.putNodeResource,stageNodeResource:journal.stageNodeResource,finishNodeResource:journal.finishNodeResource,flush:async()=>{await localJournal.flush();await journal.flush()}}
   client=mode.create({cache,registry:{archiveResource:async input=>{if(!inScope())throw new Error('word-node-resource-unavailable');const result=await latest.current.registry.archiveResource(input);if(!inScope())throw new Error('word-node-resource-unavailable');return result}},ready:()=>inScope()&&latest.current.ready(),available:inScope,notify:()=>{if(inScope())channel?.postMessage('changed')}})
   runtime.current={client,loading:false,problem:false,name,inScope};if(channel)channel.onmessage=()=>{if(inScope())void client?.refresh()};render(value=>value+1);await client.initialize()
  })().catch(()=>{if(inScope()){runtime.current={client:null,loading:false,problem:true,inScope};render(value=>value+1)}})
  const focus=()=>{if(inScope())void client?.refresh()};window.addEventListener('focus',focus)
  return()=>{live=false;window.removeEventListener('focus',focus);channel?.close();client?.dispose();void owned?.close()}
 },[localJournal,registry,session.documentId,session.userId,session.apiUrl,session.collabUrl,session.collaborationProtocol,session.collaborationEpoch,session.flowLayoutVersion,session.format,userId,retry,mode])
 const client=runtime.current.inScope()?runtime.current.client:null,snapshot=useSyncExternalStore(client?.subscribe??noop,client?.snapshot??zero)
 return{client,withFileLock:<T,>(work:()=>Promise<T>,signal?:AbortSignal)=>{const state=runtime.current;if(!state.inScope())return Promise.reject(new Error('word-node-resource-unavailable'));const checked=()=>{signal?.throwIfAborted();if(!state.inScope())throw new Error('word-node-resource-unavailable');return work()};return state.name?withDeviceFileLock(state.name,checked,signal):checked()},version:version+snapshot,pending:()=>!runtime.current.inScope()||runtime.current.loading||runtime.current.problem||runtime.current.client?.state().pending===true,problem:runtime.current.problem,retry:()=>setRetry(value=>value+1)}
}
