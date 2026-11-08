import {test} from 'node:test'
import assert from 'node:assert/strict'
import {planWordStoryLink,readWordLinkSelection} from './wordLinkPlan.ts'
import type {WordLayout} from './wordRegions.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`
function fixture(){
 const layout:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:true,sections:[1,2,3,4,5].map(n=>({id:id(n),differentFirstPage:true,page:{widthTwips:12240},headers:n===1?{default:id(10),first:id(12)}:n===2?{default:id(11),first:id(13),even:id(14)}:n===4?{default:id(12)}:{},footers:{}})),stories:[10,11,12,13,14].map(n=>({id:id(n),kind:'header',sourcePart:`word/header${n}.xml`}))}
 return{layout,selection:{sectionId:id(2),kind:'header' as const,variant:'default' as const,transactionId:'a'.repeat(32)}}
}
test('link changes one binding, retains all stories and stops at the next explicit binding',()=>{
 const {layout,selection}=fixture(),before=structuredClone(layout),plan=planWordStoryLink(layout,selection)
 assert.deepEqual(layout,before);assert.deepEqual(plan.layout.stories,layout.stories);assert.equal(plan.retainedStoryId,id(11));assert.equal(plan.inheritedStoryId,id(10))
 assert.deepEqual(plan.affected,[2,3].map(n=>({sectionId:id(n),beforeStoryId:id(11),afterStoryId:id(10)})))
 const expected=structuredClone(before);delete expected.sections[1].headers.default;assert.deepEqual(plan.layout,expected)
})
test('first and even page links are independent and an absent preceding variant means blank',()=>{
 const {layout,selection}=fixture(),first=planWordStoryLink(layout,{...selection,variant:'first'}),even=planWordStoryLink(layout,{...selection,variant:'even'})
 assert.equal(first.inheritedStoryId,id(12));assert.equal(first.affected.length,4);assert.equal(first.layout.sections[1].headers.default,id(11));assert.equal(first.layout.sections[1].headers.even,id(14))
 assert.equal(even.inheritedStoryId,null);assert.equal(even.affected.length,4);assert.ok(even.affected.every(item=>item.afterStoryId===null))
})
test('removing a same-story binding records the structural change without inventing content changes',()=>{
 const {layout,selection}=fixture();layout.sections[1].headers.default=id(10)
 const plan=planWordStoryLink(layout,selection);assert.deepEqual(plan.affected,[]);assert.equal(plan.layout.sections[1].headers.default,undefined);assert.equal(plan.retainedStoryId,id(10))
})
test('first section, already inherited, malformed identities and unexpected input never produce a plan',()=>{
 const {layout,selection}=fixture()
 assert.throws(()=>planWordStoryLink(layout,{...selection,sectionId:id(1)}),/first-section/)
 assert.throws(()=>planWordStoryLink(layout,{...selection,sectionId:id(3)}),/already-inherited/)
 for(const value of [null,{...selection,extra:true},{...selection,transactionId:'bad'},{...selection,kind:'body'},{...selection,sectionId:id(99)}])assert.throws(()=>value&&'sectionId' in value?planWordStoryLink(layout,value as any):readWordLinkSelection(value))
})
