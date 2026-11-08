/** Reproduce the active binding failure and verify the replacement storage core.
 * No browser, server, production account, credential or reminder channel used. */
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {initProseMirrorDoc,prosemirrorToYDoc,updateYFragment,yXmlFragmentToProseMirrorRootNode} from '../examples/hdoc/editor/node_modules/@tiptap/y-tiptap/dist/y-tiptap.js'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {blockMoveMeta,blockTarget,rootBlocks,transformBlocks} from '../examples/hdoc/editor/src/commands/blocks.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
const output=process.argv[2];assert.ok(output,'Supply an evidence JSON path')
const schema=getSchema(schemaExtensions),initial=schema.nodeFromJSON({type:'doc',content:['a','b','c'].map(id=>({type:'paragraph',attrs:{hcdBlockId:id},content:[{type:'text',text:id.toUpperCase()}]}))})
function exchange(a:Y.Doc,b:Y.Doc){const au=Y.encodeStateAsUpdate(a),bu=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,bu);Y.applyUpdate(b,au)}
function moveDocument(doc:any){const state=EditorState.create({schema,doc}),tr=state.tr;assert.equal(transformBlocks(tr,'block.down',undefined,blockTarget(state,rootBlocks(doc).slice(0,1))!),true);return tr}
const evidence:any={version:'hcd-structural-concurrency-evidence/1',storageProtocol:'hcd-semantic-blocks/3',textFlowProtocol:'hcd-text-flow/1',scope:'In-process real Yjs replicas, production block command builder and installed Tiptap binding. Replacement core is not integrated into the live editor/save protocol yet.',legacy:[],replacement:{}}
for(const edited of ['a','b']){
 const a=prosemirrorToYDoc(initial),b=new Y.Doc();Y.applyUpdate(b,Y.encodeStateAsUpdate(a))
 try{
  const fragment=a.getXmlFragment('prosemirror'),binding=initProseMirrorDoc(fragment,schema),tr=moveDocument(binding.doc)
  updateYFragment(a,fragment,tr.doc,binding.meta)
  const target=b.getXmlFragment('prosemirror').toArray().find((node:any)=>node.getAttribute('hcdBlockId')===edited) as Y.XmlElement,text=target.get(0) as Y.XmlText
  text.insert(text.length,' Peer!');exchange(a,b)
  const projected=yXmlFragmentToProseMirrorRootNode(fragment,schema)
  evidence.legacy.push({editedBlock:edited,movedBlock:'a',concurrentInputLost:!projected.textContent.includes('Peer!'),projection:projected.toJSON()})
 }finally{a.destroy();b.destroy()}
}
const a=new Y.Doc(),sa=new SemanticBlockStore(a,schema),keys=sa.initialize(initial),b=new Y.Doc(),recovered=new Y.Doc()
Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const sb=new SemanticBlockStore(b,schema),history=sa.undoManager()
try{
 const before=sa.blocks(),text=sa.contents.get(keys[0])!.get(0),tr=moveDocument(sa.project()),intent=tr.getMeta(blockMoveMeta) as {first:number;count:number}
 const after:any[]=[];tr.doc.forEach(node=>after.push({key:before.find(block=>block.node.attrs.hcdBlockId===node.attrs.hcdBlockId)!.key,node}))
 sa.reconcile(before,after,{movedKeys:before.slice(intent.first,intent.first+intent.count).map(block=>block.key)})
 const peer=sb.content(keys[0]);sb.update(keys[0],peer,peer.type.createChecked(peer.attrs,[...peer.content.content,schema.text(' Peer!',[schema.marks.bold.create()])]))
 exchange(a,b);exchange(a,b)
 const sameTextIdentity=sa.contents.get(keys[0])!.get(0)===text
 assert.ok(sameTextIdentity);assert.equal(sa.project().textContent,'BA Peer!C');assert.ok(sa.project().eq(sb.project()))
 evidence.replacement.afterMerge=sa.project().toJSON();evidence.replacement.samePhysicalTextIdentity=sameTextIdentity
 history.undo();exchange(a,b);assert.equal(sa.project().textContent,'A Peer!BC');evidence.replacement.afterUndo=sa.project().toJSON()
 history.redo();exchange(a,b);assert.equal(sa.project().textContent,'BA Peer!C');evidence.replacement.afterRedo=sa.project().toJSON()
 Y.applyUpdate(recovered,Y.encodeStateAsUpdate(a));const restored=new SemanticBlockStore(recovered,schema)
 assert.ok(restored.project().eq(sa.project()));assert.deepEqual(restored.keys(),sa.keys())
 evidence.replacement.snapshotRecoveryVerified=true;evidence.replacement.peerTextAndBoldPreserved=true
 await writeFile(output,JSON.stringify(evidence,null,2)+'\n')
 console.log('PASS replacement core: concurrent moved-block input, physical text identity, own undo/redo, duplicate update exchange and snapshot recovery')
}finally{history.destroy();a.destroy();b.destroy();recovered.destroy()}
