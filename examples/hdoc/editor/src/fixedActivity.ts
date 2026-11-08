import {api,type Session} from './api.ts'
export const fixedActivityKey=(revision:number,nodeId:string)=>`${revision}:${nodeId}`
/** Fetch only canonical text. Never serialize or broadcast a private draft. */
export async function readFixedActivity(session:Session,revision:number,nodeId:string,signal:AbortSignal):Promise<string>{
 if(!Number.isSafeInteger(revision)||revision<0||!/^n_[a-f0-9]{32}$/.test(nodeId))throw new Error('fixedActivityInvalid')
 signal.throwIfAborted()
 const value=await(await api(session,`/text/${nodeId}?revision=${revision}`,{signal})).json() as {documentId?:unknown;revision?:unknown;nodeId?:unknown;text?:unknown}
 signal.throwIfAborted()
 if(value.documentId!==session.documentId||value.revision!==revision||value.nodeId!==nodeId||typeof value.text!=='string')throw new Error('fixedActivityInvalid')
 return Array.from(value.text.replace(/\s+/gu,' ').trim()).slice(0,64).join('')
}
