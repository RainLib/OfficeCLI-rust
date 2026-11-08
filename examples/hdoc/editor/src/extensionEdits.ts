import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import type * as Y from 'yjs'
import {readExtensionNode,extensionNodes} from './extensionNode.ts'
import {stableExtension} from './extensionRegistry.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import {createNodePropertyProtocol,type PropertyEditGroup,type PropertyEditIntent} from './nodePropertyEdits.ts'
export {nodeFallbackField,nodeEnvelopeField,nodeMaterializeOrigin,type NodeFieldChoice} from './nodePropertyEdits.ts'
export const nodeEditFields={intents:'hcd-node-edits/1/intents',materialized:'hcd-node-edits/1/materialized'} as const
export type NodeEditIntent=PropertyEditIntent<ExtensionNodePayload>
export type NodeEditGroup=PropertyEditGroup<ExtensionNodePayload>
const protocol=createNodePropertyProtocol(nodeEditFields,readExtensionNode)
export const extensionEditIndex=protocol.index,materializeExtensionEdits=protocol.materialize,publishExtensionEdits=protocol.publish,resolveExtensionEdits=protocol.resolve
const same=(a:unknown,b:unknown)=>stableExtension(a)===stableExtension(b)
export function prepareExtensionEdits(document:Y.Doc,before:PmNode,after:PmNode){return protocol.prepare(document,[...extensionNodes(before).values()].map(entry=>entry.value),[...extensionNodes(after).values()].map(entry=>entry.value))}
export function projectExtensionEdits(node:PmNode,index:Map<string,NodeEditGroup>):PmNode{
 if(!index.size)return node
 let current=node
 const raw=node.attrs.extension
 if(raw&&['hcdExtensionInline','hcdExtensionBlock','hcdExtensionContainer'].includes(node.type.name)){
  const value=readExtensionNode(raw),group=index.get(value.instanceId);if(group){if(!same(value,group.root))throw new Error('node-edit-base-changed');current=node.type.createChecked({...node.attrs,extension:group.value},node.content,node.marks)}
 }
 if(current.isLeaf)return current
 const children=current.content.content.map(child=>projectExtensionEdits(child,index));return children.every((child,i)=>child===current.child(i))?current:current.copy(Fragment.fromArray(children))
}
export function storageExtensionNode(value:Record<string,unknown>,index:Map<string,NodeEditGroup>){
 if(value.type!=='hcdExtensionInline')return value
 const attrs=value.attrs as Record<string,unknown>,payload=readExtensionNode(attrs.extension),group=index.get(payload.instanceId);return group?{...value,attrs:{...attrs,extension:group.root}}:value
}
export function nodeEditStatus(document:Y.Doc,doc:PmNode){const active=extensionNodes(doc),groups=[...extensionEditIndex(document).values()].filter(group=>active.has(group.root.instanceId));return{conflicts:groups.filter(g=>Object.keys(g.conflicts).length>0),pending:groups.filter(g=>!g.ready)}}
