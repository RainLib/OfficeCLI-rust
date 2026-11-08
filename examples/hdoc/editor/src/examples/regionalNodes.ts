import type {NodeExtensionDefinition} from '../extensionTypes.ts'

/** Bundled host examples, registered only by an explicit example/preview host. */
export const regionalExampleNodes:readonly NodeExtensionDefinition[]=[
 {
  type:'example.status',version:1,display:'inline',label:{'zh-CN':'状态标签','en-US':'Status label'},icon:'◇',
  defaultData:{label:'待处理',owner:'未分配'},validate:data=>typeof data.label==='string'&&data.label.length>0&&data.label.length<=80&&typeof data.owner==='string'&&data.owner.length<=80,
  fallback:data=>`${data.label} · ${data.owner}`,
  properties:[{key:'label',label:{'zh-CN':'状态','en-US':'Status'},kind:'text',required:true,maxLength:80},{key:'owner',label:{'zh-CN':'负责人','en-US':'Owner'},kind:'text',maxLength:80}],
  exportAdapters:{docx:({data})=>({support:'semantic',blocks:[{kind:'paragraph',runs:[{text:`${data.label} · ${data.owner}`,bold:true}]}]})},
 },
 {
  type:'example.card',version:1,display:'block',label:{'zh-CN':'资料卡片','en-US':'Resource card'},icon:'▣',
  defaultData:{title:'项目资料',owner:'团队'},validate:data=>typeof data.title==='string'&&data.title.length>0&&data.title.length<=120&&typeof data.owner==='string'&&data.owner.length<=80,
  fallback:data=>`${data.title} · ${data.owner}`,
  properties:[{key:'title',label:{'zh-CN':'名称','en-US':'Name'},kind:'text',required:true,maxLength:120},{key:'owner',label:{'zh-CN':'负责人','en-US':'Owner'},kind:'text',maxLength:80}],
  exportAdapters:{docx:({data,resources})=>({support:'semantic',blocks:[{kind:'paragraph',runs:[{text:`${data.title} · ${data.owner}`,bold:true}]},...resources.filter(resource=>['image/png','image/jpeg','image/gif','image/webp'].includes(resource.mediaType)).map(resource=>({kind:'paragraph' as const,runs:[{resource:resource.key,alt:resource.name,widthPt:120,heightPt:60}]}))]})},
 },
 {
  type:'example.note',version:1,display:'block',contentModel:'blocks',label:{'zh-CN':'说明块','en-US':'Rich note'},icon:'▤',
  defaultData:{title:'说明'},validate:data=>typeof data.title==='string'&&data.title.length>0&&data.title.length<=120,
  fallback:data=>String(data.title),properties:[{key:'title',label:{'zh-CN':'标题','en-US':'Title'},kind:'text',required:true,maxLength:120}],
  exportAdapters:{docx:({data})=>({support:'semantic',includeContent:true,blocks:[{kind:'paragraph',runs:[{text:String(data.title),bold:true}]}]})},
 },
]
