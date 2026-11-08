import {api,type Session} from './api.ts'
import {awaitRecoveryResponse,readBoundedResponse} from './boundedResponse.ts'
import {workbookCellAddress} from './workbookInputBuffer.ts'

export type BlankTarget={sheetId:string;row:number;column:number}
export type BlankObservation=BlankTarget&{sheetPart:string;sheetName:string;sheetIndex:number;sheetState:string;address:string;nodeId:string}
const hash=/^[a-f0-9]{64}$/
const sheet=/^s_[a-f0-9]{32}$/
const node=/^n_[a-f0-9]{32}$/
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const bounded=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f]/.test(value)

/** A bounded, revision-bound observation; the server rechecks on commit.
 * Coordinates are zero-based in the editor and one-based on the wire. */
export async function inspectWorkbookBlanks(session:Session,revision:number,sourceHash:string,targets:ReadonlyArray<BlankTarget>,signal:AbortSignal):Promise<{revision:number;rootHash:string;cells:BlankObservation[]}>{
 if(session.format!=='xlsx'||session.scope!=='write'||!Number.isSafeInteger(revision)||revision<0||!hash.test(sourceHash)||!targets.length||targets.length>4000)throw new Error('invalid blank inspection')
 const keys=new Set<string>()
 for(const target of targets){
  if(!sheet.test(target.sheetId)||!Number.isInteger(target.row)||target.row<0||target.row>=1_048_576||!Number.isInteger(target.column)||target.column<0||target.column>=16_384||keys.has(`${target.sheetId}:${target.row}:${target.column}`))throw new Error('invalid blank inspection')
  keys.add(`${target.sheetId}:${target.row}:${target.column}`)
 }
 const body={expectedRevision:revision,sourceSha256:sourceHash,cells:targets.map(({sheetId,row,column})=>({sheetId,row:row+1,column:column+1}))}
 const response=await awaitRecoveryResponse(()=>api(session,'/grid/cells/inspect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal}),signal)
 const bytes=await readBoundedResponse(response,4*1024*1024,signal,'invalid blank inspection result')
 let result:unknown
 try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw new Error('invalid blank inspection result')}
 if(!object(result)||result.revision!==revision||result.sourceSha256!==sourceHash||typeof result.rootHash!=='string'||!hash.test(result.rootHash)||!Array.isArray(result.cells)||result.cells.length!==targets.length)throw new Error('invalid blank inspection result')
 const cells=result.cells.map((value:unknown,index:number)=>{
  const target=targets[index]
  if(!object(value)||value.sheetId!==target.sheetId||value.row!==target.row+1||value.column!==target.column+1||value.address!==workbookCellAddress(target.row,target.column)||!bounded(value.sheetPart,2048)||!bounded(value.sheetName,512)||!Number.isSafeInteger(value.sheetIndex)||(value.sheetIndex as number)<0||!['visible','hidden','very-hidden'].includes(String(value.sheetState))||typeof value.nodeId!=='string'||!node.test(value.nodeId))throw new Error('invalid blank inspection result')
  return {...target,sheetPart:value.sheetPart,sheetName:value.sheetName,sheetIndex:value.sheetIndex as number,sheetState:value.sheetState as string,address:value.address as string,nodeId:value.nodeId}
 })
 signal.throwIfAborted()
 return {revision,rootHash:result.rootHash,cells}
}
