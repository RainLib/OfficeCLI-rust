import {TiptapTransformer} from '@hocuspocus/transformer'
import {upgradeSourceIdentity} from './sourceIdentityMigration.ts'
import {checkpointContents} from './checkpointSnapshot.ts'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {getSchema} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {Slice} from '@tiptap/pm/model'
import {ySyncPluginKey} from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import {schemaExtensions,projectionToJson,jsonToSnapshot,clearPastedBlockIds,type Projection} from './schema.ts'
import {readExtensionNode,extensionPreservationPlugin,extensionNodes,type ExtensionNodePayload} from './extensionNode.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const inline:ExtensionNodePayload={schemaVersion:'hcd.extension/1',instanceId:'x_'+'1'.repeat(32),type:'example.future',version:77,display:'inline',data:{future:{unknown:['中文<&😀',1,true,null]}},fallback:{text:'Readable inline'}}
const block:ExtensionNodePayload={...inline,instanceId:'x_'+'2'.repeat(32),display:'block',fallback:{text:'Readable block'}}
function projection():Projection{return{documentId:'doc',revision:2,blocks:[{blockId:'n_'+'a'.repeat(32),blockHash:'a'.repeat(64),region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:'before '},{text:inline.fallback.text,extension:inline},{text:' after'}]}},{blockId:'n_'+'b'.repeat(32),blockHash:'b'.repeat(64),region:'body',readOnly:false,content:{kind:'extension',extension:block,inlines:[{text:block.fallback.text,nodeId:'n_'+'c'.repeat(32)}]}}]}}
test('unknown inline and block extensions round-trip their complete inert envelopes and readable text',()=>{
 const p=projection(),doc=schema.nodeFromJSON(projectionToJson(p));doc.check();const snapshot=jsonToSnapshot(doc.toJSON());assert.deepEqual(snapshot[0].content.inlines[1].extension,inline);assert.deepEqual(snapshot[1].content.extension,block);assert.deepEqual(snapshot.map(x=>x.content.inlines.map(i=>i.text)),p.blocks.map(x=>x.content.inlines.map(i=>i.text)));assert.deepEqual([...extensionNodes(doc).values()].map(x=>x.value),[inline,block]);assert.match(doc.textBetween(0,doc.content.size,'\n'),/Readable inline/);assert.match(doc.textBetween(0,doc.content.size,'\n'),/Readable block/)
 const paste=clearPastedBlockIds(new Slice(doc.content,0,0));const copied=extensionNodes(schema.node('doc',null,paste.content));assert.equal(copied.size,2);assert.equal(jsonToSnapshot(schema.node('doc',null,paste.content).toJSON())[1].content.inlines[0].nodeId,undefined);assert.ok([...copied.keys()].every(id=>id!==inline.instanceId&&id!==block.instanceId));assert.deepEqual([...copied.values()].map(x=>x.value.data),[inline.data,block.data])
})
test('missing codecs retain atoms through unrelated typing and block destructive local edits',()=>{
 const doc=schema.nodeFromJSON(projectionToJson(projection()));let state=EditorState.create({schema,doc,plugins:[extensionPreservationPlugin()]});state=state.apply(state.tr.insertText('Keep ',1));assert.equal(extensionNodes(state.doc).size,2)
 const entry=extensionNodes(state.doc).get(inline.instanceId)!,before=state.doc;state=state.apply(state.tr.delete(entry.position,entry.position+1));assert.equal(state.doc,before)
 state=state.apply(state.tr.addMark(entry.position,entry.position+1,schema.mark('bold')));assert.equal(state.doc,before)
 const replacement={...inline,data:{retarget:'not permitted without codec'}};state=state.apply(state.tr.setNodeMarkup(entry.position,undefined,{extension:replacement}));assert.equal(state.doc,before)
 // Legitimate peer transactions can replace the inert envelope; local fallback
 // readers retain its new data without claiming they understand its schema.
 state=state.apply(state.tr.setNodeMarkup(entry.position,undefined,{extension:replacement}).setMeta(ySyncPluginKey,{isChangeOrigin:true}));assert.deepEqual(extensionNodes(state.doc).get(inline.instanceId)!.value.data,replacement.data)
})
test('extension atoms survive real Yjs peer merge and own undo/redo without dropping business fields',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema);sa.initialize(schema.nodeFromJSON(projectionToJson(projection())));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.deepEqual([...extensionNodes(sb.project()).values()].map(x=>x.value),[inline,block]);const undo=sa.undoManager(),p=sa.project()
 // Reconcile a normal text edit while retaining both unknown envelopes.
 const first=p.child(0),next=schema.node(first.type,first.attrs,[...first.content.content,schema.text(' more')]);sa.reconcile(sa.blocks(),sa.blocks().map((entry,index)=>({key:entry.key,node:index===0?next:entry.node})));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.equal(extensionNodes(sb.project()).size,2);undo.undo();assert.equal(extensionNodes(sa.project()).size,2);undo.redo();assert.equal(extensionNodes(sa.project()).size,2);assert.deepEqual([...extensionNodes(sa.project()).values()].map(x=>x.value.data),[inline.data,block.data]);undo.destroy();a.destroy();b.destroy()
})
test('malformed envelope models, prototype keys, unsafe numbers, cycles and excessive payloads fail closed',()=>{
 for(const value of [{...inline,schemaVersion:'hcd.extension/3'},{...inline,data:{__proto__:null,constructor:'unsafe'}},{...inline,data:{id:9007199254740992}},{...inline,data:{text:'x'.repeat(65536)}},{...inline,fallback:{text:'a\nb'}},{...inline,extra:'discard me'},{...inline,type:'hcd.mention'}])assert.throws(()=>readExtensionNode(value))
 const cycle:any={};cycle.self=cycle;assert.throws(()=>readExtensionNode({...inline,data:cycle}));assert.deepEqual(readExtensionNode({...inline,version:999}).data,inline.data)
})

test('legacy room source migration preserves inline atoms between ordinary spans and block envelopes',()=>{
 const p=projection();p.blocks[0].content.inlines.forEach((inline,index)=>inline.nodeId='n_'+String(index+1).repeat(32));const document=TiptapTransformer.toYdoc(projectionToJson(p),'default',schemaExtensions),before=checkpointContents(jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default')))
 document.getMap('hcdSchema').set('sourceIdentity',1);upgradeSourceIdentity(document,p,true);assert.equal(checkpointContents(jsonToSnapshot(TiptapTransformer.fromYdoc(document,'default'))),before);document.destroy()
})
