/** One-use host permit for unloading a fenced Hocuspocus Word document while
 * retaining its native lease. The host owns admission and registry cleanup. */
import type {Document} from '@hocuspocus/server'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'

type Lease={assert:()=>void;headers:()=>Record<string,string>}
type Operation='word-layout-change'|'word-layout-room-save'|'word-story-unlink'|'word-story-link'
type Entry={id:string;operation:Operation;document:Document;owner:WordSaveCoordinator;gate:RoomMigrationGate;lease:Lease;journal:WordCheckpointJournal;tip:string;checked:boolean}
export class WordRoomRetirements{
 private entries=new Map<string,Entry>()
 private completed=new Map<string,Entry>()
 has(name:string){return this.entries.has(name)}
 async reserve(name:string,id:string,operation:Operation,document:Document,owner:WordSaveCoordinator,gate:RoomMigrationGate,lease:Lease,journal:WordCheckpointJournal,signal?:AbortSignal){
  if(this.entries.has(name))throw new Error('word-retirement-busy')
  const guard=()=>{signal?.throwIfAborted();lease.assert();if(!gate.readyToRelease(id,operation)||!owner.isTopologySealed()||!owner.ownsJournal(journal)||owner.model.document!==document||document.getConnectionsCount()!==0)throw new Error('word-retirement-not-ready');owner.assertTopologyHeld()}
  guard();const saved=signal?await awaitRecoveryPreparation(()=>journal.load(signal),signal):await journal.load();guard()
  if(!saved||lease.headers()['X-HCD-Word-Journal-Hash']!==saved.hash||!owner.heldSnapshotRecorded())throw new Error('word-retirement-not-durable')
  if(this.entries.has(name))throw new Error('word-retirement-busy')
  this.entries.set(name,{id,operation,document,owner,gate,lease,journal,tip:saved.hash,checked:false})
 }
 before(name:string,document:Document,owner:WordSaveCoordinator|undefined){
  const entry=this.entries.get(name);if(!entry)return false
  entry.lease.assert();if(owner!==entry.owner||entry.document!==document||!entry.gate.readyToRelease(entry.id,entry.operation)||entry.lease.headers()['X-HCD-Word-Journal-Hash']!==entry.tip||document.getConnectionsCount()!==0)throw new Error('word-retirement-changed')
  owner.assertTopologyHeld();entry.checked=true;return true
 }
 /** Called after Hocuspocus removed and destroyed the exact old document.
  * Do not read its Y.Doc after destruction; preserve the still-held lease. */
 finish(name:string,owner:WordSaveCoordinator|undefined){
  const entry=this.entries.get(name);if(!entry)return false
  entry.lease.assert();if(!entry.checked||owner!==entry.owner||!entry.gate.readyToRelease(entry.id,entry.operation)||entry.lease.headers()['X-HCD-Word-Journal-Hash']!==entry.tip)throw new Error('word-retirement-changed')
  this.entries.delete(name);this.completed.set(name,entry);return true
 }
 /** A completed retirement can be checked after its old Y.Doc was destroyed.
  * Descendant journal writes are valid only when the owner recorded that tip. */
 retired(name:string,owner:WordSaveCoordinator,gate:RoomMigrationGate,journal:WordCheckpointJournal){
  const entry=this.completed.get(name);if(!entry||entry.owner!==owner||entry.gate!==gate||entry.journal!==journal)return false
  entry.lease.assert();const chain=journal.knownHashes();if(!gate.readyToRelease(entry.id,entry.operation)||!chain.includes(entry.tip)||chain.at(-1)!==entry.lease.headers()['X-HCD-Word-Journal-Hash'])throw new Error('word-retirement-changed')
  return true
 }
 forgetRetired(name:string,owner:WordSaveCoordinator,gate:RoomMigrationGate,journal:WordCheckpointJournal){const entry=this.completed.get(name);if(entry?.owner===owner&&entry.gate===gate&&entry.journal===journal)this.completed.delete(name)}
 cancel(name:string){const entry=this.entries.get(name);if(entry?.checked)throw new Error('word-retirement-in-progress');this.entries.delete(name)}
}

type Host={documents:Map<string,Document>;closeConnections:(name:string)=>void;shouldUnloadDocument:(document:Document)=>boolean;unloadDocument:(document:Document)=>Promise<unknown>}
type RetireOptions={host:Host;registry:WordRoomRetirements;name:string;id:string;operation:Operation;owner:WordSaveCoordinator;gate:RoomMigrationGate;lease:Lease;journal:WordCheckpointJournal;signal?:AbortSignal;timeoutMs?:number}
const retirementsInFlight=new WeakMap<WordRoomRetirements,Set<string>>()
/** Disconnect and unload the exact old document. The gate must remain closed;
 * once unload starts an error can mean it completed, so its permit is retained
 * and the host must inspect the document/registry before retrying. */
export async function retireWordRoom({host,registry,name,id,operation,owner,gate,lease,journal,signal,timeoutMs=15_000}:RetireOptions){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120_000)throw new Error('word-retirement-timeout-invalid')
 let active=retirementsInFlight.get(registry);if(!active){active=new Set();retirementsInFlight.set(registry,active)}
 if(active.has(name))throw new Error('word-retirement-busy');active.add(name)
 const timerController=new AbortController(),timeout=setTimeout(()=>timerController.abort(new Error('word-retirement-timeout')),timeoutMs)
 const deadline=AbortSignal.any([timerController.signal,...(signal?[signal]:[])])
 try{
  const document=host.documents.get(name)
  const guard=()=>{deadline.throwIfAborted();lease.assert();if(!document||host.documents.get(name)!==document||!gate.readyToRelease(id,operation)||!owner.isTopologySealed()||!owner.ownsJournal(journal)||owner.model.document!==document)throw new Error('word-retirement-not-ready');owner.assertTopologyHeld()}
  guard();host.closeConnections(name)
  while(true){guard();if(document!.getConnectionsCount()===0&&host.shouldUnloadDocument(document!))break;await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);deadline.removeEventListener('abort',stop);reject(deadline.reason)},timer=setTimeout(()=>{deadline.removeEventListener('abort',stop);resolve()},25);deadline.addEventListener('abort',stop,{once:true});if(deadline.aborted)stop()})}
  await registry.reserve(name,id,operation,document!,owner,gate,lease,journal,deadline)
  try{guard()}catch(error){try{registry.cancel(name)}catch{/* An unload hook already started; retain its permit. */}throw error}
  await new Promise<void>((resolve,reject)=>{let settled=false;const finish=(fn:()=>void)=>{if(settled)return;settled=true;deadline.removeEventListener('abort',stop);fn()},stop=()=>finish(()=>reject(new Error('word-retirement-outcome-unknown',{cause:deadline.reason})));deadline.addEventListener('abort',stop,{once:true});if(deadline.aborted){stop();return}host.unloadDocument(document!).then(()=>finish(resolve),error=>finish(()=>reject(error)))})
  lease.assert();if(!gate.readyToRelease(id,operation)||host.documents.has(name)||registry.has(name))throw new Error('word-retirement-outcome-unknown')
 }finally{clearTimeout(timeout);active.delete(name)}
}
