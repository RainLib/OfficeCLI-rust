import { test, expect } from '@playwright/test'
import { compareRevisions, textDifference } from '../src/revisionDiff.ts'
import type { Block, Projection } from '../src/schema.ts'
const block=(id:string,text:string):Block=>({blockId:id,blockHash:id,region:'body',readOnly:false,content:{kind:'paragraph',inlines:[{text}]}})
const projection=(blocks:Block[]):Projection=>({documentId:'diff',revision:0,blocks})

test('revision diffs distinguish insertion, deletion, formatting, movement and complex content',()=>{
  const a=block('a','unchanged'), b=block('b','removed'), c=block('c','same text'), d=block('d','complex')
  d.readOnly=true;d.readOnlyHtml='<table><tr><td>old</td></tr></table>'
  const nextC={...c,content:{...c.content,inlines:[{text:'same text',bold:true}]}}
  const nextD={...d,readOnlyHtml:'<table><tr><td>new</td></tr></table>'}
  const result=compareRevisions(projection([a,b,c,d]),projection([a,block('inserted','new'),nextC,nextD]))
  expect(result.map(({id,kind,detail})=>({id,kind,detail}))).toEqual([
    {id:'b',kind:'removed',detail:'text'},{id:'inserted',kind:'added',detail:'text'},
    {id:'c',kind:'modified',detail:'format'},{id:'d',kind:'modified',detail:'complex'},
  ])
  const moved=compareRevisions(projection([a,b,c]),projection([c,a,b]))
  expect(moved).toHaveLength(1);expect(moved[0]).toMatchObject({id:'c',kind:'moved'})
  expect(compareRevisions(projection([a]),projection([{...a,content:{...a.content,inlines:[{text:'un'},{text:'changed'}]}}]))).toEqual([])
})

test('inline diffs preserve Unicode offsets and bound long replacements',()=>{
  const before='建设周期九个月，保留🙂内容。', after='建设周期六个月，新增🙂内容。'
  const [oldRanges,newRanges]=textDifference(before,after)
  expect(oldRanges.map(range=>before.slice(range.from,range.to)).join('')).toBe('九保留')
  expect(newRanges.map(range=>after.slice(range.from,range.to)).join('')).toBe('六新增')
  const [largeOld,largeNew]=textDifference('前'+'甲'.repeat(2000)+'后','前'+'乙'.repeat(2000)+'后')
  expect(largeOld).toEqual([{from:1,to:2001}]);expect(largeNew).toEqual([{from:1,to:2001}])
})
