import {Node} from '@tiptap/core'
import {inlineContainerNodeName,readInlineContainerPayload} from './semanticInlineContainers.ts'
import {semanticSourceDefaults} from './semanticSourceDefaults.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {inlineContainerPreservationPlugin} from './inlineContainerPreservation.ts'
import {translate,type EditorLocale} from './i18n.tsx'
import type {Transaction} from '@tiptap/pm/state'
import {inlineContainerClipboardPlugin,pastedInlineContainerAttributes} from './inlineContainerClipboard.ts'
/** Opt-in host schema. Registration does not upgrade an active room; its
 * schema, guard and save protocol must negotiate the inline body model. */
type Options={registry:()=>InlineContainerRegistry|undefined;onError:(error:unknown)=>void}
export const SemanticInlineContainerNode=Node.create<Options>({
 name:inlineContainerNodeName,inline:true,group:'inline',content:'inline*',marks:'_',isolating:true,defining:true,
 addOptions(){return{registry:()=>undefined as InlineContainerRegistry|undefined,onError:(_error:unknown)=>{}}},
 addProseMirrorPlugins(){return[inlineContainerClipboardPlugin(this.options.onError),inlineContainerPreservationPlugin(value=>this.options.registry()?.resolve(value),this.options.onError,this.options.registry)]},
 addAttributes(){return{
  extension:{default:null,validate:readInlineContainerPayload,renderHTML:()=>({})},
  hcdSourceId:{default:null,validate:value=>semanticSourceDefaults({hcdSourceId:value}),renderHTML:()=>({})},
  hcdSourceTypography:{default:null,validate:value=>semanticSourceDefaults({hcdSourceTypography:value}),renderHTML:()=>({})},
  hcdSourceSizeExplicit:{default:false,renderHTML:()=>({})},
 }},
 // The DOM exposes the real body, never a duplicated fallback/body JSON blob.
 parseHTML(){return[{tag:'span[data-hcd-inline-payload]',priority:120,getAttrs:(element:HTMLElement)=>{try{return pastedInlineContainerAttributes(element)}catch{return false}}}]},
 renderHTML({node}){const value=readInlineContainerPayload(node.attrs.extension);return['span',{'data-hcd-inline-container':value.instanceId,'data-hcd-inline-payload':JSON.stringify(value)},0]},
 addNodeView(){return({node:initial,editor,getPos})=>{
  const dom=document.createElement('span'),label=document.createElement('button'),contentDOM=document.createElement('span')
  dom.className='hcd-inline-container';dom.setAttribute('role','group');label.type='button';label.contentEditable='false';label.className='hcd-inline-container-label';contentDOM.setAttribute('data-hcd-inline-body','');dom.append(label,contentDOM)
  let current=initial,lastEditable=editor.isEditable,registry:InlineContainerRegistry|undefined,unsubscribe:(()=>void)|undefined,closed=false
  const paint=()=>{
   if(closed)return
   const nextRegistry=this.options.registry();if(nextRegistry!==registry){unsubscribe?.();registry=nextRegistry;unsubscribe=registry?.subscribe(paint)}
   const value=readInlineContainerPayload(current.attrs.extension),known=!!registry?.resolve(value),locale=(editor.storage as unknown as {hcdIdentity?:{locale:EditorLocale}}).hcdIdentity?.locale||'en-US'
   lastEditable=editor.isEditable
   if(label.textContent!==value.fallback.text)label.textContent=value.fallback.text
   const title=known?value.fallback.text:translate(locale,'extensionUnavailable',{type:value.type,version:value.version})
   label.title=title;label.setAttribute('aria-label',title);dom.setAttribute('data-hcd-inline-container',value.instanceId);dom.setAttribute('aria-readonly',String(!known||!lastEditable));dom.classList.toggle('hcd-extension-unavailable',!known)
   // Inherit the editor's editing host. A nested `contenteditable=true`
   // creates a second focus root and can send typing outside ProseMirror.
   if(known&&lastEditable){if(contentDOM.hasAttribute('contenteditable'))contentDOM.removeAttribute('contenteditable')}
   else if(contentDOM.getAttribute('contenteditable')!=='false')contentDOM.setAttribute('contenteditable','false')
  }
  const select=()=>{const position=getPos();if(typeof position==='number'&&editor.state.doc.nodeAt(position)?.attrs.extension?.instanceId===current.attrs.extension.instanceId)editor.chain().focus().setNodeSelection(position).run()}
  const updated=({transaction}:{transaction:Transaction})=>{if(transaction.getMeta('hcd-ui-locale')||transaction.getMeta('hcd-node-registry')||lastEditable!==editor.isEditable||registry!==this.options.registry())paint()}
  label.addEventListener('click',select);editor.on('transaction',updated);editor.on('update',updated);paint()
  return{dom,contentDOM,update(node){if(node.type!==initial.type)return false;current=node;paint();return true},stopEvent:event=>label.contains(event.target as globalThis.Node),ignoreMutation:mutation=>label.contains(mutation.target)||mutation.type==='attributes'&&(mutation.target===dom||mutation.target===contentDOM),destroy(){closed=true;unsubscribe?.();label.removeEventListener('click',select);editor.off('transaction',updated);editor.off('update',updated)}}
 }},
})
