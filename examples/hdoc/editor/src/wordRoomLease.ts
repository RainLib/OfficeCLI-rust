/** Server-only native owner lease. Monotonic local expiry is deliberately
 * earlier than the native deadline; delayed receipts cannot resurrect it. */
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {constants} from 'node:fs'
import {join,resolve} from 'node:path'
const hex=(value:unknown,length=32):value is string=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value)
export async function wordRecoveryStoreId(root:string,api:string,secret:string){
 if(Buffer.byteLength(secret)<32)throw new Error('word-store-secret-invalid')
 const apiHash=createHash('sha256').update(api).digest('hex'),directory=join(resolve(root),apiHash,'word-room-store'),path=join(directory,'identity.json')
 await fs.mkdir(directory,{recursive:true,mode:0o700})
 for(let current=directory,i=0;i<3;i++,current=resolve(current,'..')){const meta=await fs.lstat(current);if(!meta.isDirectory()||meta.isSymbolicLink())throw new Error('word-store-invalid')}
 const sign=(id:string)=>createHmac('sha256',secret).update(`word-store/1:${apiHash}:${id}`).digest('hex')
 const read=async()=>{
  const file=await fs.open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  try{const meta=await file.stat();if(!meta.isFile()||meta.size>4096)throw new Error('word-store-invalid');const value=JSON.parse(await file.readFile('utf8'));if(Object.keys(value).sort().join(',')!=='apiHash,id,signature,version'||value.version!==1||value.apiHash!==apiHash||!hex(value.id)||!hex(value.signature,64)||!timingSafeEqual(Buffer.from(value.signature),Buffer.from(sign(value.id))))throw new Error('word-store-invalid');return value.id as string}finally{await file.close()}
 }
 try{return await read()}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const id=randomUUID().replaceAll('-',''),temporary=join(directory,`${id}.tmp`)
 try{
  const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify({version:1,id,apiHash,signature:sign(id)}));await file.sync()}finally{await file.close()}
  try{await fs.link(temporary,path);if(process.platform!=='win32'){const dir=await fs.open(directory,'r');try{await dir.sync()}finally{await dir.close()}}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
  return await read()
 }finally{await fs.rm(temporary,{force:true}).catch(()=>{})}
}
type Options={epoch:number;storeId:string;request:(route:string,init:RequestInit)=>Promise<Response>;onLost?:(reason:string)=>void|Promise<void>;now?:()=>number;autoRenew?:boolean;safetyMs?:number;renewMs?:number;journalHashes?:readonly string[]}
export class WordRoomLease{
 readonly ownerId=randomUUID().replaceAll('-','')
 private leaseId:string|undefined
 private deadline=0
 private journalHash='none'
 private network:Promise<unknown>=Promise.resolve()
 private lost=false
 private closed=false
 private acquiring=false
 private renewal:Promise<void>|undefined
 private renewTimer:ReturnType<typeof setTimeout>|undefined
 private expiryTimer:ReturnType<typeof setTimeout>|undefined
 private recovery:Promise<unknown>=Promise.resolve()
 private now:()=>number
 constructor(private options:Options){if(!Number.isSafeInteger(options.epoch)||options.epoch<0||!hex(options.storeId))throw new Error('word-owner-scope-invalid');this.now=options.now??(()=>performance.now())}
 private body(action:'acquire'|'renew'|'release'|'record',hashes?:readonly string[]){return{version:1,epoch:this.options.epoch,ownerId:this.ownerId,storeId:this.options.storeId,action,...(action==='acquire'?{journalHashes:this.options.journalHashes??['none']}:{...(hashes?{journalHashes:hashes}:{})}),...(action!=='acquire'?{leaseId:this.leaseId}:{})}}
 private call(action:'acquire'|'renew'|'release'|'record',hashes?:readonly string[]){const task=this.network.catch(()=>{}).then(()=>this.exchange(action,hashes));this.network=task;return task}
 private async exchange(action:'acquire'|'renew'|'release'|'record',hashes?:readonly string[]){
  const start=this.now(),response=await this.options.request('/collaboration/word-owner',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'5'},body:JSON.stringify(this.body(action,hashes)),signal:AbortSignal.timeout(10_000)})
  if(!response.ok)throw new Error(`word-owner:${response.status}`)
  const value=await response.json()
  if(action==='release')return
  if(this.closed||this.lost)throw new Error('word-owner-lost')
  if(value.journalHash!=='none'&&!hex(value.journalHash,64))throw new Error('word-owner-receipt-invalid')
  if(action==='record'&&value.journalHash!==hashes?.at(-1))throw new Error('word-owner-receipt-invalid')
  if(value.version!==1||value.epoch!==this.options.epoch||value.ownerId!==this.ownerId||value.storeId!==this.options.storeId||!hex(value.leaseId)||this.leaseId!==undefined&&value.leaseId!==this.leaseId||!Number.isFinite(value.remainingMs)||value.remainingMs<=0||value.remainingMs>15_000)throw new Error('word-owner-receipt-invalid')
  const deadline=start+value.remainingMs-(this.options.safetyMs??2000)
  if(deadline<=this.now()||action!=='acquire'&&this.deadline<=this.now())throw new Error('word-owner-expired-receipt')
  this.leaseId=value.leaseId;this.journalHash=value.journalHash;this.deadline=deadline;this.schedule()
 }
 private schedule(){
  clearTimeout(this.renewTimer);clearTimeout(this.expiryTimer)
  if(this.options.autoRenew===false)return
  this.expiryTimer=setTimeout(()=>this.lose('word-owner-expired'),Math.max(0,this.deadline-this.now()))
  this.renewTimer=setTimeout(()=>{void this.renew().catch(()=>{})},Math.max(1,Math.min(this.options.renewMs??4000,(this.deadline-this.now())/3)))
 }
 private lose(reason:string){
  if(this.closed||this.lost)return
  this.lost=true;this.deadline=0;clearTimeout(this.renewTimer);clearTimeout(this.expiryTimer)
  try{this.recovery=Promise.resolve(this.options.onLost?.(reason));void this.recovery.catch(()=>{})}catch(error){this.recovery=Promise.reject(error);void this.recovery.catch(()=>{})}
 }
 assert(){if(this.closed||this.lost||!this.leaseId||this.deadline<=this.now()){this.lose('word-owner-expired');throw new Error('word-owner-lost')}}
 headers(){this.assert();return{'X-HCD-Word-Owner':this.leaseId!,'X-HCD-Word-Owner-Id':this.ownerId,'X-HCD-Word-Journal-Hash':this.journalHash}}
 /** A pinned, read-only projection can race a journal record in flight.
  * Repeat only if that same lease has actually acknowledged a different tip;
  * unchanged 409s, permission failures and lost ownership remain failures. */
 async readProjection(request:(headers:Record<string,string>)=>Promise<Response>){
  for(let attempt=0;;attempt++){
   await this.network;const headers=this.headers(),response=await request(headers);this.assert()
   if(response.status!==409||attempt===3)return response
   await this.network;const current=this.headers()
   if(current['X-HCD-Word-Journal-Hash']===headers['X-HCD-Word-Journal-Hash'])return response
   void response.body?.cancel().catch(()=>{})
  }
 }
 async acquire(){
  if(this.acquiring||this.leaseId||this.closed||this.lost)throw new Error('word-owner-unavailable')
  this.acquiring=true;try{await this.call('acquire')}catch(error){this.lose('word-owner-acquire-failed');throw error}finally{this.acquiring=false}
 }
 renew(){
  if(this.renewal)return this.renewal
  try{this.assert()}catch(error){return Promise.reject(error)}
  const work=this.call('renew').catch(error=>{this.lose('word-owner-renew-failed');throw error});this.renewal=work;void work.then(()=>{this.renewal=undefined},()=>{this.renewal=undefined});return work
 }
 async recordJournal(hashes:readonly string[]){this.assert();try{await this.call('record',hashes)}catch(error){this.lose('word-owner-record-failed');throw error}}
 async settled(){await this.recovery}
 async close(){
  if(this.closed)return
  this.closed=true;clearTimeout(this.renewTimer);clearTimeout(this.expiryTimer)
  if(this.leaseId)try{await this.call('release')}catch{/* Native expiry and OS release remain the fallback. */}
  await this.recovery.catch(()=>{})
 }
}
