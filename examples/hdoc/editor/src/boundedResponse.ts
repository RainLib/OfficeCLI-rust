/** Stop waiting for local read/hash work. The work itself may finish later;
 * callers must check the signal before any subsequent side effect. */
export function awaitRecoveryPreparation<T>(work:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  let settled=false
  const finish=(action:()=>void)=>{if(settled)return;settled=true;signal.removeEventListener('abort',stop);action()}
  const stop=()=>finish(()=>reject(signal.reason))
  signal.addEventListener('abort',stop,{once:true})
  if(signal.aborted){stop();return}
  Promise.resolve().then(()=>{signal.throwIfAborted();return work()}).then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)))
 })
}

/** Stop waiting for a response even if a transport ignores abort. A late
 * response is closed without waiting for cleanup. For mutations the caller
 * must treat cancellation as an unknown outcome, never as a rollback. */
export function awaitRecoveryResponse(request:()=>Promise<Response>,signal:AbortSignal):Promise<Response>{
 return new Promise((resolve,reject)=>{
  let settled=false
  const stop=()=>{if(!settled){settled=true;reject(signal.reason)}}
  signal.addEventListener('abort',stop,{once:true})
  if(signal.aborted){stop();return}
  Promise.resolve().then(()=>{signal.throwIfAborted();return request()}).then(response=>{
   if(settled||signal.aborted){void response.body?.cancel(signal.reason).catch(()=>{});if(!settled)stop();return}
   settled=true;signal.removeEventListener('abort',stop);resolve(response)
  },error=>{if(!settled){settled=true;signal.removeEventListener('abort',stop);reject(error)}})
  if(signal.aborted)stop()
 })
}

/** Limit response bodies while reading, not after allocating an unbounded buffer. */
export async function readBoundedResponse(response:Response,max:number,signal:AbortSignal,limitError='semantic-recovery-limit'):Promise<Uint8Array<ArrayBuffer>>{
 if(signal.aborted){void response.body?.cancel(signal.reason).catch(()=>{});signal.throwIfAborted()}
 const length=response.headers.get('content-length')
 if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>max)){
  // Cancellation is best effort: a broken transport may never settle it.
  // The rejected size check must not keep the recovery UI waiting on cleanup.
  void response.body?.cancel().catch(()=>{})
  throw new Error(limitError)
 }
 const reader=response.body?.getReader();if(!reader)throw new Error(limitError)
 const chunks:Uint8Array[]=[];let total=0
 const abort=()=>{void reader.cancel(signal.reason).catch(()=>{})}
 signal.addEventListener('abort',abort,{once:true})
 try{
  for(;;){
   signal.throwIfAborted()
   const part=await reader.read();signal.throwIfAborted();if(part.done)break
   total+=part.value.byteLength
   if(total>max)throw new Error(limitError)
   chunks.push(part.value)
  }
 }catch(error){void reader.cancel().catch(()=>{});throw error}finally{signal.removeEventListener('abort',abort);reader.releaseLock()}
 const result=new Uint8Array(total);let offset=0
 for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}
 return result
}
