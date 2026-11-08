/** Isolated internal binding demonstration. No active room or server
 * capability is enabled. Two real PM views exchange actual Yjs updates. */
import * as Y from 'yjs'
import {Editor,Extension} from '@tiptap/core'
import {schemaExtensions} from '../src/schema.ts'
import {SemanticInlineContainerNode} from '../src/semanticInlineNode.ts'
import {SemanticStructureIdentity} from '../src/semanticStructureIdentity.ts'
import {SemanticBlockStore,semanticBlockOrigin} from '../src/semanticBlockStore.ts'
import {semanticStructureBinding} from '../src/semanticStructureBinding.ts'
import {InlineContainerRegistry,type InlineContainerDefinition,prepareInlineContainerHistoryGuard} from '../src/inline-containers.ts'
import '../src/style.css'
const id='x_'+'1'.repeat(32),documents=[new Y.Doc({gc:false}),new Y.Doc({gc:false})]
documents[0].clientID=1;documents[1].clientID=2
let connected=true
const definition:InlineContainerDefinition={type:'example.inline_field',version:1,display:'inline',contentModel:'inline',label:'内部字段',defaultData:{},validate:data=>Object.keys(data).length===0,fallback:()=> '内部字段'}
const registries=[new InlineContainerRegistry(),new InlineContainerRegistry()],disconnect=registries.map(registry=>registry.connect()),registrations=registries.map(registry=>registry.register([definition]))
const status=document.querySelector<HTMLElement>('#status')!,error=document.querySelector<HTMLElement>('#errors')!,editors:Editor[]=[],stores:SemanticBlockStore[]=[],histories:Y.UndoManager[]=[],peerOrigin={kind:'owned-preview-peer'}
const payload={schemaVersion:'hcd.extension/3',instanceId:id,type:'example.inline_field',version:1,display:'inline',contentModel:'inline',data:{},fallback:{text:'内部字段'}}
const initial={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'开始 '},{type:'hcdExtensionInlineContainer',attrs:{extension:payload},content:[{type:'text',text:'AAA😀AAA'}]},{type:'text',text:' 结束'}]}]}
const visible=(text:Y.XmlText)=>{const result:string[]=[];for(let item=text._start;item;item=item.right)if(!item.deleted&&item.countable)for(let n=0;n<item.length;n++)result.push(`${item.id.client}:${item.id.clock+n}`);return result}
let original:string[]=[]
let firstBody:Element|null=null,firstEditor:Element|null=null
let receiptSelection=''
const refresh=()=>{if(stores.length!==2)return;firstBody??=editors[0]?.view.dom.querySelector('[data-hcd-inline-body]');firstEditor??=editors[0]?.view.dom;status.textContent=stores.map((store,index)=>{const body=store.flow.containers!.bodies.get(id)!;return `${index?'Bob':'Alice'}：${store.project().textContent} ｜可见容器 ${Array.from(store.project().content.content).reduce((n,node)=>{node.descendants(child=>{if(child.type.name==='hcdExtensionInlineContainer')n++});return n},0)} ｜原始字符 ${visible(body).filter(value=>original.includes(value)).length}/${original.length}`}).join('\n')+`\nAlice 编辑器 DOM ${firstEditor===editors[0]?.view.dom?'稳定':'已更换'} / 正文容器 DOM ${firstBody===editors[0]?.view.dom.querySelector('[data-hcd-inline-body]')?'稳定':'已更换'}${receiptSelection}`;document.querySelector('#connection')!.textContent=connected?'本机副本已连接':'副本暂时断开'}
for(let index=0;index<2;index++){
 const Binding=Extension.create({name:'ownedInlineBinding',addExtensions(){return[SemanticStructureIdentity]},addProseMirrorPlugins(){
  const store=new SemanticBlockStore(documents[index],this.editor.schema,semanticBlockOrigin,{inlineContainers:true});stores[index]=store
  if(!index){store.initialize(this.editor.schema.nodeFromJSON(initial));Y.applyUpdate(documents[1],Y.encodeStateAsUpdate(documents[0]),peerOrigin);original=visible(store.flow.containers!.bodies.get(id)!)}
  return[semanticStructureBinding(store,{canWrite:()=>this.editor.isEditable,onError:cause=>{error.textContent+=String(cause)+'\n'}})]
 }})
 editors[index]=new Editor({element:document.querySelector(`#editor-${index}`)!,extensions:[...schemaExtensions,SemanticInlineContainerNode.configure({registry:()=>registries[index],onError:cause=>{if(cause instanceof Error&&cause.message==='historyExtensionUnavailable')document.querySelector('#rejected')!.textContent='已阻止修改缺少扩展的内容';else if(cause instanceof Error&&cause.message==='inlineContainerClipboardInvalid')document.querySelector('#rejected')!.textContent='无法完整保留此粘贴内容，原文未更改';else error.textContent+=String(cause)+'\n'}}),Binding],editorProps:{attributes:{role:'textbox','aria-multiline':'true','aria-label':`${index?'Bob':'Alice'} 编辑区`}}})
 histories[index]=stores[index].undoManager(true,before=>prepareInlineContainerHistoryGuard(before,registries[index].resolve))
 document.querySelector(`#undo-${index}`)!.addEventListener('click',()=>histories[index].undo())
 document.querySelector(`#redo-${index}`)!.addEventListener('click',()=>histories[index].redo())
}
document.querySelector('#unload')!.addEventListener('click',()=>{registrations[0]();refresh()})
document.querySelector('#readonly')!.addEventListener('click',()=>editors[0].setEditable(false))
document.querySelector('#editable')!.addEventListener('click',()=>editors[0].setEditable(true))
document.querySelector('#reload')!.addEventListener('click',()=>{registrations[0]();registrations[0]=registries[0].register([definition]);refresh()})
document.querySelector('#receipt')!.addEventListener('mousedown',event=>event.preventDefault())
document.querySelector('#receipt')!.addEventListener('click',()=>{const before=editors[0].state.selection;documents[0].transact(()=>stores[0].flow.containers!.sourceDefaultActions(id,{hcdSourceId:'n_'+'a'.repeat(32),hcdSourceTypography:null,hcdSourceSizeExplicit:false}).forEach(action=>action()),'owned-receipt');const after=editors[0].state.selection;receiptSelection=`\n来源回执选区 ${before.from}:${before.to} → ${after.from}:${after.to}`;refresh()})
documents.forEach((doc,index)=>{doc.on('update',(update:Uint8Array,origin:unknown)=>{if(origin===peerOrigin)return;queueMicrotask(()=>{if(connected)Y.applyUpdate(documents[1-index],update,peerOrigin);refresh()})});doc.on('afterTransaction',()=>queueMicrotask(refresh))})
document.querySelector('#offline')!.addEventListener('click',()=>{connected=false;refresh()})
document.querySelector('#sync')!.addEventListener('click',()=>{const a=Y.encodeStateAsUpdate(documents[0]),b=Y.encodeStateAsUpdate(documents[1]);Y.applyUpdate(documents[0],b,peerOrigin);Y.applyUpdate(documents[1],a,peerOrigin);connected=true;refresh()})
queueMicrotask(refresh)
window.addEventListener('pagehide',()=>{editors.forEach(editor=>editor.destroy());histories.forEach(history=>history.destroy());registrations.forEach(remove=>remove());disconnect.forEach(close=>close());documents.forEach(doc=>doc.destroy())},{once:true})
