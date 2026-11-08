import type {Session} from './api.ts'
import type {DeletionReview} from './deletionReview.ts'
import {structuralProtocol,inlineProtocol,wordLayoutProtocol,nodeEditWireVersion,requireCollaborationSession,type CollaborationSession} from './collaborationProtocol.ts'
type Transport={on:(event:string,handler:(value:any)=>void)=>unknown;off:(event:string,handler:(value:any)=>void)=>unknown;sendStateless:(value:string)=>void}
export class ProtocolClientError extends Error{constructor(readonly key:'protocolUnavailable'|'protocolWaiting'|'protocolPending',readonly status?:number){super(key)}}
export function negotiationURL(session:Session){
 const url=new URL(session.collabUrl||'ws://127.0.0.1:8768')
 if(!['ws:','wss:','http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new ProtocolClientError('protocolUnavailable')
 url.protocol=url.protocol==='wss:'||url.protocol==='https:'?'https:':'http:'
 url.pathname=url.pathname.replace(/\/$/,'')+`/v1/documents/${encodeURIComponent(session.documentId)}/collaboration/negotiate`
 return url.href
}
export async function negotiateSession(session:Session,signal:AbortSignal,models:{inlineContainers?:true;wordLayoutV2?:true}={}):Promise<CollaborationSession>{
 signal.throwIfAborted()
 if(models.inlineContainers!==undefined&&models.inlineContainers!==true||models.wordLayoutV2!==undefined&&models.wordLayoutV2!==true||models.inlineContainers&&models.wordLayoutV2)throw new ProtocolClientError('protocolUnavailable')
 if(session.collaborationProtocol===inlineProtocol&&!models.inlineContainers)throw new ProtocolClientError('protocolUnavailable')
 if(session.collaborationProtocol===wordLayoutProtocol&&!models.wordLayoutV2)throw new ProtocolClientError('protocolUnavailable')
 const response=await fetch(negotiationURL(session),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,...(models.inlineContainers?{'X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3','X-HCD-Node-Edits-Version':String(nodeEditWireVersion),'X-HCD-Custom-Marks-Version':'1'}:{}),...(models.wordLayoutV2?{'X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Node-Edits-Version':String(nodeEditWireVersion)}:{})},signal:AbortSignal.any([signal,AbortSignal.timeout(45_000)])})
 if(!response.ok){let code='';try{code=(await response.json()).code}catch{};throw new ProtocolClientError(code==='migration-online-clients'?'protocolWaiting':response.status===503?'protocolPending':'protocolUnavailable',response.status)}
 const value=await response.json();if((value.collaborationProtocol===structuralProtocol||value.collaborationProtocol===inlineProtocol||value.collaborationProtocol===wordLayoutProtocol)&&value.nodeEditVersion!==nodeEditWireVersion||value.collaborationProtocol===inlineProtocol&&(!models.inlineContainers||value.inlineContainers!==1)||models.inlineContainers&&value.collaborationProtocol!==inlineProtocol||value.collaborationProtocol===wordLayoutProtocol&&(!models.wordLayoutV2||value.wordRegionVersion!==2||value.wordLayoutVersion!==1)||models.wordLayoutV2&&value.collaborationProtocol!==wordLayoutProtocol)throw new ProtocolClientError('protocolUnavailable');return requireCollaborationSession(value,{wordLayoutV2:models.wordLayoutV2})
}
export async function restoreInlineDeletion(session:Session,review:Pick<DeletionReview,'key'|'receipt'|'snapshot'>,signal:AbortSignal){
 if(session.collaborationProtocol!==structuralProtocol&&session.collaborationProtocol!==inlineProtocol||!Number.isSafeInteger(session.collaborationEpoch))throw new Error('deletion-review-changed')
 const url=negotiationURL(session).replace(/\/negotiate$/,'/inline-restore'),response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json','X-HCD-Node-Edits-Version':String(nodeEditWireVersion),...(session.collaborationProtocol===inlineProtocol?{'X-HCD-Inline-Containers-Version':'1'}:{})},body:JSON.stringify({epoch:session.collaborationEpoch,review}),signal:AbortSignal.any([signal,AbortSignal.timeout(45_000)])})
 if(!response.ok)throw new Error('deletion-review-changed')
 return response.json()
}
export function confirmProtocolReady(provider:Transport,signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  const requestId=crypto.randomUUID(),fail=()=>{clean();reject(new ProtocolClientError('protocolUnavailable'))}
  const receive=({payload}:{payload:string})=>{let message:any;try{message=JSON.parse(payload)}catch{return}if(message.type!=='hcd-protocol-ready'||message.requestId!==requestId||message.version!==1||message.ready!==true)return;clean();resolve()}
  const timer=setTimeout(fail,15_000),clean=()=>{clearTimeout(timer);provider.off('stateless',receive);signal.removeEventListener('abort',fail)}
  provider.on('stateless',receive);signal.addEventListener('abort',fail,{once:true})
  if(signal.aborted){fail();return}
  try{provider.sendStateless(JSON.stringify({type:'hcd-protocol-ready',version:1,requestId}))}catch{fail()}
 })
}

/** Abortable polling without retaining one listener per completed delay. */
export function protocolDelay(milliseconds:number,signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  const finish=()=>{signal.removeEventListener('abort',abort);resolve()},abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new ProtocolClientError('protocolUnavailable'))}
  const timer=setTimeout(finish,milliseconds);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
 })
}
