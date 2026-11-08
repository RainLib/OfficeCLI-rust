/** Atomic, causal reference values. Target and display snapshot cannot be mixed
 * across concurrent edits. These records are not notification delivery jobs. */
import * as Y from 'yjs'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {readInlineReference,type InlineReference} from './inlineReference.ts'
export const referenceEditField='hcd-reference-edits/1/intents'
export type ReferenceEditIntent={version:1;id:string;root:InlineReference;before:InlineReference;after:InlineReference;parents:string[]}
export type ReferenceEditGroup={root:InlineReference;ids:string[];intents:ReferenceEditIntent[];candidates:ReferenceEditIntent[];value:InlineReference;conflicted:boolean}
const same=(a:unknown,b:unknown):boolean=>JSON.stringify(a,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)===JSON.stringify(b,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)
const validId=(value:unknown):value is string=>typeof value==='string'&&/^q_[a-f0-9]{32}$/.test(value)
function readIntent(raw:unknown,key:string):ReferenceEditIntent{
 const value=raw as ReferenceEditIntent
 if(!value||Object.keys(value).sort().join(',')!=='after,before,id,parents,root,version'||value.version!==1||!validId(value.id)||value.id!==key||!Array.isArray(value.parents)||value.parents.length>128||new Set(value.parents).size!==value.parents.length||value.parents.some(id=>!validId(id)||id===key)||JSON.stringify(value).length>16384)throw new Error('reference-edit-schema')
 const root=readInlineReference(value.root),before=readInlineReference(value.before),after=readInlineReference(value.after)
 if(root.mentionId!==before.mentionId||root.mentionId!==after.mentionId)throw new Error('reference-edit-identity')
 return{version:1,id:key,root,before,after,parents:[...value.parents]}
}
export function referenceEditIndex(document:Y.Doc):Map<string,ReferenceEditGroup>{
 const map=document.getMap(referenceEditField),groups=new Map<string,ReferenceEditGroup>();let bytes=0
 if(map.size>2048)throw new Error('reference-edit-limit')
 for(const [key,raw]of map){bytes+=JSON.stringify(raw).length;if(bytes>8_000_000)throw new Error('reference-edit-limit');const edit=readIntent(raw,key),id=edit.root.mentionId,group=groups.get(id)
  if(group){if(!same(group.root,edit.root)||group.intents.length>=128)throw new Error('reference-edit-root');group.intents.push(edit)}else groups.set(id,{root:edit.root,ids:[],intents:[edit],candidates:[],value:edit.root,conflicted:false})
 }
 for(const group of groups.values()){
  group.intents.sort((a,b)=>a.id.localeCompare(b.id));group.ids=group.intents.map(edit=>edit.id)
  const byId=new Map(group.intents.map(edit=>[edit.id,edit])),ancestry=new Map<string,Set<string>>(),visiting=new Set<string>()
  const ancestors=(id:string):Set<string>=>{const known=ancestry.get(id);if(known)return known;if(visiting.has(id))throw new Error('reference-edit-cycle');const edit=byId.get(id);if(!edit)return new Set();visiting.add(id);const found=new Set(edit.parents);for(const parent of edit.parents)for(const ancestor of ancestors(parent))found.add(ancestor);visiting.delete(id);ancestry.set(id,found);return found}
  group.ids.forEach(ancestors)
  group.candidates=group.intents.filter(edit=>!group.intents.some(other=>other.id!==edit.id&&ancestry.get(other.id)!.has(edit.id)))
  if(!group.candidates.length)throw new Error('reference-edit-cycle')
  group.conflicted=group.candidates.some(edit=>!same(edit.after,group.candidates[0].after))
  group.value=group.conflicted?group.root:group.candidates[0].after
 }
 return new Map([...groups].sort(([a],[b])=>a.localeCompare(b)))
}
export function documentReferences(doc:PmNode){
 const result=new Map<string,{reference:InlineReference;position:number}>()
 doc.descendants((node,position)=>{if(node.type.name!=='hcdMention')return;const reference=readInlineReference(node.attrs.reference);if(result.has(reference.mentionId)||result.size>=10000)throw new Error('duplicate-reference-identity');result.set(reference.mentionId,{reference,position})})
 return result
}
function budget(document:Y.Doc,records:ReferenceEditIntent[]){
 const existing=document.getMap(referenceEditField)
 if(existing.size+records.length>2048||records.some(record=>record.parents.length>=128)||[...existing.values(),...records].reduce<number>((sum,value)=>sum+JSON.stringify(value).length,0)>8_000_000)throw new Error('reference-edit-limit')
}
export function prepareReferenceEdits(document:Y.Doc,before:PmNode,after:PmNode){
 const old=documentReferences(before),next=documentReferences(after),index=referenceEditIndex(document),records:ReferenceEditIntent[]=[]
 for(const [id,entry]of old){const value=next.get(id)?.reference;if(!value||same(value,entry.reference))continue;const group=index.get(id);if(group?.conflicted)throw new Error('reference-drafts-conflict');const edit:ReferenceEditIntent={version:1,id:`q_${crypto.randomUUID().replaceAll('-','')}`,root:group?.root??entry.reference,before:entry.reference,after:value,parents:group?.ids??[]};readIntent(edit,edit.id);records.push(edit)}
 budget(document,records);return records
}
export function publishReferenceEdits(document:Y.Doc,records:ReferenceEditIntent[]){for(const edit of records)document.getMap(referenceEditField).set(edit.id,structuredClone(edit))}
export function storageReferenceNode(value:Record<string,unknown>,index:Map<string,ReferenceEditGroup>){
 const attrs=value.attrs as {reference?:unknown}|undefined
 if(value.type==='hcdMention'&&attrs?.reference){const reference=readInlineReference(attrs.reference),group=index.get(reference.mentionId);if(group)return{...value,attrs:{...attrs,reference:group.root}}}
 return value
}
export function projectReferenceEdits(node:PmNode,index:Map<string,ReferenceEditGroup>):PmNode{
 if(node.type.name==='hcdMention'){const reference=readInlineReference(node.attrs.reference),group=index.get(reference.mentionId);return group?node.type.createChecked({...node.attrs,reference:group.value},null,node.marks):node}
 if(!node.childCount)return node
 return node.copy(Fragment.fromArray(node.content.content.map(child=>projectReferenceEdits(child,index))))
}
export function resolveReferenceEdit(document:Y.Doc,mentionId:string,expectedIds:readonly string[],candidateId:string,origin:unknown){
 const group=referenceEditIndex(document).get(mentionId)
 if(!group?.conflicted||!same(group.ids,expectedIds))throw new Error('reference-changed')
 const candidate=group.candidates.find(edit=>edit.id===candidateId);if(!candidate)throw new Error('reference-changed')
 return resolveReferenceValue(document,mentionId,expectedIds,candidate.after,origin)
}
/** The caller must obtain this value from a checked canonical revision; a root
 * placeholder is not evidence of the latest saved target. */
export function resolveReferenceValue(document:Y.Doc,mentionId:string,expectedIds:readonly string[],value:InlineReference,origin:unknown){
 const group=referenceEditIndex(document).get(mentionId),after=readInlineReference(value)
 if(!group?.conflicted||!same(group.ids,expectedIds)||after.mentionId!==mentionId)throw new Error('reference-changed')
 const edit:ReferenceEditIntent={version:1,id:`q_${crypto.randomUUID().replaceAll('-','')}`,root:group.root,before:group.value,after,parents:group.ids};budget(document,[edit]);readIntent(edit,edit.id)
 document.transact(()=>publishReferenceEdits(document,[edit]),origin);return edit.after
}
