import {Plugin,PluginKey} from '@tiptap/pm/state'
import {Decoration,DecorationSet} from '@tiptap/pm/view'
import {aiText} from './core.ts'
export type AiGhost={requestId:string;position:number;text:string;ready:boolean;applying:boolean}
export const aiGhostKey=new PluginKey<AiGhost|null>('hcd-ai-private-ghost/1')
export function aiGhostPlugin(options:{accept:()=>void;dismiss:()=>void;labels:()=>{accept:string;dismiss:string};mounted:(node:HTMLElement)=>void;unmounted:(node:HTMLElement)=>void}){
 return new Plugin<AiGhost|null>({key:aiGhostKey,state:{init:()=>null,apply:(tr,value)=>{
  const next=tr.getMeta(aiGhostKey) as AiGhost|null|undefined
  if(next!==undefined)return next
  return tr.docChanged||tr.selectionSet?null:value
 }},props:{decorations:state=>{
  const ghost=aiGhostKey.getState(state);if(!ghost||!ghost.text||ghost.position<0||ghost.position>state.doc.content.size)return null
  return DecorationSet.create(state.doc,[Decoration.widget(ghost.position,()=>{
   const dom=document.createElement('span');dom.className='hcd-ai-completion';dom.contentEditable='false';dom.setAttribute('data-hcd-ai-ghost','')
   const text=document.createElement('span');text.className='hcd-ai-completion-text';text.setAttribute('aria-hidden','true');text.textContent=Array.from(ghost.text.replaceAll('\r\n','\n').replaceAll('\r','\n')).filter(char=>aiText(char)).join('');dom.append(text)
   const hint=document.createElement('span');hint.className='hcd-ai-completion-hint';hint.setAttribute('aria-hidden','true');hint.textContent=ghost.applying?'…':ghost.ready?'Tab · Esc':'… · Esc';dom.append(hint)
   const controls=document.createElement('span');controls.className='hcd-ai-completion-controls'
   const button=(label:string,symbol:string,run:()=>void,disabled=false)=>{const node=document.createElement('button');node.type='button';node.tabIndex=-1;node.disabled=disabled;node.setAttribute('aria-label',label);node.title=label;node.textContent=symbol;node.addEventListener('pointerdown',event=>event.preventDefault());node.addEventListener('mousedown',event=>event.preventDefault());node.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();run()});return node}
   const labels=options.labels();controls.append(button(labels.accept,'✓',options.accept,!ghost.ready||ghost.applying),button(labels.dismiss,'×',options.dismiss));dom.append(controls);options.mounted(dom);return dom
  },{key:JSON.stringify(ghost),side:1,ignoreSelection:true,stopEvent:event=>event.target instanceof Element&&!!event.target.closest('.hcd-ai-completion-controls'),destroy:node=>options.unmounted(node as HTMLElement)})])
 }}})
}
