import type {NodeResource,NodeExportFormat,NodeExportSnapshot} from './extensionPortable.js'
export type {NodeResource,NodeExportFormat,NodeExportSnapshot,NodeExportBlock,NodeExportRun} from './extensionPortable.js'
import type {CommandLabel} from './commands/types.js'
import type {CustomMarkDefinition,CustomMarkPayload} from './customMarkTypes.js'
export type {CustomMarkDefinition,CustomMarkPayload,CustomMarkStyle} from './customMarkTypes.js'
export type ExtensionNodePayload={schemaVersion:'hcd.extension/1'|'hcd.extension/2';resources?:NodeResource[];contentModel?:'blocks';exports?:Partial<Record<NodeExportFormat,NodeExportSnapshot>>;instanceId:string;type:string;version:number;display:'inline'|'block';data:Record<string,unknown>;fallback:{text:string}}
export type NodeProperty={key:string;label:CommandLabel;kind:'text'|'number'|'boolean'|'select';options?:readonly {value:string;label:CommandLabel}[];required?:boolean;maxLength?:number;min?:number;max?:number}
export type ExtensionViewContext={readonly node:Readonly<ExtensionNodePayload>;readonly locale:string;readonly readOnly:boolean}
export type NodeMigrationStep={
 fromVersion:number
 /** Validate the source business schema before executing a one-version step. */
 validate:(data:Readonly<Record<string,unknown>>)=>boolean
 /** Pure, deterministic, synchronous; output is checked before the next step. */
 migrate:(data:Readonly<Record<string,unknown>>)=>Record<string,unknown>
}
export type NodeMigrationPreview={before:ExtensionNodePayload;after:ExtensionNodePayload;versions:readonly number[]}
/** Trusted, bundled host code; no editor, Y.Doc or authority handle is exposed. */
export type NodeExtensionDefinition={
 type:string;version:number;display:'inline'|'block';label:CommandLabel;icon?:string
 description?:CommandLabel
 /** Defaults to true. Disable for scalar atoms that cannot own attachments. */
 allowResources?:boolean
 defaultData:Record<string,unknown>
 /** Synchronous business-schema validation. Must return exactly true. */
 validate:(data:Readonly<Record<string,unknown>>)=>boolean
 /** Deterministic, locale-independent persisted representation. */
 fallback:(data:Readonly<Record<string,unknown>>)=>string
 contentModel?:'blocks'
 /** Pure portable snapshots are persisted for offline/server export. */
 exportAdapters?:Partial<Record<NodeExportFormat,(context:{readonly data:Readonly<Record<string,unknown>>;readonly resources:readonly NodeResource[]})=>NodeExportSnapshot>>
 properties?:readonly NodeProperty[]
 migrations?:readonly NodeMigrationStep[]
 /** Optional trusted DOM view; cleanup runs before repaint/unmount. Never serialized. */
 mountView?:(element:HTMLElement,context:ExtensionViewContext)=>void|(()=>void)
}
export type NodeConflictChoice={intentId:string;present:boolean;value?:unknown}
export type NodeEditInfo={ids:readonly string[];conflicts:Readonly<Record<string,readonly NodeConflictChoice[]>>;ready:boolean}
export type NodeExtensionService={
 registerMarks:(definitions:readonly CustomMarkDefinition[])=>()=>void
 listMarks:()=>ReadonlyArray<Readonly<{type:string;version:number;label:CommandLabel}>>
 createMark:(type:string,data?:Record<string,unknown>)=>CustomMarkPayload
 resourceStatus:()=>Readonly<{pending:number}>
 archiveResource:(input:{file:Blob;name:string;key:string;signal?:AbortSignal})=>Promise<Readonly<NodeResource>>
 readResource:(resource:NodeResource,revision?:number)=>Promise<Blob>
 register:(definitions:readonly NodeExtensionDefinition[])=>()=>void
 subscribe:(listener:()=>void)=>()=>void
 list:()=>ReadonlyArray<Readonly<{type:string;version:number;display:'inline'|'block';label:CommandLabel}>>
 previewMigration:(node:ExtensionNodePayload)=>Readonly<NodeMigrationPreview>|null
 capabilities:()=>{version:'hcd-nodes/1';atoms:true;properties:true;views:true;collaboration:'fields-v2';marks:'format-v1';migrations:'explicit-v1';exportAdapters:'portable-v1';resources:'archive-v1';containers:'blocks-v1'}
}
export type NodeExtensions={nodes?:readonly NodeExtensionDefinition[];marks?:readonly CustomMarkDefinition[];onReady?:(service:NodeExtensionService)=>void|(()=>void);onError?:(error:Error)=>void}
