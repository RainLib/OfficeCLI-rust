import {api,type Session} from './api.ts'
import {boundedAsyncPool} from './boundedAsyncPool.ts'
import {readBoundedResponse} from './boundedResponse.ts'
import {readWordLayout,wordRegionForElement,type WordLayout} from './wordRegions.ts'
import type {Manifest} from './fixedPages.ts'

/** Older servers have no body identity in the index. Fetch and validate only
 * that index page's regions before grouping; never infer a section by order. */
export function compatibleWordIndexReader(session:Session,manifest:Manifest){
 let layoutPromise:Promise<WordLayout>|undefined
 const json=async(response:Response,signal:AbortSignal,max:number)=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,max,signal,'fixedIndexInvalid')))
 const layout=(signal:AbortSignal)=>{
  if(!layoutPromise){const request=api(session,`/word/layout?revision=${manifest.revision}`,{signal}).then(response=>json(response,signal,16*1024*1024)).then(value=>readWordLayout(value,manifest.revision,2));layoutPromise=request;void request.catch(()=>{if(layoutPromise===request)layoutPromise=undefined})}
  return layoutPromise
 }
 return async(page:number,signal:AbortSignal):Promise<unknown>=>{
  const raw=await (await api(session,`/index/${page}?revision=${manifest.revision}&wordRegions=true&wordBodies=true`,{signal})).json() as {page?:unknown;chunks?:unknown;wordBodiesVerified?:unknown;wordRegionsVerified?:unknown}
  if(raw.wordBodiesVerified===true)return raw
  if(raw.wordBodiesVerified!==undefined||raw.wordRegionsVerified!==undefined&&raw.wordRegionsVerified!==true||raw.page!==page||!Array.isArray(raw.chunks)||raw.chunks.length!==Math.min(128,manifest.chunkCount-page*128))throw new Error('fixedIndexInvalid')
  const model=await layout(signal)
  const chunks=await boundedAsyncPool(raw.chunks.map((item:unknown,offset:number)=>async taskSignal=>{
   const descriptor=item as {sequence?:unknown;region?:unknown;chunkId?:unknown;htmlHash?:unknown;mapHash?:unknown;byteLength?:unknown;continuation?:unknown}
   if(!descriptor||descriptor.sequence!==page*128+offset||typeof descriptor.region!=='string'||typeof descriptor.continuation!=='boolean')throw new Error('fixedIndexInvalid')
   if(!['body','header','footer'].includes(descriptor.region))return {sequence:descriptor.sequence,region:descriptor.region,continuation:descriptor.continuation}
   if(typeof descriptor.chunkId!=='string'||!/^c_[0-9a-f]{32}$/.test(descriptor.chunkId)||typeof descriptor.htmlHash!=='string'||!/^[0-9a-f]{64}$/.test(descriptor.htmlHash)||typeof descriptor.mapHash!=='string'||!/^[0-9a-f]{64}$/.test(descriptor.mapHash)||typeof descriptor.byteLength!=='number'||!Number.isSafeInteger(descriptor.byteLength)||descriptor.byteLength<0||descriptor.byteLength>2*1024*1024)throw new Error('fixedIndexInvalid')
   const value=await json(await api(session,`/chunks/${descriptor.sequence}?revision=${manifest.revision}`,{signal:taskSignal}),taskSignal,24*1024*1024) as {revision?:unknown;html?:unknown;descriptor?:typeof descriptor;map?:{chunkId?:unknown;entries?:unknown}}
   if(value.revision!==manifest.revision||typeof value.html!=='string'||!value.descriptor||value.descriptor.sequence!==descriptor.sequence||value.descriptor.region!==descriptor.region||value.descriptor.chunkId!==descriptor.chunkId||value.descriptor.htmlHash!==descriptor.htmlHash||value.descriptor.mapHash!==descriptor.mapHash||value.map?.chunkId!==descriptor.chunkId||!Array.isArray(value.map?.entries))throw new Error('fixedIndexInvalid')
   const bytes=new TextEncoder().encode(value.html);if(bytes.byteLength!==descriptor.byteLength)throw new Error('fixedIndexInvalid')
   const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('')
   taskSignal.throwIfAborted();if(digest!==descriptor.htmlHash)throw new Error('fixedIndexInvalid')
   const root=new DOMParser().parseFromString(value.html,'text/html').body.firstElementChild,region=wordRegionForElement(root)
   if(!region?.id||region.kind!==descriptor.region||root?.querySelector('[data-hcd-flow-region]')||value.map.entries.some((entry:unknown)=>(entry as {source?:{part?:unknown}})?.source?.part!==region.sourcePart))throw new Error('fixedIndexInvalid')
   if(region.kind==='body'?(region.sourcePart!=='word/document.xml'||!model.sections.some(section=>section.id===region.id)):!model.stories.some(story=>story.id===region.id&&story.kind===region.kind&&story.sourcePart===region.sourcePart))throw new Error('fixedIndexInvalid')
   return {sequence:descriptor.sequence,region:descriptor.region,continuation:descriptor.continuation,wordRegionId:region.id}
  }),signal)
  return {page,chunks,wordRegionsVerified:true,wordBodiesVerified:true}
 }
}
