import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

/** Bounded transport for saved receipts, never a decision to release a draft.
 * A failed read may follow a successful server commit; retain the exact request. */
export async function readFixedReceipt(request:()=>Promise<Response>,signal:AbortSignal):Promise<any>{
 const response=await awaitRecoveryResponse(request,signal)
 const bytes=await readBoundedResponse(response,8*1024*1024,signal,'invalidSaveReceipt')
 let value:unknown
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new Error('invalidSaveReceipt')}
 signal.throwIfAborted()
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalidSaveReceipt')
 return value
}
