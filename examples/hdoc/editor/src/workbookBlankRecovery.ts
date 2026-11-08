import type {Session} from './api.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import {WorkbookBlankSave,validateBlankCreateAttempt} from './workbookBlankSave.ts'
import {validateWorkbookBlankInput} from './workbookBlankInput.ts'
import {inspectWorkbookBlanks} from './workbookBlankInspection.ts'

/** Transfer the compared copy to a new journal before resolving its exact
 * request. The source copy stays intact until the caller completes launch. */
export async function resolveWorkbookBlankRecovery(state:FixedDraftState,session:Session,sourceHash:string,write:(value:FixedDraftState)=>Promise<void>,signal:AbortSignal):Promise<FixedDraftState>{
 if(!state.blankAttempt)return state
 const attempt=validateBlankCreateAttempt(state.blankAttempt,session,sourceHash)
 let recovered=structuredClone(state)
 await write(recovered)
 const saver=new WorkbookBlankSave(session,sourceHash,{write:async next=>{
  const {blankAttempt:_,...rest}=recovered
  const snapshot:FixedDraftState=next?{...rest,version:rest.blankInput?6:5,blankAttempt:next}:{...rest,version:rest.blankInput?6:rest.workbookBuffer?4:3}
  await write(snapshot);recovered=snapshot
 },superseded:async()=>{
  // A legacy request can lack a separate input buffer. Reconstruct it only
  // when it contains one cell and cannot overwrite a different later input.
  if(attempt.cells.length!==1)throw new Error('blank recovery requires review')
  const cell=attempt.cells[0],existing=recovered.blankInput
  if(existing&&(existing.cell.nodeId!==cell.nodeId||existing.cell.sheetId!==cell.sheetId||existing.cell.sheetPart!==cell.sheetPart||existing.cell.row!==cell.row||existing.cell.column!==cell.column))throw new Error('blank recovery requires review')
  const input=existing??validateWorkbookBlankInput({documentId:attempt.documentId,baseRevision:attempt.baseRevision,sourceSha256:attempt.sourceSha256,cell},session,sourceHash)
  const {blankAttempt:_,...rest}=recovered
  const snapshot:FixedDraftState={...rest,version:6,blankInput:input}
  await write(snapshot);recovered=snapshot
 }},attempt)
 await saver.save(attempt,signal)
 // The buffer may have been captured after the submitted attempt. Only
 // remove it when it is exactly the intent confirmed by that receipt.
 const input=recovered.blankInput
 if(input&&attempt.cells.some(cell=>cell.nodeId===input.cell.nodeId&&cell.sheetId===input.cell.sheetId&&cell.sheetPart===input.cell.sheetPart&&cell.row===input.cell.row&&cell.column===input.cell.column&&cell.text===input.cell.text)){
  const {blankInput:_,...rest}=recovered
  const snapshot:FixedDraftState={...rest,version:rest.workbookBuffer?4:3}
  await write(snapshot);recovered=snapshot
 }
 return recovered
}

/** After explicit comparison, transfer the input before inspecting and
 * submitting. A changed or newly occupied target is never overwritten. */
export async function resolveWorkbookBlankInput(state:FixedDraftState,session:Session,sourceHash:string,revision:number,write:(value:FixedDraftState)=>Promise<void>,signal:AbortSignal):Promise<FixedDraftState>{
 if(!state.blankInput)return state
 if(state.blankAttempt)throw new Error('blank save pending')
 const input=validateWorkbookBlankInput(state.blankInput,session,sourceHash)
 let recovered=structuredClone(state)
 await write(recovered)
 const cell=input.cell
 const observation=await inspectWorkbookBlanks(session,revision,sourceHash,[{sheetId:cell.sheetId,row:cell.row-1,column:cell.column-1}],signal)
 const found=observation.cells[0]
 if(found.nodeId!==cell.nodeId||found.sheetPart!==cell.sheetPart)throw new Error('blank input target changed')
 const attempt={documentId:session.documentId,patchId:`grid-${crypto.randomUUID()}`,baseRevision:revision,sourceSha256:sourceHash,cells:[cell]}
 const saver=new WorkbookBlankSave(session,sourceHash,{write:async next=>{
  const {blankAttempt:_,blankInput:__,...rest}=recovered
  const snapshot:FixedDraftState=next?{...rest,version:6,blankInput:input,blankAttempt:next}:{...rest,version:rest.workbookBuffer?4:3}
  await write(snapshot);recovered=snapshot
 }})
 await saver.save(attempt,signal)
 return recovered
}
