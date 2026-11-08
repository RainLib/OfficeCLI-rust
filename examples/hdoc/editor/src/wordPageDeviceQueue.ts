/** Page limits and schema remain stable while sharing the lossless device queue. */
import {readDeviceRequestQueue,deviceRequestQueueJson,migrateDeviceRequestLegacy,type DeviceRequestStorage,type LegacyRequestStorage} from './wordDeviceRequestQueue.ts'
export type WordPageStorage=DeviceRequestStorage
export type WordPageLegacyStorage=LegacyRequestStorage
const options={schemaVersion:'hcd-word-page-device/1',errorPrefix:'word-page',maxBytes:8*1024*1024,maxRequestBytes:512*1024,maxRequests:16}
export const readWordPageQueue=(raw:string|null)=>readDeviceRequestQueue(raw,options)
export const wordPageQueueJson=(requests:readonly string[])=>deviceRequestQueueJson(requests,options)
export const migrateWordPageLegacy=(store:WordPageStorage,legacy:WordPageLegacyStorage|undefined,key:string,signal:AbortSignal)=>migrateDeviceRequestLegacy(store,legacy,key,signal,options)
