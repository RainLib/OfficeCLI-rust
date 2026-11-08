/** Per-client input pause. A ready reply is not a save receipt and never
 * consumes the device journal. Only the matching release resumes this round. */
import {awaitRecoveryPreparation} from './boundedResponse.ts'
type Options={send:(value:unknown)=>void;ready:()=>boolean;pause:()=>()=>void;flush:()=>Promise<void>;synced:()=>boolean;generation:()=>number;changed:()=>void;timeoutMs?:number}
type Round={id:string;abort:AbortController;resume:()=>void;acknowledged:boolean}
export const wordTopologyWire={version:1,nodeEditVersion:7,wordRegionVersion:2,wordLayoutVersion:1} as const
export class WordTopologyPause{
 private round:Round|undefined
 private closed=false
 constructor(private readonly options:Options){}
 get pending(){return !!this.round}
 get requestId(){return this.round?.id}
 receive(value:unknown){
  const message=value as {type?:unknown;version?:unknown;requestId?:unknown;nodeEditVersion?:unknown;wordRegionVersion?:unknown;wordLayoutVersion?:unknown}
  if(!message||!['hcd-word-topology-prepare','hcd-word-topology-release'].includes(String(message.type))||message.version!==1||message.nodeEditVersion!==7||message.wordRegionVersion!==2||message.wordLayoutVersion!==1||typeof message.requestId!=='string'||!/^[a-f0-9]{32}$/.test(message.requestId))return false
  if(this.closed)return true
  if(message.type==='hcd-word-topology-release'){if(this.round?.id===message.requestId)this.release();return true}
  if(this.round){if(this.round.id!==message.requestId)this.reply(message.requestId,false);else if(this.round.acknowledged)this.reply(message.requestId,true);return true}
  if(!this.options.ready()){this.reply(message.requestId,false);return true}
  let resume:()=>void
  try{resume=this.options.pause();if(typeof resume!=='function')throw Error('word-topology-input-unavailable')}catch{this.reply(message.requestId,false);return true}
  const round:Round={id:message.requestId,abort:new AbortController(),resume,acknowledged:false};this.round=round;this.options.changed();void this.prepare(round);return true
 }
 private reply(id:string,ready:boolean){try{this.options.send({type:'hcd-word-topology-ready',...wordTopologyWire,requestId:id,ready})}catch{/* The server cannot count a reply it did not receive. */}}
 private async prepare(round:Round){
  const timeout=setTimeout(()=>round.abort.abort(),this.options.timeoutMs??12000)
  try{
   for(let attempt=0;attempt<4;attempt++){
    const generation=this.options.generation();await awaitRecoveryPreparation(()=>this.options.flush(),round.abort.signal)
    while(!this.options.synced()){
     round.abort.signal.throwIfAborted()
     await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(Error('word-topology-pause-cancelled'))},timer=setTimeout(()=>{round.abort.signal.removeEventListener('abort',abort);resolve()},20);round.abort.signal.addEventListener('abort',abort,{once:true});if(round.abort.signal.aborted)abort()})
    }
    if(this.round!==round||round.abort.signal.aborted)return
    if(generation!==this.options.generation())continue
    if(!this.options.ready())throw Error('word-topology-client-busy')
    round.acknowledged=true;this.reply(round.id,true);return
   }
   throw Error('word-topology-input-changed')
  }catch{if(this.round===round&&!this.closed)this.reply(round.id,false)}finally{clearTimeout(timeout)}
 }
 invalidate(){if(this.round?.acknowledged){this.round.acknowledged=false;this.reply(this.round.id,false)}}
 private release(){const round=this.round;if(!round)return;this.round=undefined;round.abort.abort();this.options.changed();round.resume()}
 dispose(){this.closed=true;this.round?.abort.abort();this.round=undefined}
}
