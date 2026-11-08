import type {NodeExtensions,NodeExtensionService} from '../src/extensionTypes.ts'
import {nodePortableFixture} from './nodePortable.ts'

/** Owned preview controls use only the public host registration API. They do
 * not inspect or mutate editor/CRDT state and are never part of the product UI. */
export function createNodeHistoryFixture():NodeExtensions{
 return{onError:error=>console.error(error),onReady:(service:NodeExtensionService)=>{
  const panel=document.createElement('aside'),unload=document.createElement('button'),load=document.createElement('button'),status=document.createElement('span');panel.setAttribute('aria-label','扩展加载验证');panel.style.cssText='position:fixed;z-index:500;top:6px;left:230px;display:flex;gap:5px;align-items:center;padding:3px 6px;background:#fff;border:1px solid #ccd6e5;border-radius:4px;font:11px system-ui';unload.textContent='卸载业务扩展';load.textContent='加载业务扩展';unload.type=load.type='button';status.setAttribute('role','status');let release:(()=>void)|undefined
  const paint=()=>{unload.disabled=!release;load.disabled=!!release;status.textContent=release?'业务扩展已加载':'业务扩展已卸载'}
  const register=()=>{if(!release)release=service.register(nodePortableFixture);paint()},unregister=()=>{release?.();release=undefined;paint()}
  unload.addEventListener('click',unregister);load.addEventListener('click',register);register();panel.append(unload,load,status);document.body.append(panel)
  return()=>{release?.();release=undefined;unload.removeEventListener('click',unregister);load.removeEventListener('click',register);panel.remove()}
 }}
}
