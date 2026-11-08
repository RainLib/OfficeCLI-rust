/** Shared bounded CAS queue. Raw unknown requests are evidence, not authority. */
import type {WordStoryStorage} from './wordStoryRequestStore.ts'
export type DeviceRequestStorage=WordStoryStorage&{replace:(expected:string|null,next:string|null,exclusive?:boolean)=>Promise<void>}
export type LegacyRequestStorage=Pick<Storage,'getItem'|'removeItem'>
export type DeviceQueueOptions={schemaVersion:string;errorPrefix:string;maxBytes:number;maxRequestBytes:number;maxRequests:number}
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength
export function readDeviceRequestQueue(raw:string|null,options:DeviceQueueOptions):string[]{
 if(raw===null)return[]
 const fail=()=>{throw Error(`${options.errorPrefix}-device-invalid`)}
 if(bytes(raw)>options.maxBytes)throw Error(`${options.errorPrefix}-device-limit`)
 const value=JSON.parse(raw)
 if(!value||Object.keys(value).sort().join(',')!=='requests,schemaVersion'||value.schemaVersion!==options.schemaVersion||!Array.isArray(value.requests)||!value.requests.length||value.requests.length>options.maxRequests||value.requests.some((request:unknown)=>typeof request!=='string'||!request||bytes(request)>options.maxRequestBytes)||new Set(value.requests).size!==value.requests.length)return fail()
 return [...value.requests]
}
export function deviceRequestQueueJson(requests:readonly string[],options:DeviceQueueOptions){
 if(!requests.length)return null
 const raw=JSON.stringify({schemaVersion:options.schemaVersion,requests});readDeviceRequestQueue(raw,options);return raw
}
export async function migrateDeviceRequestLegacy(store:DeviceRequestStorage,legacy:LegacyRequestStorage|undefined,key:string,signal:AbortSignal,options:DeviceQueueOptions,convert:(raw:string)=>string=value=>value){
 if(!legacy)return
 for(let attempt=0;attempt<8;attempt++){
  signal.throwIfAborted();const original=legacy.getItem(key);if(original===null)return
  if(!original||bytes(original)>options.maxRequestBytes)throw Error(`${options.errorPrefix}-legacy-invalid`)
  const migrated=convert(original),raw=await store.read();signal.throwIfAborted();const requests=readDeviceRequestQueue(raw,options)
  if(!requests.includes(migrated)){
   const next=deviceRequestQueueJson([...requests,migrated],options)
   try{await store.replace(raw,next)}catch(error){if(error instanceof Error&&error.message===`${options.errorPrefix}-record-changed`)continue;throw error}
  }
  signal.throwIfAborted();if(legacy.getItem(key)!==original)continue
  legacy.removeItem(key);if(legacy.getItem(key)===null)return
 }
 throw Error(`${options.errorPrefix}-legacy-changed`)
}
