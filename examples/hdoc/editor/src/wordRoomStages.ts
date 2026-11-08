/** Private, one-use host permits for a layout-aware room installed behind an
 * exact held transaction. None of these permits is a client authentication
 * token. The host still gates every connection and packet independently. */
import type {Document,Hocuspocus} from '@hocuspocus/server'
import {WordRoomBinding} from './wordRoomBinding.ts'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

type Host=Pick<Hocuspocus,'documents'|'loadingDocuments'|'unloadingDocuments'|'shouldUnloadDocument'|'unloadDocument'>
type Spec={name:string;id:string;operation:string;identity:string;gate:RoomMigrationGate;lease:{assert:()=>void};binding:WordRoomBinding;assertSource:()=>void}
type Stage=Spec&{context:object;document?:Document;owner?:WordSaveCoordinator;rollback:boolean;checked:boolean;finished:boolean;busy:boolean}
function synchronous(work:()=>void){const proof=work() as unknown;if(proof&&typeof (proof as PromiseLike<unknown>).then==='function'){void Promise.resolve(proof).catch(()=>{});throw new Error('word-host-stage-proof-must-be-synchronous')}}
export class WordRoomStages{
 private entries=new Map<string,Stage>()
 has(name:string){return this.entries.has(name)}
 retained(name:string){const entry=this.entries.get(name);if(!entry)throw new Error('word-host-stage-missing');this.guard(entry);return{binding:entry.binding,owner:entry.owner}}
 private guard(entry:Stage){entry.lease.assert();if(!entry.gate.readyToReleaseIdentity(entry.id,entry.operation,entry.identity))throw new Error('word-host-stage-not-held');synchronous(entry.assertSource)}
 reserve(spec:Spec,host:Host):object{
  if(this.entries.has(spec.name)||[...this.entries.values()].some(entry=>entry.id===spec.id))throw new Error('word-host-stage-busy')
  if(host.documents.has(spec.name)||host.loadingDocuments.has(spec.name)||host.unloadingDocuments.has(spec.name))throw new Error('word-host-stage-occupied')
  if(spec.binding.journal.scope.documentId!==spec.id||!spec.identity)throw new Error('word-host-stage-scope')
  const entry:Stage={...spec,context:Object.freeze({}),rollback:false,checked:false,finished:false,busy:false}
  this.guard(entry);this.entries.set(spec.name,entry);return entry.context
 }
 private claim(name:string,context:unknown,document?:Document){
  const entry=this.entries.get(name)
  if(!entry||entry.context!==context||entry.rollback||document&&entry.document!==document)throw new Error('word-host-stage-context')
  this.guard(entry);return entry
 }
 binding(name:string,context:unknown,document?:Document){return this.claim(name,context,document).binding}
 async load(name:string,context:unknown,document:Document){
  const entry=this.claim(name,context);if(entry.document)throw new Error('word-host-stage-already-loaded');entry.document=document
  try{const seed=await entry.binding.load();this.claim(name,context,document);return seed}catch(error){entry.binding.close();throw error}
 }
 attached(name:string,context:unknown,document:Document,owner:WordSaveCoordinator){
  const entry=this.claim(name,context,document)
  if(entry.owner||owner.model.document!==document||!owner.ownsJournal(entry.binding.journal)||!owner.isLayoutAwareLive()||owner.isAutoSaveEnabled())throw new Error('word-host-stage-owner')
  entry.owner=owner
 }
 assertInstalled(name:string,owner:WordSaveCoordinator,host:Host){
  const entry=this.entries.get(name);if(!entry||entry.owner!==owner||entry.rollback||host.documents.get(name)!==entry.document||host.loadingDocuments.has(name)||host.unloadingDocuments.has(name))throw new Error('word-host-stage-not-installed')
  this.guard(entry)
 }
 /** Must run synchronously after installLayoutDraftRoom released admission. */
 activate(name:string,owner:WordSaveCoordinator,host:Host,autoSave=true){
  const entry=this.entries.get(name)
  if(!entry||entry.owner!==owner||entry.rollback||host.documents.get(name)!==entry.document||host.loadingDocuments.has(name)||host.unloadingDocuments.has(name))throw new Error('word-host-stage-not-installed')
  const released=()=>{entry.lease.assert();if(entry.gate.blocked(entry.id)||host.documents.get(name)!==entry.document)throw new Error('word-host-stage-not-released')}
  released();if(autoSave)owner.enableLayoutAutoSave(released);this.entries.delete(name)
 }
 beforeUnload(name:string,document:Document,owner:WordSaveCoordinator|undefined){
  const entry=this.entries.get(name);if(!entry)return false
  this.guard(entry)
  if(!entry.rollback||entry.document!==document||entry.owner!==owner||document.getConnectionsCount()!==0)throw new Error('word-host-stage-unload-denied')
  entry.checked=true;return true
 }
 afterUnload(name:string,owner:WordSaveCoordinator|undefined){
  const entry=this.entries.get(name);if(!entry)return false
  this.guard(entry)
  if(!entry.rollback||!entry.checked||entry.owner!==owner||!entry.document?.isDestroyed)throw new Error('word-host-stage-unload-denied')
  entry.finished=true;return true
 }
 /** The caller removes only this stage's host registries in unregister(). The
  * installer owns disposal of a returned owner after removal is proven. A
  * factory rejecting before return must dispose its owner itself afterwards. */
 async rollback(name:string,host:Host,unregister:()=>void,timeoutMs=15_000){
  const entry=this.entries.get(name);if(!entry)throw new Error('word-host-stage-missing')
  if(entry.busy)throw new Error('word-host-stage-busy')
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120_000)throw new Error('word-host-stage-timeout-invalid')
  entry.busy=true
  try{
   this.guard(entry);entry.rollback=true;entry.owner?.freeze()
   if(host.loadingDocuments.has(name))throw new Error('word-host-stage-loading')
   const document=host.documents.get(name)
   if(document){
    if(document!==entry.document||document.getConnectionsCount()!==0||!host.shouldUnloadDocument(document))throw new Error('word-host-stage-unload-denied')
    await awaitRecoveryPreparation(()=>host.unloadDocument(document),AbortSignal.timeout(timeoutMs));this.guard(entry)
    if(host.documents.has(name)||!entry.finished)throw new Error('word-host-stage-unload-uncertain')
   }
   if(host.documents.has(name)||host.loadingDocuments.has(name)||host.unloadingDocuments.has(name))throw new Error('word-host-stage-unload-uncertain')
   this.guard(entry);synchronous(unregister);this.guard(entry)
   // A failed onLoad/afterLoad may leave a document that never entered the
   // host's document map. No load/unload is in flight at this point.
   if(entry.document&&!entry.document.isDestroyed)entry.document.destroy();if(!entry.owner)entry.binding.close();this.entries.delete(name)
  }finally{entry.busy=false}
 }
}
