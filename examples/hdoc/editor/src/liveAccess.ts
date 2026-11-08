import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {api,type Session} from './api.ts'
import {accessDenied,writeAllowed,type AccessSnapshot} from './accessPolicy.ts'

export type LiveAccessState='write'|'read'|'revoked'|'unavailable'
/** Terminal loss of authority is sticky for this open editor. A fresh opening
 * must authenticate again; polling cannot replay old queued edits after a grant. */
export class LiveAccess {
 private state:LiveAccessState
 private lost=false
 private closed=false
 private abort=new AbortController()
 private timer:ReturnType<typeof setTimeout>|undefined
 private listeners=new Set<()=>void>()
 constructor(private session:Session,private interval=2000){this.state=session.scope}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.state
 private set(state:LiveAccessState){if(this.state!==state){this.state=state;this.listeners.forEach(listener=>listener())}}
 async refresh(){
  if(this.closed||this.lost)return
  const owner=this.abort
  try{
   const signal=AbortSignal.any([owner.signal,AbortSignal.timeout(15_000)])
   const response=await awaitRecoveryResponse(()=>api(this.session,'/auth',{signal}),signal)
   const bytes=await readBoundedResponse(response,64*1024,signal,'access-response-limit')
   const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as AccessSnapshot
   if(this.closed||this.lost||owner!==this.abort)return
   if(!['read','write'].includes(result.scope??''))throw new Error('Invalid document access snapshot')
   if(this.session.scope==='write'&&!writeAllowed(result)){this.lost=true;this.set('revoked')}
   else this.set(this.session.scope==='write'?'write':'read')
  }catch(error){if(this.closed||this.lost||owner!==this.abort)return;if(accessDenied(error)){this.lost=true;this.set('revoked')}else this.set('unavailable')}
 }
 start(){
  this.abort.abort();clearTimeout(this.timer)
  this.closed=false;const owner=this.abort=new AbortController()
  const poll=async()=>{await this.refresh();if(owner===this.abort&&!this.closed&&!this.lost)this.timer=setTimeout(poll,this.interval)}
  void poll();return()=>{if(owner===this.abort)this.dispose()}
 }
 dispose(){this.closed=true;this.abort.abort();clearTimeout(this.timer)}
}
