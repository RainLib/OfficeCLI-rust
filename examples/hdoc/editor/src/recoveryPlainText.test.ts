import {test} from 'node:test'
import assert from 'node:assert/strict'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {recoveryPlainText} from './recoveryPlainText.ts'

test('plain recovery text includes the whole document and block breaks',()=>{
 const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),tail='A'.repeat(7000)+'末尾😀',doc=schema.node('doc',null,[schema.node('paragraph',null,[schema.text('第一行'),schema.node('hardBreak'),schema.text('第二行')]),schema.node('paragraph',null,schema.text(tail))])
 assert.equal(recoveryPlainText(doc),`第一行\n第二行\n${tail}`)
})
test('opaque block text is recovered instead of its shortened preview',()=>{
 const schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),doc=schema.node('doc',null,[schema.node('hcdOpaque',{preview:'short',hcdContent:{inlines:[{text:'完整 '},{text:'内容'}]}})])
 assert.equal(recoveryPlainText(doc),'完整 内容')
})
