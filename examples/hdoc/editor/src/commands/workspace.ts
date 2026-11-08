import type {EditorCommand} from './types.ts'
import {CommandError} from './registry.ts'

const read={access:'read',ready:false,selectionSensitive:false,shortcutScope:'workspace',profiles:['flow','fixed']} as const
const view={...read,group:'panels',surfaces:['ribbon','palette'],tabs:['view']} as const
/** These actions change local UI only. Hosts can compose them without granting edit access. */
export const workspaceCommands:readonly EditorCommand[]=[
 {...read,id:'file.recovery',labelKey:'recoveryArchiveTitle',icon:'▣',group:'file',order:12,profiles:['flow'],surfaces:['ribbon','palette'],tabs:['export','revisions'],canExecute:context=>context.capabilities.recoveryFiles===true},
 {...view,id:'view.properties',labelKey:'properties',icon:'panel',order:120},
 {...view,profiles:['flow','fixed','sheet'],id:'view.collaboration',labelKey:'onlineCollaborators',icon:'◉',order:121,aliases:['collaboration','协同','協同','follow','跟随']},
 {...view,id:'view.navigation',labelKey:'navigationPanel',icon:'slides',order:122,aliases:['outline','thumbnails','大纲','大綱','缩略图','縮圖']},
 {...view,id:'view.settings',labelKey:'settings',icon:'⚙',order:123,profiles:['flow']},
 {...view,id:'view.readOnly',labelKey:'readOnlyMode',icon:'◇',order:124,profiles:['flow']},
 {...view,id:'view.actualSize',labelKey:'actualSize',icon:'fit',group:'zoom',order:130},
 {...view,id:'view.fit',labelKey:'fitWindow',icon:'fit',group:'zoom',order:131,profiles:['fixed']},
 {...view,id:'view.focus',labelKey:'focusView',icon:'focus',group:'zoom',order:132,profiles:['fixed']},
 {...read,id:'view.zoom.set',labelKey:'zoom',surfaces:[]},
 {...read,profiles:['flow','fixed','sheet'],id:'view.panel.close',labelKey:'hidePanel',surfaces:[]},
 {...read,id:'revision.history',labelKey:'viewHistory',icon:'◷',group:'revisions',order:140,profiles:['flow'],surfaces:['ribbon','palette'],tabs:['revisions']},
 {...read,id:'revision.save',labelKey:'saveCurrentVersion',icon:'save',group:'revisions',order:139,profiles:['flow'],surfaces:['ribbon','palette'],tabs:['revisions'],requires:['file.save']},
 {...read,id:'revision.localCopies',labelKey:'recoveryCopies',icon:'▣',group:'revisions',order:141,profiles:['flow'],surfaces:['ribbon','palette'],tabs:['revisions']},
 {...read,id:'revision.open',labelKey:'viewRevision',profiles:['flow'],surfaces:[]},
 {...read,id:'revision.current',labelKey:'returnToEditing',profiles:['flow'],surfaces:['palette']},
 {...read,id:'revision.restore.review',labelKey:'restoreRevision',profiles:['flow'],surfaces:['palette']},
]

function object(id:string,input:unknown):Record<string,unknown>{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new CommandError('unavailable',id,'Invalid command input')
 return input as Record<string,unknown>
}
/** No implicit string/number conversion: external menus must provide a real boolean. */
export function toggleInput(id:string,input:unknown,current:boolean):boolean{
 if(input===undefined)return !current
 const value=object(id,input).enabled
 if(typeof value!=='boolean')throw new CommandError('unavailable',id,'Invalid toggle input')
 return value
}
/** An explicit hide is idempotent and must not close a different panel. */
export function panelTarget<P extends string>(desired:boolean|undefined,current:P|null,target:P,aliases:readonly P[]=[]):P|null{
 const active=current===target||current!==null&&aliases.includes(current)
 return (desired??!active)?active?current:target:active?null:current
}
export function zoomInput(input:unknown,profile:'flow'|'fixed'):number{
 const value=object('view.zoom.set',input).percent,min=profile==='flow'?70:25,max=profile==='flow'?150:200,step=profile==='flow'?5:1
 if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||value%step!==0)throw new CommandError('unavailable','view.zoom.set','Invalid zoom')
 return value
}
export function revisionInput(input:unknown,head:number|null):number{
 const value=object('revision.open',input).revision
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||head===null||value>head)throw new CommandError('unavailable','revision.open','Invalid revision')
 return value
}
