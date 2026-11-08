import {Plugin,PluginKey,type Transaction,type EditorState} from '@tiptap/pm/state'
import {stableExtension} from './extensionRegistry.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import type {Node as PmNode} from '@tiptap/pm/model'
import {ySyncPluginKey} from '@tiptap/y-tiptap'
import {sameNodeExceptSourceMarks} from './extensionNode.ts'
import {inlineContainerNodeName,readInlineContainerPayload,type InlineContainerPayload} from './inlineContainerPayload.ts'
import {sourceDefaultNames} from './semanticSourceDefaults.ts'
export type InlineContainerResolver=(value:InlineContainerPayload)=>unknown
export const inlineContainerAccessKey=new PluginKey<{resolve:InlineContainerResolver;registry:()=>InlineContainerRegistry|undefined}>('hcd-inline-container-access')
export const inlineContainerRegistryForState=(state:EditorState)=>inlineContainerAccessKey.getState(state)?.registry()
type MigrationPermit={registry:InlineContainerRegistry;before:InlineContainerPayload;after:InlineContainerPayload}
const migrations=new WeakMap<Transaction,MigrationPermit>()
export function authorizeInlineContainerMigration(transaction:Transaction,registry:InlineContainerRegistry,before:InlineContainerPayload,after:InlineContainerPayload){
 const preview=registry.previewMigration(before)
 if(!preview||stableExtension(preview.after)!==stableExtension(after))throw new Error('extensionChanged')
 migrations.set(transaction,{registry,before:preview.before,after:preview.after})
}
function occurrences(doc:PmNode){
 const found=new Map<string,{node:PmNode;value:InlineContainerPayload}>()
 const visit=(node:PmNode)=>{if(node.type.name!==inlineContainerNodeName)return;const value=readInlineContainerPayload(node.attrs.extension);if(found.has(value.instanceId))throw new Error('duplicateInlineContainerIdentity');found.set(value.instanceId,{node,value})}
 visit(doc);doc.descendants(visit);return found
}
function available(resolve:InlineContainerResolver,value:InlineContainerPayload){try{return !!resolve(value)}catch{return false}}
function sameExceptSources(a:PmNode,b:PmNode):boolean{
 const attrs=(node:PmNode)=>Object.fromEntries(Object.entries(node.attrs).filter(([key])=>!sourceDefaultNames.includes(key as typeof sourceDefaultNames[number])))
 const clean=(node:PmNode):PmNode=>node.isText?node.mark(node.marks.filter(mark=>mark.type.name!=='hcdSource')):node.type.create(attrs(node),node.content.content.map(clean),node.marks.filter(mark=>mark.type.name!=='hcdSource'))
 return clean(a).eq(clean(b))
}
/** Evaluate codec availability when executing history, not when recording it. */
export function prepareInlineContainerHistoryGuard(before:PmNode,resolve:InlineContainerResolver){
 const protectedNodes=[...occurrences(before)].filter(([,entry])=>!available(resolve,entry.value))
 if(!protectedNodes.length)return undefined
 return(after:PmNode)=>{const next=occurrences(after);for(const[id,entry]of protectedNodes){const other=next.get(id);if(!other||!sameExceptSources(entry.node,other.node))throw new Error('historyExtensionUnavailable')}}
}
/** Readonly DOM is presentation, not an edit gate. Protect unknown bodies from
 * parent-range deletion, formatting, commands and paste before shared writes. */
export function inlineContainerPreservationPlugin(resolve:InlineContainerResolver,onError:(error:unknown)=>void=()=>{},registry:()=>InlineContainerRegistry|undefined=()=>undefined){
 return new Plugin({key:inlineContainerAccessKey,state:{init:()=>({resolve,registry}),apply:(_tr,current)=>current},filterTransaction(tr,state){
  if(!tr.docChanged||tr.getMeta('hcd-structure-remote/1')||tr.getMeta('hcd-structure-normalized/1')||tr.getMeta(ySyncPluginKey)?.isChangeOrigin)return true
  try{
   const before=occurrences(state.doc),after=occurrences(tr.doc),repair=tr.getMeta('hcd-source-defaults')===true,permit=migrations.get(tr)
   for(const[id,entry]of before){const next=after.get(id)
    if(next&&permit&&permit.registry===registry()&&stableExtension(entry.value)===stableExtension(permit.before)&&stableExtension(next.value)===stableExtension(permit.after)&&stableExtension(permit.registry.previewMigration(entry.value)?.after)===stableExtension(next.value)&&entry.node.eq(next.node.type.create({...next.node.attrs,extension:entry.value},next.node.content,next.node.marks)))continue
    if(available(resolve,entry.value)){if(next&&!available(resolve,next.value))throw new Error('historyExtensionUnavailable')}
    else if(!next||!(repair?sameExceptSources(entry.node,next.node):sameNodeExceptSourceMarks(entry.node,next.node)))throw new Error('historyExtensionUnavailable')
   }
   for(const[id,entry]of after)if(!before.has(id)&&!available(resolve,entry.value))throw new Error('historyExtensionUnavailable')
   return true
  }catch(error){onError(error);return false}
 }})
}
