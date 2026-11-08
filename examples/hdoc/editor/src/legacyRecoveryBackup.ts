import {validateNodeResources} from './extensionPortable.ts'
import {nodeResourceHash,pendingNodeResource,type WordNodeResourceDraft} from './wordNodeResources.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
import * as Y from 'yjs'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

function base64(bytes:Uint8Array){const chunks:string[]=[];for(let offset=0;offset<bytes.length;offset+=8192)chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+8192)));return btoa(chunks.join(''))}
const equalBytes=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((value,index)=>value===b[index])
function equalFiles(a:readonly WordNodeResourceDraft<ResourceNodePayload>[],b:readonly WordNodeResourceDraft<ResourceNodePayload>[]){
 if(a.length!==b.length)return false
 const left=[...a].sort((x,y)=>x.id.localeCompare(y.id)),right=[...b].sort((x,y)=>x.id.localeCompare(y.id))
 return left.every((file,index)=>{const other=right[index],{bytes,...meta}=file,{bytes:otherBytes,...otherMeta}=other;return bytes instanceof Uint8Array&&otherBytes instanceof Uint8Array&&equalBytes(bytes,otherBytes)&&JSON.stringify(meta)===JSON.stringify(otherMeta)})
}
/** Capture a stable pair while the caller holds the device file boundary. A
 * changing live room can be retried; no snapshot is published on failure. */
export async function captureLegacyRecovery(document:Y.Doc,readFiles:()=>Promise<WordNodeResourceDraft<ResourceNodePayload>[]>,signal:AbortSignal){
 for(let attempt=0;attempt<3;attempt++){
  signal.throwIfAborted();const before=Y.encodeStateAsUpdate(document),files=await awaitRecoveryPreparation(readFiles,signal);signal.throwIfAborted();const again=await awaitRecoveryPreparation(readFiles,signal);signal.throwIfAborted();const after=Y.encodeStateAsUpdate(document)
  if(equalBytes(before,after)&&equalFiles(files,again))return{state:before,files}
 }
 throw Error('legacy-recovery-changed')
}

/** This legacy format remains a raw device copy, not an import or a grant of
 * authority. Verify selected files before claiming their bytes are preserved. */
export async function legacyRecoveryBackup(documentId:string,epoch:number,state:Uint8Array,files:readonly WordNodeResourceDraft<ResourceNodePayload>[],signal:AbortSignal=new AbortController().signal){
 signal.throwIfAborted()
 const crdt=Uint8Array.from(state),captured=structuredClone(files)
 for(const file of captured){
  try{validateNodeResources([file.resource])}catch{throw Error('word-node-resource-integrity')}
  if(!pendingNodeResource(file)||!(file.bytes instanceof Uint8Array)||file.bytes.length!==file.resource.byteLength||await awaitRecoveryPreparation(()=>nodeResourceHash(file.bytes),signal)!==file.resource.hash)throw Error('word-node-resource-integrity')
 }
 signal.throwIfAborted()
 return {schemaVersion:'hcd-recovery/1',documentId,collaborationEpoch:epoch,crdt:base64(crdt),...(captured.length?{nodeResources:captured.map(value=>({...value,bytes:Array.from(value.bytes)}))}:{})}
}
