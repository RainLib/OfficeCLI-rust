import {createHash,randomUUID} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {join} from 'node:path'
export type RestoreProtocol='hcd-semantic-blocks/3'|'hcd-semantic-inline/1'
export const restoreProtocol=(request:{fromProtocol?:RestoreProtocol}):RestoreProtocol=>request.fromProtocol??'hcd-semantic-blocks/3'
export type RestoreRequest={requestId:string;expectedRevision:number;fromEpoch:number;fromProtocol?:RestoreProtocol;sourceHash:string;authorId:string;authorName:string}
export type RestoreJob={version:1;documentId:string;target:number;request:RestoreRequest;status:'prepared'|'committed';receipt?:RestoreReceipt}
export type RestoreReceipt={requestId:string;revision:number;restoredFrom:number;collaborationEpoch:number;collaborationProtocol:RestoreProtocol}
export function validRestoreRequest(value:unknown):value is RestoreRequest{
 const v=value as RestoreRequest
 return !!v&&(v.fromProtocol===undefined||v.fromProtocol==='hcd-semantic-blocks/3'||v.fromProtocol==='hcd-semantic-inline/1')&&/^[a-f0-9]{32}$/.test(v.requestId)&&Number.isSafeInteger(v.expectedRevision)&&v.expectedRevision>0&&Number.isSafeInteger(v.fromEpoch)&&v.fromEpoch>=0&&v.fromEpoch<Number.MAX_SAFE_INTEGER&&/^[a-f0-9]{64}$/.test(v.sourceHash)&&typeof v.authorId==='string'&&!!v.authorId&&v.authorId.length<=128&&typeof v.authorName==='string'&&v.authorName.length<=256
}
export function validRestoreJob(value:unknown,documentId:string):value is RestoreJob{
 const v=value as RestoreJob
 return !!v&&v.version===1&&v.documentId===documentId&&Number.isSafeInteger(v.target)&&v.target>=0&&v.target<v.request?.expectedRevision&&validRestoreRequest(v.request)&&['prepared','committed'].includes(v.status)
}
/** Private single-owner journal, deliberately namespaced separately from body migration. */
export class RestoreJournal{
 readonly directory:string
 constructor(root:string,api:string){this.directory=join(root,createHash('sha256').update(api).digest('hex'),'restores')}
 private path(id:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('invalid-document-id');return join(this.directory,`${id}.json`)}
 async load(id:string):Promise<RestoreJob|undefined>{try{const path=this.path(id),stat=await fs.lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error('restore-journal-invalid');const job=JSON.parse(await fs.readFile(path,'utf8'));if(!validRestoreJob(job,id))throw new Error('restore-journal-invalid');return job}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}}
 private async sync(){if(process.platform!=='win32'){const fd=await fs.open(this.directory,'r');try{await fd.sync()}finally{await fd.close()}}}
 async save(job:RestoreJob){
  if(!validRestoreJob(job,job.documentId))throw new Error('restore-journal-invalid')
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('restore-journal-invalid');await fs.chmod(this.directory,0o700)
  const previous=await this.load(job.documentId)
  if(previous?.status==='prepared'&&(previous.target!==job.target||JSON.stringify(previous.request)!==JSON.stringify(job.request)))throw new Error('restore-unresolved')
  const path=this.path(job.documentId),temporary=`${path}.${randomUUID()}.tmp`
  try{const fd=await fs.open(temporary,'wx',0o600);try{await fd.writeFile(JSON.stringify(job));await fd.sync()}finally{await fd.close()}await fs.rename(temporary,path);await this.sync()}catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error}
 }
 async reject(job:RestoreJob){const previous=await this.load(job.documentId);if(previous?.request.requestId!==job.request.requestId)throw new Error('restore-job-changed');await fs.rename(this.path(job.documentId),join(this.directory,`${job.documentId}.${job.request.requestId}.rejected.json`));await this.sync()}
}
