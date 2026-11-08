import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Schema} from '@tiptap/pm/model'
import {editorNodes} from './editorNodes.ts'
import {extensionNodes} from './extensionNode.ts'

const schema=new Schema({nodes:{
 doc:{content:'block+'}, text:{group:'inline'}, paragraph:{group:'block',content:'inline*'},
 hcdExtensionContainer:{group:'block',content:'block+',attrs:{extension:{}}},
 hcdExtensionInline:{inline:true,group:'inline',attrs:{extension:{}}},
 hcdExtensionInlineContainer:{inline:true,group:'inline',content:'inline*',attrs:{extension:{}}},
}})
const id=(n:number)=>`x_${n.toString(16).padStart(32,'0')}`
const node=(n:number,container=false)=>({schemaVersion:'hcd.extension/2',instanceId:id(n),type:'example.field',version:1,display:container?'block':'inline',data:{title:`Node ${n}`},fallback:{text:`Node ${n}`},...(container?{contentModel:'blocks'}:{})})
const inline=(n:number)=>({schemaVersion:'hcd.extension/3',instanceId:id(n),type:'example.field',version:1,display:'inline',contentModel:'inline',data:{title:`Node ${n}`},fallback:{text:`Node ${n}`}})
const p=(...children:ReturnType<typeof schema.text>[])=>schema.nodes.paragraph.create(null,children)

test('location index retains nested identities and exact positions without changing document nodes',()=>{
 const leaf=schema.nodes.hcdExtensionInline.create({extension:node(2)})
 const nested=schema.nodes.hcdExtensionInlineContainer.create({extension:inline(3)},schema.text('body'))
 const root=schema.nodes.hcdExtensionContainer.create({extension:node(1,true)},schema.nodes.paragraph.create(null,[schema.text('before'),leaf,nested]))
 const doc=schema.nodes.doc.create(null,[root,p(schema.text('after'))])
 const prior=extensionNodes(doc),indexed=editorNodes(doc)
 for(const [key,value] of prior)assert.deepEqual(indexed.get(key),{value:value.value,position:value.position})
 assert.equal(indexed.get(id(3))?.value.instanceId,id(3))
 for(const entry of indexed.values())assert.equal(doc.nodeAt(entry.position)?.attrs.extension.instanceId,entry.value.instanceId)
})

test('location index still rejects duplicate identities across extension kinds',()=>{
 const a=schema.nodes.hcdExtensionInline.create({extension:node(1)})
 const b=schema.nodes.hcdExtensionInline.create({extension:node(1)})
 assert.throws(()=>editorNodes(schema.nodes.doc.create(null,[schema.nodes.paragraph.create(null,[a,b])])),/duplicateExtensionIdentity/)
 const c=schema.nodes.hcdExtensionInlineContainer.create({extension:inline(1)},schema.text('body'))
 assert.throws(()=>editorNodes(schema.nodes.doc.create(null,[schema.nodes.paragraph.create(null,[a,c])])),/duplicateInlineContainerIdentity/)
})
