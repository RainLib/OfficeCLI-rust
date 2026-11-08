import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {I18nProvider} from './i18n.tsx'
import {WordPaperOverview,wordPaperOverviewPage} from './WordPaperOverview.tsx'
import type {WordLayout} from './wordRegions.ts'

test('paper overview bounds its rows and opens the page containing the current section',()=>{
 const layout:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,stories:[],sections:Array.from({length:140},(_,index)=>({id:`section-${index}`,differentFirstPage:false,page:{},headers:{},footers:{}}))}
 const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordPaperOverview,{layout,section:128,onClose:()=>{}})}))
 assert.equal((html.match(/<li/g)??[]).length,20);assert.match(html,/第 121–140 节，共 140 节/);assert.match(html,/第 129 节/);assert.match(html,/aria-current="true"/);assert.doesNotMatch(html,/第 120 节/)
 assert.equal(wordPaperOverviewPage(140,999),3);assert.equal(wordPaperOverviewPage(140,-5),0);assert.equal(wordPaperOverviewPage(140,null),0)
})
