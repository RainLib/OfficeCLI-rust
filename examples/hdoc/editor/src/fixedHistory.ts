import {api,ApiError,type Session} from './api.ts'
import type {DraftAction} from './draftActions.ts'
import {TextDraftStore,type TextRun,type TextDraft} from './textDrafts.ts'
import {ImageDraftStore,desiredAsset,validGeometry,type PositionedImage,type ImageDraft} from './imageDrafts.ts'

const fields=['x','y','width','height','assetHash'] as const
type Field=typeof fields[number]
type ChoiceAction<T,D>=DraftAction<T,D>&{published?:boolean;publishedFields?:Field[];replay?:{before:D|null;after:D|null;canonical:T}}
type Action=({type:'text'}&ChoiceAction<TextRun,TextDraft>)|({type:'image'}&ChoiceAction<PositionedImage,ImageDraft>)
type TextAction=Extract<Action,{type:'text'}>
type HistoryEntry=Action|{type:'batch';actions:TextAction[]}
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
 private undoStack:HistoryEntry[]=[]
 private redoStack:HistoryEntry[]=[]
 private collecting:TextAction[]|null=null
 private detach:Array<()=>void>
 private version=0
 private listeners=new Set<()=>void>()
 private lastEdit=0
 private closed=false
 private abort=new AbortController()
 private working=false
 private continuations=new Map<string,({type:'text';draft:TextDraft|null}|{type:'image';draft:ImageDraft|null})&{source:Action}>()
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
 /** Record an already-preflighted workbook edit as one user action. */
 batch(work:()=>void){
  if(this.collecting)throw new Error('historyBusy')
  const collected:TextAction[]=[];this.collecting=collected
  try{work()}finally{
   this.collecting=null
   if(collected.length===1)this.record(collected[0])
   else if(collected.length>1){for(const action of collected)this.continuations.delete(`text:${action.after.nodeId}`);this.undoStack.push({type:'batch',actions:collected});this.redoStack=[];this.lastEdit=0;while(this.undoStack.length>200||JSON.stringify(this.undoStack).length>4*1024*1024)this.undoStack.shift();this.changed()}
  }
 }
 private record(action:Action){
  if(this.closed)return
  if(this.collecting){if(action.type!=='text'||action.kind!=='edit')throw new Error('historyInvalid');this.collecting.push(action);return}
  this.continuations.delete(`${action.type}:${action.after.nodeId}`)
  if(action.type==='image')action={...action,before:clean(action.before),after:clean(action.after)}
  if(action.kind==='reset'){
   const keep=(entry:HistoryEntry)=>entry.type==='batch'?!entry.actions.some(item=>sameTarget(item,action)):!sameTarget(entry,action)
   this.undoStack=this.undoStack.filter(keep);this.redoStack=this.redoStack.filter(keep);this.stopCapturing();this.changed();return
  }
  const previous=this.undoStack.at(-1),at=this.now()
  const continuous=previous&&previous.type!=='batch'&&sameTarget(previous,action)&&previous.kind===action.kind&&action.kind==='edit'&&this.lastEdit>0&&at-this.lastEdit<750
   &&(previous.type==='text'&&action.type==='text'?previous.after.text===action.before.text:previous.type==='image'&&action.type==='image'&&JSON.stringify(changedFields(previous))===JSON.stringify(changedFields(action))&&fields.every(key=>Object.is(value(previous.after,key),value(action.before,key))))
  if(continuous)this.undoStack[this.undoStack.length-1]={...previous,after:action.after} as Action
  else this.undoStack.push(action)
  const latest=this.undoStack.at(-1)
  if(latest&&latest.type!=='batch'&&!latest.choice&&(latest.type==='text'?latest.before.text===latest.after.text:!changedFields(latest).length))this.undoStack.pop()
  this.redoStack=[];this.lastEdit=at
  // Bound retained text/resource metadata. Resource bytes never enter history.
  while(this.undoStack.length>200||JSON.stringify(this.undoStack).length>4*1024*1024)this.undoStack.shift()
  this.changed()
 }
 /** Only the captured branch is published by this exact immutable receipt. */
 captureSave(sent:{texts:Array<[string,TextDraft]>;images:Array<[string,ImageDraft]>}){
  const covered:Array<{action:Action;fields:Field[]}> = [],shadowed=new Map<string,Set<string>>()
  for(const action of [...this.undoStack].reverse()){
   if(action.type==='batch')continue
   if(!action.choice)continue
   const key=`${action.type}:${action.after.nodeId}`,later=shadowed.get(key)??new Set<string>()
   const choiceFields=action.type==='text'?['text']:action.choice.fields??[...fields]
   const active=choiceFields.filter(field=>!later.has(field));choiceFields.forEach(field=>later.add(field));shadowed.set(key,later)
   if(action.published||!active.length)continue
   if(action.type==='text'){
    const choice=action.choice
    if(choice.after&&choice.after.text!==choice.canonical.text&&sent.texts.some(([id,draft])=>id===action.after.nodeId&&draft.text!==choice.canonical.text))covered.push({action,fields:[]})
   }else{
    const choice=action.choice
    const publishing=active.filter(field=>fields.includes(field as Field)&&!Object.is(value(action.after,field as Field),value(choice.canonical,field as Field))) as Field[]
    const captured=publishing.filter(field=>sent.images.some(([id,draft])=>id===action.after.nodeId&&!Object.is(value({...draft.base,geometry:draft.geometry,assetHash:desiredAsset(draft)},field),value(choice.canonical,field))))
    if(captured.length)covered.push({action,fields:captured})
   }
  }
  return ()=>{covered.forEach(({action,fields})=>{action.published=true;action.publishedFields=fields});if(covered.length)this.changed()}
 }

 skip(direction:'undo'|'redo',expectedVersion:number){
  if(this.closed||this.working||this.blocked()||this.session.scope!=='write')throw new Error('historyBusy')
  if(expectedVersion!==this.version)throw new Error('historyChanged')
  const stack=direction==='undo'?this.undoStack:this.redoStack
  if(!stack.length)throw new Error('historyEmpty')
  stack.pop();this.continuations.clear();this.stopCapturing();this.changed()
 }
 async step(direction:'undo'|'redo'):Promise<{revision:number;nodeId:string;type:Action['type'];page?:number}>{
  if(this.closed||this.working||this.blocked())throw new Error('historyBusy')
  if(this.session.scope!=='write')throw new Error('readOnlyMode')
  const from=direction==='undo'?this.undoStack:this.redoStack,to=direction==='undo'?this.redoStack:this.undoStack,action=from.at(-1)
  if(!action)throw new Error('historyEmpty')
  if(action.type==='batch')return this.stepBatch(direction,action,from,to)
  this.working=true;this.stopCapturing();this.changed()
  const textVersion=this.texts.snapshot(),imageVersion=this.images.snapshot(),historyVersion=this.version
  const nodeId=action.after.nodeId
  let before=action.before,after=action.after
  let imageFields=action.type==='image'?changedFields(action):[]
  if(action.choice&&action.published){
   if(action.type==='text')before=action.choice.canonical
   else{
    const canonical=action.choice.canonical,original=clean(action.after)
    imageFields=(action.publishedFields??action.choice.fields??fields).filter(field=>fields.includes(field as Field)&&!Object.is(value(canonical,field as Field),value(action.after,field as Field))) as Field[]
    for(const field of imageFields){if(field==='assetHash')original.assetHash=canonical.assetHash;else original.geometry[field]=canonical.geometry[field]}
    before=original
   }
  }
  const expected=direction==='undo'?after:before,desired=direction==='undo'?before:after
  try{
   const response=await api(this.session,`/${action.type==='text'?'text':'images'}/${encodeURIComponent(nodeId)}`,{signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000)])})
   const result=await response.json()
   if(this.closed||this.blocked())throw new Error('historyBusy')
   if(textVersion!==this.texts.snapshot()||imageVersion!==this.images.snapshot()||historyVersion!==this.version)throw new Error('historyChanged')
   if(!validRevision(result.revision))throw new Error('historyInvalid')
   if(action.type==='text'){
    const current=result as TextRun&{revision:number},draft=this.texts.get(nodeId)
    if(current.nodeId!==nodeId||typeof current.text!=='string'||!hash.test(current.nodeHash))throw new Error('historyInvalid')
    if(action.choice&&!action.published){
     const frame=action.replay??action.choice
     let expectedChoice=direction==='undo'?frame.after:frame.before
     const previous=this.continuations.get(`text:${nodeId}`),alternate=direction==='undo'&&previous?.source!==action&&previous?.type==='text'&&previous.draft&&!previous.draft.remote&&previous.draft.text===action.after.text?previous.draft:null
     if(alternate)expectedChoice=alternate
     const transition=this.texts.applyChoiceHistory(current,result.revision,expectedChoice,direction==='undo'?frame.before:frame.after,direction==='redo'?frame.canonical:undefined,!!alternate)
     if(direction==='undo')action.replay={before:transition.after,after:transition.before,canonical:{...current}}
    }else{
    if(draft&&(draft.stale==='deleted'||draft.base.nodeHash!==current.nodeHash&&draft.text!==current.text))throw new Error('historyConflict')
    if((draft?.text??current.text)!==(expected as TextRun).text)throw new Error('historyConflict')
    this.texts.applyHistory(current,result.revision,(desired as TextRun).text,action.page)
    }
   }else{
    const current=result.image as PositionedImage|null,draft=this.images.get(nodeId)
    if(!current)throw new Error('historyDeleted')
    if(current.nodeId!==nodeId||!current.geometry||!validGeometry(current.geometry)||!hash.test(current.visualHash)||(current.assetHash!=null&&!hash.test(current.assetHash)))throw new Error('historyInvalid')
    if(action.choice&&!action.published){
     const frame=action.replay??action.choice,choiceFields=action.choice.fields??[...fields]
     let expectedChoice=direction==='undo'?frame.after:frame.before
     const previous=this.continuations.get(`image:${nodeId}`),prior=previous?.source!==action&&previous?.type==='image'?previous.draft:null
     const alternate=direction==='undo'&&prior&&!prior.remote&&choiceFields.every(field=>Object.is(value({...prior.base,geometry:prior.geometry,assetHash:desiredAsset(prior)},field as Field),value(action.after,field as Field)))?prior:null
     if(alternate)expectedChoice=alternate
     const transition=this.images.applyChoiceHistory(current,result.revision,expectedChoice,direction==='undo'?frame.before:frame.after,direction==='redo'?{canonical:frame.canonical,fields:choiceFields}:undefined,!!alternate)
     if(direction==='undo')action.replay={before:transition.after,after:transition.before,canonical:clean(current)}
    }else{
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
    for(const key of imageFields){
     if(!Object.is(value(next,key),value(expected as PositionedImage,key)))throw new Error('historyConflict')
     if(key==='assetHash'&&!hash.test((desired as PositionedImage).assetHash??'')&&!(this.session.format==='pdf'&&(desired as PositionedImage).assetHash==null))throw new Error('historyInvalid')
     set(key,desired as PositionedImage)
    }
    // Invalid local numeric input can be undone. Redo keeps it visibly invalid;
    // normal save validation continues to reject it.
    this.images.applyHistory(current,result.revision,next,action.page)
    }
   }
   this.continuations.set(`${action.type}:${nodeId}`,action.type==='text'?{type:'text',source:action,draft:structuredClone(this.texts.get(nodeId)??null)}:{type:'image',source:action,draft:structuredClone(this.images.get(nodeId)??null)})
   while(this.continuations.size>200)this.continuations.delete(this.continuations.keys().next().value!)
   from.pop();to.push(action);this.changed()
   return {revision:result.revision,nodeId,type:action.type,page:action.page}
  }catch(error){if(error instanceof ApiError&&error.status===404)throw new Error('historyDeleted');throw error}
  finally{this.working=false;this.changed()}
 }
 private async stepBatch(direction:'undo'|'redo',batch:Extract<HistoryEntry,{type:'batch'}>,from:HistoryEntry[],to:HistoryEntry[]){
  this.working=true;this.stopCapturing();this.changed()
  const textVersion=this.texts.snapshot(),imageVersion=this.images.snapshot(),historyVersion=this.version
  try{
   const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(30_000+Math.min(270_000,batch.actions.length*125))])
   const manifest=await(await api(this.session,'',{signal})).json() as {revision:number;documentId:string}
   if(!validRevision(manifest.revision)||manifest.documentId!==this.session.documentId)throw new Error('historyInvalid')
   const results:Array<TextRun&{revision:number}>=[]
   for(let start=0;start<batch.actions.length;start+=4){
    const part=await Promise.all(batch.actions.slice(start,start+4).map(async action=>{
     const result=await(await api(this.session,`/text/${encodeURIComponent(action.after.nodeId)}?revision=${manifest.revision}`,{signal})).json() as TextRun&{revision:number}
     if(result.nodeId!==action.after.nodeId||result.revision!==manifest.revision||typeof result.text!=='string'||!hash.test(result.nodeHash))throw new Error('historyInvalid')
     return result
    }));results.push(...part)
   }
   const latest=await(await api(this.session,'',{signal})).json() as {revision:number;documentId:string}
   if(latest.documentId!==this.session.documentId||!validRevision(latest.revision))throw new Error('historyInvalid')
   if(latest.revision!==manifest.revision)throw new Error('historyChanged')
   if(this.closed||this.blocked())throw new Error('historyBusy')
   if(textVersion!==this.texts.snapshot()||imageVersion!==this.images.snapshot()||historyVersion!==this.version)throw new Error('historyChanged')
   // Validate every cell against the same revision before changing any one.
   for(let i=0;i<batch.actions.length;i++){
    const action=batch.actions[i],current=results[i],draft=this.texts.get(current.nodeId),expected=direction==='undo'?action.after:action.before
    if(draft&&(draft.stale||draft.remote||draft.base.nodeHash!==current.nodeHash&&draft.text!==current.text))throw new Error('historyConflict')
    if((draft?.text??current.text)!==expected.text)throw new Error('historyConflict')
   }
   this.texts.batch(()=>batch.actions.forEach((action,index)=>{
    const current=results[index],desired=direction==='undo'?action.before:action.after
    this.texts.applyHistory(current,manifest.revision,desired.text,action.page)
   }))
   for(const action of batch.actions)this.continuations.set(`text:${action.after.nodeId}`,{type:'text',source:action,draft:structuredClone(this.texts.get(action.after.nodeId)??null)})
   while(this.continuations.size>200)this.continuations.delete(this.continuations.keys().next().value!)
   from.pop();to.push(batch);this.changed()
   return{revision:manifest.revision,nodeId:batch.actions[0].after.nodeId,type:'text' as const}
  }catch(error){if(error instanceof ApiError&&error.status===404)throw new Error('historyDeleted');throw error}
  finally{this.working=false;this.changed()}
 }
 dispose(){this.closed=true;this.abort.abort();this.detach.forEach(detach=>detach());this.listeners.clear();this.continuations.clear()}
}
