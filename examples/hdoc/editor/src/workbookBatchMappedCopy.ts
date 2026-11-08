import {api,type Session} from './api.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {workbookBatchComparison,type BatchComparisonCell} from './workbookBatchComparison.ts'
import {workbookCellAddress} from './workbookInputBuffer.ts'
import {workbookServerHead} from './workbookExportGuard.ts'
import {TextDraftStore,type TextRun} from './textDrafts.ts'

type ReadInput={session:Session;source:string;revision:number;reviewed:BatchComparisonCell;signal:AbortSignal;guard:()=>boolean}
/** Reconfirm the exact reviewed mapping and full content at one server head. */
export async function readMappedBatchCell(input:ReadInput):Promise<TextRun>{
 const {session,source,revision,reviewed,signal,guard}=input,expected=structuredClone(reviewed)
 const check=()=>{signal.throwIfAborted();if(!guard())throw Error('batch-copy-unavailable')}
 check();if(!expected.mapped?.editable)throw Error('batch-copy-unavailable')
 if(await workbookServerHead(session,source,signal)!==revision)throw Error('batch-copy-changed');check()
 const [current]=await workbookBatchComparison(session,source,revision,[expected.cell],signal);check()
 if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('batch-copy-changed')
 const nodeId=expected.mapped.nodeId,response=await awaitRecoveryResponse(()=>api(session,`/text/${encodeURIComponent(nodeId)}?revision=${revision}`,{signal,cache:'no-store'}),signal)
 const bytes=await readBoundedResponse(response,8*1024*1024,signal,'batch-copy-invalid');let value:any
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw Error('batch-copy-invalid')}
 if(!value||value.documentId!==session.documentId||value.revision!==revision||value.nodeId!==nodeId||typeof value.text!=='string'||typeof value.nodeHash!=='string'||!/^[a-f0-9]{64}$/.test(value.nodeHash)||value.source?.nodeKind!=='cell'||value.source?.editable!==true||value.source?.paragraphId!==workbookCellAddress(expected.cell.row,expected.cell.column))throw Error('batch-copy-invalid')
 const chars=Array.from(value.text.slice(0,2002)),excerpt=chars.slice(0,1000).join(''),truncated=chars.length>1000||value.text.length>2002
 if(excerpt!==expected.mapped.text||truncated!==expected.mapped.truncated)throw Error('batch-copy-changed')
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.text)),actual=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')
 check();if(actual!==value.nodeHash)throw Error('batch-copy-invalid')
 if(await workbookServerHead(session,source,signal)!==revision)throw Error('batch-copy-changed');check()
 return{nodeId,nodeHash:value.nodeHash,text:value.text}
}
/** The reviewed full value is mandatory for truncated comparisons. The source
 * batch is never removed by this operation. */
export async function copyMappedBatchCell(input:ReadInput&{reviewedFull?:string;stage:(run:TextRun,revision:number,text:string)=>Promise<void>}){
 const run=await readMappedBatchCell(input)
 if(input.reviewed.mapped?.truncated&&input.reviewedFull!==run.text)throw Error('batch-copy-changed')
 if(input.reviewed.cell.text===run.text)throw Error('batch-copy-identical')
 input.signal.throwIfAborted();if(!input.guard())throw Error('batch-copy-unavailable')
 await input.stage(run,input.revision,input.reviewed.cell.text)
}

/** Stage once, or confirm the exact already-staged draft after an interrupted flush.
 * A different draft, remote conflict or changed base is never replaced. */
export async function stageMappedBatchDraft(input:{texts:TextDraftStore;run:TextRun;revision:number;text:string;signal:AbortSignal;guard:()=>boolean;flush:()=>Promise<void>}){
 const {texts,run,revision,text,signal,guard,flush}=input
 const check=()=>{signal.throwIfAborted();if(!guard())throw Error('batch-copy-unavailable')}
 const matches=()=>{const draft=texts.get(run.nodeId);return !!draft&&draft.revision===revision&&draft.base.nodeId===run.nodeId&&draft.base.nodeHash===run.nodeHash&&draft.base.text===run.text&&draft.text===text&&!draft.remote&&!draft.stale}
 check();if(texts.currentRun(run,revision).nodeHash!==run.nodeHash)throw Error('batch-copy-changed')
 const existing=texts.get(run.nodeId)
 if(existing&&!matches())throw Error('batch-copy-existing-draft')
 if(!existing)texts.edit(run,revision,text)
 await flush();check();if(!matches()||texts.currentRun(run,revision).nodeHash!==run.nodeHash)throw Error('batch-copy-changed')
}
