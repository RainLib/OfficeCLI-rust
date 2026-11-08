import {api,type Session} from './api.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

/** A failed or cancelled wait does not imply that the server did not restore
 * the source. Retrying the same file is safe because the server checks its
 * source identity and never overwrites a different file. */
export async function restoreWorkbookSource(session:Session,file:Blob,signal:AbortSignal){
 if(!file.size||file.size>256*1024*1024)throw new Error('invalid workbook size')
 const response=await awaitRecoveryResponse(()=>api(session,'/xlsx/source',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal}),signal)
 const bytes=await readBoundedResponse(response,64*1024,signal,'invalid source receipt')
 let value:unknown
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new Error('invalid source receipt')}
 if(!value||typeof value!=='object')throw new Error('invalid source receipt')
 const receipt=value as {sourceRestored?:unknown;revision?:unknown;alreadyPresent?:unknown}
 if(receipt.sourceRestored!==true||!Number.isSafeInteger(receipt.revision)||(receipt.revision as number)<0||typeof receipt.alreadyPresent!=='boolean')throw new Error('invalid source receipt')
 signal.throwIfAborted()
 return {revision:receipt.revision as number,alreadyPresent:receipt.alreadyPresent}
}
