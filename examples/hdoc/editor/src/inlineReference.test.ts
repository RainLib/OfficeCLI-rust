import test from 'node:test'
import assert from 'node:assert/strict'
import {getSchema} from '@tiptap/core'
import {Slice} from '@tiptap/pm/model'
import * as Y from 'yjs'
import {schemaExtensions,projectionToJson,jsonToSnapshot,clearPastedBlockIds,type Projection} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {duplicateBlock} from './commands/blocks.ts'
import {checkpointContents} from './checkpointSnapshot.ts'
import {validateSemanticInline,readSemanticInline} from './semanticInlineContent.ts'
import {readInlineReference,referenceText,type InlineReference} from './inlineReference.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const ref:InlineReference={type:'hcd.mention',version:1,mentionId:'m_'+'1'.repeat(32),target:{kind:'person',id:'user:alice'},snapshot:{label:'同名😀'}}
function projection():Projection{return{documentId:'doc',revision:2,blocks:[{blockId:'n_'+'2'.repeat(32),blockHash:'hash',region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text:'Hi '},{text:referenceText(ref),reference:ref,nodeId:'n_'+'3'.repeat(32)},{text:'!'}]}}]}}
test('reference atom roundtrips native content without exposing ID as visible text',()=>{
 const json=projectionToJson(projection()),doc=schema.nodeFromJSON(json);doc.check();const atom=doc.firstChild!.child(1)
 assert.equal(atom.type.name,'hcdMention');assert.equal(atom.nodeSize,1);assert.equal(atom.isAtom,true);assert.equal(doc.textContent.includes('@同名😀'),true)
 const content=jsonToSnapshot(doc.toJSON())[0].content;assert.deepEqual(content.inlines[1].reference,ref);assert.equal(content.inlines[1].nodeId,'n_'+'3'.repeat(32));assert.equal(content.inlines[1].text,'@同名😀')
 const changed=structuredClone(content);changed.inlines[1].reference!.target.id='user:bob';assert.notEqual(checkpointContents([{blockId:null,content}]),checkpointContents([{blockId:null,content:changed}]))
})
test('copying or pasting allocates a new occurrence while preserving the target and snapshot',()=>{
 const root=schema.nodeFromJSON(projectionToJson(projection())).firstChild!,copy=duplicateBlock(root),paste=clearPastedBlockIds(new Slice(root.content,0,0))
 for(const atom of [copy.child(1),paste.content.child(1)]){
  assert.notEqual(atom.attrs.reference.mentionId,ref.mentionId);assert.deepEqual(atom.attrs.reference.target,ref.target);assert.deepEqual(atom.attrs.reference.snapshot,ref.snapshot);assert.equal(atom.marks.some(mark=>mark.type.name==='hcdSource'),false)
 }
 assert.notEqual(copy.child(1).attrs.reference.mentionId,paste.content.child(1).attrs.reference.mentionId)
})
test('reference CRDT leaf embeds retain occurrence IDs through peer sync and own undo/redo',()=>{
 const a=new Y.Doc(),b=new Y.Doc(),sa=new SemanticBlockStore(a,schema),sb=new SemanticBlockStore(b,schema)
 const json=projectionToJson(projection());json.content!.push({type:'paragraph',attrs:{hcdBlockId:'n_'+'9'.repeat(32)},content:[{type:'text',text:'Other'}]});sa.initialize(schema.nodeFromJSON(json));Y.applyUpdate(b,Y.encodeStateAsUpdate(a));const um=sa.undoManager()
 const key=sa.keys()[0];sa.remove([key]);assert.equal(sa.project().childCount,1);um.undo();assert.deepEqual(jsonToSnapshot(sa.project().toJSON())[0].content.inlines[1].reference,ref);um.redo();assert.equal(sa.project().childCount,1);um.undo();Y.applyUpdate(b,Y.encodeStateAsUpdate(a));assert.deepEqual(jsonToSnapshot(sb.project().toJSON())[0].content.inlines[1].reference,ref)
 um.destroy();a.destroy();b.destroy()
})
test('unknown versions, extra attributes, controls and malformed snapshots fail closed',()=>{
 for(const value of [{...ref,version:2},{...ref,url:'javascript:alert(1)'},{...ref,snapshot:{label:'\u0000'}},{...ref,target:{kind:'Person',id:'a'}},{...ref,snapshot:{label:'x'.repeat(257)}}])assert.throws(()=>readInlineReference(value),/unsupportedInlineReference/)
 const json=projectionToJson(projection());json.content![0].content![1].attrs!.reference={...ref,version:2};assert.throws(()=>schema.nodeFromJSON(json).check())
})
test('local and received reference atoms reject incompatible code and link marks',()=>{
 for(const mark of [schema.mark('code'),schema.mark('link',{href:'https://example.com'})]){
  const atom=schema.node('hcdMention',{reference:ref},undefined,[mark]),paragraph=schema.node('paragraph',null,[atom]);assert.throws(()=>validateSemanticInline(paragraph),/unsupportedInlineMarks/)
  assert.throws(()=>readSemanticInline({toDelta:()=>[{insert:{type:'hcdMention',attrs:{reference:ref}},attributes:{[mark.type.name]:mark.attrs}}],delete:()=>{},applyDelta:()=>{}},schema),/unsupportedInlineMarks/)
 }
})
