import {test} from 'node:test'
import assert from 'node:assert/strict'
import {planWordStaleMerge,type MergeRegion} from './wordStaleMergePlan.ts'

const block=(id:string,text:string)=>({blockId:id,content:{kind:'paragraph' as const,inlines:[{text}]}})
const regions=(...blocks:ReturnType<typeof block>[]):MergeRegion[]=>[{regionId:'body',blocks}]
const base=regions(block('a','One'),block('b','Two'))
const plan=(draft:MergeRegion[],current:MergeRegion[],extra:Partial<Parameters<typeof planWordStaleMerge>[0]>={})=>planWordStaleMerge({baseLayoutHash:'layout',currentLayoutHash:'layout',base,draft,current,unverifiedObjects:false,...extra})
test('three-way planning identifies independent, overlapping and identical edits',()=>{
 assert.deepEqual(plan(regions(block('a','Draft'),block('b','Two')),regions(block('a','One'),block('b','Current'))),{status:'review',changes:[{regionId:'body',blockId:'a',side:'draft'},{regionId:'body',blockId:'b',side:'current'}]})
 assert.equal(plan(regions(block('a','Draft'),block('b','Two')),regions(block('a','Current'),block('b','Two'))).status,'conflict')
 assert.equal(plan(regions(block('a','Same'),block('b','Two')),regions(block('a','Same'),block('b','Two'))).changes[0].side,'same')
})
test('planning rejects layout, unverified objects, structural edits, reorder and missing identities',()=>{
 assert.equal(plan(base,base,{currentLayoutHash:'other'}).reason,'layout')
 assert.equal(plan(base,base,{unverifiedObjects:true}).reason,'objects')
 for(const value of [regions(block('a','One')),regions(block('b','Two'),block('a','One')),regions(block('x','One'),block('b','Two')),regions(block('a','One'),block('a','Two'))])assert.equal(plan(value,base).reason,'structure')
})
test('formatting differences in the same block are treated as overlapping edits',()=>{
 const styled=(bold:boolean,italic:boolean):MergeRegion[]=>[{regionId:'body',blocks:[{blockId:'a',content:{kind:'paragraph',inlines:[{text:'One',bold,italic}]}},block('b','Two')]}]
 const baseline=styled(false,false),result=planWordStaleMerge({baseLayoutHash:'layout',currentLayoutHash:'layout',base:baseline,draft:styled(true,false),current:styled(false,true),unverifiedObjects:false})
 assert.equal(result.status,'conflict');assert.equal(result.changes[0].blockId,'a')
})
