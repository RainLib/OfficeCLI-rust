/** Member-readable canonical baseline pinned to the active layout owner.
 * Native owner credentials never leave the sidecar. */
import type {IncomingMessage,ServerResponse} from 'node:http'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {CollaborationAccess} from './collaborationAccess.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {requireWordHttpModel,wordRoomStatus} from './wordRoomHost.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {readWordLayout} from './wordRegions.ts'

type Options={enabled:boolean;access:(id:string,token:string)=>Promise<CollaborationAccess>;enter:(id:string)=>()=>void;owner:(id:string,epoch:number)=>WordSaveCoordinator|undefined;projection:(id:string,epoch:number,revision:number,signal:AbortSignal)=>Promise<Response>}
class Rejected extends Error{constructor(readonly status:number,readonly code:string){super(code)}}
function reject(status:number,code:string):never{throw new Rejected(status,code)}
async function input(request:IncomingMessage){
 let raw='',timedOut=false
 const timer=setTimeout(()=>{timedOut=true;request.destroy(new Error('word-room-projection-timeout'))},15_000)
 try{for await(const part of request){raw+=part;if(Buffer.byteLength(raw)>4096)reject(413,'word-room-projection-input-limit')}return JSON.parse(raw)}
 catch(error){if(timedOut)reject(408,'word-room-projection-timeout');if(error instanceof Rejected)throw error;reject(400,'word-room-projection-input')}
 finally{clearTimeout(timer)}
}
export async function wordRoomProjectionHttp(request:IncomingMessage,response:ServerResponse,options:Options){
 const path=new URL(request.url??'/','http://sidecar').pathname,match=/^\/v1\/documents\/([A-Za-z0-9_-]{1,128})\/collaboration\/word-room-projection$/.exec(path)
 if(!match)return false
 response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-hcd-node-edits-version,x-hcd-word-regions-version,x-hcd-word-layout-version');response.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');response.setHeader('Cache-Control','no-store')
 if(request.method==='OPTIONS'){response.writeHead(204);response.end();return true}
 let status=200,result:unknown,leave:(()=>void)|undefined
 try{
  if(!options.enabled)reject(426,'word-room-projection-unavailable')
  if(request.method!=='POST')reject(405,'word-room-projection-method')
  const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))reject(401,'word-room-projection-authority')
  const token=authorization!.slice(7),authorize=async()=>{
   const user=await options.access(match[1],token)
   if(!['read','write'].includes(user.scope)||!Number.isFinite(user.expiresAt)||Date.now()>=user.expiresAt*1000||user.collaborationProtocol!==wordLayoutProtocol||user.coordinatedRestore!==true)reject(403,'word-room-projection-authority')
   try{requireWordHttpModel(user.collaborationProtocol,request.headers,true)}catch{reject(426,'word-room-projection-client')}
   return user
  }
  const user=await authorize(),body=await input(request)
  if(!body||Object.keys(body).sort().join(',')!=='epoch,revision'||!Number.isSafeInteger(body.epoch)||body.epoch!==user.collaborationEpoch||!Number.isSafeInteger(body.revision)||body.revision<0)reject(409,'word-room-projection-baseline')
  leave=options.enter(match[1]);const owner=options.owner(match[1],body.epoch);if(!owner)reject(409,'word-room-projection-owner')
  const guard=()=>{if(options.owner(match[1],body.epoch)!==owner)reject(409,'word-room-projection-owner');owner!.assertAcceptingPackets();if(owner!.state().revision!==body.revision)reject(409,'word-room-projection-changed')}
  guard();const signal=AbortSignal.timeout(30_000),native=await awaitRecoveryResponse(()=>options.projection(match[1],body.epoch,body.revision,signal),signal);guard()
  if(!native.ok)reject(native.status===401||native.status===403?403:409,'word-room-projection-unavailable')
  const bytes=await readBoundedResponse(native,16*1024*1024,signal,'word-room-projection-limit'),projection=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));guard()
  if(projection.documentId!==match[1]||projection.revision!==body.revision||!Array.isArray(projection.blocks))reject(409,'word-room-projection-invalid')
  readWordLayout({layout:projection.flowLayout,layoutHash:projection.flowLayoutHash,revision:projection.revision},body.revision,2)
  const current=await authorize();if(current.collaborationEpoch!==user.collaborationEpoch||current.userId!==user.userId)reject(403,'word-room-projection-authority');guard()
  result={wordRegionVersion:2,wordLayoutVersion:1,projection,saveState:wordRoomStatus(owner!.state(),wordLayoutProtocol)}
 }catch(error){status=error instanceof Rejected?error.status:409;result={code:error instanceof Rejected?error.code:'word-room-projection-unavailable'}}finally{leave?.()}
 if(!response.destroyed){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(result))}return true
}
