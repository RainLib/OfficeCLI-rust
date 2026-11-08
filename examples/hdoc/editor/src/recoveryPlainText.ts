import type {Node as PmNode} from '@tiptap/pm/model'

/** Readable escape hatch for a verified packet; never applies its CRDT data. */
export function recoveryPlainText(document:PmNode):string{
 return document.textBetween(0,document.content.size,'\n',node=>{
  if(node.type.name==='hardBreak')return '\n'
  if(node.type.name==='hcdOpaque'){
   const inlines=node.attrs.hcdContent?.inlines
   if(Array.isArray(inlines))return inlines.map(part=>typeof part?.text==='string'?part.text:'').join('')
   return typeof node.attrs.preview==='string'?node.attrs.preview:''
  }
  const extension=node.attrs.extension?.fallback?.text,reference=node.attrs.reference?.snapshot?.label
  return typeof extension==='string'?extension:typeof reference==='string'?reference:''
 })
}
