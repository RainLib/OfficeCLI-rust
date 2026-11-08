import type {WorkbookViewport} from './workbookViewport.ts'

/** Awareness contains view coordinates only, never cell content. */
export const workbookPresenceField='hcdWorkbookViewport'
export type WorkbookPresence={version:1;sheetId:string;row:number;column:number;selection?:{row:number;column:number;height:number;width:number};following?:number}
const coordinate=(value:unknown,limit:number):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<limit
export function readWorkbookPresence(input:unknown):WorkbookPresence|null{
 if(!input||typeof input!=='object')return null
 const value=input as WorkbookPresence
 if(value.version!==1||typeof value.sheetId!=='string'||!value.sheetId||value.sheetId.length>128||!coordinate(value.row,1_048_576)||!coordinate(value.column,16_384))return null
 if(value.following!==undefined&&!coordinate(value.following,Number.MAX_SAFE_INTEGER))return null
 const selected=value.selection
 if(selected!==undefined&&(!selected||typeof selected!=='object'||!coordinate(selected.row,1_048_576)||!coordinate(selected.column,16_384)||!Number.isSafeInteger(selected.height)||selected.height<1||selected.row+selected.height>1_048_576||!Number.isSafeInteger(selected.width)||selected.width<1||selected.column+selected.width>16_384))return null
 return {version:1,sheetId:value.sheetId,row:value.row,column:value.column,...(selected?{selection:{row:selected.row,column:selected.column,height:selected.height,width:selected.width}}:{}),...(value.following===undefined?{}:{following:value.following})}
}
export function workbookPresence(viewport:WorkbookViewport,following:number|null):WorkbookPresence|null{
 return readWorkbookPresence({version:1,sheetId:viewport.sheetId,row:viewport.row,column:viewport.column,selection:viewport.selection,...(following===null?{}:{following})})
}
export function workbookFollowCycle(peers:ReadonlyArray<{clientId:number;workbook?:WorkbookPresence}>,local:number,target:number){
 const states=new Map(peers.map(peer=>[peer.clientId,peer.workbook])),seen=new Set([local]);let current:number|undefined=target
 while(current!==undefined){if(seen.has(current))return true;seen.add(current);current=states.get(current)?.following}
 return false
}
