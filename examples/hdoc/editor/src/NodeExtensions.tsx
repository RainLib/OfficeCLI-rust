import {archiveNodeResource,readNodeResource,type Session} from './api.ts'
import {useI18n} from './i18n.tsx'
import {createContext,useContext,useEffect,useMemo,useRef,useSyncExternalStore,type ReactNode} from 'react'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import type {NodeExtensions} from './extensionTypes.ts'
import {sameResourceSession} from './semanticImageScope.ts'
import {builtinWordNodes} from './wordNumericField.ts'
const fallback=new NodeExtensionRegistry()
const Context=createContext(fallback)
export function NodeExtensionsProvider({value,children,session}:{value?:NodeExtensions;children:ReactNode;session?:Session}){
 const {t}=useI18n()
 const latest=useRef(value);latest.current=value
 const latestSession=useRef(session);latestSession.current=session
 const state=useMemo(()=>{const bound=session&&{...session};const current=()=>{const next=latestSession.current;if(!bound||!next||bound.scope!==next.scope||!sameResourceSession(bound,next))throw new Error('nodeResourcesUnavailable');return next}
  try{return{registry:new NodeExtensionRegistry([...builtinWordNodes(session),...(value?.nodes??[])],error=>latest.current?.onError?.(error),bound?{archive:input=>archiveNodeResource(current(),input),read:(resource,revision,signal)=>readNodeResource(current(),resource,revision,signal)}:undefined,value?.marks),error:null}}catch(error){return{registry:new NodeExtensionRegistry([],cause=>latest.current?.onError?.(cause)),error:error instanceof Error?error:new Error(String(error))}}
 },[value?.nodes,value?.marks,!!session,session?.documentId,session?.userId,session?.scope,session?.apiUrl,session?.collabUrl,session?.collaborationEpoch,session?.collaborationProtocol,session?.flowLayoutVersion,session?.format,session?.wordNumericFields])
 useEffect(()=>state.registry.connect(),[state.registry])
 useEffect(()=>{let cleanup:void|(()=>void);try{if(state.error)latest.current?.onError?.(state.error);cleanup=latest.current?.onReady?.(state.registry);if(cleanup!==undefined&&typeof cleanup!=='function')throw new Error('nodeExtensionCleanup')}catch(error){state.registry.error(error)}return()=>{try{cleanup?.()}catch(error){state.registry.error(error)}}},[state])
 return <Context.Provider value={state.registry}>{state.error&&<p role="alert" className="error">{t('nodeExtensionConfigurationError')}</p>}{children}</Context.Provider>
}
export function useNodeExtensions(){const registry=useContext(Context);useSyncExternalStore(registry.subscribe,registry.snapshot,registry.snapshot);return registry}
