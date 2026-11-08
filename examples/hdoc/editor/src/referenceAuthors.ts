import {readInlineReference,type InlineReference} from './inlineReference.ts'
import type {SnapshotBlock} from './checkpointSnapshot.ts'
import type {BlockContent,Inline} from './schema.ts'
export type ReferenceAuthor={mentionId:string;userId:string}
export type AuthenticatedContributor={userId:string;displayName:string;generation:number}
export type ReferenceAuthorEntry=AuthenticatedContributor&{mentionId:string;target:InlineReference['target'];present:boolean}
export function validActorId(value:unknown):value is string{return typeof value==='string'&&!!value.length&&new TextEncoder().encode(value).length<=256&&!/[\u0000-\u001f\u007f-\u009f]/u.test(value)&&![...value].some(char=>{const n=char.codePointAt(0)!;return n>=0xd800&&n<=0xdfff})}
export function actorName(value:string){let result='';for(const char of value.trim()){if(/[\u0000-\u001f\u007f-\u009f]/u.test(char)||char.codePointAt(0)!>=0xd800&&char.codePointAt(0)!<=0xdfff)continue;if(new TextEncoder().encode(result+char).length>64)break;result+=char}return result||'Member'}
export function validContributor(value:unknown):value is AuthenticatedContributor{const v=value as AuthenticatedContributor;return !!v&&validActorId(v.userId)&&validActorId(v.displayName)&&new TextEncoder().encode(v.displayName).length<=64&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v.displayName)&&Number.isSafeInteger(v.generation)&&v.generation>=0}
export function snapshotReferences(blocks:readonly SnapshotBlock[]){
 const values=new Map<string,InlineReference>()
 const inlines=(parts:readonly Inline[],depth=0)=>{if(depth>24)throw new Error('reference-depth');for(const inline of parts){if(inline.reference){const ref=readInlineReference(inline.reference);if(values.has(ref.mentionId)||values.size>=10000)throw new Error('duplicate-reference-identity');values.set(ref.mentionId,ref)}if(inline.content)inlines(inline.content.inlines,depth+1)}}
 const walk=(content:BlockContent,depth:number)=>{if(depth>32)throw new Error('reference-depth');inlines(content.inlines);for(const child of content.children??[])walk(child,depth+1)}
 for(const block of blocks)walk(block.content,0)
 return values
}
const sameTarget=(a:InlineReference['target']|undefined,b:InlineReference['target'])=>a?.kind===b.kind&&a.id===b.id
/** Only the server's synchronous, authenticated transaction observer may assign
 * authors. Online presence, node attrs and the user pressing Save are irrelevant. */
export class ReferenceAuthorLedger{
 private observed:Map<string,InlineReference>
 private canonical:Map<string,InlineReference>
 private entries=new Map<string,ReferenceAuthorEntry>()
 private captured=new Set<string>()
 constructor(blocks:readonly SnapshotBlock[],canonical:readonly SnapshotBlock[]){this.observed=snapshotReferences(blocks);this.canonical=snapshotReferences(canonical)}
 observe(blocks:readonly SnapshotBlock[],actor?:AuthenticatedContributor){
  const next=snapshotReferences(blocks)
  for(const [id,old]of this.observed)if(!next.has(id)){if(!this.canonical.has(id)&&!this.captured.has(id)){this.entries.delete(id);continue}if(actor&&validContributor(actor))this.entries.set(id,{...actor,mentionId:id,target:{...old.target},present:false});else this.entries.delete(id)}
  for(const [id,ref]of next)if(!sameTarget(this.observed.get(id)?.target,ref.target)){
   if(actor&&validContributor(actor))this.entries.set(id,{...actor,mentionId:id,target:{...ref.target},present:true})
   else this.entries.delete(id)
  }
  this.observed=next
 }
 restore(value:unknown){
  if(!Array.isArray(value)||value.length>10000)throw new Error('reference-author-schema')
  const next=new Map<string,ReferenceAuthorEntry>()
  for(const item of value){
   const entry=item as ReferenceAuthorEntry,ref=this.observed.get(entry?.mentionId)
   readInlineReference({type:'hcd.mention',version:1,mentionId:entry?.mentionId,target:entry?.target,snapshot:{label:'validation'}})
   if(!validContributor(entry)||typeof entry.present!=='boolean'||(entry.present?(!ref||!sameTarget(entry.target,ref.target)):!!ref)||next.has(entry.mentionId)||Object.keys(entry).sort().join(',')!=='displayName,generation,mentionId,present,target,userId')throw new Error('reference-author-schema')
   next.set(entry.mentionId,structuredClone(entry))
  }
  this.entries=next
 }
 proof(){return [...this.entries.values()].sort((a,b)=>a.mentionId.localeCompare(b.mentionId)).map(entry=>structuredClone(entry))}
 commit(blocks:readonly SnapshotBlock[]){this.canonical=snapshotReferences(blocks);this.captured.clear();for(const [id,entry]of this.entries)if(!entry.present&&!this.canonical.has(id)&&!this.observed.has(id))this.entries.delete(id)}
 capture(blocks:readonly SnapshotBlock[]){
  const authors:ReferenceAuthor[]=[],people=new Map<string,AuthenticatedContributor>()
  const current=snapshotReferences(blocks),changes=new Map([...current].filter(([id,ref])=>!sameTarget(this.canonical.get(id)?.target,ref.target)))
  for(const [id,ref]of this.canonical)if(!current.has(id))changes.set(id,ref)
  for(const [id,ref]of changes){
   const entry=this.entries.get(id)
   if(!entry||entry.present!==current.has(id)||!sameTarget(entry.target,ref.target))throw new Error('reference-authors-unbound')
   authors.push({mentionId:id,userId:entry.userId})
   const previous=people.get(entry.userId);if(!previous||previous.generation<entry.generation)people.set(entry.userId,{userId:entry.userId,displayName:entry.displayName,generation:entry.generation})
  }
  this.captured=new Set(current.keys())
  return{referenceAuthors:authors.sort((a,b)=>a.mentionId.localeCompare(b.mentionId)),contributors:[...people.values()]}
 }
}
/** Yjs update listeners run before another transaction or deferred hook can
 * change the projection. This boundary is essential for per-occurrence identity. */
export function observeCoordinatorChanges(document:import('yjs').Doc,changed:(actor: {userId?:string;displayName?:string}|undefined,origin:unknown)=>void,actorFor:(origin:unknown)=>{userId?:string;displayName?:string}|undefined){
 const update=(_bytes:Uint8Array,origin:unknown)=>changed(actorFor(origin),origin)
 document.on('update',update);return()=>document.off('update',update)
}
