import type {CustomMarkDefinition,NodeExtensions,NodeExtensionService} from '../src/extensionTypes.ts'
export const customMarkFixture:readonly CustomMarkDefinition[]=[
 {type:'example.review',version:1,label:{'zh-CN':'需复核','en-US':'Review'},icon:'R',defaultData:{ticket:'HCD-27'},validate:data=>typeof data.ticket==='string'&&data.ticket.length<64,fallback:data=>({label:`需复核 ${data.ticket}`,style:{bold:true,backgroundColor:'#fff2a8'}})},
 {type:'example.project',version:1,label:{'zh-CN':'项目标记','en-US':'Project'},icon:'P',defaultData:{project:'HCD'},validate:data=>typeof data.project==='string'&&data.project.length<64,fallback:data=>({label:`项目 ${data.project}`,style:{underline:true,textColor:'#246a4b'}})},
]
/** Owned fixture controls exercise only the public registration service. */
export function createCustomMarksFixture():NodeExtensions{return{onReady(service:NodeExtensionService){
 let release:(()=>void)|undefined=service.registerMarks(customMarkFixture)
 const controls=document.createElement('aside'),unload=document.createElement('button'),reload=document.createElement('button');controls.style.cssText='position:fixed;bottom:40px;left:12px;z-index:80;display:flex;gap:6px;background:white;padding:6px;border:1px solid #b4bdca';unload.textContent='卸载文字标记扩展';reload.textContent='重新加载文字标记扩展';unload.type=reload.type='button';reload.disabled=true;controls.append(unload,reload);document.body.append(controls)
 const off=()=>{release?.();release=undefined;unload.disabled=true;reload.disabled=false},on=()=>{if(release)return;release=service.registerMarks(customMarkFixture);unload.disabled=false;reload.disabled=true};unload.addEventListener('click',off);reload.addEventListener('click',on)
 return()=>{release?.();unload.removeEventListener('click',off);reload.removeEventListener('click',on);controls.remove()}
}}}
