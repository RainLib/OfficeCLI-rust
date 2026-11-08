import type {Node as PmNode} from '@tiptap/pm/model'
import type {EditorState} from '@tiptap/pm/state'
import {extensionNodeLocations} from './extensionNode.ts'
import {selectedExtension} from './extensionCommands.ts'
import {readInlineContainerPayload} from './inlineContainerPayload.ts'
import {selectedInlineContainer} from './inlineContainerCommands.ts'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'
export function selectedEditorNode(state:EditorState){return selectedInlineContainer(state)??selectedExtension(state)}
export function editorNodes(doc:PmNode){
 const result=new Map<string,{value:ResourceNodePayload;position:number}>(extensionNodeLocations(doc))
 doc.descendants((node,position)=>{if(node.type.name==='hcdExtensionInlineContainer'){const value=readInlineContainerPayload(node.attrs.extension);if(result.has(value.instanceId))throw Error('duplicateInlineContainerIdentity');result.set(value.instanceId,{value,position})}})
 return result
}
export function editorNodeCodec(nodes:NodeExtensionRegistry,inline:InlineContainerRegistry){return{
 resolve:(value:ResourceNodePayload)=>value.schemaVersion==='hcd.extension/3'?inline.resolve(value):nodes.resolve(value),
 migrationAvailable:(value:ResourceNodePayload)=>value.schemaVersion==='hcd.extension/3'?inline.migrationAvailable(value):nodes.migrationAvailable(value),
}}
