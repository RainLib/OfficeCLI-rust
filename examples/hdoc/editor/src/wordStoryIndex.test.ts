import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseWordStoryIndex} from './wordStoryIndex.ts'
import type {Manifest} from './fixedPages.ts'

const manifest={revision:3,chunkCount:150} as Manifest
const id='n_'+'a'.repeat(32)
const valid={schemaVersion:'hcd-word-story-index/1',revision:3,chunkCount:150,wordRegionsVerified:true,stories:[{sequence:142,region:'header',wordRegionId:id},{sequence:149,region:'footer',wordRegionId:id}]}
test('revision-pinned story index maps later pages without body descriptors',()=>{
 const groups=parseWordStoryIndex(valid,manifest)
 assert.deepEqual(groups.map(group=>group.firstSequence),[142,149])
 assert.equal(groups[0].wordRegionsVerified,true)
 assert.deepEqual(parseWordStoryIndex({...valid,stories:[]},manifest),[])
 const shared=parseWordStoryIndex({...valid,stories:[valid.stories[0],{...valid.stories[0],sequence:143}]},manifest)
 assert.deepEqual(shared.map(group=>group.sequences),[[142,143]])
})
test('reject incomplete, stale, malformed or unordered catalogs',()=>{
 for(const input of [null,{...valid,revision:2},{...valid,chunkCount:149},{...valid,wordRegionsVerified:false},{...valid,stories:[{...valid.stories[0],wordRegionId:'bad'}]},{...valid,stories:[valid.stories[0],valid.stories[0]]},{...valid,stories:[{...valid.stories[0],sequence:150}]},{...valid,stories:[{...valid.stories[0],region:'body'}]}])assert.throws(()=>parseWordStoryIndex(input,manifest),/wordStoryIndexInvalid/)
})
