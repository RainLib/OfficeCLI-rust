import assert from 'node:assert/strict'
import {test} from 'node:test'
import {locateWordField} from './wordFieldLocation.ts'

test('field location checks canonical IDs and reports removed blocks',()=>{
 const id='n_'+'a'.repeat(32),calls:string[]=[]
 const block={scrollIntoView:()=>calls.push('scroll'),animate:()=>calls.push('highlight')}
 const root={querySelector:(selector:string)=>{calls.push(selector);return selector===`[data-hcd-block-id="${id}"]`?block:null}} as unknown as ParentNode
 assert.equal(locateWordField(root,id),true)
 assert.deepEqual(calls,[`[data-hcd-block-id="${id}"]`,'scroll','highlight'])
 assert.equal(locateWordField(root,'n_'+'b'.repeat(32)),false)
 const count=calls.length;assert.equal(locateWordField(root,'"] *'),false);assert.equal(calls.length,count)
 assert.equal(locateWordField(null,id),false)
})
