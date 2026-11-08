import {ApiError,type Session} from './api.ts'
import {inspectWorkbookBlanks,type BlankTarget} from './workbookBlankInspection.ts'
import {WorkbookBlankSave,validateBlankCreateAttempt,type BlankCreateAttempt} from './workbookBlankSave.ts'

export type BlankBatchCell=BlankTarget&{text:string}
export type BlankBatchInput={documentId:string;sourceSha256:string;baseRevision:number;rootHash:string;cells:BlankBatchCell[]}
export type BlankBatchState={input:BlankBatchInput;attempt:BlankCreateAttempt|null}
/** A classified inspection failure occurred before any request was persisted
 * or submitted. Submission failures must remain separate: their result can
 * be unknown even when the server reports a conflict. */
export class BlankBatchInspectionError extends Error {
 constructor(cause:ApiError){super('blank batch inspection failed',{cause})}
}
/** The store must compare and replace the entire state atomically and durably.
 * It must isolate document, source, service and authenticated user. */
export type BlankBatchStore={read:()=>Promise<BlankBatchState|null>;replace:(expected:BlankBatchState,next:BlankBatchState|null)=>Promise<boolean>}
const hash=/^[a-f0-9]{64}$/
const sheet=/^s_[a-f0-9]{32}$/
const invalidText=/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
export function validateBlankBatchInput(input:BlankBatchInput,session:Session,sourceHash:string):BlankBatchInput{
 if(!input||session.format!=='xlsx'||input.documentId!==session.documentId||input.sourceSha256!==sourceHash||!hash.test(sourceHash)||!hash.test(input.rootHash)||!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0||!Array.isArray(input.cells)||input.cells.length<1||input.cells.length>4000)throw new Error('invalid blank batch')
 const seen=new Set<string>(),cells=input.cells.map(cell=>{
  if(!cell||!sheet.test(cell.sheetId)||!Number.isInteger(cell.row)||cell.row<0||cell.row>=1_048_576||!Number.isInteger(cell.column)||cell.column<0||cell.column>=16_384||typeof cell.text!=='string'||!cell.text.length||cell.text.length>1_000_000||cell.text.startsWith('=')||invalidText.test(cell.text))throw new Error('invalid blank batch')
  const key=`${cell.sheetId}:${cell.row}:${cell.column}`;if(seen.has(key))throw new Error('invalid blank batch');seen.add(key)
  return{sheetId:cell.sheetId,row:cell.row,column:cell.column,text:cell.text}
 })
 const result={documentId:input.documentId,sourceSha256:sourceHash,baseRevision:input.baseRevision,rootHash:input.rootHash,cells}
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>4*1024*1024)throw new Error('invalid blank batch')
 return result
}

export function sameBlankBatchAttempt(input:BlankBatchInput,attempt:BlankCreateAttempt){
 return attempt.baseRevision===input.baseRevision&&attempt.cells.length===input.cells.length&&attempt.cells.every((cell,index)=>{const expected=input.cells[index];return cell.sheetId===expected.sheetId&&cell.row===expected.row+1&&cell.column===expected.column+1&&cell.text===expected.text})
}

/** Submit only a previously durable whole batch. Inspection and creation
 * share one immutable revision; a conflict leaves all input for review. */
export async function saveBlankBatch(session:Session,sourceHash:string,store:BlankBatchStore,signal:AbortSignal,inspect=inspectWorkbookBlanks,stillAllowed:()=>boolean=()=>true,acknowledgeAllowed:()=>boolean=stillAllowed,newAttemptAllowed:()=>boolean=()=>true){
 let creating=false
 const guard=()=>{signal.throwIfAborted();if(session.scope!=='write'||!session.userId||!stillAllowed())throw new Error('readOnlyMode');if(creating&&!newAttemptAllowed())throw new Error('blank batch other request pending')}
 guard();const initial=await store.read();guard();if(!initial)throw new Error('blank batch missing')
 creating=!initial.attempt;guard()
 const input=validateBlankBatchInput(initial.input,session,sourceHash)
 let state:BlankBatchState={input,attempt:initial.attempt?validateBlankCreateAttempt(initial.attempt,session,sourceHash):null}
 if(state.attempt&&!sameBlankBatchAttempt(input,state.attempt))throw new Error('blank batch attempt changed')
 if(!state.attempt){
  let checked:Awaited<ReturnType<typeof inspectWorkbookBlanks>>
  try{checked=await inspect(session,input.baseRevision,sourceHash,input.cells.map(({sheetId,row,column})=>({sheetId,row,column})),signal)}catch(cause){if(cause instanceof ApiError)throw new BlankBatchInspectionError(cause);throw cause}
  guard()
  if(checked.revision!==input.baseRevision||checked.rootHash!==input.rootHash||checked.cells.length!==input.cells.length)throw new Error('blank batch baseline changed')
  const cells=checked.cells.map((cell,index)=>{const expected=input.cells[index];if(cell.sheetId!==expected.sheetId||cell.row!==expected.row||cell.column!==expected.column)throw new Error('blank batch target changed');return{sheetId:cell.sheetId,sheetPart:cell.sheetPart,sheetName:cell.sheetName,row:cell.row+1,column:cell.column+1,nodeId:cell.nodeId,text:expected.text}})
  state={input,attempt:validateBlankCreateAttempt({documentId:session.documentId,sourceSha256:sourceHash,baseRevision:input.baseRevision,patchId:`grid-${crypto.randomUUID()}`,cells},session,sourceHash)}
 }
 const attempt=state.attempt!
 let current:BlankBatchState={input,attempt:initial.attempt?state.attempt:null}
 const saver=new WorkbookBlankSave(session,sourceHash,{write:async next=>{
  if(next)guard();else{signal.throwIfAborted();if(session.scope!=='write'||!session.userId||!acknowledgeAllowed())throw new Error('readOnlyMode')}
  const replacement=next?{input,attempt:next}:null
  if(!await store.replace(current,replacement))throw new Error('blank batch changed')
  // Recheck before sending a newly persisted attempt. Once a verified receipt
  // has cleared it, a concurrent refresh must not turn success into failure.
  if(replacement){guard();current=structuredClone(replacement)}
 },superseded:async()=>{
  guard();const replacement={input,attempt:null}
  if(!await store.replace(current,replacement))throw new Error('blank batch changed')
  current=replacement
 }},initial.attempt?attempt:null,()=>{signal.throwIfAborted();if(!stillAllowed())throw new Error('readOnlyMode');return newAttemptAllowed()})
 guard();return saver.save(attempt,signal)
}
