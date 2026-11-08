import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordBookNumbering,wordBookStoryUses,wordBookPageIndex,type WordBookSectionMetric} from './wordBook.ts'
import {wordVariantForSectionPage} from './wordPaper.ts'
import type {WordLayout} from './wordRegions.ts'
function layout():WordLayout{return{schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:true,stories:[{id:'h',kind:'header',sourcePart:'word/header1.xml'},{id:'e',kind:'header',sourcePart:'word/header2.xml'},{id:'first',kind:'header',sourcePart:'word/header3.xml'}],sections:['a','b','c'].map(id=>({id,differentFirstPage:false,page:{},headers:id==='a'?{default:'h',even:'e',first:'first'}:{},footers:{}}))}}
const measured=(count:number):WordBookSectionMetric=>({flow:{phase:'ready',pages:count},pages:count,height:count*1000})
test('book screen numbering continues measured sections and honors zero/restart without changing canonical layout',()=>{
 const value=layout(),original=structuredClone(value),metrics=new Map([['a',measured(3)],['b',measured(2)],['c',measured(4)]])
 assert.deepEqual(wordBookNumbering(value,metrics).map(row=>[row.start,row.end]),[[1,3],[4,5],[6,9]])
 assert.equal(wordVariantForSectionPage(value,1,0,4),'even')
 value.sections[1].page.numberStart=0
 assert.deepEqual(wordBookNumbering(value,metrics).map(row=>[row.start,row.end]),[[1,3],[0,1],[2,5]])
 assert.equal(wordVariantForSectionPage(value,1,0,7),'even','explicit native restart wins over a measured continuation')
 delete value.sections[1].page.numberStart;assert.deepEqual(value,original)
})
test('dirty/unsupported predecessors never lend a stale count; a later explicit restart can establish numbering again',()=>{
 const value=layout(),metrics=new Map([['a',measured(3)],['b',measured(2)],['c',measured(4)]])
 metrics.set('a',{...measured(3),flow:{phase:'measuring',pages:3}})
 assert.deepEqual(wordBookNumbering(value,metrics).map(row=>row.start),[1,undefined,undefined])
 value.sections[1].page.numberStart=12;assert.deepEqual(wordBookNumbering(value,metrics).map(row=>[row.start,row.end]),[[1,undefined],[12,13],[14,17]])
 metrics.set('b',{...measured(2),flow:{phase:'unsupported',pages:null,reason:'atomic'}})
 assert.equal(wordBookNumbering(value,metrics)[2].start,undefined)
})
test('non-page section breaks do not invent physical sharing, blank pages or subsequent inherited numbers',()=>{
 for(const kind of ['continuous','nextColumn','oddPage','evenPage'] as const){const value=layout();value.sections[1].breakType=kind;const result=wordBookNumbering(value,new Map([['a',measured(3)],['b',measured(2)],['c',measured(1)]]));assert.equal(result[1].reason,'break');assert.equal(result[1].start,undefined);assert.equal(result[2].start,undefined)}
 const value=layout();value.sections[1].breakType='oddPage';value.sections[1].page.numberStart=7
 const result=wordBookNumbering(value,new Map([['a',measured(3)],['b',measured(2)]]));assert.equal(result[1].start,7);assert.equal(result[1].end,undefined)
})
test('invalid counts and overflowing page numbers cannot become a following section baseline',()=>{
 for(const count of [0,-1,1.5,513,Infinity,NaN]){const result=wordBookNumbering(layout(),new Map([['a',measured(count)]]));assert.equal(result[1].start,undefined)}
 const value=layout();value.sections[0].page.numberStart=2_147_483_647
 const result=wordBookNumbering(value,new Map([['a',measured(2)]]));assert.equal(result[0].reason,'limit');assert.equal(result[1].start,undefined)
})
test('story uses keep inherited disabled bindings for later sections and deduplicate shared identities at each width',()=>{
 const value=layout();value.sections[1].differentFirstPage=true;value.sections[1].page.widthTwips=15840
 const uses=wordBookStoryUses(value)
 assert.deepEqual([...uses[0].ids].sort(),['e','h']);assert.deepEqual([...uses[1].ids].sort(),['e','first','h']);assert.notEqual(uses[0].width,uses[1].width)
 value.evenAndOddHeaders=false;value.sections[1].headers.default='first';assert.deepEqual([...wordBookStoryUses(value)[2].ids],['first'])
})
test('ephemeral paper positions are bounded and do not create missing pages',()=>{
 assert.equal(wordBookPageIndex(8,4),3);assert.equal(wordBookPageIndex(-2,4),0)
 for(const value of [undefined,NaN,Infinity,1.2,'2',{}])assert.equal(wordBookPageIndex(value,4),0)
})
