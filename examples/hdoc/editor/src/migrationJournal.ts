import {createHash,randomUUID} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {join} from 'node:path'
import {inlineProtocol,structuralProtocol} from './collaborationProtocol.ts'
export type MigrationJob={version:1;targetProtocol?:typeof inlineProtocol;documentId:string;apiHash:string;id:string;fromEpoch:number;targetEpoch:number;baseRevision:number;sourceHash:string;sourceBytes:string;targetBytes:string;targetHash:string;status:'prepared'|'committed';receipt?:unknown}
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex')
const hex=(value:unknown,length:number):value is string=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value)
export function validateMigrationJob(value:unknown,documentId:string,apiHash:string):MigrationJob{
 const job=value as MigrationJob
 const emptySource=job?.targetProtocol===inlineProtocol&&job.sourceHash==='none'&&job.sourceBytes===''
 if(!job||job.version!==1||job.targetProtocol!==undefined&&job.targetProtocol!==inlineProtocol||job.documentId!==documentId||job.apiHash!==apiHash||!hex(job.id,32)||!Number.isSafeInteger(job.fromEpoch)||job.fromEpoch<0||job.targetEpoch!==job.fromEpoch+1||!Number.isSafeInteger(job.targetEpoch)||!Number.isSafeInteger(job.baseRevision)||job.baseRevision<0||(!hex(job.sourceHash,64)&&!emptySource)||job.targetProtocol===inlineProtocol&&!emptySource||!hex(job.targetHash,64)||!['prepared','committed'].includes(job.status))throw new Error('migration-journal-invalid')
 for(const [bytes,expected]of [[job.sourceBytes,job.sourceHash],[job.targetBytes,job.targetHash]]){
  if(emptySource&&expected==='none'&&bytes==='')continue
  if(typeof bytes!=='string'||bytes.length>12*1024*1024||bytes.length%4!==0)throw new Error('migration-journal-invalid')
  const decoded=Buffer.from(bytes,'base64')
  if(!decoded.length||decoded.length>8*1024*1024||decoded.toString('base64')!==bytes||hash(decoded)!==expected)throw new Error('migration-journal-invalid')
 }
 return job
}
/** A single sidecar's private, atomic journal. Native CAS remains the publisher
 * authority; this file is NOT a distributed room lease. No bearer/secret is stored. */
export class MigrationJournal {
 readonly apiHash:string
 private readonly directory:string
 constructor(directory:string,apiUrl:string){this.apiHash=hash(apiUrl);this.directory=join(directory,this.apiHash)}
 private path(documentId:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(documentId))throw new Error('invalid-document-id');return join(this.directory,`${documentId}.json`)}
 async load(documentId:string):Promise<MigrationJob|undefined>{
  const path=this.path(documentId)
  try{const stat=await fs.lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>25*1024*1024)throw new Error('migration-journal-invalid');return validateMigrationJob(JSON.parse(await fs.readFile(path,'utf8')),documentId,this.apiHash)}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
 }
 private async syncDirectory(){if(process.platform!=='win32'){const directory=await fs.open(this.directory,'r');try{await directory.sync()}finally{await directory.close()}}}
 async save(job:MigrationJob){
  validateMigrationJob(job,job.documentId,this.apiHash)
  await fs.mkdir(this.directory,{recursive:true,mode:0o700})
  const directory=await fs.lstat(this.directory);if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('migration-journal-invalid')
  await fs.chmod(this.directory,0o700)
  const previous=await this.load(job.documentId)
  if(previous?.status==='prepared'&&(previous.id!==job.id||previous.targetHash!==job.targetHash||previous.sourceHash!==job.sourceHash||previous.targetProtocol!==job.targetProtocol))throw new Error('migration-job-unresolved')
  const destination=this.path(job.documentId),temporary=`${destination}.${randomUUID()}.tmp`
  try{
   const file=await fs.open(temporary,'wx',0o600)
   try{await file.writeFile(JSON.stringify(job)+'\n');await file.sync()}finally{await file.close()}
   await fs.rename(temporary,destination);await this.syncDirectory()
  }catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error}
 }
 async archive(job:MigrationJob){
  const current=await this.load(job.documentId)
  if(!current||current.id!==job.id)throw new Error('migration-job-changed')
  await fs.rename(this.path(job.documentId),join(this.directory,`${job.documentId}.${job.id}.rejected.json`));await this.syncDirectory()
 }
 job(documentId:string,fromEpoch:number,baseRevision:number,sourceBytes:Uint8Array,targetBytes:Uint8Array,targetProtocol?:typeof structuralProtocol|typeof inlineProtocol):MigrationJob{
  return validateMigrationJob({version:1,...(targetProtocol===inlineProtocol?{targetProtocol}:{}),documentId,apiHash:this.apiHash,id:randomUUID().replaceAll('-',''),fromEpoch,targetEpoch:fromEpoch+1,baseRevision,sourceHash:targetProtocol===inlineProtocol?'none':hash(sourceBytes),sourceBytes:Buffer.from(sourceBytes).toString('base64'),targetBytes:Buffer.from(targetBytes).toString('base64'),targetHash:hash(targetBytes),status:'prepared'},documentId,this.apiHash)
 }
}
