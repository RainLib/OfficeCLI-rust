import {api,type Session} from './api.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

/** Auditing is read-only; enabling protection can have an unknown outcome if
 * its response is lost. Neither operation commits or clears cell drafts. */
export async function workbookFormulaAudit(session:Session,revision:number,enable:boolean,signal:AbortSignal){
 if(!Number.isSafeInteger(revision)||revision<0)throw new Error('invalid audit revision')
 const path=enable?'/xlsx/formula-audit':`/xlsx/formula-audit?revision=${revision}`
 const response=await awaitRecoveryResponse(()=>api(session,path,enable?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision}),signal}:{signal}),signal)
 const bytes=await readBoundedResponse(response,64*1024,signal,'invalid audit result')
 let value:unknown
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new Error('invalid audit result')}
 if(!value||typeof value!=='object')throw new Error('invalid audit result')
 const result=value as {revision?:unknown;editableCellsChecked?:unknown;sourceFreeEditsAuthorized?:unknown;scope?:unknown}
 if(result.revision!==revision||!Number.isSafeInteger(result.editableCellsChecked)||(result.editableCellsChecked as number)<0||result.sourceFreeEditsAuthorized!==enable||enable&&result.scope!=='this-server')throw new Error('invalid audit result')
 signal.throwIfAborted()
 return {revision,editableCellsChecked:result.editableCellsChecked as number}
}
