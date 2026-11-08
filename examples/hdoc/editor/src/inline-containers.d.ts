import type {Node as TiptapNode} from '@tiptap/core'
import type {Editor} from '@tiptap/core'
import type {EditorState} from '@tiptap/pm/state'
import type {EditorCommand} from './commands/types.js'
import type {Node as PmNode,Slice} from '@tiptap/pm/model'
import type {ExtensionNodePayload,NodeExtensionDefinition,NodeResource} from './extensionTypes.js'
export type InlineContainerPayload=Omit<ExtensionNodePayload,'schemaVersion'|'display'|'contentModel'>&{schemaVersion:'hcd.extension/3';display:'inline';contentModel:'inline'}
export type InlineContainerDefinition=Omit<NodeExtensionDefinition,'display'|'contentModel'|'mountView'>&{display:'inline';contentModel:'inline'}
export type InlineContainerService=Pick<InlineContainerRegistry,'register'|'subscribe'|'snapshot'|'commandSnapshot'|'list'|'resolve'|'create'|'update'|'updateResources'|'migrationAvailable'|'previewMigration'|'capabilities'|'commands'>
export type InlineContainerExtensions={nodes?:readonly InlineContainerDefinition[];onReady?:(service:InlineContainerService)=>void|(()=>void);onError?:(error:Error)=>void}
export declare class InlineContainerRegistry{
 constructor(definitions?:readonly InlineContainerDefinition[],report?:(error:Error)=>void)
 connect:()=>()=>void
 subscribe:(listener:()=>void)=>()=>void
 snapshot:()=>number
 commandSnapshot:()=>number
 error:(error:unknown)=>void
 commands:()=>EditorCommand[]
 register:(definitions:readonly InlineContainerDefinition[])=>()=>void
 list:()=>ReadonlyArray<Readonly<{type:string;version:number;display:'inline';contentModel:'inline';label:NodeExtensionDefinition['label']}>>
 capabilities:()=>Readonly<{version:'hcd-inline-containers/1';envelope:3;content:'inline';properties:'fields-v1';exportAdapters:'portable-v1';requiresNegotiatedModel:true}>
 resolve:(input:InlineContainerPayload)=>Readonly<InlineContainerDefinition>|undefined
 create:(type:string,data?:Record<string,unknown>,resources?:readonly NodeResource[])=>InlineContainerPayload
 update:(input:InlineContainerPayload,data:Record<string,unknown>)=>InlineContainerPayload
 updateResources:(input:InlineContainerPayload,resources:readonly NodeResource[])=>InlineContainerPayload
 migrationAvailable:(input:InlineContainerPayload)=>boolean
 previewMigration:(input:InlineContainerPayload)=>Readonly<{before:InlineContainerPayload;after:InlineContainerPayload;versions:readonly number[]}>|null
}
export declare function readInlineContainerPayload(input:unknown):InlineContainerPayload
export declare function prepareInlineContainerHistoryGuard(before:PmNode,resolve:(value:InlineContainerPayload)=>unknown):((after:PmNode)=>void)|undefined
export declare function copyInlineContainerSlice(slice:Slice,targetSourceId?:string):Slice
export declare function selectedInlineContainer(state:EditorState):{value:InlineContainerPayload;position:number;node:PmNode}|null
export declare function prepareInlineContainerTransaction(editor:Editor,registry:InlineContainerRegistry,id:string,input:unknown):{commit:()=>boolean;value?:InlineContainerPayload}|null
export declare const SemanticInlineContainerNode:TiptapNode<{registry:()=>InlineContainerRegistry|undefined;onError:(error:unknown)=>void}>
