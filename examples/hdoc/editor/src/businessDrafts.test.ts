import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {businessDraftProblem} from './businessDrafts.ts'
import {prepareReferenceEdits,publishReferenceEdits,referenceEditIndex,projectReferenceEdits,resolveReferenceEdit} from './referenceEdits.ts'
import type {InlineReference} from './inlineReference.ts'

test('metadata-only reference conflict invalidates a saved body even when its digest and editor generation could be unchanged',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),schema=getSchema(schemaExtensions),root:InlineReference={type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'original'},snapshot:{label:'Original'}}
 const doc=(reference:InlineReference)=>schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.nodes.hcdMention.createChecked({reference})])])
 const saved=doc(root)
 try{
  assert.equal(businessDraftProblem(a,saved),undefined)
  publishReferenceEdits(a,prepareReferenceEdits(a,saved,doc({...root,target:{kind:'person',id:'alice'},snapshot:{label:'Alice'}})))
  publishReferenceEdits(b,prepareReferenceEdits(b,saved,doc({...root,target:{kind:'person',id:'bob'},snapshot:{label:'Bob'}})))
  Y.applyUpdate(a,Y.encodeStateAsUpdate(b))
  const group=referenceEditIndex(a).get(root.mentionId)!,current=projectReferenceEdits(saved,referenceEditIndex(a))
  assert.ok(current.eq(saved),'body-only receipt still matches the unchanged conflict placeholder')
  assert.equal(businessDraftProblem(a,current),'reference-drafts-conflict')
  const deleted=schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked()])
  assert.equal(businessDraftProblem(a,deleted),undefined,'history for an absent occurrence does not block saving its deletion')
  resolveReferenceEdit(a,root.mentionId,group.ids,group.candidates[0].id,{})
  assert.equal(businessDraftProblem(a,projectReferenceEdits(saved,referenceEditIndex(a))),undefined)
 }finally{a.destroy();b.destroy()}
})
