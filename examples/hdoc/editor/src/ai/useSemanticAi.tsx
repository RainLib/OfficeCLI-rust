import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {Editor} from '@tiptap/core'
import type {Session} from '../api.ts'
import {AiSuggestionController} from './core.ts'
import {createSemanticAiAdapter,canAiSelection,type SemanticAiStore} from './semantic.ts'
import {useAiConfiguration} from './react.tsx'
import type {AiComposerEntry} from './Composer.tsx'
import type {AiSnapshot} from './types.ts'
import type {AiAutocompleteService} from './useAutocomplete.tsx'

const idle:AiSnapshot=Object.freeze({phase:'idle',requestId:null,output:'',source:''})
const emptySubscribe=()=>()=>{},emptySnapshot=()=>idle
/** Shared UI lifecycle; the adapter is pinned to one editor/region. A late
 * provider result cannot follow a mutable active-editor ref into another story. */
export function useSemanticAi(options:{editor:Editor|null;scope?:string;session:Session;store:(editor:Editor)=>SemanticAiStore|undefined;canWrite:boolean;revision:number|null;locale:string;history:{stopCapturing:()=>void}}){
 const configuration=useAiConfiguration(),latest=useRef(options);latest.current=options
 const autocomplete=useRef<AiAutocompleteService|null>(null)
 const [enabled,setEnabled]=useState(configuration.autocomplete.enabled)
 const [entry,setEntry]=useState<{editor:Editor;value:AiComposerEntry}|null>(null)
 const runtime=useMemo(()=>{
  const editor=options.editor,provider=configuration.provider
  if(!editor||!provider)return null
  const adapter=(requireCaret=false)=>createSemanticAiAdapter({session:options.session,requireCaret,editor:()=>editor,store:()=>latest.current.store(editor),canWrite:()=>latest.current.editor===editor&&latest.current.scope===options.scope&&latest.current.canWrite&&(!requireCaret||autocomplete.current?.eligible()===true),revision:()=>latest.current.revision,locale:()=>latest.current.locale,history:options.history})
  return{manual:new AiSuggestionController(provider,adapter(),configuration.options),automatic:configuration.autocomplete.available?new AiSuggestionController(provider,adapter(true),{...configuration.options,limits:{timeoutMs:Math.min(configuration.options.limits?.timeoutMs??120000,15000),maxOutput:Math.min(configuration.options.limits?.maxOutput??16000,configuration.autocomplete.maxOutput),maxEvents:Math.min(configuration.options.limits?.maxEvents??20000,2048)}}):null}
 },[options.editor,options.scope,options.session,options.history,configuration])
 const controller=runtime?.manual??null,automatic=runtime?.automatic??null
 const state=useSyncExternalStore(controller?.subscribe??emptySubscribe,controller?.snapshot??emptySnapshot,emptySnapshot)
 const autoState=useSyncExternalStore(automatic?.subscribe??emptySubscribe,automatic?.snapshot??emptySnapshot,emptySnapshot)
 useEffect(()=>controller?.connect(),[controller])
 useEffect(()=>{setEnabled(configuration.autocomplete.enabled)},[configuration.autocomplete.enabled])
 useEffect(()=>{setEntry(null);return()=>{automatic?.dispose()}},[options.editor,controller,automatic])
 useEffect(()=>{
  const editor=options.editor;if(!editor||!controller)return
  const changed=()=>controller.invalidate();editor.on('transaction',changed)
  return()=>{editor.off('transaction',changed)}
 },[options.editor,controller])
 useEffect(()=>{if(!options.canWrite){controller?.invalidate();automatic?.invalidate();setEntry(null)}},[options.canWrite,controller,automatic])
 const composer=entry?.editor===options.editor?entry.value:null
 const can=(mode:'replace'|'insert')=>!!controller&&options.canWrite&&!!options.editor&&!options.editor.isDestroyed&&options.editor.isEditable&&!!options.store(options.editor)?.initialized&&canAiSelection(options.editor.state,mode)
 const open=()=>{const editor=latest.current.editor;if(!editor||editor.isDestroyed)return;autocomplete.current?.dismiss();setEntry({editor,value:{id:crypto.randomUUID(),bookmark:editor.state.selection.getBookmark()}})}
 const close=()=>{controller?.cancel();setEntry(null)}
 return{configuration,controller,automatic,state,autoState,enabled,setEnabled,autocomplete,composer,can,open,close,
  start:(actionId:string,instruction='')=>{const action=configuration.actions.find(action=>action.id===actionId);if(!controller||!action||!can(action.mode))return false;autocomplete.current?.dismiss();if(!composer)open();void controller.start(action,instruction);return true},
  accept:async(requestId:string)=>{const applied=await controller?.accept(requestId)??false;if(applied)setEntry(null);return applied}}
}
