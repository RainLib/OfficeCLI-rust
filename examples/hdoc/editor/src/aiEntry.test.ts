import {test} from 'node:test'
import assert from 'node:assert/strict'
import {getSchema} from '@tiptap/core'
import {EditorState,TextSelection} from '@tiptap/pm/state'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {aiSpaceEntry} from './ai/entry.ts'
const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
function state(text='',kind='paragraph'){const doc=schema.node('doc',null,[schema.node(kind,{hcdStructureKey:'line'},text?[schema.text(text)]:[])]);return EditorState.create({doc,selection:TextSelection.create(doc,1)})}
test('AI space entry only captures a plain space on an eligible empty line with a provider',()=>{
 assert.equal(aiSpaceEntry(state(),{key:' '},true),true)
 for(const event of [{key:'Enter'},{key:' ',isComposing:true},{key:' ',keyCode:229},{key:' ',shiftKey:true},{key:' ',metaKey:true},{key:' ',ctrlKey:true},{key:' ',altKey:true}])assert.equal(aiSpaceEntry(state(),event,true),false)
 assert.equal(aiSpaceEntry(state(),{key:' '},false),false);assert.equal(aiSpaceEntry(state('Text'),{key:' '},true),false);assert.equal(aiSpaceEntry(state('','codeBlock'),{key:' '},true),false)
})
