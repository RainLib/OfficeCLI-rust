import type {Session} from './api.ts'
import type {WordDeviceDraft} from './wordDeviceDraft.ts'
import {downloadWordDeviceBackup} from './wordDeviceBackup.ts'

export type WordDeviceDownloadState={phase:'idle'|'preparing'|'requested'|'failed';error?:'changed'|'limit'|'unavailable'}
export function wordDeviceDownloadError(cause:unknown):NonNullable<WordDeviceDownloadState['error']>{
 const message=cause instanceof Error?cause.message:''
 if(message==='word-device-backup-limit'||message==='word-device-limit')return 'limit'
 if(['word-device-scope-changed','word-device-scope','word-device-backup-changed'].includes(message))return 'changed'
 return 'unavailable'
}
/** Preparing a local escape copy must not submit, consume or merge drafts.
 * Browser handoff is observable; a successful disk save is not. */
export class WordDeviceDownload {
 private state:WordDeviceDownloadState={phase:'idle'}
 private listeners=new Set<()=>void>()
 private job:object|null=null
 private pending:Promise<void>|null=null
 private disposed=false
 constructor(readonly cache:WordDeviceDraft,readonly session:Session,private work:(stillCurrent:()=>boolean)=>Promise<void>=current=>downloadWordDeviceBackup(cache,session,current),private stillBound:()=>boolean=()=>true){}
 snapshot=()=>this.state
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private publish(state:WordDeviceDownloadState){this.state=state;for(const listener of this.listeners)listener()}
 dismiss=()=>{if(!this.disposed&&this.state.phase!=='preparing')this.publish({phase:'idle'})}
 run=():Promise<void>=>{
  if(this.disposed||!this.stillBound())return Promise.resolve()
  if(this.pending)return this.pending
  const job={};this.job=job
  const current=()=>!this.disposed&&this.job===job&&this.stillBound()
  this.pending=Promise.resolve().then(async()=>{if(current())await this.work(current)}).then(()=>{if(current())this.publish({phase:'requested'})},cause=>{if(current())this.publish({phase:'failed',error:wordDeviceDownloadError(cause)})}).finally(()=>{if(this.job===job){this.job=null;this.pending=null}})
  this.publish({phase:'preparing'})
  return this.pending
 }
 dispose(){this.disposed=true;this.job=null;this.listeners.clear()}
}
