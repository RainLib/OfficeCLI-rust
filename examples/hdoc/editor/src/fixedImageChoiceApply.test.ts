import {test} from 'node:test'
import assert from 'node:assert/strict'
import {ImageDraftStore} from './imageDrafts.ts'
import {applyFixedImageChoice} from './fixedImageChoiceApply.ts'
import type {FixedImageChoice} from './fixedImageFiles.ts'
import type {Session} from './api.ts'

const hash='a'.repeat(64),base={nodeId:'image/1',visualHash:'b'.repeat(64),assetHash:'c'.repeat(64),geometry:{x:1,y:2,width:3,height:4,unit:'pt' as const}}
const choice:FixedImageChoice={version:1,id:'00000000-0000-4000-8000-000000000000',name:'x.png',extension:'png',hash,bytes:new Uint8Array([1]),base,revision:1,page:0,phase:'staged'}
const session:Session={documentId:'doc',token:'token',scope:'write',format:'pptx',userId:'alice',apiUrl:'https://test.invalid'}
const source='d'.repeat(64)
function install(image:unknown=base,scope='write'){
 const original=globalThis.fetch
 globalThis.fetch=async input=>{const url=String(input);const data=url.endsWith('/auth')?{scope,userId:'alice'}:url.includes('/images/')?{revision:2,image}:{revision:2,source:{sha256:source}};return Response.json(data)}
 return()=>{globalThis.fetch=original}
}
test('staged image is attached only after an authenticated pinned target check',async()=>{
 const restore=install(),drafts=new ImageDraftStore()
 try{await applyFixedImageChoice(session,source,drafts,choice,new AbortController().signal);assert.equal(drafts.get(base.nodeId)?.assetHash,hash);assert.equal(drafts.get(base.nodeId)?.revision,2)
 let changes=0;const unsubscribe=drafts.actions.subscribe(()=>changes++);await applyFixedImageChoice(session,source,drafts,choice,new AbortController().signal);unsubscribe();assert.equal(changes,0)
 }finally{restore()}
})
test('deleted or changed targets and revoked writes never attach the local file',async()=>{
 for(const [image,scope] of [[null,'write'],[{...base,visualHash:'e'.repeat(64)},'write'],[base,'read']] as const){const restore=install(image,scope),drafts=new ImageDraftStore();try{await assert.rejects(applyFixedImageChoice(session,source,drafts,choice,new AbortController().signal));assert.equal(drafts.size,0)}finally{restore()}}
})
test('an existing different local replacement is not overwritten',async()=>{
 const restore=install(),drafts=new ImageDraftStore(),operation=drafts.prepareReplacement(base,1);operation.commit('f'.repeat(64));operation.finish()
 try{await assert.rejects(applyFixedImageChoice(session,source,drafts,choice,new AbortController().signal),/draft-conflict/);assert.equal(drafts.get(base.nodeId)?.assetHash,'f'.repeat(64))}finally{restore()}
})
