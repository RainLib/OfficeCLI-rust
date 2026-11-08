import type * as Y from 'yjs'
import type {Node as PmNode} from '@tiptap/pm/model'
import {stableExtension} from './extensionRegistry.ts'
import {inlineContainerNodeName,readInlineContainerPayload,type InlineContainerPayload} from './inlineContainerPayload.ts'
import {createNodePropertyProtocol,type PropertyCodec,type PropertyEditGroup} from './nodePropertyEdits.ts'

/** Internal opt-in model. The active room guard rejects these maps even when
 * no body/definition has arrived yet. Public registry contracts stay unchanged. */
export const inlineContainerEditFields={intents:'hcd-inline-container-edits/1/intents',materialized:'hcd-inline-container-edits/1/materialized'} as const
export type InlineContainerEditGroup=PropertyEditGroup<InlineContainerPayload>
export type InlineContainerPropertyCodec=PropertyCodec<InlineContainerPayload>
const protocol=createNodePropertyProtocol(inlineContainerEditFields,readInlineContainerPayload)
export const inlineContainerEditIndex=protocol.index,prepareInlineContainerEdits=protocol.prepare,publishInlineContainerEdits=protocol.publish
function checkedCodec(codec:InlineContainerPropertyCodec):InlineContainerPropertyCodec{
 return{resolve:value=>codec.resolve(structuredClone(value)),update:(base,data)=>{
  if(!codec.resolve(structuredClone(base)))throw new Error('nodeExtensionUnavailable')
  const after=readInlineContainerPayload(codec.update(structuredClone(base),structuredClone(data)))
  if(after.instanceId!==base.instanceId||after.type!==base.type||after.version!==base.version||stableExtension(after.resources)!==stableExtension(base.resources)||stableExtension(after.data)!==stableExtension(data))throw new Error('nodeExtensionInvalidData')
  return after
 }}
}
export function materializeInlineContainerEdits(document:Y.Doc,codec:InlineContainerPropertyCodec){protocol.materialize(document,checkedCodec(codec))}
export function resolveInlineContainerEdits(document:Y.Doc,codec:InlineContainerPropertyCodec,instanceId:string,ids:unknown,choices:Record<string,string>,origin:unknown){return protocol.resolve(document,checkedCodec(codec),instanceId,ids,choices,origin)}
export function inlineContainerNodes(node:PmNode){
 const values=new Map<string,InlineContainerPayload>()
 const visit=(node:PmNode)=>{if(node.type.name!==inlineContainerNodeName)return;const value=readInlineContainerPayload(node.attrs.extension);if(values.has(value.instanceId))throw new Error('duplicateInlineContainerIdentity');values.set(value.instanceId,value)}
 visit(node);node.descendants(visit);return values
}
export function inlineContainerEditStatus(document:Y.Doc,doc:PmNode){const active=inlineContainerNodes(doc),groups=[...protocol.index(document).values()].filter(group=>active.has(group.root.instanceId));return{conflicts:groups.filter(group=>Object.keys(group.conflicts).length>0),pending:groups.filter(group=>!group.ready)}}
