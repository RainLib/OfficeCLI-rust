import {NodeExtensionRegistry,frozenExtension} from './extensionRegistry.ts'
import type {NodeExtensionDefinition,ExtensionNodePayload} from './extensionTypes.ts'
import {validateNodeExports,type NodeResource} from './extensionPortable.ts'
import {inlineContainerNodeName,readInlineContainerPayload,type InlineContainerPayload} from './inlineContainerPayload.ts'
import type {EditorCommand} from './commands/types.ts'

/** Trusted host code only. Editable text belongs to the permanent body, never
 * to `data` or a DOM callback. Active rooms must negotiate this model first. */
export type InlineContainerDefinition=Omit<NodeExtensionDefinition,'display'|'contentModel'|'mountView'>&{display:'inline';contentModel:'inline'}
export type InlineContainerService=Pick<InlineContainerRegistry,'register'|'subscribe'|'snapshot'|'commandSnapshot'|'list'|'resolve'|'create'|'update'|'updateResources'|'migrationAvailable'|'previewMigration'|'capabilities'|'commands'>
export type InlineContainerExtensions={nodes?:readonly InlineContainerDefinition[];onReady?:(service:InlineContainerService)=>void|(()=>void);onError?:(error:Error)=>void}
const lower=(node:InlineContainerPayload):ExtensionNodePayload=>({...readInlineContainerPayload(node),schemaVersion:'hcd.extension/2',display:'block',contentModel:'blocks'})
const upper=(node:ExtensionNodePayload)=>readInlineContainerPayload({...node,schemaVersion:'hcd.extension/3',display:'inline',contentModel:'inline'})
function definition(value:InlineContainerDefinition):NodeExtensionDefinition{
 if(!value||value.display!=='inline'||value.contentModel!=='inline'||Object.hasOwn(value,'mountView'))throw new Error('inlineContainerDefinition')
 const adapters=value.exportAdapters,fallback=value.fallback
 return{...value,display:'block',contentModel:'blocks',fallback:data=>{
  const text=fallback(data);if(typeof text!=='string'||/[\r\n\t]/u.test(text))throw new Error('unsupportedInlineContainer');return text
 },...(adapters?{exportAdapters:Object.fromEntries(Object.entries(adapters).map(([format,adapter])=>[format,(context:Parameters<NonNullable<typeof adapter>>[0])=>{
  const snapshot=adapter!(context);validateNodeExports({[format]:snapshot},context.resources,true,true);return snapshot
 }]))}:{})}
}

/** Reuses atomic registration, bounded JSON, deterministic codecs, explicit
 * migrations and property validation from the ordinary node SDK. This service
 * does not grant room authority or initialize a document. */
export class InlineContainerRegistry{
 private core:NodeExtensionRegistry
 private active=true
 private generation=0
 private lifecycle=0
 private listeners=new Set<()=>void>()
 constructor(definitions:readonly InlineContainerDefinition[]=[],report?:(error:Error)=>void){this.core=new NodeExtensionRegistry(definitions.map(definition),report)}
 private changed(){this.lifecycle++;this.listeners.forEach(listener=>listener())}
 private requireLive(){if(!this.active)throw new Error('nodeExtensionDisposed')}
 connect=()=>{const generation=++this.generation,close=this.core.connect();this.active=true;this.changed();return()=>{close();if(this.generation===generation){this.active=false;this.changed()}}}
 subscribe=(listener:()=>void)=>{const close=this.core.subscribe(listener);this.listeners.add(listener);return()=>{close();this.listeners.delete(listener)}}
 snapshot=()=>this.core.snapshot()+this.lifecycle
 commandSnapshot=()=>this.core.commandSnapshot()+this.lifecycle
 error=(error:unknown)=>this.core.error(error)
 register=(values:readonly InlineContainerDefinition[])=>this.core.register(values.map(definition))
 list=()=>Object.freeze(this.core.list().map(value=>Object.freeze({...value,display:'inline' as const,contentModel:'inline' as const})))
 capabilities=()=>Object.freeze({version:'hcd-inline-containers/1' as const,envelope:3 as const,content:'inline' as const,properties:'fields-v1' as const,exportAdapters:'portable-v1' as const,requiresNegotiatedModel:true as const})
 resolve=(input:InlineContainerPayload):Readonly<InlineContainerDefinition>|undefined=>{
  if(!this.active)return undefined
  try{const found=this.core.resolve(lower(input));return found?Object.freeze({...found,display:'inline',contentModel:'inline'}):undefined}catch{return undefined}
 }
 create=(type:string,data?:Record<string,unknown>,resources?:readonly NodeResource[])=>{this.requireLive();return upper(this.core.create(type,data,resources))}
 update=(input:InlineContainerPayload,data:Record<string,unknown>)=>{this.requireLive();return upper(this.core.update(lower(input),data))}
 updateResources=(input:InlineContainerPayload,resources:readonly NodeResource[])=>{this.requireLive();return upper(this.core.updateResources(lower(input),resources))}
 migrationAvailable=(input:InlineContainerPayload)=>{if(!this.active)return false;try{return this.core.migrationAvailable(lower(input))}catch{return false}}
 previewMigration=(input:InlineContainerPayload):Readonly<{before:InlineContainerPayload;after:InlineContainerPayload;versions:readonly number[]}>|null=>{
  if(!this.active)return null
  const result=this.core.previewMigration(lower(input));return result?frozenExtension({before:upper(result.before),after:upper(result.after),versions:result.versions}):null
 }
 commands():EditorCommand[]{return this.core.commands().filter(command=>command.id.startsWith('node.insert.')).map(command=>{const type=command.id.slice('node.insert.'.length);return{...command,id:`node.inline.insert.${type}`,aliases:[type,'inline','行内'],canExecute:context=>this.active&&context.capabilities.customNodes===true&&context.capabilities.inlineContainers===true&&context.actions['node.insert']?.enabled===true&&(!context.selection.parentTypes.includes(inlineContainerNodeName)||!context.selection.protected),execute:({commands})=>commands.run('node.insert',{model:'inline',type})}})}
}
