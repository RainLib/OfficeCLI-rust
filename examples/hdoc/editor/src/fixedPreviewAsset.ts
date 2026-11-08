import {readBoundedResponse} from './boundedResponse.ts'
import {imageFileHash} from './imageFileIntegrity.ts'
import {translate,type EditorLocale} from './i18n.tsx'

/** Validate immutable page resources before exposing them to the preview. */
export async function readFixedPreviewAsset(response:Response,hash:string,signal:AbortSignal,locale:EditorLocale):Promise<Blob>{
 const bytes=await readBoundedResponse(response,64*1024*1024,signal,translate(locale,'assetTooLarge'))
 signal.throwIfAborted()
 if(await imageFileHash(bytes)!==hash)throw new Error(translate(locale,'assetIntegrity'))
 signal.throwIfAborted()
 return new Blob([Uint8Array.from(bytes)],{type:response.headers.get('content-type')||'application/octet-stream'})
}
