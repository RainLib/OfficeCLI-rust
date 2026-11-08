import type {Node as PmNode} from '@tiptap/pm/model'
import type {NodeViewRenderer} from '@tiptap/core'
import {api,type Session} from './api.ts'
import type {WordBrowserState} from './wordBrowserState.ts'
import type {CollaborativeImageDraftStore} from './collaborativeImages.ts'
/** Native static content stays inside a script-free iframe. Resolve only
 * authenticated content-addressed assets; never load document-supplied URLs. */
export function wordOpaqueView(session:Session,controller:WordBrowserState,images:CollaborativeImageDraftStore,select:(id:string)=>void):NodeViewRenderer{
 return({node:initial})=>{
  let node=initial,closed=false,generation=0,last='',request:AbortController|undefined;const urls=new Set<string>(),frame=document.createElement('iframe'),dom=document.createElement('div');dom.className='hcd-word-opaque';dom.contentEditable='false';frame.setAttribute('sandbox','allow-same-origin');frame.referrerPolicy='no-referrer';frame.title='Document object';frame.style.cssText='width:100%;height:32px;border:0;display:block';dom.append(frame)
  const paint=async()=>{
   const projection=controller.projection,block=projection?.blocks.find(block=>block.blockId===node.attrs.hcdBlockId),html=block?.readOnlyHtml
   if(!html){dom.setAttribute('data-hcd-object-unavailable','true');return}
   const signature=JSON.stringify([html,images.entries().map(([id,draft])=>[id,draft.geometry,draft.assetHash])]);if(signature===last)return;last=signature;request?.abort();const signal=(request=new AbortController()).signal,current=++generation,parser=new DOMParser().parseFromString(html,'text/html'),nextUrls:string[]=[]
   parser.querySelectorAll('script,iframe,object,embed,form,link,meta,base,style,video,audio,source,input,textarea,select,button,animate,animateTransform,animateMotion,set,foreignObject').forEach(element=>element.remove())
   for(const element of parser.querySelectorAll('*'))for(const attribute of [...element.attributes])if(/^on/i.test(attribute.name)||['src','srcset','href','xlink:href','action','formaction','contenteditable','autofocus','tabindex'].includes(attribute.name)||attribute.name==='style'&&/url\s*\(|@import/i.test(attribute.value))element.removeAttribute(attribute.name)
   try{
    await Promise.all([...parser.querySelectorAll('img')].map(async image=>{
     const id=image.getAttribute('data-hcd-id')??'',draft=images.get(id),hash=draft?.assetHash??image.getAttribute('data-hcd-asset-hash');if(!hash||!/^[a-f0-9]{64}$/.test(hash)){image.remove();return}
     let response:Response;try{response=await api(session,`/assets/${hash}?revision=${projection!.revision}`,{signal})}catch{response=await api(session,`/staged-assets/${hash}`,{signal})}const blob=await response.blob();if(!blob.type.startsWith('image/'))throw new Error('word-object-media-type');if(blob.size>8*1024*1024)throw new Error('word-object-too-large');const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(value=>value.toString(16).padStart(2,'0')).join('');if(actual!==hash)throw new Error('word-object-integrity');const url=URL.createObjectURL(blob);nextUrls.push(url);image.src=url
     if(draft){const scale=draft.geometry.unit==='emu'?1/9525:96/72;image.style.width=`${draft.geometry.width*scale}px`;image.style.height=`${draft.geometry.height*scale}px`}
    }))
    if(closed||current!==generation){nextUrls.forEach(url=>URL.revokeObjectURL(url));return}for(const url of urls)URL.revokeObjectURL(url);urls.clear();dom.removeAttribute('data-hcd-object-unavailable');nextUrls.forEach(url=>urls.add(url));frame.srcdoc=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;padding:0;background:transparent;font:14px/1.5 system-ui;color:#1e293b}img{max-width:100%}p{margin:0 0 8px}</style>${parser.body.innerHTML}`
   }catch{nextUrls.forEach(url=>URL.revokeObjectURL(url));if(!closed&&current===generation)dom.setAttribute('data-hcd-object-unavailable','true')}
  }
  frame.onload=()=>{const content=frame.contentDocument;if(!content)return;const measure=()=>{frame.style.height='0px';frame.style.height=`${Math.max(24,content.body.scrollHeight,content.documentElement.scrollHeight)}px`};measure();content.querySelectorAll('img').forEach(image=>{image.addEventListener('load',measure);image.addEventListener('click',()=>{const id=image.getAttribute('data-hcd-id');if(id)select(id)})})}
  const detach=controller.subscribe(()=>{void paint()}),detachImages=images.subscribe(()=>{void paint()});void paint()
  return{dom,update(next:PmNode){if(next.type!==node.type)return false;node=next;void paint();return true},ignoreMutation:()=>true,stopEvent:()=>true,destroy(){closed=true;generation++;request?.abort();detach();detachImages();for(const url of urls)URL.revokeObjectURL(url)}}
 }
}
