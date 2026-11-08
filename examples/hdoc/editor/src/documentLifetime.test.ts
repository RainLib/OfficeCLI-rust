import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {retainDocument} from './documentLifetime.ts'
test('effect replay retains a usable document; real unmount destroys once after plugin cleanup',async()=>{
 const doc=new Y.Doc();let destroyed=0;doc.on('destroy',()=>destroyed++)
 const first=retainDocument(doc);first();const replay=retainDocument(doc)
 await Promise.resolve();assert.equal(destroyed,0);doc.getText('text').insert(0,'still live')
 first();assert.equal(destroyed,0);replay();assert.equal(destroyed,0)
 await Promise.resolve();assert.equal(destroyed,1);replay();await Promise.resolve();assert.equal(destroyed,1)
})
test('document replacement disposes only the old document and parallel leases are independent',async()=>{
 const a=new Y.Doc(),b=new Y.Doc();let ad=0,bd=0;a.on('destroy',()=>ad++);b.on('destroy',()=>bd++)
 const a1=retainDocument(a),a2=retainDocument(a),b1=retainDocument(b);a1();await Promise.resolve();assert.equal(ad,0)
 a2();await Promise.resolve();assert.equal(ad,1);assert.equal(bd,0);b1();await Promise.resolve();assert.equal(bd,1)
})
