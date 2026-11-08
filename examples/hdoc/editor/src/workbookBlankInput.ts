import type {Session} from './api.ts'
import {validateBlankCreateAttempt,type BlankCreateCell} from './workbookBlankSave.ts'

/** Unsubmitted text for a source-checked blank. This is not an HTTP attempt:
 * text may change while the user is still typing. */
export type WorkbookBlankInput={documentId:string;baseRevision:number;sourceSha256:string;cell:BlankCreateCell}

/** Batch coordinates are zero-based; retained blank requests are one-based. */
export function workbookBatchAvoidsBlank(cells:ReadonlyArray<{sheetId:string;row:number;column:number}>,input:WorkbookBlankInput|null,attempt:{cells:ReadonlyArray<BlankCreateCell>}|null){
 const reserved=[...(input?[input.cell]:[]),...(attempt?.cells??[])]
 return !cells.some(cell=>reserved.some(value=>value.sheetId===cell.sheetId&&value.row===cell.row+1&&value.column===cell.column+1))
}
/** A retained request can advance the known head before the visible grid is
 * reloaded. Its older verified snapshot remains a safe draft baseline; later
 * submission still requires explicit current-head review. */
export function workbookBatchSnapshotAllowed(revision:number,head:number|null,unresolved:boolean){
 return head!==null&&Number.isSafeInteger(revision)&&revision>=0&&(revision===head||unresolved&&revision<head)
}

export function validateWorkbookBlankInput(value:unknown,session:Session,sourceHash:string):WorkbookBlankInput{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid blank input')
 const item=value as Record<string,unknown>
 const checked=validateBlankCreateAttempt({documentId:item.documentId,baseRevision:item.baseRevision,sourceSha256:item.sourceSha256,patchId:'grid-input',cells:[item.cell]},session,sourceHash)
 return {documentId:checked.documentId,baseRevision:checked.baseRevision,sourceSha256:checked.sourceSha256,cell:checked.cells[0]}
}

/** Records each input change through the owner, which keeps the full journal
 * snapshot. End-of-edit never discards a confirmed value before a durable
 * draft or exact save attempt has taken ownership of it. */
export class WorkbookBlankInputCapture{
 private current:WorkbookBlankInput|null=null
 private ended=false
 private didObserve=false
 constructor(private readonly setBuffer:(value:WorkbookBlankInput|null)=>void){}
 get active(){return this.current!==null&&!this.ended}
 get ownsInput(){return this.current!==null}
 matches(sheetId:string,row:number,column:number){const cell=this.current?.cell;return !!cell&&cell.sheetId===sheetId&&cell.row===row+1&&cell.column===column+1}
 acceptsObservation(sheetId:string,row:number,column:number){return !this.didObserve&&this.matches(sheetId,row,column)}
 start(input:WorkbookBlankInput){
  if(this.current)throw new Error('blank input already active')
  this.current=structuredClone(input);this.ended=false;this.didObserve=false
 }
 change(sheetId:string,row:number,column:number,dataStream:string){
  const input=this.current
  if(!input||this.ended||input.cell.sheetId!==sheetId||input.cell.row!==row+1||input.cell.column!==column+1)return
  const text=dataStream.endsWith('\r\n')?dataStream.slice(0,-2):dataStream
  input.cell.text=text;this.didObserve=false
  this.setBuffer(text?structuredClone(input):null)
 }
 observed(sheetId:string,row:number,column:number,text:string){
  if(!this.acceptsObservation(sheetId,row,column)||!this.current)return
  this.didObserve=true;this.current.cell.text=text;this.setBuffer(text?structuredClone(this.current):null)
 }
 end(confirm:boolean){
  if(!this.current)return
  if(!confirm||!this.current.cell.text){this.setBuffer(null);this.current=null;this.ended=false;return}
  this.ended=true
 }
 /** Losing access or closing the editor must preserve the private buffer. */
 abandon(){this.current=null;this.ended=false}
 /** The owner calls this only after preserving the same intent elsewhere. */
 release(){this.current=null;this.ended=false}
}
