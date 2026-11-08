import type {BlockTarget} from './blocks.ts'
import type {InsertionStage,SlashTarget,ContentTarget} from './insertion.ts'
import {eventKey,shortcutKey,type KeyEvent} from './keymap.ts'
import type {CommandContext,CommandExtensions,CommandItem,CommandSurface,EditorCommand,EditorCommandService} from './types.ts'
export class CommandError extends Error{
 constructor(readonly code:'configuration'|'unavailable'|'readOnly'|'selectionChanged'|'disposed'|'busy'|'cycle',readonly commandId:string,detail?:string){super(detail??code);this.name='CommandError'}
}
const surfaces:CommandSurface[]=['ribbon','context','bubble','slash','block','palette']
const profiles=['flow','fixed','sheet'] as const
const normalized=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase().trim()
const label=(value:EditorCommand['label'],locale:string)=>typeof value==='string'?value:value?.[locale]??value?.[locale.split('-')[0]]??value?.['en-US']??(value?Object.values(value)[0]:'')??''
function snapshot(context:CommandContext):Readonly<CommandContext>{
 const copy=structuredClone(context)
 const freeze=(value:unknown)=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}};if(copy.selection.extension)freeze(copy.selection.extension);if(copy.selection.nodeEdits)freeze(copy.selection.nodeEdits)
 if(copy.selection.customMarkTypes)Object.freeze(copy.selection.customMarkTypes);Object.freeze(copy.selection.parentTypes);Object.freeze(copy.selection);Object.values(copy.actions).forEach(Object.freeze);Object.freeze(copy.actions);Object.freeze(copy.capabilities)
 return Object.freeze(copy)
}
type Entry={definition:EditorCommand;builtin:boolean;owner:symbol}
/** Per-editor, headless command dispatch. UI visibility never grants authority. */
export class CommandRegistry implements EditorCommandService{
 private entries=new Map<string,Entry>();private listeners=new Set<()=>void>();private version=0
 private closed=true;private lifetime=new AbortController();private running=new Map<string,symbol>();private lastContext=''
 constructor(private getContext:()=>CommandContext,private adapter:(id:string,input:unknown,signal:AbortSignal,insertion?:InsertionStage)=>unknown|Promise<unknown>,builtins:readonly EditorCommand[],private configuration:CommandExtensions={},private translate:(key:string)=>string=key=>key){
  this.configuration={...configuration,keymap:configuration.keymap?Object.freeze(Object.fromEntries(Object.entries(configuration.keymap).map(([id,keys])=>[id,keys?Object.freeze([...keys]):null]))):undefined,menuOverrides:configuration.menuOverrides?Object.freeze(Object.fromEntries(Object.entries(configuration.menuOverrides).map(([surface,override])=>[surface,Object.freeze({hidden:Object.freeze([...(override?.hidden??[])]),order:Object.freeze([...(override?.order??[])])})]))):undefined}
  this.add(builtins,true);this.add(configuration.commands??[],false);this.validate()
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.version
 private changed(){this.version++;this.listeners.forEach(listener=>listener())}
 context=()=>snapshot(this.getContext())
 capabilities=()=>({version:'hcd-commands/1' as const,commands:true as const,customNodes:(this.getContext().capabilities.customNodes?'atomic-v1':'reserved') as 'atomic-v1'|'reserved',mentions:(this.getContext().capabilities.mentions?'person':'reserved') as 'person'|'reserved',autocomplete:(this.getContext().capabilities.aiAutocomplete?'ghost-text-v1':'reserved') as 'ghost-text-v1'|'reserved',ai:(this.getContext().capabilities.ai?'private-text-v1':'reserved') as 'private-text-v1'|'reserved'})
 connect(){if(!this.closed)throw new CommandError('configuration','','Registry already connected');this.closed=false;this.lifetime=new AbortController();this.changed();const owner=this.lifetime;return()=>{if(owner===this.lifetime)this.dispose()}}
 dispose(){this.closed=true;this.lifetime.abort();this.running.clear();this.changed()}
 refresh(){const current=JSON.stringify(this.getContext());if(current!==this.lastContext){this.lastContext=current;this.changed()}}
 private add(commands:readonly EditorCommand[],builtin:boolean){
  const owner=Symbol('registration')
  for(const command of commands){
   if(!/^[a-zA-Z][\w.-]{0,127}$/.test(command.id)||this.entries.has(command.id)||!command.label&&!command.labelKey||!builtin&&typeof command.execute!=='function')throw new CommandError('configuration',command.id,'Invalid or duplicate command definition')
   if(command.order!==undefined&&!Number.isFinite(command.order)||command.profiles?.some(profile=>!profiles.includes(profile))||command.surfaces?.some(surface=>!surfaces.includes(surface))||command.shortcutScope!==undefined&&!['editor','workspace'].includes(command.shortcutScope))throw new CommandError('configuration',command.id,'Invalid command placement')
   const definition=Object.freeze({...command,shortcuts:Object.freeze([...(command.shortcuts??[])]),surfaces:Object.freeze([...(command.surfaces??['palette'])]),profiles:Object.freeze([...(command.profiles??profiles)]),requires:Object.freeze([...(command.requires??[])]),aliases:Object.freeze([...(command.aliases??[])]),tabs:command.tabs?Object.freeze([...command.tabs]):undefined,label:typeof command.label==='object'?Object.freeze({...command.label}):command.label})
   this.entries.set(command.id,{definition,builtin,owner})
  }
  return owner
 }
 register(commands:readonly EditorCommand[]){
  const previous=new Map(this.entries);let owner:symbol
  try{
   owner=this.add(commands,false)
   for(const command of commands)for(const dependency of command.requires??[])if(!this.entries.has(dependency))throw new CommandError('configuration',command.id,'Missing command dependency')
   this.validate(true)
  }catch(error){this.entries=previous;throw error}
  this.changed();let active=true
  return()=>{if(!active)return;active=false;for(const[id,entry]of this.entries)if(entry.owner===owner)this.entries.delete(id);this.changed()}
 }
 private shortcuts(command:EditorCommand){return this.configuration.keymap&&Object.hasOwn(this.configuration.keymap,command.id)?this.configuration.keymap[command.id]??[]:command.shortcuts??[]}
 private validate(allowDetached=false){
  if(this.entries.size>256)throw new CommandError('configuration','','Too many commands')
  const visited=new Set<string>(),visiting=new Set<string>()
  const walk=(id:string)=>{if(visiting.has(id))throw new CommandError('configuration',id,'Command dependency cycle');if(visited.has(id))return;const entry=this.entries.get(id);if(!entry){if(allowDetached)return;throw new CommandError('configuration',id,'Missing command dependency')}visiting.add(id);entry.definition.requires?.forEach(walk);visiting.delete(id);visited.add(id)}
  this.entries.forEach((_,id)=>walk(id))
  for(const id of Object.keys(this.configuration.keymap??{}))if(!this.entries.has(id))throw new CommandError('configuration',id,'Unknown shortcut command')
  for(const override of Object.values(this.configuration.menuOverrides??{}))for(const id of [...override?.hidden??[],...override?.order??[]])if(!this.entries.has(id))throw new CommandError('configuration',id,'Unknown menu command')
  for(const platform of ['mac','other'] as const){
   const bindings=new Map<string,Array<{id:string;profiles:readonly string[]}>>()
   for(const{id,definition}of [...this.entries].map(([id,entry])=>({id,...entry}))){
    const own=new Set<string>()
    for(const key of this.shortcuts(definition)){
     let canonical:string;try{canonical=shortcutKey(key,platform)}catch{throw new CommandError('configuration',id,'Invalid shortcut')}
     if(own.has(canonical))throw new CommandError('configuration',id,'Duplicate shortcut');own.add(canonical)
     const existing=bindings.get(canonical)??[]
     if(existing.some(other=>other.profiles.some(profile=>definition.profiles!.includes(profile as typeof profiles[number]))))throw new CommandError('configuration',id,'Shortcut collision')
     existing.push({id,profiles:definition.profiles!});bindings.set(canonical,existing)
    }
   }
  }
 }
 private dependenciesPresent(id:string):boolean{const entry=this.entries.get(id);return !!entry&&!(entry.definition.requires??[]).some(dependency=>!this.dependenciesPresent(dependency))}
 private state(entry:Entry,context:Readonly<CommandContext>):{enabled:boolean;reason?:string;active?:boolean}{
  const command=entry.definition
  let reason:string|undefined
  if(this.closed)reason='commandUnavailable'
  else if(!command.profiles?.includes(context.profile)||command.ready!==false&&!context.ready)reason='commandUnavailable'
  else if(context.historical&&(command.access??'write')==='write')reason='readOnlyMode'
  else if((command.access??'write')==='write'&&context.readOnly)reason='readOnlyMode'
  else if((command.access??'write')==='write'&&context.selection.protected&&!command.allowProtectedSelection)reason='commandProtected'
  else if(!this.dependenciesPresent(command.id))reason='commandUnavailable'
  else if(this.running.has(command.id))reason='commandBusy'
  else if(entry.builtin&&!context.actions[command.id]?.enabled)reason=context.actions[command.id]?.reason??'commandUnavailable'
  let active=context.actions[command.id]?.active
  try{if(!reason&&command.canExecute&&!command.canExecute(context))reason='commandUnavailable';active=command.isActive?.(context)??active}catch{reason='commandUnavailable'}
  return {enabled:!reason,...(reason?{reason}:{}),active}
 }
 private describe(entry:Entry,context:Readonly<CommandContext>):CommandItem{
  const command=entry.definition,state=this.state(entry,context)
  return {id:command.id,label:label(command.label,context.locale)||(command.labelKey?this.translate(command.labelKey):command.id),description:label(command.description,context.locale)||(command.descriptionKey?this.translate(command.descriptionKey):''),icon:command.icon,group:command.group??'extensions',shortcuts:this.shortcuts(command),builtin:entry.builtin,control:command.control,initialValue:command.initialValue,groupLabel:label(command.groupLabel,context.locale),presentation:command.presentation,...state}
 }
 item(id:string):CommandItem|undefined{const entry=this.entries.get(id);return entry?this.describe(entry,this.context()):undefined}

 list(surface:CommandSurface,query='',tab?:string){
  const context=this.context(),override=this.configuration.menuOverrides?.[surface],order=override?.order??[],needle=normalized(query.slice(0,200))
  return [...this.entries.values()].filter(({definition:command})=>command.surfaces?.includes(surface)&&command.profiles?.includes(context.profile)&&!override?.hidden?.includes(command.id)&&(!tab||!command.tabs||command.tabs.includes(tab)))
   .sort((a,b)=>{const ai=order.indexOf(a.definition.id),bi=order.indexOf(b.definition.id);return (ai<0?Number.MAX_SAFE_INTEGER:ai)-(bi<0?Number.MAX_SAFE_INTEGER:bi)||(a.definition.order??1000)-(b.definition.order??1000)||a.definition.id.localeCompare(b.definition.id)})
   .filter(({definition:command})=>!needle||normalized([command.id,label(command.label,context.locale),command.labelKey?this.translate(command.labelKey):'',...(typeof command.label==='object'?Object.values(command.label):[]),...(command.aliases??[])].join(' ')).includes(needle))
   .map(entry=>this.describe(entry,context))
 }
 visible(id:string,surface:CommandSurface,tab?:string){const command=this.entries.get(id)?.definition;return !!command&&!!command.surfaces?.includes(surface)&&!!command.profiles?.includes(this.getContext().profile)&&!this.configuration.menuOverrides?.[surface]?.hidden?.includes(id)&&(!tab||!command.tabs||command.tabs.includes(tab))}
 private check(entry:Entry,anchor:Readonly<CommandContext>){
  const id=entry.definition.id,current=this.context(),state=this.state(entry,current)
  if(this.entries.get(id)!==entry||!state.enabled)throw new CommandError(state.reason==='readOnlyMode'?'readOnly':state.reason==='commandBusy'?'busy':'unavailable',id)
  if(current.instanceId!==anchor.instanceId||current.documentId!==anchor.documentId||entry.definition.selectionSensitive!==false&&(entry.definition.access??'write')==='write'&&current.selection.anchor!==anchor.selection.anchor)throw new CommandError('selectionChanged',id)
  return current
 }
 execute=(id:string,input?:unknown)=>this.run(id,input,[],this.context(),this.lifetime.signal)
 /** Stage one content transaction; only the successful outer invocation commits it.
  * An async host callback never deletes a trigger before its outcome is known. */
 executeInsertion(id:string,target:SlashTarget,signal?:AbortSignal){return this.executeTarget(id,target,'slash',signal)}
 executeBlock(id:string,target:BlockTarget,signal?:AbortSignal){return this.executeTarget(id,target,target.intent==='operate'?'block':'slash',signal)}
 private async executeTarget(id:string,target:ContentTarget,surface:CommandSurface,cancellation?:AbortSignal){
  const anchor=this.context(),signal=cancellation?AbortSignal.any([this.lifetime.signal,cancellation]):this.lifetime.signal,entry=this.entries.get(id)
  if(!entry?.definition.surfaces?.includes(surface))throw new CommandError('unavailable',id)
  if(anchor.selection.anchor!==target.anchor)throw new CommandError('selectionChanged',id)
  const placement={target:Object.freeze({...target}),commit:null as (()=>boolean)|null,active:true}
  try{
   const result=await this.run(id,undefined,[],anchor,signal,placement)
   if(this.closed||signal.aborted)throw new CommandError('disposed',id)
   this.check(entry,anchor)
   if(result===false)return false
   if(!placement.commit)return 'kind'in target&&target.intent==='operate'
   return placement.commit()
  }finally{placement.active=false}
 }

 private async run(id:string,input:unknown,stack:readonly Entry[],anchor:Readonly<CommandContext>,signal:AbortSignal,insertion?:{target:ContentTarget;commit:(()=>boolean)|null;active:boolean}):Promise<unknown>{
  if(this.closed||signal.aborted||insertion&&!insertion.active)throw new CommandError('disposed',id)
  if(stack.some(parent=>parent.definition.id===id))throw new CommandError('cycle',id)
  const entry=this.entries.get(id);if(!entry)throw new CommandError('unavailable',id)
  const command=entry.definition,current=this.check(entry,anchor)
  const owner=Symbol(id);this.running.set(id,owner);this.changed()
  try{
   const placement:InsertionStage|undefined=insertion?{target:insertion.target,stage:commit=>{
    if(!insertion.active)throw new CommandError('disposed',id)
    if(insertion.commit)throw new CommandError('configuration',id,'An insertion must stage exactly one content transaction')
    insertion.commit=()=>{if(this.closed||signal.aborted)throw new CommandError('disposed',id);for(const origin of [...stack,entry])this.check(origin,anchor);return commit()}
   }}:undefined
   const result=command.execute?await command.execute({context:current,signal,commands:{run:(target,args)=>this.run(target,args,[...stack,entry],anchor,signal,insertion)}},input):await this.adapter(id,input,signal,placement)
   if(this.closed||signal.aborted)throw new CommandError('disposed',id)
   return result
  }finally{if(this.running.get(id)===owner)this.running.delete(id);this.changed()}
 }
 handleKey(event:KeyEvent,scope:'editor'|'input'='editor',beforeRun?:(id:string)=>void){
  if(event.defaultPrevented)return false
  const context=this.context(),key=eventKey(event);if(!key)return false
  const entry=[...this.entries.values()].find(({definition:command})=>command.profiles?.includes(context.profile)&&this.shortcuts(command).some(shortcut=>shortcutKey(shortcut,context.platform)===key))
  if(!entry||scope==='input'&&entry.definition.shortcutScope!=='workspace')return false
  beforeRun?.(entry.definition.id)
  // Disabled registered bindings are consumed, so browser/editor fallbacks
  // cannot perform a different operation under the same key.
  if(this.state(entry,context).enabled)void this.execute(entry.definition.id).catch(error=>this.configuration.onError?.(error))
  return true
 }
}
