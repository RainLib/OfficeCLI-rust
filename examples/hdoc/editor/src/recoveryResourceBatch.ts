/** Abort sibling transfers after the first failure, but drain all started
 * work before returning: a request may have reached the server already. */
export async function recoveryResourceBatch(tasks:readonly ((signal:AbortSignal)=>Promise<void>)[],signal:AbortSignal):Promise<void>{
 signal.throwIfAborted()
 const cancelled=new AbortController(),batchSignal=AbortSignal.any([signal,cancelled.signal]);let failure:{reason:unknown}|undefined
 const results=await Promise.allSettled(tasks.map(task=>Promise.resolve().then(()=>{batchSignal.throwIfAborted();return task(batchSignal)}).catch(reason=>{if(!failure&&!signal.aborted){failure={reason};cancelled.abort(reason)}throw reason})))
 signal.throwIfAborted()
 const rejected=results.find((result):result is PromiseRejectedResult=>result.status==='rejected')
 if(failure)throw failure.reason
 if(rejected)throw rejected.reason
}

export {boundedAsyncPool as recoveryResourcePool} from './boundedAsyncPool.ts'
