import * as Y from 'yjs'
import {WordRegionStore} from './wordRegionStore.ts'

type PreviewRegion={id:string;kind:'body'|'header'|'footer';number:number;text:string}
/** Inspection only: a file's snapshot can include peers and is not proof of
 * authorship. A different layout cannot be interpreted using current fences. */
export function wordDeviceBackupPreview(update:Uint8Array,current:WordRegionStore,limit=4000){
 const document=new Y.Doc()
 try{
  Y.applyUpdate(document,update)
  const {layout,layoutHash}=current.layoutState(),model=new WordRegionStore(document,current.schema,current.documentId,layout,layoutHash)
  const captured=model.capture().regions,regions:PreviewRegion[]=[];let size=0,truncated=false,headers=0,footers=0
  for(const region of captured){
   const section=layout.sections.findIndex(item=>item.id===region.regionId),story=layout.stories.find(item=>item.id===region.regionId)
   if(section<0&&!story)throw new Error('invalidWordRegionMetadata')
   const kind=section>=0?'body':story!.kind,number=kind==='body'?section+1:kind==='header'?++headers:++footers
   const node=model.project(region.regionId),text=node.textBetween(0,node.content.size,'\n',leaf=>leaf.type.name==='hardBreak'?'\n':leaf.type.spec.leafText?.(leaf)??''),remaining=limit-size
   if(text.length>remaining){let end=Math.max(0,remaining);if(end>0&&end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;regions.push({id:region.regionId,kind,number,text:text.slice(0,end)});truncated=true;break}
   regions.push({id:region.regionId,kind,number,text});size+=text.length
  }
  return {regions,truncated}
 }finally{document.destroy()}
}

/** A text-only escape hatch; a too-large snapshot fails instead of silently
 * downloading a partial file. Non-text content remains in the backup. */
export function wordDeviceBackupTextFile(update:Uint8Array,current:WordRegionStore,label:(region:PreviewRegion)=>string,limit=8*1024*1024){
 const preview=wordDeviceBackupPreview(update,current,limit)
 if(preview.truncated)throw new Error('word-device-text-limit')
 const body=preview.regions.map(region=>`[${label(region)}]\n${region.text}`).join('\n\n')
 return{name:'word-backup-text.txt',blob:new Blob([body],{type:'text/plain;charset=utf-8'})}
}
