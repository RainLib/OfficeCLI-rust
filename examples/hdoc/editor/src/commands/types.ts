import type {InlineContainerPayload} from '../inline-containers.js'
import type {ExtensionNodePayload,NodeEditInfo} from '../extensionTypes.js'
export type CommandSurface='ribbon'|'context'|'bubble'|'slash'|'block'|'palette'
export type EditorProfile='flow'|'fixed'|'sheet'
export type CommandLabel=string|Readonly<Record<string,string>>
export type CommandContext={
 instanceId:string;documentId:string;format:string;profile:EditorProfile;locale:string;platform:'mac'|'other'
 ready:boolean;readOnly:boolean;revision:number|null;historical:boolean
 selection:Readonly<{kind:'text'|'object'|'none';empty:boolean;anchor:string|null;protected:boolean;from?:number;to?:number;text?:string;nodeId?:string;extension?:Readonly<ExtensionNodePayload|InlineContainerPayload>;nodeEdits?:NodeEditInfo;customMarkTypes?:readonly string[];parentTypes:readonly string[]}>
 actions:Readonly<Record<string,{enabled:boolean;active?:boolean;reason?:string}>>
 capabilities:Readonly<Record<string,boolean>>
}
export type CommandInvocation={
 readonly context:Readonly<CommandContext>;readonly signal:AbortSignal
 /** Runs another registered command, rechecking current authority and selection. */
 commands:{run:(id:string,input?:unknown)=>Promise<unknown>}
}
export type EditorCommand={
 id:string;label?:CommandLabel;labelKey?:string;description?:CommandLabel;descriptionKey?:string;icon?:string;group?:string;order?:number
 aliases?:readonly string[];shortcuts?:readonly string[];surfaces?:readonly CommandSurface[];profiles?:readonly EditorProfile[]
 /** Editor bindings leave unrelated form fields alone; workspace bindings also apply there. */
 shortcutScope?:'editor'|'workspace'
 /** Only for actions outside the selection, such as appending after an image.
  * Read-only, historical and action-specific authority checks still apply. */
 allowProtectedSelection?:boolean
 control?:'color';initialValue?:string;groupLabel?:CommandLabel;presentation?:'large'|'compact';tabs?:readonly string[];access?:'read'|'write';selectionSensitive?:boolean;requires?:readonly string[];ready?:boolean
 canExecute?:(context:Readonly<CommandContext>)=>boolean
 isActive?:(context:Readonly<CommandContext>)=>boolean
 execute?:(invocation:CommandInvocation,input?:unknown)=>unknown|Promise<unknown>
}
export type CommandMenuOverride={hidden?:readonly string[];order?:readonly string[]}
export type CommandExtensions={
 commands?:readonly EditorCommand[]
 menuOverrides?:Partial<Record<CommandSurface,CommandMenuOverride>>
 /** null disables a binding. Rebindings are checked for platform/profile collisions. */
 keymap?:Readonly<Record<string,readonly string[]|null>>
 /** Return a cleanup for host subscriptions when the editor/registry is replaced. */
 onReady?:(commands:EditorCommandService)=>void|(()=>void)
 onError?:(error:Error)=>void
}
export type CommandItem={id:string;label:string;description:string;icon?:string;group:string;enabled:boolean;active?:boolean;reason?:string;shortcuts:readonly string[];builtin:boolean;control?:'color';initialValue?:string;groupLabel?:string;presentation?:'large'|'compact'}
export type EditorCommandService={
 register:(commands:readonly EditorCommand[])=>()=>void
 subscribe:(listener:()=>void)=>()=>void
 list:(surface:CommandSurface,query?:string)=>CommandItem[]
 execute:(id:string,input?:unknown)=>Promise<unknown>
 context:()=>Readonly<CommandContext>
 capabilities:()=>{version:'hcd-commands/1';commands:true;customNodes:'atomic-v1'|'reserved';mentions:'person'|'reserved';ai:'private-text-v1'|'reserved';autocomplete:'ghost-text-v1'|'reserved'}
}
