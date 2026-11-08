import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {I18nProvider} from './i18n.tsx'
import {WorkbookBatchText,WorkbookBlankBatchPanel} from './WorkbookBlankBatchPanel.tsx'
import type {WorkbookBlankBatchClient} from './workbookBlankBatchClient.ts'

const render=(text:string)=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WorkbookBatchText,{text})}))
test('batch review bounds long cell previews without splitting emoji',()=>{
 const html=render('a'.repeat(399)+'😀'+'tail'.repeat(100_000))
 assert.ok(html.length<1000);assert.match(html,/显示完整单元格内容/);assert.match(html,/aria-expanded="false"/);assert.doesNotMatch(html,/�|tail/)
})
test('short multiline cell text stays visible without a disclosure',()=>{
 const html=render('第一行\nsecond 😀')
 assert.match(html,/第一行\nsecond 😀/);assert.doesNotMatch(html,/aria-expanded/)
})
test('batch save and receipt resolution are disabled until the save prerequisites are ready',()=>{
 for(const attempt of [null,{id:'pending'}])for(const canReview of [false,true]){
  const client={working:false,canReview,transient:null,entries:[{id:'batch',state:{input:{baseRevision:1,cells:[{sheetId:'sheet',row:0,column:0,text:'a'}]},attempt}}]} as unknown as WorkbookBlankBatchClient
  const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WorkbookBlankBatchPanel,{client,sheetName:()=> 'Sheet',onSaved:()=>{}})}))
  assert.match(html,/只剩一个值的备份需要使用当前或更新版本的编辑器恢复/)
  const button=html.match(/<button[^>]*>(?:保存整组|核对保存结果)<\/button>/)?.[0]
  assert.ok(button);assert.equal(button.includes('disabled=""'),!canReview)
 }
})
