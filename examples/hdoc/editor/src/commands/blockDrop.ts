import type {Node as PmNode} from '@tiptap/pm/model'
import {editorBlockEntries,blockEntryScope,type BlockTarget} from './blocks.ts'
export type DropRect={left:number;right:number;top:number;bottom:number}
export type DropRow={from:number;to:number;name:string;rect:DropRect}
export type BlockDrop={row:DropRow;edge:'before'|'after';position:number;allowed:boolean;rect:DropRect;lineTop:number|null}
/** A child move resolves against its own siblings, never the covering outer
 * container. Viewport rectangles already include document zoom and scroll. */
export function blockDropEntries(doc:PmNode,target:BlockTarget){return editorBlockEntries(doc).filter(entry=>{const scope=blockEntryScope(doc,entry);return target.scope?scope?.from===target.scope.from&&scope.instanceId===target.scope.instanceId:!scope})}
const contains=(rect:DropRect,x:number,y:number)=>x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom
export function pickBlockDrop(rows:readonly DropRow[],point:{x:number;y:number},viewport:DropRect,region:DropRect,allowed:readonly number[]):BlockDrop|null{
 if(!contains(viewport,point.x,point.y)||!contains(region,point.x,point.y))return null
 const candidates=rows.filter(row=>Object.values(row.rect).every(Number.isFinite)&&row.rect.bottom>row.rect.top&&row.rect.right>row.rect.left&&point.x>=row.rect.left-56&&point.x<=row.rect.right+24)
 let row:DropRow|undefined,distance=Infinity
 for(const candidate of candidates){const delta=Math.max(candidate.rect.top-point.y,0,point.y-candidate.rect.bottom);if(delta<distance){row=candidate;distance=delta}}
 if(!row)return null
 const edge=point.y<(row.rect.top+row.rect.bottom)/2?'before':'after',position=edge==='before'?row.from:row.to,line=edge==='before'?row.rect.top:row.rect.bottom
 const rect={left:Math.max(row.rect.left,viewport.left),right:Math.min(row.rect.right,viewport.right),top:Math.max(row.rect.top,viewport.top),bottom:Math.min(row.rect.bottom,viewport.bottom)}
 if(rect.right<=rect.left||rect.bottom<=rect.top)return null
 return{row,edge,position,allowed:allowed.includes(position),rect,lineTop:line>=viewport.top&&line<=viewport.bottom?line:null}
}
/** Pixels per animation frame; only the scroll viewport's edge can scroll. */
export function blockEdgeScroll(point:{x:number;y:number},viewport:DropRect){
 if(!contains(viewport,point.x,point.y))return 0
 const edge=Math.min(48,(viewport.bottom-viewport.top)/3)
 if(point.y<viewport.top+edge)return -Math.ceil(18*(1-(point.y-viewport.top)/edge))
 if(point.y>viewport.bottom-edge)return Math.ceil(18*(1-(viewport.bottom-point.y)/edge))
 return 0
}
