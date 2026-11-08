import {useAiConfiguration} from '../ai/react.tsx'
import {useNodeExtensions} from '../NodeExtensions.tsx'
import {useInlineContainerExtensions} from '../InlineContainerExtensions.tsx'
import type {BlockTarget} from './blocks.ts'
import type {InsertionStage,SlashTarget} from './insertion.ts'
import {createContext,useContext,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {EditorIcon,isEditorIcon} from '../EditorIcon.tsx'
import {useI18n,type MessageKey} from '../i18n.tsx'
import {workspaceCommands} from './workspace.ts'
import {builtinCommands} from './builtins.ts'
import {CommandError,CommandRegistry} from './registry.ts'
import {displayShortcut} from './keymap.ts'
import type {CommandContext,CommandExtensions,CommandItem,CommandSurface} from './types.ts'
const empty:CommandExtensions=Object.freeze({})
const Extensions=createContext<CommandExtensions>(empty)
export function CommandExtensionsProvider({value,children}:{value?:CommandExtensions;children:ReactNode}){return <Extensions.Provider value={value??empty}>{children}</Extensions.Provider>}
export function useCommands(getContext:(instance:string)=>CommandContext,adapter:(id:string,input:unknown,signal:AbortSignal,insertion?:InsertionStage)=>unknown|Promise<unknown>,onError:(error:unknown)=>void){
 const ai=useAiConfiguration(),extensions=useContext(Extensions),nodes=useNodeExtensions(),inline=useInlineContainerExtensions(),nodeVersion=nodes.commandSnapshot(),inlineVersion=inline.commandSnapshot(),{t}=useI18n(),instance=useId()
 const latest=useRef({getContext,adapter,onError,extensions,t});latest.current={getContext,adapter,onError,extensions,t}
 const state=useMemo(()=>{
  const report=(error:unknown)=>{latest.current.onError(error);latest.current.extensions.onError?.(error instanceof Error?error:new Error(String(error)))}
  const make=(configuration:CommandExtensions)=>new CommandRegistry(()=>latest.current.getContext(instance),(id,input,signal,insertion)=>latest.current.adapter(id,input,signal,insertion),builtinCommands,{...configuration,onError:report},key=>latest.current.t(key as MessageKey))
  try{return{registry:make({...extensions,commands:[...nodes.commands(),...inline.commands(),...ai.commands,...(extensions.commands??[])]}),error:null}}
  catch(error){return{registry:make({}),error:error instanceof Error?error:new Error(String(error))}}
 },[instance,extensions.commands,extensions.menuOverrides,extensions.keymap,nodes,nodeVersion,inline,inlineVersion,ai])
 useSyncExternalStore(state.registry.subscribe,state.registry.snapshot)
 useEffect(()=>state.registry.connect(),[state.registry])
 useLayoutEffect(()=>state.registry.refresh())
 useEffect(()=>{if(state.error)latest.current.extensions.onError?.(state.error);return latest.current.extensions.onReady?.(state.registry)},[state.registry,state.error])
 const run=(id:string,input?:unknown)=>{void state.registry.execute(id,input).catch(error=>{latest.current.onError(error);latest.current.extensions.onError?.(error instanceof Error?error:new Error(String(error)))})}
 const insert=(id:string,target:SlashTarget,signal?:AbortSignal)=>state.registry.executeInsertion(id,target,signal).catch(error=>{if(signal?.aborted)return false;latest.current.onError(error);latest.current.extensions.onError?.(error instanceof Error?error:new Error(String(error)));return false})
 const block=(id:string,target:BlockTarget,signal?:AbortSignal)=>state.registry.executeBlock(id,target,signal).catch(error=>{if(signal?.aborted)return false;latest.current.onError(error);latest.current.extensions.onError?.(error instanceof Error?error:new Error(String(error)));return false})
 return{...state,run,insert,block}
}
export function CommandButton({item,run,platform,className='',iconOnly=false,children,disclosure=false}:{item:CommandItem;run:(id:string,input?:unknown)=>void;platform:'mac'|'other';className?:string;iconOnly?:boolean;children?:ReactNode;disclosure?:boolean}){
 const {t}=useI18n(),shortcut=item.shortcuts.map(key=>displayShortcut(key,platform)).join(' / ')
 const title=[item.label,shortcut,item.reason?t(item.reason as MessageKey):''].filter(Boolean).join(' · ')
 if(item.control==='color')return <label className="word-color-picker" title={title}><span aria-hidden="true">A</span><input type="color" aria-label={item.label} defaultValue={item.initialValue??'#1f2328'} disabled={!item.enabled} onChange={event=>run(item.id,{color:event.target.value})}/></label>
 return <button type="button" data-command-id={item.id} className={`${className} ${item.presentation==='large'?'presentation-ribbon-tool':''} ${item.id.startsWith('text.')?'command-'+item.id.replaceAll('.','-'):''}`} disabled={!item.enabled} aria-label={item.label} title={title} aria-expanded={disclosure?item.active:undefined} aria-pressed={disclosure?undefined:item.active} onMouseDown={event=>event.preventDefault()} onClick={()=>run(item.id)}>
  {children??<>{item.icon&&(isEditorIcon(item.icon)?<EditorIcon name={item.icon}/>:<span className="command-symbol" aria-hidden="true">{item.icon}</span>)}{(!iconOnly||!item.icon)&&<span>{item.label}</span>}</>}
 </button>
}
export function CommandAction({registry,id,...props}:{registry:CommandRegistry;id:string;run:(id:string,input?:unknown)=>void;className?:string;iconOnly?:boolean;children?:ReactNode;disclosure?:boolean}){
 const item=registry.item(id)
 return item?<CommandButton {...props} item={item} platform={registry.context().platform}/>:null
}
const groupKeys:Record<string,MessageKey>={wordStories:'wordHeaderFooter',file:'document',history:'editHistory',style:'styles',format:'formatting',paragraph:'paragraph',arrange:'arrange',insert:'insert',extensions:'commandExtensions',ai:'aiAssistant',panels:'panels',zoom:'zoom',revisions:'revisions'}
export function CommandRibbon({registry,run,tab,customOnly=false,workspaceViews=false}:{registry:CommandRegistry;run:(id:string,input?:unknown)=>void;tab:string;customOnly?:boolean;workspaceViews?:boolean}){
 const {t}=useI18n(),platform=registry.context().platform,groups=new Map<string,CommandItem[]>()
 for(const item of registry.list('ribbon','',tab)){
  if(customOnly&&item.builtin&&item.id!=='editor.palette'&&!(workspaceViews&&workspaceCommands.some(command=>command.id===item.id)))continue
  const group=groups.get(item.group)??[];group.push(item);groups.set(item.group,group)
 }
 return <>{[...groups].map(([id,items])=><div key={id} className={`word-tool-group command-ribbon-group command-group-${id.replace(/[^\w-]/g,'')} ${id==='file'?'presentation-tool-group presentation-file-actions':''}`}>
  <div className="command-group-items">{items.map(item=><CommandButton key={item.id} item={item} run={run} platform={platform} iconOnly={id==='format'}/>)}</div><span className="word-tool-caption">{items.find(item=>item.groupLabel)?.groupLabel??t(groupKeys[id]??'commandExtensions')}</span>
 </div>)}</>
}
export function CommandBubble({registry,run}:{registry:CommandRegistry;run:(id:string,input?:unknown)=>void}){const platform=registry.context().platform;return <>{registry.list('bubble').map(item=><CommandButton key={item.id} item={item} run={run} platform={platform} iconOnly/>)}</>}
export function CommandPalette({registry,run,onClose}:{registry:CommandRegistry;run:(id:string,input?:unknown)=>void;onClose:()=>void}){
 const {t}=useI18n(),id=useId(),input=useRef<HTMLInputElement>(null),root=useRef<HTMLDivElement>(null),restore=useRef(true),previous=useRef<Element|null>(null)
 const [query,setQuery]=useState(''),[selected,setSelected]=useState(0),items=registry.list('palette',query),active=Math.min(selected,Math.max(0,items.length-1)),platform=registry.context().platform
 useEffect(()=>{
  previous.current=document.activeElement
  const containFocus=(event:FocusEvent)=>{if(root.current&&event.target instanceof Node&&!root.current.contains(event.target))input.current?.focus()}
  document.addEventListener('focusin',containFocus);input.current?.focus()
  return()=>{document.removeEventListener('focusin',containFocus);if(restore.current&&previous.current instanceof HTMLElement&&previous.current.isConnected)previous.current.focus()}
 },[])
 useEffect(()=>{root.current?.querySelector(`[data-command-option="${active}"]`)?.scrollIntoView({block:'nearest'})},[active,query])
 const choose=(item:CommandItem|undefined)=>{if(!item?.enabled)return;restore.current=false;run(item.id);onClose();queueMicrotask(()=>{if(document.activeElement===document.body&&previous.current instanceof HTMLElement&&previous.current.isConnected)previous.current.focus()})}
 return <div className="hcd-command-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
  <div ref={root} className="hcd-command-palette" role="dialog" aria-modal="true" aria-label={t('commandPalette')} onKeyDown={event=>{
   if(event.nativeEvent.isComposing||event.keyCode===229)return
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose()}
   else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setSelected((active+(event.key==='ArrowDown'?1:-1)+items.length)%Math.max(1,items.length))}
   else if(event.key==='Home'&&event.ctrlKey){event.preventDefault();setSelected(0)}
   else if(event.key==='End'&&event.ctrlKey){event.preventDefault();setSelected(items.length-1)}
   else if(event.key==='Enter'){event.preventDefault();choose(items[active])}
   else if(event.key==='Tab'){const focusable=[...(root.current?.querySelectorAll<HTMLElement>('input,button')??[])].filter(node=>node.tabIndex>=0&&!node.hasAttribute('disabled'));if(focusable.length){event.preventDefault();const index=focusable.indexOf(document.activeElement as HTMLElement);focusable[(index+(event.shiftKey?-1:1)+focusable.length)%focusable.length].focus()}}
  }}>
   <div className="hcd-command-search"><input ref={input} role="combobox" aria-expanded="true" aria-controls={`${id}-results`} aria-activedescendant={items.length?`${id}-${active}`:undefined} autoComplete="off" aria-label={t('commandSearch')} placeholder={t('commandSearch')} value={query} onChange={event=>{setQuery(event.target.value);setSelected(0)}}/><button type="button" aria-label={t('close')} onClick={onClose}>×</button></div>
   <div id={`${id}-results`} role="listbox" aria-label={t('commandResults')} className="hcd-command-results">{items.map((item,index)=><button key={item.id} id={`${id}-${index}`} data-command-option={index} type="button" role="option" aria-selected={index===active} aria-disabled={!item.enabled} tabIndex={-1} onMouseMove={()=>setSelected(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(item)}>
    <span><strong>{item.label}</strong>{item.description&&<small>{item.description}</small>}{!item.enabled&&<small>{t((item.reason??'commandUnavailable') as MessageKey)}</small>}</span><kbd>{item.shortcuts.map(key=>displayShortcut(key,platform)).join(' / ')}</kbd>
   </button>)}{!items.length&&<p role="status">{t('commandNoResults')}</p>}</div><div className="hcd-command-hint">{t('commandKeyboardHint')}</div>
  </div>
 </div>
}
export function commandMessage(error:unknown):MessageKey|null{if(!(error instanceof CommandError))return null;return error.code==='selectionChanged'?'commandSelectionChanged':error.code==='readOnly'?'readOnlyMode':error.code==='busy'?'commandBusy':error.code==='disposed'?'commandCancelled':'commandUnavailable'}
