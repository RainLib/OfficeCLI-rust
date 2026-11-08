import type {Node as PmNode} from '@tiptap/pm/model'
import type {Editor} from '@tiptap/core'
import {NodeSelection} from '@tiptap/pm/state'
import {readInlineReference,type InlineReference} from './inlineReference.ts'
export type ReferenceTarget=InlineReference['target']
export type SavedReference={reference:InlineReference;blockId:string;childPath:number[];inlineIndex:number;chunkSequence?:number;indexPage?:number}
export type ReferenceSnapshot={revision:number;items:SavedReference[]}
export type LiveReference={reference:InlineReference;position:number;excerpt:string}
export type ReferenceRow={reference:InlineReference;saved?:SavedReference;live?:LiveReference;state:'saved'|'draft'|'changed'|'removed'}
const bounded=(v:unknown,max:number):v is string=>typeof v==='string'&&new TextEncoder().encode(v).length<=max&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v)
export const referenceTargetKey=(target:ReferenceTarget)=>JSON.stringify([target.kind,target.id])
export const sameReferenceTarget=(a:ReferenceTarget,b:ReferenceTarget)=>a.kind===b.kind&&a.id===b.id
export function liveReferences(doc:PmNode):LiveReference[]{
 const result:LiveReference[]=[],seen=new Set<string>()
 doc.descendants((node,position,parent)=>{
  if(node.type.name!=='hcdMention')return true
  const reference=readInlineReference(node.attrs.reference)
  if(seen.has(reference.mentionId)||result.length>=10000)throw new Error('reference-index-ambiguous')
  seen.add(reference.mentionId);result.push({reference,position,excerpt:Array.from(parent?.textContent??'').slice(0,120).join('')});return false
 });return result
}
export function readReferenceSnapshot(value:unknown,documentId:string,revision:number):ReferenceSnapshot{
 const v=value as {schemaVersion:string;documentId:string;revision:number;items:SavedReference[]}
 if(!v||v.schemaVersion!=='hcd-references/1'||v.documentId!==documentId||v.revision!==revision||!Array.isArray(v.items)||v.items.length>10000)throw new Error('reference-index-schema')
 const seen=new Set<string>(),items=v.items.map(item=>{
  const reference=readInlineReference(item.reference),index=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0
  if(!bounded(item.blockId,256)||!item.blockId||!Array.isArray(item.childPath)||item.childPath.length>32||!item.childPath.every(index)||!index(item.inlineIndex)||seen.has(reference.mentionId)||(item.chunkSequence!==undefined&&(!index(item.chunkSequence)||!index(item.indexPage))))throw new Error('reference-index-schema')
  seen.add(reference.mentionId);return structuredClone({...item,reference})
 });return{revision,items}
}
export function referenceRows(saved:SavedReference[],live:LiveReference[]|null):ReferenceRow[]{
 if(live===null)return saved.map(item=>({reference:item.reference,saved:item,state:'saved'}))
 const current=new Map(live.map(item=>[item.reference.mentionId,item])),committed=new Set(saved.map(item=>item.reference.mentionId))
 return [...saved.map((item):ReferenceRow=>{const active=current.get(item.reference.mentionId);return{reference:active?.reference??item.reference,saved:item,live:active,state:!active?'removed':sameReferenceTarget(active.reference.target,item.reference.target)&&active.reference.snapshot.label===item.reference.snapshot.label?'saved':'changed'}}),...live.filter(item=>!committed.has(item.reference.mentionId)).map((item):ReferenceRow=>({reference:item.reference,live:item,state:'draft'}))]
}
export function referencePosition(doc:PmNode,reference:InlineReference){const found=liveReferences(doc).filter(item=>item.reference.mentionId===reference.mentionId&&sameReferenceTarget(item.reference.target,reference.target));return found.length===1?found[0].position:null}
/** Re-resolve on every action. Positions captured before a peer moves a block
 * are presentation data, never an authority to select a different occurrence. */
export function locateLiveReference(editor:Editor,reference:InlineReference){
 if(editor.isDestroyed)return false
 const position=referencePosition(editor.state.doc,reference);if(position===null)return false
 editor.view.dom.dispatchEvent(new Event('hcd-user-navigation',{bubbles:true}))
 editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc,position)))
 editor.view.focus();const node=editor.view.nodeDOM(position)
 if(node instanceof HTMLElement){const scroll=editor.view.dom.closest('.document-scroll') as HTMLElement|null;if(scroll){const box=scroll.getBoundingClientRect(),rect=node.getBoundingClientRect();scroll.scrollTo({top:scroll.scrollTop+rect.top-box.top-scroll.clientHeight/3,behavior:'auto'})}else node.scrollIntoView({block:'center',behavior:'auto'})}
 return true
}
export type ReferenceResolution={target:ReferenceTarget;status:'active'|'inactive'|'restricted'|'unsupported';canMention:boolean;label?:string;detail?:string|null}
export function readReferenceResolutions(value:unknown,targets:readonly ReferenceTarget[]):ReferenceResolution[]{
 const v=value as {schemaVersion:string;items:ReferenceResolution[]}
 if(!v||v.schemaVersion!=='hcd-reference-resolution/1'||!Array.isArray(v.items)||v.items.length!==targets.length||targets.length>100)throw new Error('reference-resolution-schema')
 const requested=new Set(targets.map(referenceTargetKey)),seen=new Set<string>()
 return v.items.map(item=>{
  readInlineReference({type:'hcd.mention',version:1,mentionId:`m_${'0'.repeat(32)}`,target:item.target,snapshot:{label:'validation'}})
  const key=referenceTargetKey(item.target)
  if(!requested.has(key)||seen.has(key)||!['active','inactive','restricted','unsupported'].includes(item.status))throw new Error('reference-resolution-schema')
  seen.add(key)
  if(item.status==='active'){
   if(!bounded(item.label,256)||!item.label?.trim()||typeof item.canMention!=='boolean'||item.detail!=null&&!bounded(item.detail,256))throw new Error('reference-resolution-schema')
   return{target:{...item.target},status:item.status,canMention:item.canMention,label:item.label,detail:item.detail}
  }
  // An accidental server disclosure cannot be promoted to a visible profile.
  if(item.label!==undefined||item.detail!==undefined||item.canMention===true)throw new Error('reference-resolution-schema')
  return{target:{...item.target},status:item.status,canMention:false}
 })
}
export function referenceSearch(rows:ReferenceRow[],query:string,resolutions:ReadonlyMap<string,ReferenceResolution>){
 const needle=query.normalize('NFKC').toLocaleLowerCase().trim()
 return rows.filter(row=>{const resolution=resolutions.get(referenceTargetKey(row.reference.target));return !needle||[row.reference.snapshot.label,row.live?.excerpt??'',resolution?.status==='active'?`${resolution.label} ${resolution.detail??''}`:''].some(value=>value.normalize('NFKC').toLocaleLowerCase().includes(needle))})
}
/** DOM content is already native-validated. Match identity and target without
 * interpolating arbitrary IDs in selectors, including inside sandboxed frames. */
export function referenceElement(root:ParentNode,reference:InlineReference):HTMLElement|null{
 let found:HTMLElement|null=null
 for(const element of root.querySelectorAll<HTMLElement>('[data-hcd-reference]')){
  let value:InlineReference;try{value=readInlineReference(JSON.parse(element.getAttribute('data-hcd-reference')||''))}catch{continue}
  if(value.mentionId!==reference.mentionId||!sameReferenceTarget(value.target,reference.target))continue
  if(found)return null;found=element
 }
 return found
}
