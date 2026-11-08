import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

/** Preflight is read-only. Stop waiting for stalled headers or bodies, and
 * reject oversized or malformed replies before they can enable an export. */
export async function readExportPreflight(
 request:(signal:AbortSignal)=>Promise<Response>,
 cancellation?:AbortSignal,
 timeoutMs=120_000,
):Promise<unknown>{
 const timeout=new AbortController()
 const timer=setTimeout(()=>timeout.abort(new DOMException('Export preflight timed out','TimeoutError')),timeoutMs)
 const signal=AbortSignal.any([timeout.signal,...(cancellation?[cancellation]:[])])
 try{
  const response=await awaitRecoveryResponse(()=>request(signal),signal)
  const bytes=await readBoundedResponse(response,64*1024,signal,'export-preflight-limit')
  signal.throwIfAborted()
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
 }finally{clearTimeout(timer)}
}
