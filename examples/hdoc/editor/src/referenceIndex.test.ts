import {test} from 'node:test'
import assert from 'node:assert/strict'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {liveReferences,referenceRows,referencePosition,readReferenceSnapshot,readReferenceResolutions,referenceSearch,referenceTargetKey,type SavedReference} from './referenceIndex.ts'
import type {InlineReference} from './inlineReference.ts'
const schema=getSchema(schemaExtensions),reference=(id='1',target='person:a'):InlineReference=>({type:'hcd.mention',version:1,mentionId:`m_${id.repeat(32)}`,target:{kind:'person',id:target},snapshot:{label:'同名'}})
const paragraph=(ref:InlineReference,text='')=>schema.node('paragraph',null,[...(text?[schema.text(text)]:[]),schema.node('hcdMention',{reference:ref})])
const saved=(ref=reference()):SavedReference=>({reference:ref,blockId:'block',childPath:[],inlineIndex:0,chunkSequence:3,indexPage:0})
test('current reference locations follow identity through block moves and UTF-16 edits, never old offsets or retargeted identities',()=>{
 const ref=reference(),first=schema.node('doc',null,[paragraph(ref,'Before😀'),paragraph(reference('2'))]),moved=schema.node('doc',null,[paragraph(reference('2')),paragraph(ref,'Much longer moved text😀')])
 const old=referencePosition(first,ref)!,next=referencePosition(moved,ref)!;assert.notEqual(old,next);assert.deepEqual(liveReferences(moved)[1].reference,ref)
 assert.equal(referencePosition(moved,reference('1','different')),null);assert.equal(referencePosition(schema.node('doc',null,[paragraph(reference('2'))]),ref),null)
 assert.throws(()=>liveReferences(schema.node('doc',null,[paragraph(ref),paragraph(ref)])),/ambiguous/)
})
test('saved and current reference rows distinguish drafts, edits and deletion without changing either body or snapshot',()=>{
 const base=[saved(),saved(reference('2'))],live=liveReferences(schema.node('doc',null,[paragraph(reference('1','new')),paragraph(reference('3'))])),rows=referenceRows(base,live)
 assert.deepEqual(rows.map(row=>row.state),['changed','removed','draft']);assert.equal(base[0].reference.target.id,'person:a');assert.deepEqual(referenceRows(base,null).map(row=>row.state),['saved','saved'])
 const info={target:reference().target,status:'active' as const,canMention:false,label:'Renamed',detail:'Design'}
 assert.equal(referenceSearch(referenceRows(base,null),'design',new Map([[referenceTargetKey(info.target),info]])).length,2)
})
test('canonical occurrence replies are pinned to document/revision and bounded even when navigation fields are present',()=>{
 const data={schemaVersion:'hcd-references/1',documentId:'doc',revision:5,items:[saved()]};assert.deepEqual(readReferenceSnapshot(data,'doc',5).items,[saved()])
 for(const bad of [{...data,revision:4},{...data,documentId:'other'},{...data,items:[saved(),saved()]},{...data,items:[{...saved(),chunkSequence:-1}]},{...data,items:[{...saved(),childPath:[-1]}]}])assert.throws(()=>readReferenceSnapshot(bad,'doc',5))
})
test('profiles only expose active authorized labels; unknown/restricted replies are indistinguishable and stale scope is rejected',()=>{
 const target=reference().target,value={schemaVersion:'hcd-reference-resolution/1',items:[{target,status:'active',label:'Current',detail:'Design',canMention:false}]}
 assert.equal(readReferenceResolutions(value,[target])[0].canMention,false)
 for(const status of ['inactive','restricted','unsupported'])assert.deepEqual(readReferenceResolutions({...value,items:[{target,status}]},[target]),[{target,status,canMention:false}])
 for(const items of [[{target,status:'restricted',label:'private'}],[{target:reference('1','other').target,status:'restricted'}],[{target,status:'active',label:'Current',canMention:'yes'}],[]])assert.throws(()=>readReferenceResolutions({...value,items},[target]))
})
