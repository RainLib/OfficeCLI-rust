import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {RoomProtocolGuard} from './roomProtocolGuard.ts'
import {legacyProtocol,structuralProtocol} from './collaborationProtocol.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
test('a default-fragment payload cannot mutate a structural room even when the caller names the new room',()=>{
 const document=new Y.Doc(),store=new SemanticBlockStore(document,schema),peer=new Y.Doc()
 store.initialize(schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked(null,schema.text('Original'))))
 const guard=new RoomProtocolGuard(document,structuralProtocol)
 try{
  Y.applyUpdate(peer,Y.encodeStateAsUpdate(document));peer.getXmlFragment('default').insert(0,[new Y.XmlElement('paragraph')])
  const before=Y.encodeStateAsUpdate(document);assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer)),/protocol-mismatch/);assert.deepEqual(Y.encodeStateAsUpdate(document),before)
  const [key]=store.keys(),node=store.content(key);store.update(key,node,node.type.createChecked(node.attrs,schema.text('Valid edit')))
  const valid=new Y.Doc();Y.applyUpdate(valid,Y.encodeStateAsUpdate(document));new SemanticBlockStore(valid,schema).move([key],null)
  guard.accept(Y.encodeStateAsUpdate(valid));assert.equal(store.project().textContent,'Valid edit');valid.destroy()
 }finally{guard.destroy();peer.destroy();document.destroy()}
})
test('a structural payload cannot be admitted under a legacy room name',()=>{
 const document=new Y.Doc(),peer=new Y.Doc(),guard=new RoomProtocolGuard(document,legacyProtocol)
 try{new SemanticBlockStore(peer,schema).initialize(schema.nodes.doc.createChecked(null,schema.nodes.paragraph.createChecked()));assert.throws(()=>guard.accept(Y.encodeStateAsUpdate(peer)),/protocol-mismatch/);assert.equal(document.getXmlFragment('default').length,0)}
 finally{guard.destroy();peer.destroy();document.destroy()}
})
