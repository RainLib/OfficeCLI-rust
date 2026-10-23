import {api,ApiError,type Session} from './api.ts'
import type {DraftAction} from './draftActions.ts'
import {TextDraftStore,type TextRun} from './textDrafts.ts'
import {ImageDraftStore,desiredAsset,validGeometry,type PositionedImage} from './imageDrafts.ts'

const fields=['x','y','width','height','assetHash'] as const
type Field=typeof fields[number]
type Action=({type:'text'}&DraftAction<TextRun>)|({type:'image'}&DraftAction<PositionedImage>)
const value=(image:PositionedImage,key:Field)=>key==='assetHash'?image.assetHash??null:image.geometry[key]
const clean=(image:PositionedImage):PositionedImage=>({nodeId:image.nodeId,visualHash:image.visualHash,assetHash:image.assetHash,geometry:{...image.geometry}})
const sameTarget=(a:Action,b:Action)=>a.type===b.type&&a.after.nodeId===b.after.nodeId
const changedFields=(action:Extract<Action,{type:'image'}>)=>fields.filter(key=>!Object.is(value(action.before,key),value(action.after,key)))
const validRevision=(revision:number)=>Number.isSafeInteger(revision)&&revision>=0
const hash=/^[a-f0-9]{64}$/

/** Session-local user actions across all fixed/section targets. Undo stages a
 * field-specific inverse against an authenticated current object, never restores
 * a document revision. Only Save publishes it through the normal CAS/receipt path. */
export class FixedHistory {
 private undoStack:Action[]=[]
 private redoStack:Action[]=[]
 private detach:Array<()=>void>
 private version=0
 private listeners=new Set<()=>void>()
 private lastEdit=0
 private closed=false
 private abort=new AbortController()
 private working=false
 constructor(private session:Session,private texts:TextDraftStore,private images:ImageDraftStore,private blocked:()=>boolean,private now=()=>Date.now()){
  this.detach=[texts.actions.subscribe(action=>this.record({type:'text',...action})),images.actions.subscribe(action=>this.record({type:'image',...action}))]
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 private changed(){this.version++;this.listeners.forEach(listener=>listener())}
 get busy(){return this.working}
 get canUndo(){return this.undoStack.length>0&&!this.working&&!this.blocked()}
 get canRedo(){return this.redoStack.length>0&&!this.working&&!this.blocked()}
 stopCapturing(){this.lastEdit=0}
 private record(action:Action){
  if(this.closed)return
  if(action.type==='image')action={...action,before:clean(action.before),after:clean(action.after)}
  if(action.kind==='reset'){
   this.undoStack=this.undoStack.filter(entry=>!sameTarget(entry,action));this.redoStack=this.redoStack.filter(entry=>!sameTarget(entry,action));this.stopCapturing();this.changed();return
  }
  const previous=this.undoStack.at(-1),at=this.now()
  const continuous=previous&&sameTarget(previous,action)&&previous.kind===action.kind&&action.kind==='edit'&&this.lastEdit>0&&at-this.lastEdit<750
   &&(previous.type==='text'&&action.type==='text'?previous.after.text===action.before.text:previous.type==='image'&&action.type==='image'&&JSON.stringify(changedFields(previous))===JSON.stringify(changedFields(action))&&fields.every(key=>Object.is(value(previous.after,key),value(action.before,key))))
  if(continuous)this.undoStack[this.undoStack.length-1]={...previous,after:action.after} as Action
  else this.undoStack.push(action)
  const latest=this.undoStack.at(-1)
  if(latest&&(latest.type==='text'?latest.before.text===latest.after.text:!changedFields(latest).length))this.undoStack.pop()
  this.redoStack=[];this.lastEdit=at
  // Bound retained text/resource metadata. Resource bytes never enter history.
  while(this.undoStack.length>200||JSON.stringify(this.undoStack).length>4*1024*1024)this.undoStack.shift()
  this.changed()
 }
 skip(direction:'undo'|'redo',expectedVersion:number){
  if(this.closed||this.working||this.blocked()||this.session.scope!=='write')throw new Error('historyBusy')
  if(expectedVersion!==this.version)throw new Error('historyChanged')
  const stack=direction==='undo'?this.undoStack:this.redoStack
  if(!stack.length)throw new Error('historyEmpty')
  stack.pop();this.stopCapturing();this.changed()
 }
 async step(direction:'undo'|'redo'):Promise<{revision:number;nodeId:string;type:Action['type'];page?:number}>{
  if(this.closed||this.working||this.blocked())throw new Error('historyBusy')
  if(this.session.scope!=='write')throw new Error('readOnlyMode')
  const from=direction==='undo'?this.undoStack:this.redoStack,to=direction==='undo'?this.redoStack:this.undoStack,action=from.at(-1)
  if(!action)throw new Error('historyEmpty')
  this.working=true;this.stopCapturing();this.changed()
  const textVersion=this.texts.snapshot(),imageVersion=this.images.snapshot(),historyVersion=this.version
  const nodeId=action.after.nodeId
  const expected=direction==='undo'?action.after:action.before,desired=direction==='undo'?action.before:action.after
  try{
   const response=await api(this.session,`/${action.type==='text'?'text':'images'}/${encodeURIComponent(nodeId)}`,{signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)])})
   const result=await response.json()
   if(this.closed||this.blocked())throw new Error('historyBusy')
   if(textVersion!==this.texts.snapshot()||imageVersion!==this.images.snapshot()||historyVersion!==this.version)throw new Error('historyChanged')
   if(!validRevision(result.revision))throw new Error('historyInvalid')
   if(action.type==='text'){
    const current=result as TextRun&{revision:number},draft=this.texts.get(nodeId)
    if(current.nodeId!==nodeId||typeof current.text!=='string'||!hash.test(current.nodeHash))throw new Error('historyInvalid')
    if(draft&&(draft.stale==='deleted'||draft.base.nodeHash!==current.nodeHash&&draft.text!==current.text))throw new Error('historyConflict')
    if((draft?.text??current.text)!==(expected as TextRun).text)throw new Error('historyConflict')
    this.texts.applyHistory(current,result.revision,(desired as TextRun).text,action.page)
   }else{
    const current=result.image as PositionedImage|null,draft=this.images.get(nodeId)
    if(!current)throw new Error('historyDeleted')
    if(current.nodeId!==nodeId||!current.geometry||!validGeometry(current.geometry)||!hash.test(current.visualHash)||(current.assetHash!=null&&!hash.test(current.assetHash)))throw new Error('historyInvalid')
    if(draft?.remote)throw new Error('historyConflict')
    if(draft?.deleted||draft&&draft.base.geometry.unit!==current.geometry.unit||current.geometry.unit!==(desired as PositionedImage).geometry.unit)throw new Error('historyConflict')
    const next=clean(current)
    const set=(key:Field,source:PositionedImage)=>{if(key==='assetHash')next.assetHash=source.assetHash;else next.geometry[key]=source.geometry[key]}
    // Rebase unrelated local fields only if their canonical value did not diverge.
    if(draft){const local={...draft.base,geometry:draft.geometry,assetHash:desiredAsset(draft)}
     for(const key of fields)if(!Object.is(value(draft.base,key),value(local,key))){
      if(!Object.is(value(current,key),value(draft.base,key))&&!Object.is(value(current,key),value(local,key)))throw new Error('historyConflict')
      set(key,local)
     }
    }
    for(const key of changedFields(action)){
     if(!Object.is(value(next,key),value(expected as PositionedImage,key)))throw new Error('historyConflict')
     if(key==='assetHash'&&!hash.test((desired as PositionedImage).assetHash??'')&&!(this.session.format==='pdf'&&(desired as PositionedImage).assetHash==null))throw new Error('historyInvalid')
     set(key,desired as PositionedImage)
    }
    // Invalid local numeric input can be undone. Redo keeps it visibly invalid;
    // normal save validation continues to reject it.
    this.images.applyHistory(current,result.revision,next,action.page)
   }
   from.pop();to.push(action);this.changed()
   return {revision:result.revision,nodeId,type:action.type,page:action.page}
  }catch(error){if(error instanceof ApiError&&error.status===404)throw new Error('historyDeleted');throw error}
  finally{this.working=false;this.changed()}
 }
 dispose(){this.closed=true;this.abort.abort();this.detach.forEach(detach=>detach());this.listeners.clear()}
}
