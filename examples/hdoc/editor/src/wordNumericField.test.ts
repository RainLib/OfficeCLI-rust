import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import * as Y from 'yjs'
import {EditorState} from '@tiptap/pm/state'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {builtinWordNodes,wordNumericFieldDefinition,wordNumericFieldType,wordNumericFieldsEnabled,wordNumericFieldHint} from './wordNumericField.ts'
import {wordRegionSchema} from './wordRegionStore.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {extensionNodes} from './extensionNode.ts'
import {ExtensionProperties} from './ExtensionProperties.tsx'
import {I18nProvider} from './i18n.tsx'
import type {EditorCommandService} from './commands/types.ts'
import type {NodeExtensionDefinition} from './extensionTypes.ts'

test('built-in field creation requires the exact native capability and Word room',()=>{
 const session={format:'docx',flowLayoutVersion:2 as const,collaborationProtocol:'hcd-word-regions/2' as const,wordNumericFields:'inline-v1' as const}
 assert.equal(wordNumericFieldsEnabled(session),true);assert.equal(builtinWordNodes(session)[0].type,wordNumericFieldType)
 for(const change of [{wordNumericFields:undefined},{wordNumericFields:'future-v2'},{format:'html'},{flowLayoutVersion:1},{collaborationProtocol:'hcd-word-regions/1'}])assert.equal(builtinWordNodes({...session,...change} as typeof session).length,0)
 assert.equal(builtinWordNodes(undefined).length,0)
})
test('field data cannot introduce instructions, fake counts, unsupported formats or attachments',()=>{
 const registry=new NodeExtensionRegistry([wordNumericFieldDefinition]),value=registry.create(wordNumericFieldType)
 assert.equal(value.fallback.text,'[PAGE]');assert.equal(value.exports?.docx?.support,'semantic');assert.equal(value.exports?.html?.support,'static')
 for(const data of [{kind:'DDE',format:'inherit'},{kind:'PAGE',format:'CHARFORMAT'},{kind:'PAGE',format:'inherit',instruction:'INCLUDETEXT file'},{kind:'PAGE',format:'inherit',cached:'99'}])assert.throws(()=>registry.update(value,data))
 const resource={key:'file',hash:'a'.repeat(64),byteLength:1,name:'a.bin',mediaType:'application/octet-stream'}
 assert.throws(()=>registry.create(wordNumericFieldType,undefined,[resource]));assert.throws(()=>registry.updateResources(value,[resource]))
 assert.equal(registry.resolve({...value,version:2}),undefined)
})
test('shared select properties validate and freeze choices while ordinary resources remain available',()=>{
 const choices=[{value:'a',label:'A'},{value:'b',label:'B'}],definition:NodeExtensionDefinition={type:'example.selection',version:1,display:'inline',label:'Selection',defaultData:{choice:'a'},validate:()=>true,fallback:()=> 'Selection',properties:[{key:'choice',label:'Choice',kind:'select',required:true,options:choices}]}
 const registry=new NodeExtensionRegistry([definition]),node=registry.create(definition.type)
 choices[0].value='changed';assert.equal(registry.resolve(node)?.properties?.[0].options?.[0].value,'a')
 assert.throws(()=>registry.update(node,{choice:'c'}));assert.equal(registry.update(node,{choice:'b'}).data.choice,'b')
 const resource={key:'file',hash:'b'.repeat(64),byteLength:1,name:'a.bin',mediaType:'application/octet-stream'}
 assert.equal(registry.updateResources(node,[resource]).resources?.length,1)
 for(const options of [[],[{value:'a',label:'A'},{value:'a',label:'duplicate'}],[{value:'',label:'blank'}]])assert.throws(()=>new NodeExtensionRegistry([{...definition,properties:[{key:'choice',label:'Choice',kind:'select',options}]}]))
})
test('field properties expose finite choices, read-only gates and the calculation boundary without an attachment picker',()=>{
 const registry=new NodeExtensionRegistry([wordNumericFieldDefinition]),node=registry.create(wordNumericFieldType),commands={execute:async()=>true} as unknown as EditorCommandService
 const render=(readOnly:boolean)=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(ExtensionProperties,{node,registry,commands,readOnly})}))
 const html=render(false);assert.match(html,/页码类型<select/);assert.match(html,/编号格式<select/);assert.match(html,/本编辑器尚未计算页码/);assert.doesNotMatch(html,/type="file"/)
 assert.equal((render(true).match(/<select[^>]*disabled/g)??[]).length,2);assert.match(html,/部分兼容阅读器可能保留占位/)
})
test('section-count views disclose reader compatibility without inventing calculated values',()=>{
 assert.match(wordNumericFieldHint({kind:'SECTIONPAGES',format:'inherit'},'zh-CN'),/部分兼容阅读器可能保留占位/)
 assert.match(wordNumericFieldHint({kind:'SECTIONPAGES',format:'arabic'},'en-US'),/SECTIONPAGES/)
 assert.doesNotMatch(wordNumericFieldHint({kind:'PAGE',format:'upperRoman'},'zh-CN'),/部分兼容阅读器/)
})
test('field property changes and personal undo preserve peer text in the permanent collaborative model',()=>{
 const registry=new NodeExtensionRegistry([wordNumericFieldDefinition]),node=registry.create(wordNumericFieldType),schema=wordRegionSchema(),a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema)
 sa.initialize(schema.nodeFromJSON({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'before '},{type:'hcdExtensionInline',attrs:{extension:node}}]}]}));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
 const undo=sa.undoManager();undo.stopCapturing()
 try{
  const current=sa.blocks(),selected=extensionNodes(sa.project()).get(node.instanceId)!,updated=registry.update(selected.value,{kind:'NUMPAGES',format:'upperRoman'}),tr=EditorState.create({schema,doc:sa.project()}).tr.setNodeMarkup(selected.position,undefined,{...sa.project().nodeAt(selected.position)!.attrs,extension:updated})
  sa.reconcile(current,current.map((block,index)=>({key:block.key,node:tr.doc.child(index)})));Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
  const peers=sb.blocks(),peerTr=EditorState.create({schema,doc:sb.project()}).tr.insertText('peer ',1);sb.reconcile(peers,peers.map((block,index)=>({key:block.key,node:peerTr.doc.child(index)})));Y.applyUpdate(a,Y.encodeStateAsUpdate(b))
  undo.undo();assert.match(sa.project().textContent,/peer/);assert.deepEqual(extensionNodes(sa.project()).get(node.instanceId)?.value.data,{kind:'PAGE',format:'inherit'})
  undo.redo();assert.match(sa.project().textContent,/peer/);assert.equal(extensionNodes(sa.project()).get(node.instanceId)?.value.fallback.text,'[NUMPAGES]')
 }finally{undo.destroy();a.destroy();b.destroy()}
})
