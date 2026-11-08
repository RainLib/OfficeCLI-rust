import assert from 'node:assert/strict'
import {test} from 'node:test'
import {legacyProtocol,structuralProtocol,inlineProtocol,wordRegionalProtocol,wordLayoutProtocol,inlineCollaborationUrl,wordLayoutCollaborationUrl,parseCollaborationRoom,roomMatches,requireCollaborationSession} from './collaborationProtocol.ts'
test('room identity includes the exact body protocol and one canonical epoch spelling',()=>{
 const room=parseCollaborationRoom('doc:2:structure3:save4')
 assert.equal(room.protocol,structuralProtocol);assert.equal(roomMatches(room,{collaborationEpoch:2,collaborationProtocol:legacyProtocol}),false)
 assert.equal(roomMatches(room,{collaborationEpoch:2,collaborationProtocol:structuralProtocol}),true)
 for(const name of ['doc:02:structure3:save4','doc:2','doc:2:structure4:save4','fixed:doc:2:structure3:save4'])assert.throws(()=>parseCollaborationRoom(name))
 assert.equal(parseCollaborationRoom('fixed:doc:2').fixed,true)
 assert.throws(()=>requireCollaborationSession({collaborationEpoch:2,collaborationProtocol:'future'}))
 assert.throws(()=>requireCollaborationSession({collaborationEpoch:2,collaborationProtocol:'hcd-word-regions/2'}))
 assert.throws(()=>parseCollaborationRoom('doc:2:wordregions2:save6'))
})
test('layout-aware Word rooms require explicit opt-in and never match legacy Word sessions',()=>{
 const options={wordLayoutV2:true},value={collaborationEpoch:2,collaborationProtocol:wordLayoutProtocol},room=parseCollaborationRoom('doc:2:wordregions2:save6',options)
 assert.deepEqual(requireCollaborationSession(value,options),value);assert.equal(room.protocol,wordLayoutProtocol);assert.equal(roomMatches(room,value),true);assert.equal(roomMatches(room,{collaborationEpoch:2,collaborationProtocol:wordRegionalProtocol}),false);assert.equal(roomMatches(room,{...value,collaborationEpoch:3}),false)
 assert.throws(()=>parseCollaborationRoom('doc:2:wordregions2:save6'));assert.throws(()=>requireCollaborationSession(value));assert.throws(()=>requireCollaborationSession(value,{wordLayoutV2:false}));assert.throws(()=>requireCollaborationSession(value,{wordLayoutV2:'true'} as any))
 for(const name of ['doc:2:wordregions2:save4','doc:2:wordregions2:save5','doc:02:wordregions2:save6','fixed:doc:2:wordregions2:save6','doc:2:wordregions1:save6'])assert.throws(()=>parseCollaborationRoom(name,options))
 const url=new URL(wordLayoutCollaborationUrl('ws://127.0.0.1:1234/?existing=kept'));assert.equal(url.searchParams.get('hcdWordRegions'),'2');assert.equal(url.searchParams.get('hcdWordLayout'),'1');assert.equal(url.searchParams.get('hcdNodeEdits'),'7');assert.equal(url.searchParams.get('existing'),'kept')
})
test('inline containers require a distinct room identity and an explicit client acknowledgement',()=>{
 const room=parseCollaborationRoom('doc:3:inlinecontainers1:save4')
 assert.equal(room.protocol,inlineProtocol)
 assert.equal(roomMatches(room,{collaborationEpoch:3,collaborationProtocol:structuralProtocol}),false)
 assert.equal(roomMatches(room,{collaborationEpoch:3,collaborationProtocol:inlineProtocol}),true)
 assert.deepEqual(requireCollaborationSession({collaborationEpoch:3,collaborationProtocol:inlineProtocol}),{collaborationEpoch:3,collaborationProtocol:inlineProtocol})
 for(const name of ['doc:3:inlinecontainers1:save5','doc:03:inlinecontainers1:save4','fixed:doc:3:inlinecontainers1:save4'])assert.throws(()=>parseCollaborationRoom(name))
 const url=new URL(inlineCollaborationUrl('ws://127.0.0.1:1234/?existing=kept'))
 assert.equal(url.searchParams.get('hcdNodeEdits'),'7');assert.equal(url.searchParams.get('hcdInlineContainers'),'1');assert.equal(url.searchParams.get('existing'),'kept')
})
