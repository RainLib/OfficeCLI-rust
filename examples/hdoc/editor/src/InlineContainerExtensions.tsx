import {createContext,useContext,useEffect,useMemo,useRef,useSyncExternalStore,type ReactNode} from 'react'
import {InlineContainerRegistry,type InlineContainerExtensions} from './inlineContainerRegistry.ts'
import {useI18n} from './i18n.tsx'
const fallback=new InlineContainerRegistry()
const Context=createContext(fallback)
/** Registration never grants model support. The room and command context must
 * also explicitly confirm inline containers before any insert can run. */
export function InlineContainerExtensionsProvider({value,children}:{value?:InlineContainerExtensions;children:ReactNode}){
 const {t}=useI18n(),latest=useRef(value);latest.current=value
 const state=useMemo(()=>{const report=(error:Error)=>latest.current?.onError?.(error);try{return{registry:new InlineContainerRegistry(value?.nodes,report),error:null}}catch(error){return{registry:new InlineContainerRegistry([],report),error:error instanceof Error?error:new Error(String(error))}}},[value?.nodes])
 useEffect(()=>state.registry.connect(),[state.registry])
 useEffect(()=>{let cleanup:void|(()=>void);try{if(state.error)state.registry.error(state.error);cleanup=latest.current?.onReady?.(state.registry);if(cleanup!==undefined&&typeof cleanup!=='function')throw new Error('nodeExtensionCleanup')}catch(error){state.registry.error(error)}return()=>{try{cleanup?.()}catch(error){state.registry.error(error)}}},[state])
 return <Context.Provider value={state.registry}>{state.error&&<p role="alert" className="error">{t('nodeExtensionConfigurationError')}</p>}{children}</Context.Provider>
}
export function useInlineContainerExtensions(){const registry=useContext(Context);useSyncExternalStore(registry.subscribe,registry.snapshot,registry.snapshot);return registry}
