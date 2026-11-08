import {nodeExportFormats,validateNodeResources,type NodeResource} from './extensionPortable.ts'
import {readExtensionNode} from './extensionNode.ts'
import type {ExtensionNodePayload,NodeExtensionDefinition,NodeExtensionService,NodeProperty} from './extensionTypes.ts'
import type {CommandLabel,EditorCommand} from './commands/types.ts'
import {CustomMarkRegistry,type CustomMarkDefinition} from './customMarks.ts'
import {inlineContainerNodeName} from './inlineContainerPayload.ts'
export const stableExtension=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)
export function frozenExtension<T>(value:T):Readonly<T>{const copy=structuredClone(value);const freeze=(item:unknown)=>{if(item&&typeof item==='object'){Object.values(item).forEach(freeze);Object.freeze(item)}};freeze(copy);return copy}
export function nodeLabel(label:CommandLabel,locale:string){return typeof label==='string'?label:label[locale]??label[locale.split('-')[0]]??label['en-US']??Object.values(label)[0]??''}
const validLabel=(label:CommandLabel)=>typeof label==='string'?!!label.trim()&&label.length<=256:!!label&&typeof label==='object'&&!Array.isArray(label)&&Object.keys(label).length>0&&Object.entries(label).every(([key,value])=>key.length<=32&&typeof value==='string'&&!!value.trim()&&value.length<=256)
function propertyValue(field:NodeProperty,value:unknown){
 if(value===undefined&&!field.required)return true
 if(field.kind==='boolean')return typeof value==='boolean'
 if(field.kind==='number')return typeof value==='number'&&Number.isFinite(value)&&(field.min===undefined||value>=field.min)&&(field.max===undefined||value<=field.max)
 if(field.kind==='select')return typeof value==='string'&&field.options?.some(option=>option.value===value)===true
 return typeof value==='string'&&(!field.required||!!value.trim())&&value.length<=(field.maxLength??16384)
}
export class NodeExtensionRegistry implements NodeExtensionService{
 readonly marks:CustomMarkRegistry
 registerMarks=(definitions:readonly CustomMarkDefinition[])=>{if(!this.live)throw new Error('nodeExtensionDisposed');const dispose=this.marks.register(definitions);this.changed(true);let active=true;return()=>{if(active){active=false;dispose();this.changed(true)}}}
 listMarks=()=>this.marks.list()
 createMark=(type:string,data?:Record<string,unknown>)=>this.marks.create(type,data)
 private entries=new Map<string,{definition:NodeExtensionDefinition;owner:symbol}>();private listeners=new Set<()=>void>();private version=0;private commandVersion=0;private live=false;private pendingResources=0;private resourceLifetime:AbortController|null=null
 constructor(definitions:readonly NodeExtensionDefinition[]=[],private report:(error:Error)=>void=()=>{},private resourceTransport?:{archive:(input:{file:Blob;name:string;key:string;signal?:AbortSignal;reuseExisting?:boolean})=>Promise<NodeResource>;read:(resource:NodeResource,revision?:number,signal?:AbortSignal)=>Promise<Blob>},marks:readonly CustomMarkDefinition[]=[]){this.marks=new CustomMarkRegistry(marks);this.add(definitions)}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 resourceStatus=()=>Object.freeze({pending:this.pendingResources})
 private resourceRequest<T>(run:(signal:AbortSignal)=>Promise<T>,cancellation?:AbortSignal):Promise<T>{
  const owner=this.resourceLifetime
  if(!this.live||!owner) return Promise.reject(new Error('nodeResourcesUnavailable'))
  const signal=AbortSignal.any([owner.signal,AbortSignal.timeout(45_000),...(cancellation?[cancellation]:[])])
  // Some transports finish after cancellation. Settle independently so pending
  // save guards release, while consuming any late success/failure safely.
  return new Promise<T>((resolve,reject)=>{
   const aborted=()=>{signal.removeEventListener('abort',aborted);reject(signal.reason)}
   if(signal.aborted){aborted();return}
   signal.addEventListener('abort',aborted,{once:true})
   let request:Promise<T>
   try{request=run(signal)}catch(error){signal.removeEventListener('abort',aborted);reject(error);return}
   Promise.resolve(request).then(value=>{
    signal.removeEventListener('abort',aborted)
    if(signal.aborted)reject(signal.reason)
    else if(!this.live||this.resourceLifetime!==owner)reject(new Error('nodeExtensionDisposed'))
    else resolve(value)
   },error=>{signal.removeEventListener('abort',aborted);reject(error)})
  })
 }
 archiveResource=async(input:{file:Blob;name:string;key:string;signal?:AbortSignal;reuseExisting?:boolean})=>{
  if(!this.live||!this.resourceTransport)throw new Error('nodeResourcesUnavailable')
  if(this.pendingResources>=2)throw new Error('nodeResourceBusy')
  const captured={file:input.file,name:input.name,key:input.key,reuseExisting:input.reuseExisting},cancellation=input.signal,owner=this.resourceLifetime
  this.pendingResources++;this.changed()
  try{const value=await this.resourceRequest(signal=>this.resourceTransport!.archive({...captured,signal}),cancellation);if(!this.live||this.resourceLifetime!==owner)throw new Error('nodeExtensionDisposed');cancellation?.throwIfAborted();validateNodeResources([value]);return frozenExtension(value)}
  finally{this.pendingResources--;this.changed()}
 }
 readResource=async(resource:NodeResource,revision?:number)=>{if(!this.live||!this.resourceTransport)throw new Error('nodeResourcesUnavailable');validateNodeResources([resource]);const captured=structuredClone(resource);return this.resourceRequest(signal=>this.resourceTransport!.read(captured,revision,signal))}
 snapshot=()=>this.version
 commandSnapshot=()=>this.commandVersion
 private changed(commands=false){this.version++;if(commands)this.commandVersion++;this.listeners.forEach(listener=>listener())}
 connect(){this.resourceLifetime?.abort(new Error('nodeExtensionDisposed'));const owner=new AbortController();this.resourceLifetime=owner;this.live=true;return()=>{if(this.resourceLifetime!==owner)return;this.live=false;this.resourceLifetime=null;owner.abort(new Error('nodeExtensionDisposed'))}}
 error(error:unknown){try{this.report(error instanceof Error?error:new Error(String(error)))}catch{/* Host diagnostics must not break the fallback reader. */}}
 capabilities=()=>({version:'hcd-nodes/1' as const,atoms:true as const,properties:true as const,views:true as const,collaboration:'fields-v2' as const,marks:'format-v1' as const,migrations:'explicit-v1' as const,exportAdapters:'portable-v1' as const,resources:'archive-v1' as const,containers:'blocks-v1' as const})
 list=()=>Object.freeze([...this.entries.values()].map(({definition:{type,version,display,label}})=>Object.freeze({type,version,display,label})))
 private add(definitions:readonly NodeExtensionDefinition[]){
  const pending=new Map(this.entries),owner=Symbol('node registration')
  if(definitions.length+pending.size>64)throw new Error('nodeExtensionLimit')
  for(const value of definitions){
   if(!value||typeof value.type!=='string'||value.type.length>116||pending.has(value.type)||!validLabel(value.label)||typeof value.validate!=='function'||typeof value.fallback!=='function'||value.mountView!==undefined&&typeof value.mountView!=='function'||value.icon!==undefined&&(typeof value.icon!=='string'||value.icon.length>32))throw new Error('nodeExtensionDefinition')
   if(value.contentModel!==undefined&&(value.contentModel!=='blocks'||value.display!=='block'||!!value.mountView)||value.exportAdapters!==undefined&&(Object.keys(value.exportAdapters).some(key=>!nodeExportFormats.includes(key as any))||Object.values(value.exportAdapters).some(fn=>typeof fn!=='function')))throw new Error('nodeExtensionPortableDefinition')
   if(value.description!==undefined&&!validLabel(value.description)||value.allowResources!==undefined&&typeof value.allowResources!=='boolean')throw new Error('nodeExtensionDefinition')
   const properties=value.properties??[];if(properties.length>32||new Set(properties.map(p=>p.key)).size!==properties.length)throw new Error('nodeExtensionProperties')
   for(const p of properties){
    if(!/^[a-zA-Z][\w-]{0,63}$/.test(p.key)||['constructor','prototype','__proto__'].includes(p.key)||!validLabel(p.label)||!['text','number','boolean','select'].includes(p.kind)||p.maxLength!==undefined&&(!Number.isInteger(p.maxLength)||p.maxLength<1||p.maxLength>16384)||[p.min,p.max].some(v=>v!==undefined&&!Number.isFinite(v))||p.min!==undefined&&p.max!==undefined&&p.min>p.max)throw new Error('nodeExtensionProperty')
    if(p.kind==='select'?(!Array.isArray(p.options)||p.options.length<1||p.options.length>64||new Set(p.options.map(option=>option?.value)).size!==p.options.length||p.options.some(option=>!option||typeof option.value!=='string'||!option.value||option.value.length>128||/[\u0000-\u001f\ufffe\uffff]/u.test(option.value)||!validLabel(option.label))):p.options!==undefined)throw new Error('nodeExtensionProperty')
   }
   const migrations=value.migrations??[]
   if(!Array.isArray(migrations)||migrations.length>16||new Set(migrations.map(step=>step.fromVersion)).size!==migrations.length||migrations.some(step=>!Number.isSafeInteger(step.fromVersion)||step.fromVersion<1||step.fromVersion>=value.version||typeof step.validate!=='function'||typeof step.migrate!=='function'))throw new Error('nodeMigrationDefinition')
   const definition=Object.freeze({...value,...(value.exportAdapters?{exportAdapters:Object.freeze({...value.exportAdapters})}:{}),label:frozenExtension(value.label),...(value.description===undefined?{}:{description:frozenExtension(value.description)}),defaultData:frozenExtension(value.defaultData) as Record<string,unknown>,properties:Object.freeze(properties.map(p=>Object.freeze({...p,label:frozenExtension(p.label),...(p.options?{options:Object.freeze(p.options.map(option=>Object.freeze({...option,label:frozenExtension(option.label)})))}:{})}))),migrations:Object.freeze(migrations.map(step=>Object.freeze({...step})))})
   this.build(definition,definition.defaultData,'x_'+'0'.repeat(32));pending.set(value.type,{definition,owner})
  }
  this.entries=pending;return owner
 }
 register=(definitions:readonly NodeExtensionDefinition[])=>{if(!this.live)throw new Error('nodeExtensionDisposed');const owner=this.add(definitions);this.changed(true);let active=true;return()=>{if(!active)return;active=false;for(const[type,entry]of this.entries)if(entry.owner===owner)this.entries.delete(type);this.changed(true)}}
 private build(definition:NodeExtensionDefinition,data:Record<string,unknown>,instanceId:string,resources:readonly NodeResource[]=[]){
  if(definition.allowResources===false&&resources.length)throw new Error('nodeResourceInvalid')
  // Validate JSON bounds/prototypes before invoking host code. Do not silently normalize data.
  const portable=!!definition.contentModel||!!Object.keys(definition.exportAdapters??{}).length||resources.length>0
  const base=readExtensionNode({schemaVersion:portable?'hcd.extension/2':'hcd.extension/1',...(portable?{...(resources.length?{resources:[...resources]}:{}),...(definition.contentModel?{contentModel:definition.contentModel}:{})}:{}),instanceId,type:definition.type,version:definition.version,display:definition.display,data,fallback:{text:'validation'}})
  const safe=frozenExtension(base.data)
  if(definition.properties?.some(field=>!propertyValue(field,safe[field.key]))||definition.validate(safe)!==true)throw new Error('nodeExtensionInvalidData')
  const exports=definition.exportAdapters?Object.fromEntries(Object.entries(definition.exportAdapters).map(([format,adapter])=>{const context=frozenExtension({data:base.data,resources:base.resources??[]}),first=adapter!(context),second=adapter!(frozenExtension(context));if(stableExtension(first)!==stableExtension(second))throw new Error('nodeExportNonDeterministic');return[format,first]})):undefined
  return readExtensionNode({...base,fallback:{text:definition.fallback(safe)},...(exports&&Object.keys(exports).length?{exports}:{} )})
 }
 resolve(node:ExtensionNodePayload){
  const definition=this.entries.get(node.type)?.definition
  if(!definition||definition.version!==node.version||definition.display!==node.display)return undefined
  try{return stableExtension(this.build(definition,node.data,node.instanceId,node.resources))===stableExtension(readExtensionNode(node))?definition:undefined}catch{return undefined}
 }
 create(type:string,data?:Record<string,unknown>,resources?:readonly NodeResource[]){const definition=this.entries.get(type)?.definition;if(!definition)throw new Error('nodeExtensionUnavailable');return this.build(definition,data??structuredClone(definition.defaultData),`x_${crypto.randomUUID().replaceAll('-','')}`,resources)}
 update(before:ExtensionNodePayload,data:Record<string,unknown>){const definition=this.resolve(before);if(!definition)throw new Error('nodeExtensionUnavailable');return this.build(definition,data,before.instanceId,before.resources)}
 updateResources(before:ExtensionNodePayload,resources:readonly NodeResource[]){const definition=this.resolve(before);if(!definition)throw new Error('nodeExtensionUnavailable');return this.build(definition,before.data,before.instanceId,resources)}
 migrationAvailable(node:ExtensionNodePayload){
  const definition=this.entries.get(node.type)?.definition
  if(!definition||definition.display!==node.display||definition.contentModel!==node.contentModel||node.version>=definition.version||definition.version-node.version>16)return false
  for(let version=node.version;version<definition.version;version++)if(!definition.migrations?.some(step=>step.fromVersion===version))return false
  return true
 }
 previewMigration=(input:ExtensionNodePayload)=>{
  const before=readExtensionNode(input)
  if(!this.migrationAvailable(before))return null
  const definition=this.entries.get(before.type)!.definition,versions=[before.version]
  let value=before
  for(let version=before.version;version<definition.version;version++){
   const step=definition.migrations!.find(step=>step.fromVersion===version)!,safe=frozenExtension(value.data)
   if(step.validate(safe)!==true)throw new Error('nodeMigrationInvalidSource')
   const first=readExtensionNode({...value,version:version+1,data:step.migrate(safe)}),second=readExtensionNode({...value,version:version+1,data:step.migrate(frozenExtension(value.data))})
   if(stableExtension(first)!==stableExtension(second))throw new Error('nodeMigrationNonDeterministic')
   value=first;versions.push(version+1)
  }
  const after=this.build(definition,value.data,before.instanceId,before.resources)
  if(stableExtension(after)!==stableExtension(this.build(definition,value.data,before.instanceId,before.resources)))throw new Error('nodeMigrationNonDeterministic')
  return frozenExtension({before,after,versions})
 }
 commands():EditorCommand[]{return [...this.marks.commands(),...[...this.entries.values()].map(({definition}):EditorCommand=>({id:`node.insert.${definition.type}`,label:definition.label,icon:definition.icon??'＋',profiles:['flow'],surfaces:['ribbon','context','slash','block','palette'],tabs:['insert'],group:'insert',allowProtectedSelection:true,requires:['node.insert'],canExecute:context=>context.capabilities.customNodes===true&&context.actions['node.insert']?.enabled===true&&(!context.selection.parentTypes.includes(inlineContainerNodeName)||definition.display==='inline'&&!context.selection.protected),execute:({commands})=>commands.run('node.insert',{type:definition.type})}))]}
}
