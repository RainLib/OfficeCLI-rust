import {api,type Session} from './api.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'

export type BlankCreateCell={sheetId:string;sheetPart:string;sheetName?:string;row:number;column:number;text:string;nodeId:string}
export type BlankCreateAttempt={documentId:string;patchId:string;baseRevision:number;sourceSha256:string;cells:BlankCreateCell[]}
type Persistence={write:(attempt:BlankCreateAttempt|null)=>Promise<void>;superseded?:()=>Promise<void>}
const hash=/^[a-f0-9]{64}$/
const id=(prefix:string,value:unknown)=>typeof value==='string'&&new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(value)
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

/** Validate a recovery record before using it as an immutable HTTP attempt. */
export function validateBlankCreateAttempt(value:unknown,session:Session,sourceHash:string):BlankCreateAttempt{
 if(!object(value)||session.format!=='xlsx'||value.documentId!==session.documentId||typeof value.patchId!=='string'||!/^grid-[A-Za-z0-9-]{1,128}$/.test(value.patchId)||!Number.isSafeInteger(value.baseRevision)||(value.baseRevision as number)<0||!hash.test(sourceHash)||value.sourceSha256!==sourceHash||!Array.isArray(value.cells)||!value.cells.length||value.cells.length>4000)throw new Error('invalid blank create attempt')
 const positions=new Set<string>(),nodes=new Set<string>()
 const cells=value.cells.map((cell:unknown)=>{
  if(!object(cell)||!id('s',cell.sheetId)||!id('n',cell.nodeId)||typeof cell.sheetPart!=='string'||!cell.sheetPart.length||cell.sheetPart.length>2048||/[\x00-\x1f]/.test(cell.sheetPart)||cell.sheetName!==undefined&&(typeof cell.sheetName!=='string'||!cell.sheetName.length||cell.sheetName.length>160||/[\x00-\x1f]/.test(cell.sheetName))||!Number.isInteger(cell.row)||(cell.row as number)<1||(cell.row as number)>1_048_576||!Number.isInteger(cell.column)||(cell.column as number)<1||(cell.column as number)>16_384||typeof cell.text!=='string'||cell.text.length>1_000_000||/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(cell.text))throw new Error('invalid blank create attempt')
  const position=`${cell.sheetId}:${cell.row}:${cell.column}`
  if(positions.has(position)||nodes.has(cell.nodeId as string))throw new Error('invalid blank create attempt')
  positions.add(position);nodes.add(cell.nodeId as string)
  return {sheetId:cell.sheetId as string,sheetPart:cell.sheetPart,...(typeof cell.sheetName==='string'?{sheetName:cell.sheetName}:{}),row:cell.row as number,column:cell.column as number,text:cell.text,nodeId:cell.nodeId as string}
 })
 const result={documentId:session.documentId,patchId:value.patchId,baseRevision:value.baseRevision as number,sourceSha256:sourceHash,cells}
 if(new TextEncoder().encode(JSON.stringify(result)).byteLength>4*1024*1024)throw new Error('invalid blank create attempt')
 return result
}

function wire(attempt:BlankCreateAttempt){return {documentId:attempt.documentId,patchId:attempt.patchId,baseRevision:attempt.baseRevision,sourceSha256:attempt.sourceSha256,actor:{},cells:attempt.cells.map(({nodeId:_,sheetName:__,...cell})=>cell)}}
async function responseJson(response:Response,signal:AbortSignal){const bytes=await readBoundedResponse(response,4*1024*1024,signal,'invalid blank receipt');try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown}catch{throw new Error('invalid blank receipt')}}
function receipt(value:unknown,attempt:BlankCreateAttempt,lookup:boolean){
 if(!object(value)||value.patchId!==attempt.patchId)throw new Error('invalid blank receipt')
 if(lookup&&value.status==='missing')return null
 if(lookup&&value.status==='superseded'){
  if(value.baseRevision!==attempt.baseRevision||!Number.isSafeInteger(value.observedRevision)||(value.observedRevision as number)<=attempt.baseRevision)throw new Error('invalid blank receipt')
  return {superseded:true as const}
 }
 if(lookup&&value.status!=='committed'||value.revision!==attempt.baseRevision+1||value.baseRevision!==attempt.baseRevision||typeof value.rootHash!=='string'||!hash.test(value.rootHash)||!Array.isArray(value.dirtyNodeIds)||value.dirtyNodeIds.length!==attempt.cells.length)throw new Error('invalid blank receipt')
 const expected=new Set(attempt.cells.map(cell=>cell.nodeId)),received=new Set(value.dirtyNodeIds)
 if(received.size!==expected.size||[...received].some(node=>typeof node!=='string'||!expected.has(node)))throw new Error('invalid blank receipt')
 return {revision:value.revision as number,rootHash:value.rootHash as string}
}

/** Persist the exact attempt before sending. A missing receipt never clears it:
 * a request may still commit after the lookup. Only the same attempt may retry. */
export class WorkbookBlankSave {
 private attempt:BlankCreateAttempt|null
 private work:Promise<{revision:number;rootHash:string}>|null=null
 constructor(private session:Session,private sourceHash:string,private persistence:Persistence,restored:unknown=null,private submitAllowed:()=>boolean=()=>true){this.attempt=restored===null?null:validateBlankCreateAttempt(restored,session,sourceHash)}
 get pending(){return this.attempt?structuredClone(this.attempt):null}
 async save(value:BlankCreateAttempt,signal:AbortSignal){
  if(this.work)throw new Error('blank save busy')
  const candidate=validateBlankCreateAttempt(value,this.session,this.sourceHash)
  if(this.attempt&&JSON.stringify(candidate)!==JSON.stringify(this.attempt))throw new Error('blank save pending')
  const work=this.perform(candidate,signal);this.work=work
  try{return await work}finally{if(this.work===work)this.work=null}
 }
 private async perform(candidate:BlankCreateAttempt,signal:AbortSignal){
  signal.throwIfAborted()
  if(this.session.scope!=='write')throw new Error('readOnlyMode')
  const restored=!!this.attempt
  if(!restored){await this.persistence.write(candidate);this.attempt=structuredClone(candidate)}
  signal.throwIfAborted()
  const sent=this.attempt!
  const call=async(path:string,lookup:boolean)=>{
   const response=await awaitRecoveryResponse(()=>api(this.session,path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(wire(sent)),signal}),signal)
   return receipt(await responseJson(response,signal),sent,lookup)
  }
  let result=restored?await call('/grid/cells/receipt',true):null
  if(result&&'superseded' in result){
   if(this.persistence.superseded){await this.persistence.superseded();this.attempt=null}
   throw new Error('blank batch superseded')
  }
  if(!result){signal.throwIfAborted();if(!this.submitAllowed())throw new Error('blank batch other request pending');result=await call('/grid/cells',false)}
  if(!result||'superseded' in result)throw new Error('invalid blank receipt')
  // If this write fails the original attempt stays available for replay.
  await this.persistence.write(null);this.attempt=null
  return result
 }
}
