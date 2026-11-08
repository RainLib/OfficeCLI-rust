import {api,type Session} from './api.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import type {BlankBatchCell} from './workbookBlankBatch.ts'

export type BatchComparisonCell={cell:BlankBatchCell;mapped:null|{nodeId:string;text:string;truncated:boolean;editable:boolean}}
/** This is a read-only snapshot. A missing mapping does not establish that a
 * source XLSX cell is empty or editable. */
export async function workbookBatchComparison(session:Session,source:string,revision:number,cells:BlankBatchCell[],signal:AbortSignal):Promise<BatchComparisonCell[]>{
 if(cells.length<1||cells.length>100)throw new Error('invalid batch comparison')
 const response=await awaitRecoveryResponse(()=>api(session,'/grid/cells/compare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:revision,sourceSha256:source,cells:cells.map(({sheetId,row,column})=>({sheetId,row:row+1,column:column+1}))}),signal}),signal)
 const bytes=await readBoundedResponse(response,1024*1024,signal,'invalid batch comparison')
 let value:any;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new Error('invalid batch comparison')}
 if(!value||value.documentId!==session.documentId||value.revision!==revision||value.sourceSha256!==source||typeof value.rootHash!=='string'||!/^[a-f0-9]{64}$/.test(value.rootHash)||!Array.isArray(value.cells)||value.cells.length!==cells.length)throw new Error('invalid batch comparison')
 return value.cells.map((item:any,index:number)=>{
  const cell=cells[index],mapped=item?.mapped
  if(!item||item.sheetId!==cell.sheetId||item.row!==cell.row+1||item.column!==cell.column+1||mapped!==null&&(!mapped||typeof mapped.text!=='string'||Array.from(mapped.text).length>1000||typeof mapped.truncated!=='boolean'||typeof mapped.editable!=='boolean'||typeof mapped.nodeId!=='string'||!/^n_[a-f0-9]{32}$/.test(mapped.nodeId)))throw new Error('invalid batch comparison')
  return {cell,mapped:mapped===null?null:{nodeId:mapped.nodeId,text:mapped.text,truncated:mapped.truncated,editable:mapped.editable}}
 })
}
