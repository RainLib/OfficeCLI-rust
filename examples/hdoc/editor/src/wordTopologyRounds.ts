import {wordTopologyWire} from './wordTopologyPause.ts'
type Round<P>={requestId:string;asked:Set<P>;ready:Set<P>;failed:boolean}
/** Runs before closing admission, so existing peers can flush and acknowledge.
 * The caller must assertReady again when freezing the exclusive transaction. */
export class WordTopologyRounds<P>{
 private rounds=new Map<string,Round<P>>()
 constructor(private readonly send:(peer:P,value:unknown)=>void,private readonly supported:(peer:P)=>boolean){}
 accept(id:string,peer:P,value:unknown){
  const round=this.rounds.get(id),message=value as {type?:unknown;version?:unknown;requestId?:unknown;ready?:unknown;nodeEditVersion?:unknown;wordRegionVersion?:unknown;wordLayoutVersion?:unknown}
  if(!round||!round.asked.has(peer)||!message||message.type!=='hcd-word-topology-ready'||message.version!==1||message.nodeEditVersion!==7||message.wordRegionVersion!==2||message.wordLayoutVersion!==1||message.requestId!==round.requestId||typeof message.ready!=='boolean')return false
  if(message.ready)round.ready.add(peer);else{round.ready.delete(peer);round.failed=true}return true
 }
 async prepare(id:string,requestId:string,peers:()=>readonly P[],assertAdmissionOpen:()=>void,timeoutMs=15000){
  if(!/^[a-f0-9]{32}$/.test(requestId)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('word-topology-round-invalid')
  if(this.rounds.has(id))throw Error('word-topology-round-busy')
  const round:Round<P>={requestId,asked:new Set(),ready:new Set(),failed:false};this.rounds.set(id,round);const deadline=Date.now()+timeoutMs
  try{
   while(true){
    assertAdmissionOpen();if(this.rounds.get(id)!==round)throw Error('word-topology-round-released')
    const current=peers();if(current.some(peer=>!this.supported(peer)))throw Error('word-topology-client-upgrade-required')
    for(const peer of current)if(!round.asked.has(peer)){round.asked.add(peer);this.send(peer,{type:'hcd-word-topology-prepare',...wordTopologyWire,requestId})}
    if(round.failed)throw Error('word-topology-client-busy')
    if(current.every(peer=>round.ready.has(peer)))return
    if(Date.now()>=deadline)throw Error('word-topology-client-timeout')
    await new Promise(resolve=>setTimeout(resolve,20))
   }
  }catch(error){this.release(id,requestId);throw error}
 }
 assertReady(id:string,requestId:string,peers:readonly P[]){const round=this.rounds.get(id);if(!round||round.requestId!==requestId||round.failed||peers.some(peer=>!this.supported(peer)||!round.asked.has(peer)||!round.ready.has(peer)))throw Error('word-topology-online-clients')}
 release(id:string,requestId:string){const round=this.rounds.get(id);if(!round||round.requestId!==requestId)return;this.rounds.delete(id);for(const peer of round.asked)try{this.send(peer,{type:'hcd-word-topology-release',...wordTopologyWire,requestId})}catch{/* A disconnected peer is fenced by its connection lifecycle. */}}
}
