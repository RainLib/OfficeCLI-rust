import {test} from 'node:test'
import assert from 'node:assert/strict'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from './schema.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {semanticOutline,filterSemanticOutline,semanticOutlinePosition,semanticOutlineExcerpt} from './semanticOutline.ts'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {I18nProvider} from './i18n.tsx'
import {SemanticOutlineNavigation} from './SemanticOutlineNavigation.tsx'

const schema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const heading=(text:string,key:string,level=1)=>schema.nodes.heading.createChecked({level,hcdStructureKey:key},text?schema.text(text):undefined)
test('semantic outlines search complete headings and preserve document order',()=>{
 const doc=schema.nodes.doc.createChecked(null,[heading('A'.repeat(300)+' 中文😀','one'),heading('Other','two',2),heading('','three')]),entries=semanticOutline(doc)
 assert.equal(entries.length,3);assert.equal(entries[0].text.length,305)
 assert.deepEqual(filterSemanticOutline(entries,'中文😀','zh-CN','无标题').map(item=>item.key),['one'])
 assert.deepEqual(filterSemanticOutline(entries,'other','en-US','Untitled').map(item=>item.key),['two'])
 assert.deepEqual(filterSemanticOutline(entries,'无标题','zh-CN','无标题').map(item=>item.key),['three'])
})
test('stale heading positions do not select a different block',()=>{
 const original=schema.nodes.doc.createChecked(null,[heading('First','one'),heading('Second','two')]),entries=semanticOutline(original)
 assert.equal(semanticOutlinePosition(original,entries[1]),entries[1].pos)
 const changed=schema.nodes.doc.createChecked(null,[heading('Other','replacement'),heading('Second','two')])
 assert.equal(semanticOutlinePosition(changed,entries[0]),null)
 const moved=schema.nodes.doc.createChecked(null,[heading('Second','two'),heading('First changed','one')]);assert.equal(semanticOutlinePosition(moved,entries[0]),semanticOutline(moved)[1].pos)
 const duplicate=schema.nodes.doc.createChecked(null,[heading('First','one'),heading('Duplicate','one')]);assert.equal(semanticOutlinePosition(duplicate,entries[0]),null)
})
test('long outline initially renders a bounded page and exposes further entries',()=>{
 const entries=Array.from({length:200},(_,pos)=>({pos,level:1,text:`heading-${pos}`}))
 const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(SemanticOutlineNavigation,{entries,onClose:()=>{},onLocate:()=>{}})}))
 assert.match(html,/heading-79/);assert.doesNotMatch(html,/heading-80/);assert.match(html,/加载更多标题/);assert.match(html,/80\/200/)
})
test('long labels show matching context without splitting emoji or expanded lowercase characters',()=>{
 const text='😀'.repeat(280)+'İstanbul target'+'尾'.repeat(300)
 const initial=semanticOutlineExcerpt(text,'','en-US');assert.equal(Array.from(initial).length,257);assert.ok(initial.endsWith('…'))
 const matched=semanticOutlineExcerpt(text,'i\u0307stanbul','en-US');assert.ok(matched.startsWith('…'));assert.ok(matched.includes('İstanbul'));assert.ok(matched.endsWith('…'));assert.doesNotMatch(matched,/\uFFFD/)
 assert.ok(semanticOutlineExcerpt('prefix '+text,'target','en-US').includes('target'))
 assert.ok(semanticOutlineExcerpt('a'.repeat(100)+'target','target','en-US').includes('target'))
})
