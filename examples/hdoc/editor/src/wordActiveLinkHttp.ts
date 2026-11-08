import type {IncomingMessage,ServerResponse} from 'node:http'
import type {CollaborationAccess} from './collaborationAccess.ts'
import {readActiveLinkPending,type WordActiveLinkStatus} from './wordActiveLink.ts'
import {inspectActiveWordLinkReceipt} from './wordActiveLinkReceipt.ts'
import type {WordPendingLink} from './wordLinkProof.ts'
import type {WordTopologyMember} from './wordTopologyAuthority.ts'
import {previewActiveWordLink} from './wordActiveLinkPreview.ts'
import {readWordLinkSelection} from './wordLinkPlan.ts'
import {wordLayoutProtocol} from './collaborationProtocol.ts'
import {requireWordHttpModel} from './wordRoomHost.ts'
type Owner=Pick<Parameters<typeof previewActiveWordLink>[0],'room'|'journal'|'assertOwnership'|'request'>
type Options={enabled:boolean;access:(id:string,token:string)=>Promise<CollaborationAccess>;enter:(id:string)=>()=>void;owner:(id:string,epoch:number)=>Owner|undefined;submit:(id:string,epoch:number,pending:WordPendingLink,reviewHash:string,authorize:()=>Promise<WordTopologyMember>)=>Promise<{transactionId:string;revision:number;status:'installed'}>;cancel:(id:string,epoch:number,pending:WordPendingLink,reviewHash:string,authorize:()=>Promise<WordTopologyMember>)=>Promise<{transactionId:string;status:'not-prepared'}>;status:(id:string,epoch:number,transactionId:string)=>WordActiveLinkStatus}
class Rejected extends Error{constructor(readonly status:number,readonly code:string){super(code)}}
export async function wordActiveLinkHttp(request:IncomingMessage,response:ServerResponse,options:Options){
 const match=/^\/v1\/documents\/([A-Za-z0-9_-]{1,128})\/collaboration\/word-active-link-(preview|submit|status|cancel|check)$/.exec(new URL(request.url??'/','http://sidecar').pathname)
 if(!match)return false
 response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-hcd-node-edits-version,x-hcd-word-regions-version,x-hcd-word-layout-version,x-hcd-word-link-version');response.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');response.setHeader('Cache-Control','no-store')
 if(request.method==='OPTIONS'){response.writeHead(204);response.end();return true}
 let leave:(()=>void)|undefined,status=200,result:unknown
 try{
  if(!options.enabled)throw new Rejected(426,'word-link-preview-unavailable')
  if(request.method!=='POST')throw new Rejected(405,'word-link-preview-method')
  const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))throw new Rejected(401,'word-link-preview-authority')
  const authorize=async()=>{const user=await options.access(match[1],authorization.slice(7));if(!['read','write'].includes(user.scope)||match[2]!=='status'&&(user.scope!=='write'||!user.userId||!user.displayName)||!Number.isFinite(user.expiresAt)||Date.now()>=user.expiresAt*1000||user.collaborationProtocol!==wordLayoutProtocol||user.coordinatedRestore!==true)throw new Rejected(403,'word-link-preview-authority');try{requireWordHttpModel(user.collaborationProtocol,request.headers,true)}catch{throw new Rejected(426,'word-link-preview-client')};if(request.headers['x-hcd-word-link-version']!=='1')throw new Rejected(426,'word-link-preview-client');return{...user,userId:user.userId,displayName:user.displayName}}
  const user=await authorize(),parts:Buffer[]=[];let size=0;const timer=setTimeout(()=>request.destroy(Error('word-link-input-timeout')),15000)
  try{for await(const part of request){const bytes=Buffer.from(part);size+=bytes.length;if(size>(['submit','cancel','check'].includes(match[2])?256*1024:8192))throw new Rejected(413,'word-link-preview-input-limit');parts.push(bytes)}}finally{clearTimeout(timer)}
  let body:any;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)))}catch{throw new Rejected(400,'word-link-preview-input')}
  if(!body||body.epoch!==user.collaborationEpoch)throw new Rejected(409,'word-link-preview-baseline')
  if(match[2]==='status'){
   if(Object.keys(body).sort().join(',')!=='epoch,transactionId'||!/^[a-f0-9]{32}$/.test(body.transactionId??''))throw new Rejected(400,'word-active-link-invalid')
   const current=await authorize();if(current.collaborationEpoch!==user.collaborationEpoch||current.userId!==user.userId)throw new Rejected(403,'word-link-preview-authority')
   result=options.status(match[1],body.epoch,body.transactionId)
  }else if(['submit','cancel','check'].includes(match[2])){
   if(Object.keys(body).sort().join(',')!=='epoch,pending,reviewHash'||!/^[a-f0-9]{64}$/.test(body.reviewHash??''))throw new Rejected(400,'word-active-link-invalid')
   const pending=readActiveLinkPending(body.pending,match[1],{scope:'write',userId:user.userId!,displayName:user.displayName!})
   const member=async()=>{const current=await authorize();if(current.collaborationEpoch!==user.collaborationEpoch)throw new Rejected(403,'word-link-preview-authority');return{scope:'write' as const,userId:current.userId!,displayName:current.displayName!}}
   if(match[2]==='check'){
    leave=options.enter(match[1]);const owner=options.owner(match[1],body.epoch);if(!owner)throw new Rejected(409,'word-active-link-room-unavailable')
    const guard=()=>{owner.assertOwnership();owner.room.assertAcceptingPackets();if(options.owner(match[1],body.epoch)?.room!==owner.room)throw Error('word-owner-unavailable');if(owner.room.state().revision<pending.request.expectedRevision+1)throw Error('word-active-link-not-installed')}
    result=await inspectActiveWordLinkReceipt({journal:owner.journal,pending,guard,authorize:member,request:owner.request})
   }else result=await options[match[2]==='cancel'?'cancel':'submit'](match[1],body.epoch,pending,body.reviewHash,member)
  }else{
   if(Object.keys(body).sort().join(',')!=='epoch,selection')throw new Rejected(409,'word-link-preview-baseline')
   const selection=readWordLinkSelection(body.selection)
   leave=options.enter(match[1]);const owner=options.owner(match[1],body.epoch);if(!owner)throw new Rejected(409,'word-link-preview-owner')
   result=await previewActiveWordLink({...owner,selection,actor:{userId:user.userId!,displayName:user.displayName!},authorize:async()=>{const current=await authorize();if(current.collaborationEpoch!==user.collaborationEpoch||current.userId!==user.userId||current.displayName!==user.displayName)throw new Rejected(403,'word-link-preview-authority');return{scope:'write',userId:current.userId!,displayName:current.displayName!}}})
  }
 }catch(error){const known=new Set(['word-link-selection-invalid','word-link-first-section','word-link-already-inherited','word-link-review-changed','word-link-baseline-invalid','word-link-preflight-invalid','word-link-preflight-unavailable','word-link-response-limit','word-story-source-draft-pending','word-story-baseline-invalid','word-topology-cancelled','word-topology-client-upgrade-required','word-topology-client-busy','word-link-pending-invalid','word-active-link-invalid','word-active-link-request-changed','word-active-link-pending','word-active-link-busy','word-active-link-epoch-changed','word-active-link-cancelled']);status=error instanceof Rejected?error.status:error instanceof Error&&error.message==='word-topology-actor-unauthorized'?403:409;result={code:error instanceof Rejected?error.code:error instanceof Error&&known.has(error.message)?error.message:['submit','cancel','check'].includes(match[2])?'word-active-link-outcome-unknown':'word-link-preview-unavailable'}}finally{leave?.()}
 if(!response.destroyed){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(result))}return true
}
