import type {NodeLink} from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import type {FixedSaveController,WorkbookInputBuffer} from './fixedSaveController.ts'
import type {TextDraftStore} from './textDrafts.ts'

export function workbookCellAddress(row:number,column:number){let value=column+1,label='';while(value>0){value--;label=String.fromCharCode(65+value%26)+label;value=Math.floor(value/26)}return `${label}${row+1}`}
/** A backup's location is descriptive; the node identity and base hash remain authoritative. */
export function workbookInputLocation(buffer:WorkbookInputBuffer){return `${buffer.sheetName??buffer.sheetId}!${workbookCellAddress(buffer.row,buffer.column)}`}
export function restoreWorkbookInput(texts:TextDraftStore,buffer:WorkbookInputBuffer){texts.edit(buffer.base,buffer.revision,buffer.text)}
/** A draft that changed after input began is a separate local intent. */
export function workbookInputDiverged(texts:TextDraftStore,buffer:WorkbookInputBuffer){
 const draft=texts.get(buffer.base.nodeId)
 return !!draft&&draft.text!==buffer.initial&&draft.text!==buffer.text
}

/** Private editor input, separate from committed cell drafts. It may be
 * restored only after the user compares the device copy with the server. */
export class WorkbookInputCapture {
 private active:{buffer:WorkbookInputBuffer;ended:boolean;observed:boolean;mismatch:boolean}|null=null
 private settled=new Set<()=>void>()
 constructor(private texts:TextDraftStore,private controller:FixedSaveController){}
 subscribeSettled(listener:()=>void){this.settled.add(listener);return()=>{this.settled.delete(listener)}}
 private finish(){this.active=null;for(const listener of this.settled)listener()}
 isActive(){return this.active!==null}
 canStart(){return !this.active&&!this.controller.workbookBuffer}
 abandon(){this.active=null}
 reject(nodeId:string){if(this.active?.buffer.base.nodeId!==nodeId)return false;this.finish();return true}
 start(link:Readonly<NodeLink>,head:number,sheetName?:string){
  // A delayed start event can also arrive before the first change, or after
  // typing returns to the initial value. Keep the active capture until it ends.
  if(!link.editable||!this.canStart())return
  const draft=this.texts.get(link.nodeId),canonical=this.texts.currentRun(link,link.revision??head)
  const base=draft?.base??canonical,initial=draft?.text??canonical.text
  this.active={buffer:{base:{nodeId:base.nodeId,nodeHash:base.nodeHash,text:base.text},revision:draft?.revision??link.revision??head,initial,text:initial,sheetId:link.sheetId,...(sheetName&&sheetName.length<=160&&!/[\x00-\x1f]/.test(sheetName)?{sheetName}:{}),row:link.row,column:link.column},ended:false,observed:false,mismatch:false}
 }
 change(nodeId:string,dataStream:string){
  const active=this.active;if(!active||active.buffer.base.nodeId!==nodeId||active.ended)return
  // Univer's document data stream ends with a mandatory CR/LF sentinel.
  const text=dataStream.endsWith('\r\n')?dataStream.slice(0,-2):dataStream
  active.buffer={...active.buffer,text};active.observed=false;active.mismatch=false
  this.controller.setWorkbookBuffer(text===active.buffer.initial?null:active.buffer)
 }
 observed(nodeId:string,text:string){
  const active=this.active;if(!active||active.buffer.base.nodeId!==nodeId)return
  if(text!==active.buffer.text){active.mismatch=true;if(active.ended)this.finish();return}
  active.mismatch=false
  active.observed=true;if(active.ended){this.controller.setWorkbookBuffer(null);this.finish()}
 }
 end(nodeId:string,confirm:boolean){
  const active=this.active;if(!active||active.buffer.base.nodeId!==nodeId)return
  if(!confirm||active.observed||!this.controller.workbookBuffer){this.controller.setWorkbookBuffer(null);this.finish();return}
  if(active.mismatch){this.finish();return}
  active.ended=true
 }
}
