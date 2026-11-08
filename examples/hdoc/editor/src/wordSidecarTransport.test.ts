import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseCollaborationRoom} from './collaborationProtocol.ts'
import {wordSidecarHeadModel,wordSidecarHeaders,wordSidecarRequestModel,wordSidecarRoomName} from './wordSidecarTransport.ts'

test('Word owner transport binds each protocol to its own room and lease',()=>{
 const old=parseCollaborationRoom('doc:3:wordregions1:save5'),next=parseCollaborationRoom('doc:3:wordregions2:save6',{wordLayoutV2:true})
 assert.equal(wordSidecarRoomName(old),'doc:3:wordregions1:save5');assert.equal(wordSidecarRoomName(next),'doc:3:wordregions2:save6')
 assert.throws(()=>wordSidecarRoomName(parseCollaborationRoom('fixed:doc:3')),/invalid/)
 const lease={'X-HCD-Word-Owner':'lease','X-HCD-Word-Owner-Id':'owner','X-HCD-Word-Journal-Hash':'tip'}
 for(const route of ['/word/checkpoints','/word/checkpoint-receipt','/word/checkpoint-cancel','/word/layout-receipt','/word/layout-transactions','/word/layout-preflight','/word/story-receipt','/word/story-transactions','/word/story-preflight','/word/link-preflight','/word/link-transactions','/word/link-receipt','/word/topology-cancel']){
  const headers=wordSidecarHeaders(route+'?revision=2',new Headers({'x-hcd-word-owner':'forged','x-hcd-word-owner-id':'forged','x-hcd-word-journal-hash':'forged','Content-Type':'application/json'}),lease)
  assert.equal(headers.get('x-hcd-word-owner'),'lease');assert.equal(headers.get('x-hcd-word-owner-id'),'owner');assert.equal(headers.get('x-hcd-word-journal-hash'),'tip');assert.equal(headers.get('content-type'),'application/json')
 }
 const other=wordSidecarHeaders('/editor',{'X-HCD-Word-Owner':'forged'},lease);assert.equal(other.has('X-HCD-Word-Owner'),false)
 for(const version of ['6','7']){const headers=wordSidecarHeaders('/editor?revision=3',{'X-HCD-Coordinator-Version':version,'X-HCD-Word-Layout-Version':'1'},lease);assert.equal(headers.get('X-HCD-Word-Owner'),'lease')}
 assert.throws(()=>wordSidecarHeaders('/word/layout-transactions',undefined,{}),/word-owner-unavailable/)
})
test('verified layout model selects the native editor and checkpoint headers without trusting caller overrides',()=>{
 const lease={'X-HCD-Word-Owner':'lease','X-HCD-Word-Owner-Id':'owner','X-HCD-Word-Journal-Hash':'tip'},forged={'X-HCD-Coordinator-Version':'5','X-HCD-Word-Layout-Version':'0','X-HCD-Word-Story-Version':'1','X-HCD-Word-Owner':'forged'}
 for(const route of ['/editor?revision=2','/word/checkpoints','/word/checkpoint-receipt','/word/layout-preflight','/word/layout-transactions','/word/layout-receipt'])for(const model of ['layout','story'] as const){
  const headers=wordSidecarHeaders(route,forged,lease,model)
  assert.equal(headers.get('x-hcd-coordinator-version'),model==='story'?'7':'6');assert.equal(headers.get('x-hcd-word-layout-version'),'1');assert.equal(headers.get('x-hcd-word-story-version'),model==='story'?'1':null);assert.equal(headers.get('x-hcd-word-owner'),'lease')
 }
 const transaction=wordSidecarHeaders('/word/story-transactions',{'X-HCD-Coordinator-Version':'7'},lease,'layout');assert.equal(transaction.get('x-hcd-coordinator-version'),'7')
})
test('only an identified native Word head selects the supported request model',()=>{
 const manifest={documentId:'doc',revision:3,rootHash:'a'.repeat(64),profile:'semantic-flow',source:{format:'docx'},capabilities:{flowLayout:2}}
 assert.equal(wordSidecarHeadModel(manifest,'doc'),'layout')
 assert.equal(wordSidecarHeadModel({...manifest,capabilities:{flowLayout:2,wordLayoutEdits:1}},'doc'),'layout')
 assert.equal(wordSidecarHeadModel({...manifest,capabilities:{flowLayout:2,wordLayoutEdits:3}},'doc'),'story')
 for(const capability of [2,4,null,'3'])assert.throws(()=>wordSidecarHeadModel({...manifest,capabilities:{flowLayout:2,wordLayoutEdits:capability}},'doc'),/unsupported/)
 for(const invalid of [{...manifest,documentId:'other'},{...manifest,revision:-1},{...manifest,rootHash:'bad'},{...manifest,source:{format:'xlsx'}},{...manifest,capabilities:{flowLayout:1}},null])assert.throws(()=>wordSidecarHeadModel(invalid,'doc'),/invalid/)
})
test('head selection rechecks the same lease after the asynchronous native read',async()=>{
 const manifest={documentId:'doc',revision:3,rootHash:'a'.repeat(64),profile:'semantic-flow',source:{format:'docx'},capabilities:{flowLayout:2,wordLayoutEdits:3}}
 let valid=true,reads=0
 const head=async()=>{reads++;valid=false;return Response.json(manifest)},guard=()=>{if(!valid)throw Error('owner lost')}
 await assert.rejects(wordSidecarRequestModel('/editor?revision=3','doc',head,guard),/owner lost/)
 valid=true;assert.equal(await wordSidecarRequestModel('/word/story-transactions','doc',head,guard),undefined);assert.equal(reads,1)
 await assert.rejects(wordSidecarRequestModel('/word/checkpoints','doc',async()=>new Response('',{status:503}),guard),/word-layout-head:503/)
})
