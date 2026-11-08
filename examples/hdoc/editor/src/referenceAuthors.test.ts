import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {ReferenceAuthorLedger,actorName,validActorId,observeCoordinatorChanges} from './referenceAuthors.ts'
import type {SnapshotBlock} from './checkpointSnapshot.ts'
const ref=(id='1',target='person:一')=>({type:'hcd.mention' as const,version:1 as const,mentionId:`m_${id.repeat(32)}`,target:{kind:'person',id:target},snapshot:{label:'同名'}})
const blocks=(references= [ref()]):SnapshotBlock[]=>[{blockId:'p',content:{kind:'paragraph',inlines:references.map(reference=>({text:'@同名',reference}))}}]
const alice={userId:'org:用户甲',displayName:'甲',generation:1},bob={userId:'bob',displayName:'Bob',generation:2}
test('reference authors come from the specific authenticated addition, not the saver or unrelated text editor',()=>{
 const ledger=new ReferenceAuthorLedger(blocks([]),blocks([]));ledger.observe(blocks(),alice);ledger.observe([{...blocks()[0],content:{kind:'paragraph',inlines:[{text:'Bob typed'},...blocks()[0].content.inlines]}}],bob)
 assert.deepEqual(ledger.capture(blocks()).referenceAuthors,[{mentionId:ref().mentionId,userId:alice.userId}]);assert.equal(ledger.capture(blocks()).contributors[0].userId,alice.userId)
 ledger.observe(blocks([ref('1','person:二')]),bob);assert.equal(ledger.capture(blocks([ref('1','person:二')])).referenceAuthors[0].userId,'bob')
})
test('committed references, moves and labels need no new relationship; copy and resurrection are attributed',()=>{
 const original=blocks(),ledger=new ReferenceAuthorLedger(original,original);ledger.observe(blocks([{...ref(),snapshot:{label:'新姓名'}}]),bob);assert.deepEqual(ledger.capture(original).referenceAuthors,[])
 ledger.observe(blocks([ref(),ref('2')]),alice);assert.deepEqual(ledger.capture(blocks([ref(),ref('2')])).referenceAuthors,[{mentionId:ref('2').mentionId,userId:alice.userId}])
 ledger.commit(blocks([ref(),ref('2')]));ledger.observe(blocks([ref('2')]),bob);ledger.commit(blocks([ref('2')]));ledger.observe(blocks([ref(),ref('2')]),bob);assert.deepEqual(ledger.capture(blocks([ref(),ref('2')])).referenceAuthors,[{mentionId:ref().mentionId,userId:'bob'}])
})
test('missing or unbound recovery authors are not repaired by another person typing; scoped signed entries can recover',()=>{
 const ledger=new ReferenceAuthorLedger(blocks(),blocks([]));ledger.observe(blocks(),bob);assert.throws(()=>ledger.capture(blocks()),/reference-authors-unbound/)
 ledger.observe(blocks([]));ledger.observe(blocks(),alice);const proof=ledger.proof(),recovered=new ReferenceAuthorLedger(blocks(),blocks([]));recovered.restore(proof);assert.deepEqual(recovered.capture(blocks()).referenceAuthors,ledger.capture(blocks()).referenceAuthors)
 assert.throws(()=>recovered.restore([{...proof[0],target:{kind:'person',id:'other'}}]),/schema/)
 ledger.observe(blocks([]));ledger.observe(blocks());assert.throws(()=>ledger.capture(blocks()),/unbound/)
})
test('synchronous observation separates consecutive Yjs transactions before deferred hooks run',async()=>{
 const doc=new Y.Doc(),seen:Array<[string,unknown]>=[],stop=observeCoordinatorChanges(doc,(actor,origin)=>seen.push([actor!.userId!,doc.getMap('x').get('value')]),origin=>origin as {userId:string})
 doc.transact(()=>doc.getMap('x').set('value','A'),alice);doc.transact(()=>doc.getMap('x').set('value','B'),bob)
 assert.deepEqual(seen,[[alice.userId,'A'],['bob','B']]);stop();doc.transact(()=>doc.getMap('x').set('value','C'),alice);assert.equal(seen.length,2);doc.destroy()
})
test('stable actor IDs allow namespaces and Unicode, while names obey native UTF-8 byte limits',()=>{
 assert.equal(validActorId('org:人员/甲'),true);assert.equal(validActorId('bad\nactor'),false);assert.equal(validActorId('x'.repeat(257)),false);assert.equal(validActorId('\ud800'),false)
 assert.equal(new TextEncoder().encode(actorName('中'.repeat(64))).length,63);assert.equal(actorName('a\nb'),'ab')
})
