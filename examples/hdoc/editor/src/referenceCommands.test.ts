import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as Y from 'yjs'
import {getSchema,type Editor} from '@tiptap/core'
import {EditorState} from '@tiptap/pm/state'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {NodeExtensionRegistry} from './extensionRegistry.ts'
import {referenceEditIndex,prepareReferenceEdits,publishReferenceEdits,documentReferences} from './referenceEdits.ts'
import {canEditReference,retargetReference,chooseReferenceCandidate} from './referenceCommands.ts'
import type {InlineReference} from './inlineReference.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),root:InlineReference={type:'hcd.mention',version:1,mentionId:'m_'+'a'.repeat(32),target:{kind:'person',id:'original'},snapshot:{label:'Original'}}
test('reference commands preserve an unknown rich container even when a causal conflict can be resolved directly',()=>{
 const registry=new NodeExtensionRegistry([{type:'example.notes',version:1,display:'block',contentModel:'blocks',label:'Notes',defaultData:{title:'Notes'},validate:data=>typeof data.title==='string',fallback:data=>String(data.title)}]),unknown=new NodeExtensionRegistry(),value=registry.create('example.notes'),document=new Y.Doc(),store=new SemanticBlockStore(document,schema)
 const content=(reference:InlineReference)=>schema.nodes.doc.createChecked(null,[schema.nodes.hcdExtensionContainer.createChecked({extension:value},[schema.nodes.paragraph.createChecked(null,[schema.nodes.hcdMention.createChecked({reference})])])])
 store.initialize(content(root));for(const [id,label]of [['alice','A'],['bob','B']])publishReferenceEdits(document,prepareReferenceEdits(new Y.Doc(),content(root),content({...root,target:{kind:'person',id},snapshot:{label}})))
 let editable=true;const editor={isDestroyed:false,get isEditable(){return editable},get state(){return EditorState.create({schema,doc:store.project()})},view:{composing:false,dispatch(){throw new Error('unknown subtree must not be dispatched')}}} as unknown as Editor
 try{
  const group=referenceEditIndex(document).get(root.mentionId)!,input={mentionId:root.mentionId,ids:group.ids,candidateId:group.candidates[0].id},before=Y.encodeStateAsUpdate(document)
  assert.equal(canEditReference(editor,unknown,root.mentionId),false);assert.equal(retargetReference(editor,store,unknown,root,{kind:'person',id:'other',label:'Other'}),false);assert.equal(chooseReferenceCandidate(editor,store,unknown,input),false);assert.deepEqual(Y.encodeStateAsUpdate(document),before)
  editable=false;assert.equal(chooseReferenceCandidate(editor,store,registry,input),false);assert.deepEqual(Y.encodeStateAsUpdate(document),before)
  editable=true;assert.equal(canEditReference(editor,registry,root.mentionId),true);assert.ok(chooseReferenceCandidate(editor,store,registry,input));assert.equal(referenceEditIndex(document).get(root.mentionId)!.conflicted,false);assert.equal(documentReferences(store.project()).get(root.mentionId)!.reference.target.id,group.candidates[0].after.target.id)
 }finally{document.destroy()}
})

test('reserved document/date/business references stay readable and cannot be converted through the person picker',()=>{
 const document=new Y.Doc(),store=new SemanticBlockStore(document,schema),registry=new NodeExtensionRegistry(),future={...root,target:{kind:'task',id:'task-1'},snapshot:{label:'Reserved task'}}
 store.initialize(schema.nodes.doc.createChecked(null,[schema.nodes.paragraph.createChecked(null,[schema.nodes.hcdMention.createChecked({reference:future})])]))
 const editor={isDestroyed:false,isEditable:true,get state(){return EditorState.create({schema,doc:store.project()})},view:{composing:false,dispatch(){throw new Error('reserved reference must be preserved')}}} as unknown as Editor
 try{const before=Y.encodeStateAsUpdate(document);assert.equal(canEditReference(editor,registry,root.mentionId),false);assert.equal(retargetReference(editor,store,registry,future,{kind:'person',id:'alice',label:'Alice'}),false);assert.deepEqual(Y.encodeStateAsUpdate(document),before);assert.deepEqual(documentReferences(store.project()).get(root.mentionId)!.reference,future)}finally{document.destroy()}
})
