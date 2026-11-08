/** Member-authenticated upload transport. Binary bytes never travel in Yjs or
 * the signed journal; metadata must be reserved before a body is accepted. */
import type {IncomingMessage,ServerResponse} from 'node:http'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import type {WordUploadActor} from './wordUploads.ts'
import {nodeEditWireVersion,type CollaborationSession} from './collaborationProtocol.ts'
import {requireWordHttpModel,type WordRoomProtocol} from './wordRoomHost.ts'
export type WordUploadAccess=CollaborationSession&{scope:string;userId?:string;displayName?:string;expiresAt:number}
type Options={enabled:boolean;layoutEnabled?:boolean;access:(id:string,token:string)=>Promise<WordUploadAccess>;owner:(id:string,epoch:number,protocol:WordRoomProtocol)=>WordSaveCoordinator|undefined;enter:(id:string)=>()=>void;remember:(id:string,epoch:number,actor:WordUploadActor,token:string,protocol:WordRoomProtocol)=>void;bodyTimeoutMs?:number}
class Rejected extends Error{constructor(readonly status:number,readonly code:string){super(code)}}
const reject=(status:number,code:string):never=>{throw new Rejected(status,code)}
async function bytes(request:IncomingMessage,limit:number,timeoutMs:number){
 let size=0;const chunks:Buffer[]=[];let timedOut=false
 const timer=setTimeout(()=>{timedOut=true;request.destroy(new Error('word-upload-read-timeout'))},timeoutMs)
 try{for await(const chunk of request){const next=Buffer.from(chunk);size+=next.length;if(size>limit)reject(413,'word-upload-too-large');chunks.push(next)}return Buffer.concat(chunks)}
 catch(error){if(timedOut)reject(408,'word-upload-read-timeout');throw error}
 finally{clearTimeout(timer)}
}
export async function wordUploadHttp(request:IncomingMessage,response:ServerResponse,options:Options){
 const path=new URL(request.url??'/','http://sidecar').pathname,match=/^\/v1\/documents\/([A-Za-z0-9_-]{1,128})\/collaboration\/word-uploads(?:\/([a-f0-9-]{36}))?$/.exec(path)
 if(!match)return false
 response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-hcd-node-edits-version,x-hcd-collaboration-epoch,x-hcd-word-regions-version,x-hcd-word-layout-version');response.setHeader('Access-Control-Allow-Methods','POST,PUT,OPTIONS');response.setHeader('Cache-Control','no-store')
 if(request.method==='OPTIONS'){response.writeHead(204);response.end();return true}
 let status=200,result:unknown,leave:(()=>void)|undefined
 try{
  if(!options.enabled)reject(426,'word-upload-unavailable')
  if(request.headers['x-hcd-node-edits-version']!==String(nodeEditWireVersion))reject(426,'word-upload-client-upgrade')
  const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))reject(401,'word-upload-authority-required')
  const token=authorization!.slice(7),user=await options.access(match[1],token),epoch=Number(request.headers['x-hcd-collaboration-epoch'])
  if(!Number.isSafeInteger(epoch)||epoch!==user.collaborationEpoch)reject(409,'word-upload-session-changed')
  let protocol:WordRoomProtocol;try{protocol=requireWordHttpModel(user.collaborationProtocol,request.headers,options.layoutEnabled)}catch(error){if(error instanceof Error&&error.message==='word-room-disabled')reject(409,'word-upload-session-changed');reject(426,'word-upload-client-upgrade')}
  if(!user.userId||!['read','write'].includes(user.scope)||Date.now()>=user.expiresAt*1000)reject(403,'word-upload-authority-required')
  leave=options.enter(match[1]);const owner=options.owner(match[1],epoch,protocol!);if(!owner)reject(409,'word-upload-room-unavailable')
  const actor:WordUploadActor={userId:user.userId!,displayName:user.displayName,scope:'write'}
  const writable=()=>{if(user.scope!=='write')reject(403,'word-upload-owner-required');options.remember(match[1],epoch,actor,token,protocol!)}
  if(match[2]){
   if(request.method!=='PUT')reject(405,'word-upload-method')
   writable();const record=owner!.uploads.snapshot().find(record=>record.id===match[2]&&record.actor.userId===user.userId)
   if(!record)reject(404,'word-upload-not-found')
   const body=await bytes(request,Math.min(8*1024*1024,record!.byteLength),options.bodyTimeoutMs??45_000);if(body.length!==record!.byteLength)reject(400,'word-upload-file-differs')
   // A disconnected request never abandons the persisted choice. The owner
   // verifies bytes/authority; explicit cancellation is a separate operation.
   result={version:1,record:await owner!.uploads.resume(actor,match[2],body)}
  }else{
   if(request.method!=='POST')reject(405,'word-upload-method')
   let body:any;try{body=JSON.parse((await bytes(request,1024*1024,options.bodyTimeoutMs??45_000)).toString('utf8'))}catch(error){if(error instanceof Rejected)throw error;reject(400,'word-upload-input-invalid')}
   if(!body||Object.keys(body).sort().join(',')!==(body.operation==='reserve'||body.operation==='cancel-selection'?'operation,selection':body.operation==='list'?('ids'in body?'ids,operation':'operation'):'id,operation')||!['list','reserve','resume','cancel','cancel-selection'].includes(body.operation))reject(400,'word-upload-input-invalid')
   if(body.operation==='list'){if(body.ids!==undefined&&(!Array.isArray(body.ids)||body.ids.length>128||body.ids.some((id:unknown)=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))))reject(400,'word-upload-input-invalid');const ids=new Set(body.ids??[]);result={version:1,records:owner!.uploads.snapshot().filter(record=>record.actor.userId===user.userId&&(['reserved','staged','interrupted'].includes(record.phase)||ids.has(record.id)))}}
   else{
    writable()
    if(body.operation==='reserve'||body.operation==='cancel-selection'){
     const selection=body.selection;if(!selection||Object.keys(selection).sort().join(',')!=='assetHash,byteLength,clientId,extension,id,nodeId,revision,seen,visualHash')reject(400,'word-upload-input-invalid')
     result={version:1,record:await (body.operation==='reserve'?owner!.uploads.reserve(actor,selection):owner!.uploads.cancelSelection(actor,selection))}
    }else{
     if(typeof body.id!=='string'||!/^[a-f0-9-]{36}$/.test(body.id))reject(400,'word-upload-input-invalid')
     if(!owner!.uploads.snapshot().some(record=>record.id===body.id&&record.actor.userId===user.userId))reject(404,'word-upload-not-found')
     if(body.operation==='cancel'){await owner!.uploads.cancel(actor,body.id);result={version:1,record:owner!.uploads.snapshot().find(record=>record.id===body.id)}}
     else result={version:1,record:await owner!.uploads.resume(actor,body.id)}
    }
   }
  }
 }catch(error){status=error instanceof Rejected?error.status:409;const message=error instanceof Error?error.message:'';result={code:error instanceof Rejected?error.code:/^word-upload-[a-z:-]{1,80}(?:\d{3})?$/.test(message)?message:'word-upload-unavailable'}}finally{leave?.()}
 if(!response.destroyed){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(result))}return true
}
