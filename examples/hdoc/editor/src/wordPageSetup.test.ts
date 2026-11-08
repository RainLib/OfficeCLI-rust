import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {I18nProvider} from './i18n.tsx'
import {WordPageSetup} from './WordPageSetup.tsx'
import {WordPaperOverview} from './WordPaperOverview.tsx'
import type {WordLayout} from './wordRegions.ts'
const layout:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,stories:[],sections:[{id:`n_${'1'.repeat(32)}`,differentFirstPage:false,page:{widthTwips:11906,heightTwips:16838},headers:{},footers:{}}]}
const render=(children:React.ReactNode)=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children}))
test('page setup requires a review before submitting and identifies unavailable editing',()=>{
 const markup=render(createElement(WordPageSetup,{layout,layoutHash:'a'.repeat(64),revision:2,section:0,onClose:()=>{}}));assert.match(markup,/页面设置/);assert.match(markup,/留空的字段保持原值/);assert.match(markup,/此处暂不支持修改页面设置/);assert.match(markup,/核对更改/);assert.doesNotMatch(markup,/应用设置/)
})
test('paper overview only offers editing with an explicit coordinator',()=>{
 const props={layout,section:0,onClose:()=>{}};assert.doesNotMatch(render(createElement(WordPaperOverview,props)),/>页面设置<\/button>/)
 assert.match(render(createElement(WordPaperOverview,{...props,editing:{revision:2,layoutHash:'a'.repeat(64),submit:async()=>({revision:3})}})),/>页面设置<\/button>/)
})
