import * as Y from 'yjs'
import {MigrationJournal,type MigrationJob} from './migrationJournal.ts'
import {RoomMigrationGate,MigrationUncertain} from './roomMigrationGate.ts'
import {legacyProtocol,structuralProtocol,inlineProtocol,requireCollaborationSession,type CollaborationSession} from './collaborationProtocol.ts'
import type {SemanticMigrationCandidate} from './semanticSaveCoordinator.ts'
type Host={
 freeze?:(id:string)=>void
 session:(id:string)=>Promise<CollaborationSession>
 prepare:(id:string,session:CollaborationSession)=>Promise<SemanticMigrationCandidate>
 request:(id:string,route:string,init:RequestInit,session:CollaborationSession)=>Promise<Response>
 committed:(id:string,session:CollaborationSession)=>Promise<void>
 rollback:(id:string)=>Promise<void>
}
export class MigrationRejected extends Error{
 constructor(readonly status:number,readonly code='migration-rejected'){super(code)}
}
/** Coordinates ONE sidecar process. Its packet barrier is supplied by the
 * server; durable journal IDs and native CAS resolve publication outcomes. */
export class SidecarMigration {
 constructor(readonly gate:RoomMigrationGate,readonly journal:MigrationJournal,private host:Host,private target:typeof structuralProtocol|typeof inlineProtocol=structuralProtocol){}
 private async submit(job:MigrationJob):Promise<CollaborationSession>{
  let response:Response
  if((job.targetProtocol??structuralProtocol)!==this.target)throw new MigrationUncertain()
  try{response=await this.host.request(job.documentId,'/collaboration/migrate',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-HCD-Coordinator-Version':'4',...(this.target===inlineProtocol?{'X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3'}:{}),'X-HCD-State-Hash':job.sourceHash,'X-HCD-Target-Protocol':this.target,'X-HCD-Base-Revision':String(job.baseRevision),'X-HCD-Migration-Id':job.id},body:Buffer.from(job.targetBytes,'base64')},{collaborationEpoch:job.fromEpoch,collaborationProtocol:legacyProtocol})}
  catch{throw new MigrationUncertain()}
  if(!response.ok){
   if(response.status>=500||[408,429].includes(response.status))throw new MigrationUncertain()
   const current=await this.host.session(job.documentId).catch(()=>{throw new MigrationUncertain()})
   try{await this.journal.archive(job)}catch{throw new MigrationUncertain()}
   if(current.collaborationProtocol===this.target)return current
   throw new MigrationRejected(response.status)
  }
  try{
   const receipt=await response.json(),session=requireCollaborationSession(receipt)
   if(session.collaborationProtocol!==this.target||session.collaborationEpoch!==job.targetEpoch||receipt.migration?.id!==job.id||receipt.migration?.stateHash!==job.targetHash||receipt.migration?.sourceHash!==job.sourceHash||receipt.migration?.fromEpoch!==job.fromEpoch||receipt.migration?.baseRevision!==job.baseRevision)throw new Error('migration-receipt-differs')
   await this.journal.save({...job,status:'committed',receipt})
   return session
  }catch{throw new MigrationUncertain()}
 }
 private async finish(id:string,session:CollaborationSession){try{await this.host.committed(id,session)}catch{throw new MigrationUncertain()}}
 negotiate(id:string):Promise<CollaborationSession>{
  return this.gate.exclusive(id,async()=>{
   let candidate:SemanticMigrationCandidate|undefined
   let job:MigrationJob|undefined,publicationPossible=false
   try{
    try{job=await this.journal.load(id)}catch{throw new MigrationUncertain()}
    publicationPossible=!!job
    const current=await this.host.session(id)
    if(job&&(job.targetProtocol??structuralProtocol)!==this.target)throw new MigrationUncertain()
    if(current.collaborationProtocol===this.target){
     if(job?.status==='prepared')await this.submit(job)
     const latest=await this.host.session(id)
     if(latest.collaborationProtocol!==this.target)throw new MigrationUncertain()
     await this.finish(id,latest);return latest
    }
    if(job?.status==='committed')throw new MigrationUncertain()
    if(!job){
     if(current.collaborationProtocol!==legacyProtocol)throw new MigrationRejected(409,'migration-source-protocol')
     candidate=await this.host.prepare(id,current)
     job=this.journal.job(id,current.collaborationEpoch,candidate.baseRevision,candidate.sourceBytes,Y.encodeStateAsUpdate(candidate.document),this.target)
     if(job.sourceHash!==candidate.sourceHash)throw new Error('migration-source-differs')
     await this.journal.save(job)
     publicationPossible=true
    }
    const published=await this.submit(job)
    await this.finish(id,published);return published
   }catch(error){
    if(error instanceof MigrationUncertain)throw error
    if(!(error instanceof MigrationRejected)){
     if(publicationPossible)throw new MigrationUncertain()
     if(job){try{if(await this.journal.load(id))throw new MigrationUncertain()}catch{throw new MigrationUncertain()}}
    }
    await this.host.rollback(id)
    throw error
   }finally{candidate?.document.destroy()}
  },()=>this.host.freeze?.(id),`migration:${this.target}`)
 }
}
