import type {FixedDraftCopy} from './fixedDraftJournal.ts'
import type {FixedDraftState} from './fixedSaveController.ts'

/** An interrupted startup may have written an exact request into a new
 * branch while the original input copy is still available for review. */
export function pendingWorkbookRecovery(input:FixedDraftState,sourceId:string,copies:readonly FixedDraftCopy[]):FixedDraftCopy|undefined{
 const blank=input.blankInput
 if(!blank||input.blankAttempt)return undefined
 return copies.find(copy=>{
  const attempt=copy.state.blankAttempt
  if(copy.id===sourceId||copy.retained||!attempt||attempt.documentId!==blank.documentId||attempt.sourceSha256!==blank.sourceSha256||attempt.baseRevision<blank.baseRevision||attempt.cells.length!==1)return false
  const a=attempt.cells[0],b=blank.cell
  return a.nodeId===b.nodeId&&a.sheetId===b.sheetId&&a.sheetPart===b.sheetPart&&a.row===b.row&&a.column===b.column&&a.text===b.text
 })
}
