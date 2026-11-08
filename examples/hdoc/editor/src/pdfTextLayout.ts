import type {TextRun} from './textDrafts.ts'
/** Read only committed metadata bound to this exact canonical node hash. */
export function pdfLayoutFont(raw:string|null,hash:string,text:string):TextRun['font']|undefined{
 if(!raw||raw.length>2*1024*1024)return
 try{
  const value=JSON.parse(raw)
  if(value?.version!==1||value.textHash!==hash||!Array.isArray(value.runs)||!value.runs.length||value.runs.length>4096)return
  let count=0
  for(const run of value.runs){
   if(!run||!Number.isSafeInteger(run.chars)||run.chars<=0||typeof run.family!=='string'||run.family.length>256||/[\u0000-\u001f\u007f]/.test(run.family)||!Number.isFinite(run.sizePt)||run.sizePt<=0||run.sizePt>14400||typeof run.bold!=='boolean'||typeof run.italic!=='boolean')return
   count+=run.chars
  }
  if(count!==Array.from(text).length)return
  const first=value.runs[0],families=[...new Set<string>(value.runs.map((run:{family:string})=>run.family))]
  return{family:first.family,sizePt:first.sizePt,bold:first.bold,italic:first.italic,families,mixedFamily:families.length>1,mixedSize:value.runs.some((run:{sizePt:number})=>Math.abs(run.sizePt-first.sizePt)>.01),mixedStyle:value.runs.some((run:{bold:boolean;italic:boolean})=>run.bold!==first.bold||run.italic!==first.italic)}
 }catch{return}
}
