import {test} from 'node:test'
import assert from 'node:assert/strict'
import {compareRecoveryImagePeers} from './recoveryImagePeers.ts'
import type {SharedImageDraft} from './collaborativeImages.ts'

const base={nodeId:'n_'+'a'.repeat(32),visualHash:'b'.repeat(64),assetHash:'c'.repeat(64),geometry:{unit:'pt' as const,x:0,y:0,width:20,height:10}}
const draft:SharedImageDraft={intentId:crypto.randomUUID(),clientId:1,ancestors:[],revision:1,base,geometry:{...base.geometry,width:30},touched:['width']}
test('compares overlapping room intents without touching other image objects',()=>{
 const disjoint={...draft,intentId:crypto.randomUUID(),touched:['height' as const],geometry:{...base.geometry,height:15}}
 const equal={...draft,intentId:crypto.randomUUID()}
 const conflict={...draft,intentId:crypto.randomUUID(),geometry:{...base.geometry,width:40}}
 const changedBase={...conflict,intentId:crypto.randomUUID(),base:{...base,visualHash:'d'.repeat(64)}}
 const other={...conflict,intentId:crypto.randomUUID(),base:{...base,nodeId:'n_'+'e'.repeat(32)}}
 assert.deepEqual(compareRecoveryImagePeers(draft,[draft,disjoint,equal,conflict,changedBase,other]).map(x=>[x.status,x.conflicts]),[['sameIntent',[]],['compatible',[]],['compatible',[]],['conflict',['width']],['unverified',[]]])
})
test('same intent ID with different data and resource conflicts are not treated as equal',()=>{
 const altered={...draft,geometry:{...draft.geometry,width:99}}
 const resource={...draft,intentId:crypto.randomUUID(),touched:['assetHash' as const],assetHash:'d'.repeat(64)}
 const local={...draft,touched:['assetHash' as const],assetHash:'e'.repeat(64)}
 assert.equal(compareRecoveryImagePeers(draft,[altered])[0].status,'unverified')
 assert.deepEqual(compareRecoveryImagePeers(local,[resource])[0].conflicts,['assetHash'])
})
