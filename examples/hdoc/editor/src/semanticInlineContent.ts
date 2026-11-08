import {Fragment,Mark,type Node as PmNode,type Schema} from '@tiptap/pm/model'
import {customMarkAttribute,customMarkAttributes,readCustomMarks} from './customMarks.ts'
type Attributes=Record<string,unknown>
export type SemanticInlineDelta={insert?:string|Record<string,unknown>;retain?:number;delete?:number;attributes?:Attributes}
/** A logical text can span permanent Y.XmlText carriers without moving them. */
export interface SemanticInlineText {
 toDelta():SemanticInlineDelta[]
 delete(index:number,length:number):void
 applyDelta(delta:SemanticInlineDelta[]):void
}
type Token={value:string|Record<string,unknown>;length:number;attributes:Attributes}
/** Explicit opt-in for non-leaf inline content. The encoder is pure: mutable
 * child text belongs in a separate permanent carrier, never in this embed. */
export type SemanticInlineContainerEncoder=(node:PmNode)=>Record<string,unknown>
export type SemanticInlineContainerDecoder=(value:Record<string,unknown>)=>PmNode|null
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
/** PM's JSON decoder discards unrecognized attributes. Refuse that projection
 * until a codec can preserve/render it, while retaining the original CRDT. */
export function validateSemanticNodeJson(value:any,schema:Schema){
 const type=schema.nodes[value?.type]
 if(!type||Object.keys(value.attrs??{}).some(key=>!(key in(type.spec.attrs??{}))))throw new Error('unsupportedNodeContent')
 for(const mark of value.marks??[]){const definition=schema.marks[mark.type];if(!definition||Object.keys(mark.attrs??{}).some(key=>!(key in(definition.spec.attrs??{}))))throw new Error('unsupportedInlineMarks')}
 for(const child of value.content??[])validateSemanticNodeJson(child,schema)
}
function oldTokens(text:SemanticInlineText){
 const tokens:Token[]=[]
 for(const part of text.toDelta()){
  if(typeof part.insert==='string')for(const value of part.insert)tokens.push({value,length:value.length,attributes:part.attributes??{}})
  else if(part.insert&&typeof part.insert==='object')tokens.push({value:part.insert,length:1,attributes:part.attributes??{}})
  else throw new Error('invalidInlineContent')
 }
 return tokens
}
function proposedRuns(node:PmNode,storage?:(value:Record<string,unknown>)=>Record<string,unknown>,containers?:SemanticInlineContainerEncoder){
 const runs:Token[]=[]
 node.forEach(child=>{
  if(['hcdMention','hcdExtensionInline'].includes(child.type.name)&&child.marks.some(mark=>['code','link'].includes(mark.type.name)))throw new Error('unsupportedInlineMarks')
  readCustomMarks(child.marks.filter(mark=>mark.type.name==='hcdCustomMark').map(mark=>mark.attrs.value))
  const attributes=customMarkAttributes(child.marks)
  if(Object.keys(attributes).length!==child.marks.length)throw new Error('unsupportedInlineMarks')
  if(child.isText)runs.push({value:child.text!,length:child.text!.length,attributes})
  else{
   if(!child.isInline)throw new Error('unsupportedInlineContent')
   if(!child.isLeaf){if(!containers||child.marks.length)throw new Error('unsupportedInlineContent');runs.push({value:containers(child),length:1,attributes});return}
   const {marks:_marks,...value}=child.toJSON();runs.push({value:storage?storage(value):value,length:1,attributes})
  }
 })
 return runs
}
function proposedTokens(node:PmNode,storage?:(value:Record<string,unknown>)=>Record<string,unknown>,containers?:SemanticInlineContainerEncoder){
 const tokens:Token[]=[]
 for(const run of proposedRuns(node,storage,containers)){
  if(typeof run.value==='string')for(const value of run.value)tokens.push({value,length:value.length,attributes:run.attributes})
  else tokens.push(run)
 }
 return tokens
}
export function validateSemanticInline(node:PmNode,containers?:SemanticInlineContainerEncoder,storage?:(value:Record<string,unknown>)=>Record<string,unknown>){proposedRuns(node,storage,containers)}
/** Exact stored UTF-16 splice from an editor transaction. It is a local
 * position hint, never a remote authorization or a replacement for validation. */
export type SemanticInlineSplice={from:number;to:number;insertedSize:number}
function spliceWindow(before:Token[],after:Token[],splice:SemanticInlineSplice){
 const boundary=(tokens:Token[],offset:number)=>{if(!Number.isSafeInteger(offset)||offset<0)throw new Error('invalidSemanticTextSplice');let position=0;for(let index=0;index<=tokens.length;index++){if(position===offset)return index;if(index<tokens.length)position+=tokens[index].length}throw new Error('invalidSemanticTextSplice')}
 if(!Number.isSafeInteger(splice.insertedSize)||splice.insertedSize<0||splice.to<splice.from||!Number.isSafeInteger(splice.from+splice.insertedSize))throw new Error('invalidSemanticTextSplice')
 const left=boundary(before,splice.from),end=boundary(before,splice.to),nextStart=boundary(after,splice.from),nextEnd=boundary(after,splice.from+splice.insertedSize),right=before.length-end
 const same=(a:Token,b:Token)=>stable(a.value)===stable(b.value)
 if(left!==nextStart||right!==after.length-nextEnd||before.slice(0,left).some((token,index)=>!same(token,after[index]))||before.slice(end).some((token,index)=>!same(token,after[nextEnd+index])))throw new Error('staleSemanticTextSplice')
 return{left,right}
}
/** All boundaries and retained values are checked before ANY shared mutation. */
export function validateSemanticSplice(text:SemanticInlineText,node:PmNode,splice:SemanticInlineSplice,storage?:(value:Record<string,unknown>)=>Record<string,unknown>){
 spliceWindow(oldTokens(text),proposedTokens(node,storage),splice)
}

function applySemanticFormats(text:SemanticInlineText,after:Token[]){
 const current=oldTokens(text),formats:Array<{retain:number;attributes?:Attributes}>=[]
 after.forEach((token,index)=>{
  const attrs:Attributes={},old=current[index].attributes
  for(const key of new Set([...Object.keys(old),...Object.keys(token.attributes)]))if(stable(old[key])!==stable(token.attributes[key]))attrs[key]=token.attributes[key]??null
  const attributes=Object.keys(attrs).length?attrs:undefined,last=formats.at(-1)
  if(last&&stable(last.attributes)===stable(attributes))last.retain+=token.length
  else formats.push({retain:token.length,...(attributes?{attributes}:{})})
 })
 // Never re-publish unchanged formatting: that could overwrite an unseen peer
 // formatting action when this replica reconnects.
 if(formats.some(part=>part.attributes))text.applyDelta(formats)
}
/** Sequential positions are measured in the immediately preceding PM step.
 * Fragments are ephemeral local provenance, never persisted/wire payloads. */
export type SemanticInlineEdit={from:number;to:number;insert:Fragment}
const editBatchLimits={steps:256,work:8_000_000}
function editBoundary(tokens:Token[],offset:number){
 if(!Number.isSafeInteger(offset)||offset<0)throw new Error('invalidSemanticTextEdits')
 let position=0
 for(let index=0;index<=tokens.length;index++){if(position===offset)return index;if(index<tokens.length)position+=tokens[index].length}
 throw new Error('invalidSemanticTextEdits')
}
export type SemanticInlineEditModel={containers?:SemanticInlineContainerEncoder;allowEmpty?:boolean}
function prepareSemanticEdits(text:SemanticInlineText,node:PmNode,edits:readonly SemanticInlineEdit[],storage?: (value:Record<string,unknown>)=>Record<string,unknown>,model:SemanticInlineEditModel={}){
 if(!Array.isArray(edits)||!edits.length&&!model.allowEmpty||edits.length>editBatchLimits.steps)throw new Error('semanticTextEditsLimit')
 let simulated=oldTokens(text),work=simulated.length
 const after=proposedTokens(node,storage,model.containers),operations:Array<{from:number;length:number;tokens:Token[]}>=[]
 const batch:readonly SemanticInlineEdit[]=edits
 for(const edit of batch){
  if(!edit||edit.to<edit.from||!(edit.insert instanceof Fragment))throw new Error('invalidSemanticTextEdits')
  if((work+=simulated.length+edit.insert.size)>editBatchLimits.work)throw new Error('semanticTextEditsLimit')
  const start=editBoundary(simulated,edit.from),end=editBoundary(simulated,edit.to)
  if(simulated.slice(start,end).some(token=>typeof token.value!=='string'))throw new Error('unsupportedSemanticTextEdits')
  edit.insert.forEach(child=>{if(!child.isText||child.type.schema!==node.type.schema)throw new Error('unsupportedSemanticTextEdits')})
  const inserted=node.copy(edit.insert);inserted.check();const tokens=proposedTokens(inserted,storage)
  simulated=[...simulated.slice(0,start),...tokens,...simulated.slice(end)]
  operations.push({from:edit.from,length:edit.to-edit.from,tokens})
 }
 if(simulated.length!==after.length||simulated.some((token,index)=>token.value!==after[index].value&&(typeof token.value==='string'||typeof after[index].value==='string'||stable(token.value)!==stable(after[index].value))))throw new Error('staleSemanticTextEdits')
 return{after,operations}
}
export function validateSemanticEdits(text:SemanticInlineText,node:PmNode,edits:readonly SemanticInlineEdit[],storage?:(value:Record<string,unknown>)=>Record<string,unknown>,model:SemanticInlineEditModel={}){prepareSemanticEdits(text,node,edits,storage,model)}
/** Validate the WHOLE batch first. Applying original steps (rather than their
 * final whole-text diff) retains untouched characters between replacements,
 * even when a delete/reinsert sequence has the same final visible text. */
export function writeSemanticEdits(text:SemanticInlineText,node:PmNode,edits:readonly SemanticInlineEdit[],storage?:(value:Record<string,unknown>)=>Record<string,unknown>,model:SemanticInlineEditModel={}){
 const plan=prepareSemanticEdits(text,node,edits,storage,model)
 for(const operation of plan.operations){
  if(operation.length)text.delete(operation.from,operation.length)
  const runs:Array<{insert:string;attributes:Attributes}>=[]
  for(const token of operation.tokens){if(typeof token.value!=='string')throw new Error('unsupportedSemanticTextEdits');const last=runs.at(-1);if(last)last.insert+=token.value;else runs.push({insert:token.value,attributes:{}})}
  if(runs.length)text.applyDelta([{retain:operation.from},...runs])
 }
 applySemanticFormats(text,plan.after)
}

/** A permanent XmlText exists even when the paragraph is empty. Comparing
 * Unicode code points avoids splitting UTF-16 surrogate pairs in a text diff. */
export function writeSemanticInline(text:SemanticInlineText,node:PmNode,storage?:(value:Record<string,unknown>)=>Record<string,unknown>,containers?:SemanticInlineContainerEncoder,splice?:SemanticInlineSplice){
 // A new carrier has no collaborative anchors to preserve. Build its initial
 // delta by runs rather than materializing and formatting one token per code
 // point; a long imported paragraph must not block the owner lease timer.
 if(!splice&&text.toDelta().length===0){
  const delta=proposedRuns(node,storage,containers).map(({value,attributes})=>({insert:value,attributes}))
  if(delta.length)text.applyDelta(delta)
  return
 }
 const before=oldTokens(text),after=proposedTokens(node,storage,containers),same=(a:Token,b:Token)=>stable(a.value)===stable(b.value)
 let left=0,right=0
 while(left<before.length&&left<after.length&&same(before[left],after[left]))left++
 while(right<before.length-left&&right<after.length-left&&same(before[before.length-1-right],after[after.length-1-right]))right++
 if(splice){const exact=spliceWindow(before,after,splice);left=exact.left;right=exact.right}
 const start=before.slice(0,left).reduce((sum,item)=>sum+item.length,0),removed=before.slice(left,before.length-right).reduce((sum,item)=>sum+item.length,0)
 // A single prefix/suffix splice would delete and recreate unchanged text
 // between two removed atoms, invalidating permanent collaborative anchors.
 // Prove this is an atom-only removal before mutating; retain every intervening
 // character and embed. This linear path avoids an unbounded text LCS.
 let atomOnly=!splice&&before.length>after.length,at=start,next=left
 const atomDeletes:Array<{at:number;length:number}>=[]
 for(let index=left;atomOnly&&index<before.length-right;index++){
  const token=before[index]
  if(next<after.length-right&&same(token,after[next])){at+=token.length;next++}
  else if(typeof token.value==='object'&&(['hcdMention','hcdExtensionInline'].includes(String(token.value.type))||containers&&Object.hasOwn(token.value,'hcdInlineContainer'))){const last=atomDeletes.at(-1);if(last?.at===at)last.length+=token.length;else atomDeletes.push({at,length:token.length})}
  else atomOnly=false
 }
 atomOnly=atomOnly&&next===after.length-right&&atomDeletes.length>0
 if(atomOnly)for(const deletion of atomDeletes)text.delete(deletion.at,deletion.length)
 else if(removed)text.delete(start,removed)
 const inserts=after.slice(left,after.length-right)
 if(!atomOnly&&inserts.length){
  // Insert each contiguous string once, then apply its marks. Per-character
  // inserts can let source/format boundaries split a concurrent pasted word.
  const runs:Array<{insert:Token['value'];attributes:Attributes}>=[]
  for(const item of inserts){const last=runs.at(-1);if(typeof item.value==='string'&&last&&typeof last.insert==='string')last.insert+=item.value;else runs.push({insert:item.value,attributes:{}})}
  text.applyDelta([{retain:start},...runs])
 }
 applySemanticFormats(text,after)
}
/** Pure decoding: unknown extensions fail without invoking the binding's
 * recovery decoder, which may delete unsupported Y types while reading them. */
export function readSemanticInline(text:SemanticInlineText,schema:Schema,containers?:SemanticInlineContainerDecoder){
 const nodes:PmNode[]=[]
 for(const part of text.toDelta()){
  const values=Object.entries(part.attributes??{}).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([type,attrs])=>type.startsWith('hcdCustomMark:')?customMarkAttribute(type,attrs):{type,attrs})
  validateSemanticNodeJson({type:'text',marks:values},schema)
  readCustomMarks(values.filter(mark=>mark.type==='hcdCustomMark').map(mark=>(mark.attrs as {value:unknown}).value))
  const marks=Mark.setFrom(values.map(({type,attrs})=>schema.mark(type,attrs as Attributes)))
  if(typeof part.insert==='string'){if(part.insert.length)nodes.push(schema.text(part.insert,marks))}
  else if(part.insert&&typeof part.insert==='object'){
   const container=containers?.(part.insert)
   if(container){if(container.type.schema!==schema||!container.isInline||container.isLeaf||marks.length)throw new Error('unsupportedInlineContent');container.check();nodes.push(container);continue}
   validateSemanticNodeJson(part.insert,schema)
   const node=schema.nodeFromJSON({...part.insert,marks:marks.map(mark=>mark.toJSON())})
   if(!node.isInline||!node.isLeaf)throw new Error('unsupportedInlineContent')
   if(['hcdMention','hcdExtensionInline'].includes(node.type.name)&&node.marks.some(mark=>['code','link'].includes(mark.type.name)))throw new Error('unsupportedInlineMarks')
   node.check();nodes.push(node)
  }else throw new Error('invalidInlineContent')
 }
 return Fragment.fromArray(nodes)
}
