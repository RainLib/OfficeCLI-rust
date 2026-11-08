import {inlineProtocol,structuralProtocol,nodeEditWireVersion} from './collaborationProtocol.ts'
import type {Session} from './api.ts'
import {negotiationURL,protocolDelay} from './protocolClient.ts'
type Transport={on:(event:string,handler:(value:any)=>void)=>unknown;off:(event:string,handler:(value:any)=>void)=>unknown;sendStateless:(value:string)=>void}
export type RestoreSubmission={requestId:string;target:number;expectedRevision:number;fromEpoch:number}
export class RestoreClientError extends Error{constructor(readonly code:string,readonly uncertain=false){super(code)}}
export async function submitRestore(session:Session,submission:RestoreSubmission,signal:AbortSignal){
 let response:Response
 try{response=await fetch(negotiationURL(session).replace(/negotiate$/,`restore/${submission.target}`),{method:'POST',headers:{'X-HCD-Node-Edits-Version':String(nodeEditWireVersion),'X-HCD-Custom-Marks-Version':'1',...(session.collaborationProtocol===inlineProtocol?{'X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3'}:{}),Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify({requestId:submission.requestId,expectedRevision:submission.expectedRevision,fromEpoch:submission.fromEpoch}),signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])})}catch{throw new RestoreClientError('restore-pending',true)}
 if(!response.ok){let code='restore-rejected';try{code=(await response.json()).code??code}catch{};throw new RestoreClientError(code,response.status>=500||code==='restore-pending'||code==='restore-busy')}
 try{const receipt=await response.json();if(receipt.requestId!==submission.requestId||receipt.revision!==submission.expectedRevision+1||receipt.restoredFrom!==submission.target||receipt.collaborationEpoch!==submission.fromEpoch+1||receipt.collaborationProtocol!==(session.collaborationProtocol??structuralProtocol))throw new Error();return receipt as {revision:number;collaborationEpoch:number}}catch{throw new RestoreClientError('restore-pending',true)}
}
/** Lock synchronously on the prepare packet, then drain the local journal and
 * outgoing provider updates. No private in-flight upload may attest ready. */
export function installRestoreHandoff(provider:Transport,host:{freeze:()=>void;ready:()=>Promise<boolean>;release:()=>void;committed:(epoch:number)=>void}){
 let current:string|null=null,closed=false
 const receive=({payload}:{payload:string})=>{
  let message:any;try{message=JSON.parse(payload)}catch{return}
  if(!/^[a-f0-9]{32}$/.test(message.requestId??''))return
  if(message.type==='hcd-restore-prepare'){
   if(current&&current!==message.requestId)return
   current=message.requestId;host.freeze()
   void host.ready().catch(()=>false).then(ready=>{if(!closed&&current===message.requestId)provider.sendStateless(JSON.stringify({type:'hcd-restore-ready',requestId:current,ready}))})
  }else if(message.type==='hcd-restore-release'&&current===message.requestId){current=null;host.release()}
  else if(message.type==='hcd-restore-committed'&&Number.isSafeInteger(message.collaborationEpoch)){host.freeze();host.committed(message.collaborationEpoch)}
 }
 provider.on('stateless',receive)
 return()=>{closed=true;provider.off('stateless',receive)}
}
export async function waitRestoreSync(provider:{isSynced:boolean;hasUnsyncedChanges:boolean},signal:AbortSignal){const until=Date.now()+10000;while(!signal.aborted&&(!provider.isSynced||provider.hasUnsyncedChanges)){if(Date.now()>until)return false;await protocolDelay(50,signal)}return!signal.aborted}
/** Recheck device tasks across asynchronous drain/sync phases. A task can
 * appear in another window without its notification being delivered yet. */
export async function restoreHandoffReady(input:{blocked:()=>boolean;devicePending:()=>Promise<boolean>;drain:()=>Promise<void>;sync:()=>Promise<boolean>}){
 if(input.blocked()||await input.devicePending())return false
 await input.drain()
 if(input.blocked()||await input.devicePending())return false
 if(!await input.sync())return false
 return !input.blocked()&&!await input.devicePending()&&!input.blocked()
}
/** A committed server restore cannot be undone here. Preserve this window's
 * private work before following the new epoch, even after a ready reply. */
export async function followCommittedRestore(input:{flush:()=>Promise<void>;devicePending:()=>Promise<boolean>;blocked:()=>boolean;alive:()=>boolean;commit:()=>void}){
 await input.flush()
 if(!input.alive()||input.blocked()||await input.devicePending()||!input.alive()||input.blocked())return false
 input.commit();return true
}
