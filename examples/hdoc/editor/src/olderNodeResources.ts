/** Discover only earlier file journals in the current member/document scope.
 * Copying creates a private pending task; it never links a node or edits Yjs. */
import type {Session} from './api.ts'
import {inlineProtocol,structuralProtocol} from './collaborationProtocol.ts'
import {draftIdentity} from './localDrafts.ts'
import {NodeResourceJournal} from './nodeResourceJournal.ts'
import {nodeResourceHash,type WordNodeResourceDraft} from './wordNodeResources.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
import {stableExtension} from './extensionRegistry.ts'

export type OlderFileChoice={epoch:number;id:string;name:string;target:string;source:string;fingerprint:string}
async function checkedName(session:Session,userId:string,base:string,epoch:number){
 if(!Number.isSafeInteger(epoch)||epoch<0||epoch>=(session.collaborationEpoch??0)||![structuralProtocol,inlineProtocol].includes(session.collaborationProtocol as typeof structuralProtocol|typeof inlineProtocol))throw Error('older-node-resource-scope')
 return (await draftIdentity({...session,collaborationEpoch:epoch},userId,base)).name+'-nodefiles1'
}
const fingerprint=(draft:WordNodeResourceDraft<ResourceNodePayload>)=>stableExtension({...draft,bytes:[]})
async function open(session:Session,name:string,factory:IDBFactory){return NodeResourceJournal.openEditor(name,session.collaborationProtocol,factory)}
export async function listOlderNodeResources(session:Session,userId:string,base:string,factory:IDBFactory=indexedDB):Promise<OlderFileChoice[]>{
 const current=await draftIdentity(session,userId,base),suffix=session.collaborationProtocol===inlineProtocol?'-inlinecontainers1-nodefiles1':'-structure3-nodefiles1',found:OlderFileChoice[]=[]
 if(typeof factory.databases!=='function')throw Error('older-node-resource-unavailable')
 for(const db of await factory.databases()){
  if(!db.name?.startsWith(current.prefix)||!db.name.endsWith(suffix))continue
  const raw=db.name.slice(current.prefix.length,-suffix.length);if(!/^(0|[1-9][0-9]*)$/.test(raw))continue
  const epoch=Number(raw);if(!Number.isSafeInteger(epoch)||epoch>=current.epoch||db.name!==await checkedName(session,userId,base,epoch))continue
  const journal=await open(session,db.name,factory);try{for(const draft of await journal.pendingNodeResources())found.push({epoch,id:draft.id,name:draft.resource.name,target:draft.expected.fallback.text,source:db.name,fingerprint:fingerprint(draft)})}finally{await journal.close()}
 }
 return found.sort((a,b)=>b.epoch-a.epoch||a.id.localeCompare(b.id))
}
export async function readOlderNodeResource(session:Session,userId:string,base:string,choice:OlderFileChoice,factory:IDBFactory=indexedDB){
 if(choice.source!==await checkedName(session,userId,base,choice.epoch))throw Error('older-node-resource-scope')
 const existing=await factory.databases();if(!existing.some(db=>db.name===choice.source))throw Error('older-node-resource-changed')
 const journal=await open(session,choice.source,factory);try{
  const draft=(await journal.pendingNodeResources()).find(value=>value.id===choice.id)
  if(!draft||fingerprint(draft)!==choice.fingerprint||await nodeResourceHash(draft.bytes)!==draft.resource.hash)throw Error('older-node-resource-changed')
  const hash=await nodeResourceHash(new TextEncoder().encode(`hcd-older-node-file/1:${choice.source}:${draft.id}`)),raw=hash.slice(0,32),id=`${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`
  return {...structuredClone(draft),id,phase:'chosen' as const}
 }finally{await journal.close()}
}
