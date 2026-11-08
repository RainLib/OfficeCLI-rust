import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {recoveryImagesAlreadyIntegrated} from './recoveryImageCausality.ts'

test('only image items and their deletions already integrated in the room may be merged',()=>{
 const room=new Y.Doc({gc:false}),packet=new Y.Doc({gc:false}),other=new Y.Doc({gc:false});try{
  room.getMap('hcdImageDrafts').set('one',{value:1});Y.applyUpdate(packet,Y.encodeStateAsUpdate(room));assert.equal(recoveryImagesAlreadyIntegrated(packet,room),true)
  packet.getMap('hcdImageDrafts').delete('one');assert.equal(recoveryImagesAlreadyIntegrated(packet,room),false)
  room.getMap('hcdImageDrafts').delete('one');assert.equal(recoveryImagesAlreadyIntegrated(packet,room),true)
  packet.getMap('hcdImageDrafts').set('two',{value:2});assert.equal(recoveryImagesAlreadyIntegrated(packet,room),false)
  Y.applyUpdate(other,Y.encodeStateAsUpdate(packet));assert.equal(recoveryImagesAlreadyIntegrated(packet,other),true)
 }finally{room.destroy();packet.destroy();other.destroy()}
})
test('unknown garbage-collected state and pending deletions are rejected',()=>{
 const room=new Y.Doc({gc:false}),packet=new Y.Doc({gc:false});try{const deleted=new Y.Doc();deleted.getArray('nested').insert(0,[new Y.Map()]);(deleted.getArray('nested').get(0) as Y.Map<unknown>).set('x',1);deleted.getArray('nested').delete(0);Y.applyUpdate(packet,Y.encodeStateAsUpdate(deleted));assert.ok([...packet.store.clients.values()].flat().some(entry=>entry instanceof Y.GC));assert.equal(recoveryImagesAlreadyIntegrated(packet,room),false);Y.applyUpdate(room,Y.encodeStateAsUpdate(packet));assert.equal(recoveryImagesAlreadyIntegrated(packet,room),true);deleted.destroy()}finally{room.destroy();packet.destroy()}
})

test('an unresolved delete set or a colliding non-image clock cannot pass the image gate',()=>{
 const packet=new Y.Doc({gc:false}),room=new Y.Doc({gc:false}),incomplete=new Y.Doc({gc:false});try{
  packet.clientID=12345;room.clientID=12345;packet.getMap('hcdImageDrafts').set('one',{value:1});room.getMap('body').set('one',{value:1});assert.equal(recoveryImagesAlreadyIntegrated(packet,room),false)
  packet.getMap('hcdImageDrafts').delete('one');const deletionOnly=Y.encodeStateAsUpdate(packet,Y.encodeStateVector(packet));Y.applyUpdate(incomplete,deletionOnly);assert.ok(incomplete.store.pendingDs);assert.equal(recoveryImagesAlreadyIntegrated(incomplete,room),false)
 }finally{packet.destroy();room.destroy();incomplete.destroy()}
})
