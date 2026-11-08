import type {NodeExtensionDefinition} from '../src/extensionTypes.ts'
const task:NodeExtensionDefinition={
 type:'example.task',version:2,display:'inline',label:{'en-US':'Task badge','zh-CN':'任务标记','zh-TW':'任務標記'},icon:'☑',
 defaultData:{caption:'审核任务',done:false,priority:1},
 validate:data=>typeof data.caption==='string'&&data.caption.trim().length>0&&typeof data.done==='boolean'&&typeof data.priority==='number'&&Number.isInteger(data.priority)&&data.priority>=1&&data.priority<=5,
 fallback:data=>`${data.done?'☑':'☐'} ${data.caption} · 优先级 ${data.priority}`,
 properties:[{key:'caption',label:{'en-US':'Task title','zh-CN':'任务名称','zh-TW':'任務名稱'},kind:'text',required:true,maxLength:120},{key:'done',label:{'en-US':'Completed','zh-CN':'已完成','zh-TW':'已完成'},kind:'boolean',required:true},{key:'priority',label:{'en-US':'Priority','zh-CN':'优先级','zh-TW':'優先順序'},kind:'number',min:1,max:5}],
 migrations:[{fromVersion:1,validate:data=>typeof data.title==='string'&&typeof data.done==='boolean',migrate:({title,...data})=>({...data,caption:title,priority:data.priority??1})}],
}
export const nodeMigrationsFixture:readonly NodeExtensionDefinition[]=[task,{...task,type:'example.notice',display:'block',label:{'en-US':'Notice block','zh-CN':'提示块','zh-TW':'提示區塊'},defaultData:{caption:'团队提示',done:false,priority:1}}]
