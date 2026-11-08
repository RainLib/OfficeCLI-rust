import {readExtensionNode} from './extensionNode.ts'
import type {ExtensionNodePayload} from './extensionTypes.ts'
import {readInlineContainerPayload,type InlineContainerPayload} from './inlineContainerPayload.ts'

export type ResourceNodePayload=ExtensionNodePayload|InlineContainerPayload
export type NodeResourceModel<P extends ResourceNodePayload>={read:(input:unknown)=>P;region:(id:string)=>boolean}
/** Ordinary/regional journals retain their original envelope gate. */
export const ordinaryNodeResourceModel:NodeResourceModel<ExtensionNodePayload>={read:readExtensionNode,region:id=>id==='body'||/^n_[a-f0-9]{32}$/.test(id)}
/** Explicit inline1 journals can contain both ordinary nodes and editable
 * inline containers, but cannot import a Word story address. */
export const inlineNodeResourceModel:NodeResourceModel<ResourceNodePayload>={
 read:input=>(input as {schemaVersion?:unknown})?.schemaVersion==='hcd.extension/3'?readInlineContainerPayload(input):readExtensionNode(input),
 region:id=>id==='body',
}
