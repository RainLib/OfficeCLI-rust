/** Owned React/SDK interaction fixture; no native or user document writes. */
import {StrictMode,useEffect,useMemo,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Editor,Extension,getSchema} from '@tiptap/core'
import * as Y from 'yjs'
import {I18nProvider} from '../src/i18n.tsx'
import {schemaExtensions} from '../src/schema.ts'
import {SemanticStructureIdentity} from '../src/semanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from '../src/semanticInlineNode.ts'
import {SemanticBlockStore,semanticBlockOrigin} from '../src/semanticBlockStore.ts'
import {semanticStructureBinding} from '../src/semanticStructureBinding.ts'
import {InlineContainerExtensionsProvider,useInlineContainerExtensions} from '../src/InlineContainerExtensions.tsx'
import {InlineContainerRegistry,type InlineContainerDefinition} from '../src/inlineContainerRegistry.ts'
import {prepareInlineContainerTransaction,selectedInlineContainer} from '../src/inlineContainerCommands.ts'
import {prepareInlineContainerHistoryGuard} from '../src/inlineContainerPreservation.ts'
import {resolveInlineContainerEdits} from '../src/inlineContainerEdits.ts'
import {InlineContainerProperties} from '../src/ExtensionProperties.tsx'
import {useInlineContainerEdits} from '../src/useExtensionEdits.ts'
import {WordNodeResourcePanel} from '../src/WordNodeResourcePanel.tsx'
import {useInlineNodeResources} from '../src/useSemanticNodeResources.ts'
import {LocalDraftJournal,draftIdentity} from '../src/localDrafts.ts'
import {NodeExtensionRegistry,stableExtension} from '../src/extensionRegistry.ts'
import {nodeResourceHash,type WordNodeResourceDraft} from '../src/wordNodeResources.ts'
import {readInlineContainerPayload,type InlineContainerPayload} from '../src/inlineContainerPayload.ts'
import type {ResourceNodePayload} from '../src/nodeResourceModel.ts'
import {inlineProtocol} from '../src/collaborationProtocol.ts'
import type {Session} from '../src/api.ts'
import {CommandAction,CommandPalette,useCommands} from '../src/commands/react.tsx'
import {useSlashMenu} from '../src/commands/SlashMenu.tsx'
import {prepareSlashTransaction} from '../src/commands/slashTransaction.ts'
import {canInsertExtension} from '../src/extensionCommands.ts'
import type {CommandContext} from '../src/commands/types.ts'
import '../src/style.css'

const base:InlineContainerDefinition={type:'example.field',version:1,display:'inline',contentModel:'inline',label:'业务字段',defaultData:{title:'业务字段'},validate:data=>typeof data.title==='string'&&!!data.title,fallback:data=>String(data.title),properties:[{key:'title',label:'名称',kind:'text',required:true}]}
const definitions={0:[],1:[base],2:[{...base,version:2,migrations:[{fromVersion:1,validate:base.validate,migrate:(data:Readonly<Record<string,unknown>>)=>({title:data.title+' v2'})}]}]} satisfies Record<number,InlineContainerDefinition[]>
const resourceMode=new URL(location.href).searchParams.has('resources'),session:Session={documentId:'owned-inline-resource-fixture',format:'html',token:'local-fixture-only',scope:'write',apiUrl:location.origin+'/fixture-only',collabUrl:location.origin,collaborationEpoch:0,collaborationProtocol:inlineProtocol}
const docs=[new Y.Doc({gc:false}),new Y.Doc({gc:false})],peer=Object.freeze({kind:'preview-peer'})
const seed=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
let documentJournal:LocalDraftJournal|null=null
if(resourceMode){documentJournal=await LocalDraftJournal.open(await draftIdentity(session,'alice',location.href));const restored=await documentJournal.load();try{Y.applyUpdate(docs[0],Y.encodeStateAsUpdate(restored))}finally{restored.destroy()}}
const initialStore=new SemanticBlockStore(docs[0],seed,undefined,{inlineContainers:true})
if(!initialStore.initialized){const payload={...new InlineContainerRegistry([base]).create(base.type),instanceId:'x_'+'f'.repeat(32)};initialStore.initialize(seed.nodes.doc.createChecked(null,seed.nodes.paragraph.createChecked(null,resourceMode?seed.nodes.hcdExtensionInlineContainer.createChecked({extension:payload},seed.text('文件目标正文😀')):undefined)))}
docs[0].getMap('hcdSchema').set('inlineContainers',1);Y.applyUpdate(docs[1],Y.encodeStateAsUpdate(docs[0]),peer)
if(documentJournal){await documentJournal.bind(docs[0]);await documentJournal.flush()}
const resourceBytes=new Map<string,Blob>()
let exchanging=true
const stops=docs.map((doc,index)=>{const update=(bytes:Uint8Array,origin:unknown)=>{if(exchanging&&origin!==peer)queueMicrotask(()=>Y.applyUpdate(docs[1-index],bytes,peer))};doc.on('update',update);return()=>doc.off('update',update)})
function ConnectionTools(){const[online,setOnline]=useState(true);return <button onClick={()=>{if(online){exchanging=false;setOnline(false)}else{const updates=docs.map(doc=>Y.encodeStateAsUpdate(doc));updates.forEach((bytes,index)=>Y.applyUpdate(docs[1-index],bytes,peer));exchanging=true;setOnline(true)}}}>{online?'断开测试同步':'合并测试副本'}</button>}
function Shell({index}:{index:0|1}){
 const [mode,setMode]=useState<0|1|2>(1),configuration=useMemo(()=>({nodes:definitions[mode]}),[mode])
 return <section className="inline-command-pane"><header><h2>{index?'Bob':'Alice'}</h2><button onClick={()=>setMode(0)}>卸载 {index?'Bob':'Alice'} 扩展</button><button onClick={()=>setMode(1)}>注册 {index?'Bob':'Alice'} v1</button><button onClick={()=>setMode(2)}>注册 {index?'Bob':'Alice'} v2</button></header><InlineContainerExtensionsProvider value={configuration}><Pane index={index}/></InlineContainerExtensionsProvider></section>
}
function Pane({index}:{index:0|1}){
 const registry=useInlineContainerExtensions(),latest=useRef(registry);latest.current=registry
 const element=useRef<HTMLDivElement>(null),history=useRef<Y.UndoManager|null>(null),[editor,setEditor]=useState<Editor|null>(null),[,render]=useState(0),[error,setError]=useState(''),[palette,setPalette]=useState(false),[title,setTitle]=useState('已更新字段'),[readonly,setReadonly]=useState(false),[deferFiles,setDeferFiles]=useState(true)
 const resources=useMemo(()=>new NodeExtensionRegistry([],()=>{},{archive:async input=>{const hash=await nodeResourceHash(new Uint8Array(await input.file.arrayBuffer()));resourceBytes.set(hash,input.file);return{key:input.key,name:input.name,hash,byteLength:input.file.size,mediaType:input.file.type}},read:async resource=>{const blob=resourceBytes.get(resource.hash);if(!blob)throw new Error('fixture-resource-rearchive');return blob}}),[])
 useEffect(()=>resources.connect(),[resources])
 const nodeFiles=useInlineNodeResources({session,userId:index?'bob':'alice',localJournal:resourceMode?documentJournal:null,registry:resources,ready:()=>!!editor&&!editor.isDestroyed&&!readonly})
 const nodeEdits=useInlineContainerEdits(docs[index],registry,!readonly)
 useEffect(()=>{
  let store:SemanticBlockStore
  const Binding=Extension.create({name:'inlinePreviewBinding',addExtensions(){return[SemanticStructureIdentity]},addProseMirrorPlugins(){store=new SemanticBlockStore(docs[index],this.editor.schema,undefined,{inlineContainers:true});if(!store.initialized)store.initialize(this.editor.schema.nodes.doc.createChecked(null,this.editor.schema.nodes.paragraph.createChecked()));docs[index].getMap('hcdSchema').set('inlineContainers',1);return[semanticStructureBinding(store,{canWrite:()=>this.editor.isEditable,onError:cause=>setError(String(cause))})]}})
  const current=new Editor({element:element.current!,extensions:[...schemaExtensions,SemanticInlineContainerNode.configure({registry:()=>latest.current,onError:cause=>setError(cause instanceof Error?cause.message:String(cause))}),Binding],editorProps:{attributes:{role:'textbox','aria-multiline':'true','aria-label':`${index?'Bob':'Alice'} 编辑区`}}})
  history.current=store!.undoManager(true,before=>prepareInlineContainerHistoryGuard(before,latest.current.resolve))
  const transaction=()=>render(value=>value+1)
  current.on('transaction',transaction);setEditor(current)
  return()=>{current.off('transaction',transaction);current.destroy();history.current?.destroy();history.current=null}
 },[index])
 useEffect(()=>{if(editor&&!editor.isDestroyed)editor.view.dispatch(editor.state.tr.setMeta('hcd-node-registry',true))},[editor,registry])
 const selected=editor&&!editor.isDestroyed?selectedInlineContainer(editor.state):null,edits=selected?nodeEdits.get(selected.value.instanceId):undefined
 const commands=useCommands(instance=>({instanceId:instance,documentId:'owned-inline',format:'html',profile:'flow',locale:'zh-CN',platform:'mac',ready:!!editor&&!editor.isDestroyed,readOnly:readonly,historical:false,revision:0,selection:{kind:'text',empty:editor?.state.selection.empty??true,anchor:editor?`${editor.state.selection.from}:${editor.state.selection.to}`:'',protected:false,text:'',parentTypes:['paragraph']},capabilities:{customNodes:true,inlineContainers:true},actions:{'node.insert':{enabled:!!editor&&canInsertExtension(editor.state)},'node.update':{enabled:!!selected&&!!registry.resolve(selected.value)},'node.delete':{enabled:!!selected&&!!registry.resolve(selected.value)},'node.resources':{enabled:!!selected&&!!registry.resolve(selected.value)&&!Object.keys(edits?.conflicts??{}).length},'node.resolve':{enabled:!!selected&&!!edits},'node.migrate':{enabled:!!selected&&registry.migrationAvailable(selected.value)},'edit.undo':{enabled:!!history.current?.undoStack.length},'edit.redo':{enabled:!!history.current?.redoStack.length}}} as CommandContext),(id,input,_signal,insertion)=>{
  if(!editor||editor.isDestroyed)return false
  if(id==='edit.undo'||id==='edit.redo'){history.current?.stopCapturing();if(id==='edit.undo')history.current?.undo();else history.current?.redo();return true}
  if(id==='node.resolve'){const request=input as {instanceId:string;ids:string[];choices:Record<string,string>};return resolveInlineContainerEdits(docs[index],registry,request.instanceId,request.ids,request.choices,semanticBlockOrigin)}
  if(insertion){if('kind' in insertion.target)return false;const request=input as {type:string},value=registry.create(request.type),commit=prepareSlashTransaction(editor,id,{extension:value},insertion.target);if(!commit)return false;insertion.stage(()=>{history.current?.stopCapturing();try{return commit()}finally{history.current?.stopCapturing()}});return true}
  const prepared=prepareInlineContainerTransaction(editor,registry,id,input);history.current?.stopCapturing();try{return prepared?.commit()?prepared.value??true:false}finally{history.current?.stopCapturing()}
 },cause=>setError(cause instanceof Error?cause.message:String(cause)))
 const slash=useSlashMenu(editor,commands.registry,commands.insert,readonly)
 const locate=(id:string)=>{if(!editor)return false;let pos:number|undefined;editor.state.doc.descendants((node,at)=>{if(node.attrs.extension?.instanceId===id)pos=at});if(pos===undefined)return false;editor.chain().focus().setNodeSelection(pos).run();return true}
 const attach=async(draft:WordNodeResourceDraft<ResourceNodePayload>,expected:ResourceNodePayload)=>{const current=editor&&!editor.isDestroyed?selectedInlineContainer(editor.state):null;if(!current||draft.expected.schemaVersion!=='hcd.extension/3'||current.value.instanceId!==draft.expected.instanceId||stableExtension(current.value)!==stableExtension(expected))throw new Error('extensionChanged');const value=await commands.registry.execute('node.resources',{instanceId:expected.instanceId,expected,resources:[...(expected.resources??[]),draft.resource]});return readInlineContainerPayload(value)}
 const archive=async(file:File,expected:InlineContainerPayload)=>{if(!nodeFiles.client)throw new Error('word-node-resource-unavailable');let applied=expected;await nodeFiles.client.start(file,expected,'body',deferFiles?undefined:async draft=>{applied=await attach(draft,expected);return applied});await documentJournal?.flush();return applied}

 return <div onKeyDownCapture={event=>{if(slash.handleKey(event.nativeEvent)){event.preventDefault();event.stopPropagation()}}}><nav aria-label={`${index?'Bob':'Alice'} 操作区`}><CommandAction id="node.inline.insert.example.field" registry={commands.registry} run={commands.run}/><button onClick={()=>setPalette(true)}>打开 {index?'Bob':'Alice'} 命令面板</button><CommandAction id="edit.undo" registry={commands.registry} run={commands.run}/><CommandAction id="edit.redo" registry={commands.registry} run={commands.run}/><button onClick={()=>{const next=!readonly;editor?.setEditable(!next);setReadonly(next)}}>{readonly?'恢复编辑':'只读'}</button></nav><div ref={element} className="inline-command-editor"/>{slash.menu}
 <label>字段名称<input aria-label={`${index?'Bob':'Alice'} 字段名称`} value={title} onChange={event=>setTitle(event.target.value)}/></label><button disabled={!selected||!registry.resolve(selected.value)||readonly} onClick={()=>selected&&commands.run('node.update',{instanceId:selected.value.instanceId,expected:selected.value,data:{title}})}>应用 {index?'Bob':'Alice'} 属性</button><button disabled={!selected||!registry.migrationAvailable(selected.value)||readonly} onClick={()=>{if(selected){const preview=registry.previewMigration(selected.value);if(preview)commands.run('node.migrate',{instanceId:selected.value.instanceId,expected:selected.value,after:preview.after})}}}>迁移 {index?'Bob':'Alice'} 字段</button>
 {resourceMode&&<><p>测试传输将附件保存在本页内存；真实 IndexedDB 保留文件选择与正文。刷新后需要显式重新归档、核对和关联。</p><label><input type="checkbox" checked={deferFiles} onChange={event=>setDeferFiles(event.target.checked)}/>仅归档，稍后确认关联</label>{nodeFiles.pending()&&<p role="status">存在未完成文件，保存门禁保持关闭</p>}{nodeFiles.client&&<WordNodeResourcePanel client={nodeFiles.client} selected={selected?.value??null} disabled={readonly} onLocate={locate} onApply={async(draft,expected)=>{await nodeFiles.client!.attach(draft.id,value=>attach(value,expected))}}/>}{selected&&<InlineContainerProperties key={selected.value.instanceId} node={selected.value} edits={edits} registry={registry} resources={resources} commands={commands.registry} readOnly={readonly} onArchive={archive}/>}</>}
 <p role="status">注册 {registry.list().length} 类 · 正文：{editor&&!editor.isDestroyed?editor.state.doc.textContent:''} · 版本：{selected?.value.version??'未选择'}</p>{error&&<p role="alert">{error}</p>}{palette&&<CommandPalette registry={commands.registry} run={commands.run} onClose={()=>setPalette(false)}/>}</div>
}
const root=createRoot(document.getElementById('root')!)
root.render(<StrictMode><I18nProvider initialLocale="zh-CN"><div className="hcd-surface"><h1>行内容器统一命令验证</h1><p>独立 SDK/React 入口；两份真实编辑器交换本机 Yjs 更新，不写入原生或用户文档。</p>{resourceMode&&<ConnectionTools/>}<div className="inline-command-panes"><Shell index={0}/><Shell index={1}/></div></div></I18nProvider></StrictMode>)
window.addEventListener('pagehide',()=>{stops.forEach(stop=>stop());root.unmount();documentJournal?.close();docs.forEach(doc=>doc.destroy())},{once:true})
