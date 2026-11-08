import {api,type Session} from './api.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {workbookServerHead} from './workbookExportGuard.ts'
import {workbookCellAddress} from './workbookInputBuffer.ts'
import {validateWorkbookBlankInput,type WorkbookBlankInput} from './workbookBlankInput.ts'

/** A conflict comparison is pinned to one server head and checked against
 * the original cell identity. It is not permission to overwrite that head. */
export async function workbookBlankConflict(session:Session,sourceHash:string,value:WorkbookBlankInput,signal:AbortSignal){
 const input=validateWorkbookBlankInput(value,session,sourceHash),revision=await workbookServerHead(session,sourceHash,signal)
 const response=await awaitRecoveryResponse(()=>api(session,`/text/${encodeURIComponent(input.cell.nodeId)}?revision=${revision}`,{signal,cache:'no-store'}),signal)
 const bytes=await readBoundedResponse(response,2*1024*1024,signal,'invalid blank conflict')
 let data:any;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new Error('invalid blank conflict')}
 if(!data||data.documentId!==session.documentId||data.revision!==revision||data.nodeId!==input.cell.nodeId||typeof data.text!=='string'||typeof data.nodeHash!=='string'||!/^[a-f0-9]{64}$/.test(data.nodeHash)||!data.source||data.source.nodeKind!=='cell'||data.source.part!==input.cell.sheetPart||data.source.paragraphId!==workbookCellAddress(input.cell.row-1,input.cell.column-1)||typeof data.source.editable!=='boolean')throw new Error('invalid blank conflict')
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data.text)),hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')
 signal.throwIfAborted();if(hash!==data.nodeHash)throw new Error('invalid blank conflict')
 return {revision,run:{nodeId:data.nodeId as string,nodeHash:data.nodeHash as string,text:data.text as string},editable:data.source.editable as boolean}
}
