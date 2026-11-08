import {createContext,useContext,useEffect,useMemo,useRef,type ReactNode} from 'react'
import type {AiAction,AiExtensions,AiProvider} from './types.ts'
import type {EditorCommand} from '../commands/types.ts'
import {autocompletePolicy,type AutocompletePolicy} from './autocomplete.ts'
import {AiError} from './core.ts'
import {useI18n} from '../i18n.tsx'
const defaults:readonly AiAction[]=Object.freeze([
 Object.freeze({id:'rewrite',label:Object.freeze({'en-US':'Rewrite selection','zh-CN':'AI 改写选区','zh-TW':'AI 改寫選取內容','zh-HK':'AI 改寫選取內容'}),mode:'replace',instruction:'Rewrite the selected text clearly, preserving its meaning and language. Return only the replacement text.'}),
 Object.freeze({id:'continue',label:Object.freeze({'en-US':'Continue writing','zh-CN':'AI 续写','zh-TW':'AI 續寫','zh-HK':'AI 續寫'}),mode:'insert',instruction:'Continue the text at the cursor in the same language and style. Return only new text, without repeating the context.'}),
])
export type AiConfiguration={provider?:AiProvider;actions:readonly AiAction[];autocomplete:AutocompletePolicy;options:Pick<AiExtensions,'limits'|'onAccepted'|'onError'>;commands:readonly EditorCommand[]}
const empty:AiConfiguration={autocomplete:autocompletePolicy(false),actions:defaults,options:{},commands:[]}
const Context=createContext<AiConfiguration>(empty)
export function AiExtensionsProvider({value,children}:{value?:AiExtensions;children:ReactNode}){
 const {t}=useI18n(),latest=useRef(value);latest.current=value
 const autoSettings=value?.autocomplete||undefined
 const result=useMemo(()=>{
  try{
   const autocomplete=autocompletePolicy(value?.autocomplete)
   const actions=(value?.actions??defaults).map(action=>{
    if(!/^[a-z][a-z0-9_.-]{0,63}$/.test(action.id)||!['replace','insert'].includes(action.mode)||action.instruction!==undefined&&(typeof action.instruction!=='string'||action.instruction.length>2000))throw new AiError('protocol')
    const label=typeof action.label==='string'?action.label:Object.freeze({...action.label})
    if(!label||Object.values(typeof label==='string'?{label}:label).some(text=>typeof text!=='string'||!text.length||text.length>120))throw new AiError('protocol')
    return Object.freeze({...action,label,aliases:action.aliases?Object.freeze([...action.aliases]):undefined})
   })
   if(actions.length>32||new Set(actions.map(action=>action.id)).size!==actions.length)throw new AiError('limit')
   const limits=Object.freeze({...value?.limits})
   for(const [key,min,max]of [['timeoutMs',10,600000],['maxOutput',1,100000],['maxEvents',1,100000]]as const){const n=limits[key];if(n!==undefined&&(!Number.isSafeInteger(n)||n<min||n>max))throw new AiError('limit')}
   const provider=value?.provider,generate=provider?.generate
   if(provider&&typeof generate!=='function')throw new AiError('protocol')
   const commands:EditorCommand[]=actions.map((action,index)=>({id:`ai.action.${action.id}`,label:action.label,icon:'✦',group:'ai',order:110+index,profiles:['flow'],tabs:['home','insert'],surfaces:action.mode==='replace'?['ribbon','context','bubble','palette']:['ribbon','context','palette'],canExecute:context=>context.capabilities.ai===true&&context.actions[`ai.${action.mode}`]?.enabled===true,aliases:action.aliases,execute:({commands})=>commands.run('ai.request',{actionId:action.id})}))
   return{configuration:{autocomplete,provider:provider&&generate?Object.freeze({generate:(request,options)=>generate.call(provider,request,options)}) as AiProvider:undefined,actions:Object.freeze(actions),commands:Object.freeze(commands),options:{limits,onAccepted:event=>latest.current?.onAccepted?.(event),onError:code=>latest.current?.onError?.(code)}} as AiConfiguration,error:false}
  }catch{return{configuration:empty,error:true}}
 },[value?.provider,value?.actions,value?.limits?.timeoutMs,value?.limits?.maxOutput,value?.limits?.maxEvents,value?.autocomplete===false,autoSettings?.enabled,autoSettings?.delayMs,autoSettings?.cooldownMs,autoSettings?.minPrefix,autoSettings?.maxOutput,autoSettings?.instruction])
 useEffect(()=>{if(result.error){try{latest.current?.onError?.('protocol')}catch{}}},[result.error])
 return <Context.Provider value={result.configuration}>{result.error&&<p role="alert" className="error">{t('aiConfigurationError')}</p>}{children}</Context.Provider>
}
export function useAiConfiguration(){return useContext(Context)}
export function aiActionLabel(action:AiAction,locale:string){return typeof action.label==='string'?action.label:action.label[locale]??action.label[locale==='zh-TW'||locale==='zh-HK'?'zh-TW':locale.startsWith('zh')?'zh-CN':'en-US']??Object.values(action.label)[0]??action.id}
