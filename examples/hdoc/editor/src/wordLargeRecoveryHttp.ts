/** One bounded recovery update over HTTP, admitted atomically by the current
 * regional owner. A lost response is deliberately not treated as a receipt. */
import type {IncomingMessage,ServerResponse} from 'node:http'
import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import {nodeEditWireVersion} from './collaborationProtocol.ts'
import type {WordUploadAccess} from './wordUploadHttp.ts'
import type {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {wordRoomGuard} from './wordRoomGuard.ts'
import {wordRecoveryMaxBytes} from './wordRecoveryChunks.ts'
import {requireWordHttpModel,type WordRoomProtocol} from './wordRoomHost.ts'

type Options={enabled:boolean;layoutEnabled?:boolean;access:(id:string,token:string)=>Promise<WordUploadAccess&{coordinatedRestore?:boolean}>;enter:(id:string)=>()=>void;owner:(id:string,epoch:number,protocol:WordRoomProtocol)=>WordSaveCoordinator|undefined;timeoutMs?:number}
class Reject extends Error{constructor(readonly status:number,readonly code:string){super(code)}}
const fail=(status:number,code:string):never=>{throw new Reject(status,code)}
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex')
let active=0
async function readBody(request:IncomingMessage,timeoutMs:number){
 const chunks:Buffer[]=[];let size=0,timedOut=false
 const timer=setTimeout(()=>{timedOut=true;request.destroy(new Error('word-large-recovery-timeout'))},timeoutMs)
 try{for await(const part of request){const bytes=Buffer.from(part);size+=bytes.length;if(size>wordRecoveryMaxBytes)fail(413,'word-large-recovery-limit');chunks.push(bytes)}if(!size)fail(400,'word-large-recovery-invalid');return Buffer.concat(chunks)}
 catch(error){if(timedOut)fail(408,'word-large-recovery-timeout');throw error}finally{clearTimeout(timer)}
}
export async function wordLargeRecoveryHttp(request:IncomingMessage,response:ServerResponse,options:Options){
 const path=new URL(request.url??'/','http://sidecar').pathname,match=/^\/v1\/documents\/([A-Za-z0-9_-]{1,128})\/collaboration\/word-large-recovery$/.exec(path)
 if(!match)return false
 response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-hcd-node-edits-version,x-hcd-collaboration-epoch,x-hcd-recovery-baseline,x-hcd-recovery-hash,x-hcd-word-regions-version,x-hcd-word-layout-version');response.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');response.setHeader('Cache-Control','no-store')
 if(request.method==='OPTIONS'){response.writeHead(204);response.end();return true}
 let status=200,result:unknown,leave:(()=>void)|undefined,acquired=false
 try{
  if(!options.enabled)fail(426,'word-large-recovery-unavailable')
  if(request.method!=='POST')fail(405,'word-large-recovery-method')
  if(request.headers['x-hcd-node-edits-version']!==String(nodeEditWireVersion))fail(426,'word-large-recovery-client')
  const authorization=request.headers.authorization,baseline=request.headers['x-hcd-recovery-baseline'],expected=request.headers['x-hcd-recovery-hash'],epoch=Number(request.headers['x-hcd-collaboration-epoch'])
  if(!authorization?.startsWith('Bearer '))fail(401,'word-large-recovery-authority')
  if(typeof baseline!=='string'||!/^[a-f0-9]{64}$/.test(baseline)||typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected)||!Number.isSafeInteger(epoch)||epoch<0)fail(400,'word-large-recovery-invalid')
  const token=authorization!.slice(7);let protocol:WordRoomProtocol|undefined
  const authorize=async()=>{const user=await options.access(match[1],token);if(user.scope!=='write'||!user.userId||!Number.isFinite(user.expiresAt)||Date.now()>=user.expiresAt*1000||user.collaborationEpoch!==epoch||user.coordinatedRestore!==true)fail(403,'word-large-recovery-authority');let current:WordRoomProtocol;try{current=requireWordHttpModel(user.collaborationProtocol,request.headers,options.layoutEnabled)}catch(error){if(error instanceof Error&&error.message==='word-room-disabled')fail(403,'word-large-recovery-authority');fail(426,'word-large-recovery-client')};if(protocol&&protocol!==current!)fail(403,'word-large-recovery-authority');protocol=current!;return user}
  const user=await authorize();if(active>=2)fail(429,'word-large-recovery-busy');active++;acquired=true
  leave=options.enter(match[1]);const body=await readBody(request,options.timeoutMs??45_000);if(hash(body)!==expected)fail(400,'word-large-recovery-integrity')
  const latest=await authorize();if(latest.userId!==user.userId)fail(403,'word-large-recovery-authority')
  const owner=options.owner(match[1],epoch,protocol!);if(!owner)fail(409,'word-large-recovery-unavailable');owner!.assertAcceptingPackets()
  if(owner!.state().problem==='contributors-unbound')fail(409,'word-large-recovery-unavailable')
  const document=owner!.model.document;if(hash(Y.encodeSnapshot(Y.snapshot(document)))!==baseline)fail(409,'word-large-recovery-changed')
  const guard=wordRoomGuard(owner!.model,id=>owner!.imageRegion(id),{block:id=>owner!.canonicalBlockRegion(id),text:id=>owner!.canonicalTextRegion(id)},protocol!)
  try{guard.accept(body)}finally{guard.destroy()}
  // No await between the baseline check, guard and trusted room transaction.
  owner!.change({userId:latest.userId!,displayName:latest.displayName,scope:'write'},()=>Y.applyUpdate(document,body))
  await owner!.persist();const problem=owner!.state().problem;if(problem==='contributors-unbound'||problem==='word-model-invalid')fail(409,'word-large-recovery-unavailable');result={version:1,hash:expected}
 }catch(error){status=error instanceof Reject?error.status:409;result={code:error instanceof Reject?error.code:'word-large-recovery-unavailable'}}finally{leave?.();if(acquired)active--}
 if(!response.destroyed){response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(result))}return true
}
