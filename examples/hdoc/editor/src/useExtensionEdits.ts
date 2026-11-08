import {useEffect,useMemo,useState} from 'react'
import type * as Y from 'yjs'
import {extensionEditIndex,materializeExtensionEdits,nodeEditFields} from './extensionEdits.ts'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {inlineContainerEditIndex,materializeInlineContainerEdits,inlineContainerEditFields} from './inlineContainerEdits.ts'
const ordinary={fields:nodeEditFields,index:extensionEditIndex,materialize:materializeExtensionEdits}
const inline={fields:inlineContainerEditFields,index:inlineContainerEditIndex,materialize:materializeInlineContainerEdits}
/** Read-only subscriptions never publish derived data; compatible writable
 * hosts alone render business-specific fallback text for an exact intent set. */
export function useExtensionEdits(document:Y.Doc,registry:NodeExtensionRegistry,canWrite:boolean){
 return usePropertyEdits(document,registry,canWrite,ordinary)
}
export function useInlineContainerEdits(document:Y.Doc,registry:InlineContainerRegistry,canWrite:boolean){
 return usePropertyEdits(document,registry,canWrite,inline)
}
function usePropertyEdits<R extends {snapshot:()=>number;error:(error:unknown)=>void},G>(document:Y.Doc,registry:R,canWrite:boolean,protocol:{fields:{intents:string;materialized:string};index:(document:Y.Doc)=>Map<string,G>;materialize:(document:Y.Doc,registry:R)=>void}){
 const [version,setVersion]=useState(0),registryVersion=registry.snapshot()
 useEffect(()=>{const maps=[document.getMap(protocol.fields.intents),document.getMap(protocol.fields.materialized)],change=()=>setVersion(n=>n+1);maps.forEach(map=>map.observe(change));change();return()=>maps.forEach(map=>map.unobserve(change))},[document,protocol])
 useEffect(()=>{if(!canWrite)return;let alive=true,queued=false;const run=()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;if(!alive)return;try{protocol.materialize(document,registry)}catch(error){registry.error(error)}})};document.on('afterTransaction',run);run();return()=>{alive=false;document.off('afterTransaction',run)}},[document,registry,registryVersion,canWrite,protocol])
 // Version makes the subscription intentional even when the projected payload
 // is unchanged (e.g. a second equal candidate or a newly disputed field).
 return useMemo(()=>protocol.index(document),[document,version,protocol])
}
