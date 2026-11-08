/** Bounded asynchronous work uses a rolling window so a slow transfer does not
 * leave the other slots idle. Results retain input order; on error or external
 * cancellation, no further work starts and all already-started work drains. */
export async function boundedAsyncPool<T>(tasks:readonly ((signal:AbortSignal)=>Promise<T>)[],signal:AbortSignal,limit=4):Promise<T[]>{
 signal.throwIfAborted()
 if(!Number.isSafeInteger(limit)||limit<1||limit>4)throw new RangeError('invalid concurrency')
 const cancelled=new AbortController(),combined=AbortSignal.any([signal,cancelled.signal]),results:T[]=new Array(tasks.length)
 let next=0,failure:{reason:unknown}|undefined
 async function worker(){
  while(!combined.aborted){
   const index=next++;if(index>=tasks.length)return
   try{combined.throwIfAborted();results[index]=await tasks[index](combined)}
   catch(reason){if(!failure&&!signal.aborted){failure={reason};cancelled.abort(reason)}return}
  }
 }
 await Promise.all(Array.from({length:Math.min(limit,tasks.length)},()=>worker()))
 signal.throwIfAborted()
 if(failure)throw failure.reason
 return results
}
