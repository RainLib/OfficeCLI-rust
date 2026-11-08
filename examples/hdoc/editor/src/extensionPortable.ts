/** Inert, bounded portable data. No HTML, URLs, callbacks or host handles. */
export type NodeResource={key:string;hash:string;byteLength:number;name:string;mediaType:string}
export type NodeExportFormat='docx'|'xlsx'|'pptx'|'pdf'|'html'|'md'|'txt'
export type NodeExportRun={text:string;bold?:boolean;italic?:boolean;underline?:boolean;strike?:boolean}|{resource:string;alt:string;widthPt:number;heightPt:number}
export type NodeExportBlock={kind:'paragraph'|'heading'|'bullet';level?:number;runs:NodeExportRun[]}
export type NodeExportSnapshot={support:'semantic'|'static'|'unsupported';includeContent?:true;blocks:NodeExportBlock[]}
export const nodeExportFormats:readonly NodeExportFormat[]=['docx','xlsx','pptx','pdf','html','md','txt']
const keys=(v:unknown,allowed:string[],required:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k))
const safeText=(v:unknown,max:number)=>typeof v==='string'&&new TextEncoder().encode(v).length<=max&&![...v].some(c=>{const n=c.codePointAt(0)!;return n<32&&!['\n','\r','\t'].includes(c)||n>=0xd800&&n<=0xdfff||n===0xfffe||n===0xffff})
export function validateNodeResources(value:unknown):asserts value is NodeResource[]{
 if(!Array.isArray(value)||value.length>16)throw new Error('nodeResourceLimit')
 const seen=new Set<string>()
 for(const r of value){if(!keys(r,['key','hash','byteLength','name','mediaType'],['key','hash','byteLength','name','mediaType'])||typeof r.key!=='string'||!(/^[a-z][a-zA-Z0-9_-]{0,63}$/).test(r.key)||seen.has(r.key)||typeof r.hash!=='string'||!(/^[a-f0-9]{64}$/).test(r.hash)||!Number.isSafeInteger(r.byteLength)||r.byteLength<1||r.byteLength>8*1024*1024||!safeText(r.name,256)||!r.name.trim()||/[\r\n\t/\\]/.test(r.name)||typeof r.mediaType!=='string'||!(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/).test(r.mediaType)||r.mediaType.length>128)throw new Error('nodeResourceInvalid');seen.add(r.key)}
}
export function validateNodeExports(value:unknown,resources:readonly NodeResource[],inline:boolean,container=false):asserts value is Partial<Record<NodeExportFormat,NodeExportSnapshot>>{
 if(!keys(value,[...nodeExportFormats],[]))throw new Error('nodeExportFormat')
 let count=0,bytes=0
 for(const snapshot of Object.values(value as Record<string,NodeExportSnapshot>)){
  if(!keys(snapshot,['support','blocks','includeContent'],['support','blocks'])||!['semantic','static','unsupported'].includes(snapshot.support)||!Array.isArray(snapshot.blocks)||snapshot.blocks.length>64||snapshot.support==='unsupported'&&snapshot.blocks.length||snapshot.support!=='unsupported'&&!snapshot.blocks.length&&!container||snapshot.includeContent!==undefined&&snapshot.includeContent!==true||!container&&snapshot.includeContent!==undefined||container&&snapshot.support!=='unsupported'&&snapshot.includeContent!==true||inline&&(snapshot.blocks.length>1||snapshot.blocks[0]?.kind!=='paragraph'&&snapshot.blocks.length))throw new Error('nodeExportSnapshot')
  for(const block of snapshot.blocks){
   if(!keys(block,['kind','level','runs'],['kind','runs'])||!['paragraph','heading','bullet'].includes(block.kind)||block.kind==='heading'&&(!Number.isInteger(block.level)||block.level!<1||block.level!>6)||block.kind!=='heading'&&block.level!==undefined||!Array.isArray(block.runs)||!block.runs.length)throw new Error('nodeExportBlock')
   for(const run of block.runs){if(++count>256)throw new Error('nodeExportLimit');if('text'in run){if(!keys(run,['text','bold','italic','underline','strike'],['text'])||!safeText(run.text,16384)||['bold','italic','underline','strike'].some(k=>k in run&&typeof run[k as keyof typeof run]!=='boolean'))throw new Error('nodeExportText');bytes+=new TextEncoder().encode(run.text).length}else{const resource=resources.find(r=>r.key===run.resource);if(!keys(run,['resource','alt','widthPt','heightPt'],['resource','alt','widthPt','heightPt'])||!resource||!['image/png','image/jpeg','image/gif','image/webp'].includes(resource.mediaType)||!safeText(run.alt,1024)||![run.widthPt,run.heightPt].every(n=>Number.isFinite(n)&&n>0&&n<=2000))throw new Error('nodeExportImage')}}
  }
 }
 if(bytes>32768)throw new Error('nodeExportLimit')
}
