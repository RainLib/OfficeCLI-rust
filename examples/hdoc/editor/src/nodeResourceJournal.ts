/** File tasks are independent of a chosen text recovery copy. A fresh copy
 * must still find the same member/document/epoch's uncompleted file choices. */
import {withDeviceFileLock} from './regionalFileBoundary.ts'
import {draftIdentity} from './localDrafts.ts'
import {structuralProtocol,inlineProtocol} from './collaborationProtocol.ts'
import type {Session} from './api.ts'
import {NodeResourceMetadata,resourceRequest,resourceTransaction} from './nodeResourceStorage.ts'
import {ordinaryNodeResourceModel,inlineNodeResourceModel,type ResourceNodePayload,type NodeResourceModel} from './nodeResourceModel.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
export async function nodeResourceJournalIdentity(session:Session,userId:string,base:string){
 if(session.collaborationProtocol!==structuralProtocol&&session.collaborationProtocol!==inlineProtocol)throw new Error('word-node-resource-protocol')
 return (await draftIdentity(session,userId,base)).name+'-nodefiles1'
}
export class NodeResourceJournal<P extends ResourceNodePayload=ExtensionNodePayload>{
 private pending:Promise<unknown>=Promise.resolve()
 private closed=false
 private closing:Promise<void>|undefined
 private publications=new Set<Promise<unknown>>()
 private metadata:NodeResourceMetadata<P>
 private constructor(readonly name:string,private db:IDBDatabase,model:NodeResourceModel<P>){this.metadata=new NodeResourceMetadata({read:work=>resourceTransaction(db,'readonly',work),write:work=>this.write(work)},model)}
 static async open(name:string,factory:IDBFactory=indexedDB){
  if(!/^hcd-local-draft-v1-[a-f0-9]{64}-(0|[1-9][0-9]*)-structure3-nodefiles1$/.test(name))throw new Error('word-node-resource-scope')
  return NodeResourceJournal.openModel(name,factory,ordinaryNodeResourceModel)
 }
 static async openInline(name:string,factory:IDBFactory=indexedDB){
  if(!/^hcd-local-draft-v1-[a-f0-9]{64}-(0|[1-9][0-9]*)-inlinecontainers1-nodefiles1$/.test(name))throw new Error('word-node-resource-scope')
  return NodeResourceJournal.openModel(name,factory,inlineNodeResourceModel)
 }
 static async openEditor(name:string,protocol:Session['collaborationProtocol'],factory:IDBFactory=indexedDB){
  if(protocol!==structuralProtocol&&protocol!==inlineProtocol)throw new Error('word-node-resource-protocol')
  const suffix=protocol===inlineProtocol?'inlinecontainers1':'structure3'
  if(!new RegExp(`^hcd-local-draft-v1-[a-f0-9]{64}-(0|[1-9][0-9]*)-${suffix}-nodefiles1$`).test(name))throw new Error('word-node-resource-scope')
  return NodeResourceJournal.openModel<ResourceNodePayload>(name,factory,protocol===inlineProtocol?inlineNodeResourceModel:ordinaryNodeResourceModel)
 }
 private static async openModel<P extends ResourceNodePayload>(name:string,factory:IDBFactory,model:NodeResourceModel<P>){const request=factory.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('meta');return new NodeResourceJournal(name,await resourceRequest(request),model)}
 private write<T>(work:(store:IDBObjectStore)=>Promise<T>){
  if(this.closed)return Promise.reject(new Error('word-node-resource-closed'))
  const result=this.pending.then(()=>resourceTransaction(this.db,'readwrite',work));this.pending=result.catch(()=>{});return result
 }
 private publish<T>(work:()=>Promise<T>):Promise<T>{
  if(this.closing||this.closed)return Promise.reject(new Error('word-node-resource-closed'))
  const result=withDeviceFileLock(this.name,work);this.publications.add(result);void result.finally(()=>this.publications.delete(result)).catch(()=>{});return result
 }
 importNodeResources:NodeResourceMetadata<P>['importNodeResources']=value=>this.publish(()=>this.metadata.importNodeResources(value))
 repairNodeResources:NodeResourceMetadata<P>['repairNodeResources']=(value,guard)=>this.publish(()=>this.metadata.repairNodeResources(value,guard))
 pendingNodeResources=()=>this.metadata.pendingNodeResources()
 putNodeResource:NodeResourceMetadata<P>['putNodeResource']=value=>this.publish(()=>this.metadata.putNodeResource(value))
 stageNodeResource:NodeResourceMetadata<P>['stageNodeResource']=value=>this.metadata.stageNodeResource(value)
 finishNodeResource:NodeResourceMetadata<P>['finishNodeResource']=(id,phase)=>this.metadata.finishNodeResource(id,phase)
 async flush(){await this.pending}
 close(){if(this.closing)return this.closing;if(this.closed)return Promise.resolve();this.closing=(async()=>{await Promise.allSettled([...this.publications]);this.closed=true;try{await this.pending}finally{this.db.close()}})();return this.closing}
}
