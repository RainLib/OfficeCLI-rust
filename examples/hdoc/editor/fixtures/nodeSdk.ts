import type {NodeExtensionDefinition} from '../src/extensionTypes.ts'
const task:NodeExtensionDefinition={
 type:'example.task',version:1,display:'inline',label:{'en-US':'Task badge','zh-CN':'任务标记','zh-TW':'任務標記'},icon:'☑',
 defaultData:{title:'审核任务',done:false,priority:1},
 validate:data=>typeof data.title==='string'&&data.title.length>0&&typeof data.done==='boolean'&&(data.priority===undefined||typeof data.priority==='number'&&Number.isInteger(data.priority)&&data.priority>=1&&data.priority<=5),
 fallback:data=>`${data.done?'☑':'☐'} ${data.title}`,
 properties:[{key:'title',label:{'en-US':'Task title','zh-CN':'任务名称','zh-TW':'任務名稱'},kind:'text',required:true,maxLength:120},{key:'done',label:{'en-US':'Completed','zh-CN':'已完成','zh-TW':'已完成'},kind:'boolean',required:true},{key:'priority',label:{'en-US':'Priority','zh-CN':'优先级','zh-TW':'優先順序'},kind:'number',min:1,max:5}],
 mountView:(element,{node,readOnly})=>{const label=document.createElement('span');label.textContent=node.fallback.text;label.style.cssText='background:#e8f1ff;color:#245ea8;padding:2px 6px;border-radius:4px';element.replaceChildren(label);element.dataset.customView='task';element.setAttribute('aria-readonly',String(readOnly));return()=>{delete element.dataset.customView}},
}
export const nodeSdkFixture:readonly NodeExtensionDefinition[]=[task,{...task,type:'example.notice',display:'block',label:{'en-US':'Notice block','zh-CN':'提示块','zh-TW':'提示區塊'},defaultData:{title:'团队提示',done:false},properties:[{key:'title',label:{'en-US':'Notice text','zh-CN':'提示内容','zh-TW':'提示內容'},kind:'text',required:true,maxLength:500},{key:'done',label:{'en-US':'Confirmed','zh-CN':'已确认','zh-TW':'已確認'},kind:'boolean',required:true}]}]
