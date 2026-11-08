import {panelTarget,toggleInput,zoomInput} from './commands/workspace.ts'
import type {CommandContext} from './commands/types.ts'

export type WordWorkspacePanel='images'|'properties'|'nodes'|'collaboration'|'deletions'
export type WordWorkspaceView={navigation:boolean;panel:WordWorkspacePanel|null;zoom:number}
type WordWorkspaceSetters={navigation:(update:(current:boolean)=>boolean)=>void;panel:(update:(current:WordWorkspacePanel|null)=>WordWorkspacePanel|null)=>void;zoom:(value:number)=>void}
/** Paper zoom uses the same bounded numeric input as fixed-layout canvases.
 * The command envelope remains {percent}, including calls from host menus. */
export const wordWorkspaceZoom={min:25,max:200,step:1} as const
export function wordWorkspaceCommand(id:string,input:unknown,set:WordWorkspaceSetters,customNode=false):boolean{
 if(id==='view.navigation'){const desired=input===undefined?undefined:toggleInput(id,input,false);set.navigation(current=>desired??!current);return true}
 if(id==='view.zoom.set'){set.zoom(zoomInput(input,'fixed'));return true}
 if(id==='view.actualSize'){set.zoom(100);return true}
 if(id==='view.panel.close'){set.panel(()=>null);return true}
 if(id==='view.properties'||id==='view.images'||id==='view.collaboration'){
  const target:WordWorkspacePanel=id==='view.collaboration'?'collaboration':id==='view.properties'&&customNode?'properties':'images'
  const desired=input===undefined?undefined:toggleInput(id,input,false)
  set.panel(current=>panelTarget(desired,current,target,id==='view.properties'?['images','properties']:[]));return true
 }
 return false
}
export function wordWorkspaceActions(view:WordWorkspaceView):CommandContext['actions']{
 return{'view.navigation':{enabled:true,active:view.navigation},'view.properties':{enabled:true,active:view.panel==='images'||view.panel==='properties'},'view.images':{enabled:true,active:view.panel==='images'},'view.collaboration':{enabled:true,active:view.panel==='collaboration'},'view.panel.close':{enabled:view.panel!==null},'view.actualSize':{enabled:true,active:view.zoom===100},'view.zoom.set':{enabled:true}}
}
