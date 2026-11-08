import {test} from 'node:test'
import assert from 'node:assert/strict'
import {recoveryImageAssets} from './recoveryImageAssets.ts'
import type {SharedImageDraft} from './collaborativeImages.ts'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {I18nProvider} from './i18n.tsx'
import {RecoveryImageDraftReview} from './RecoveryImageDraftReview.tsx'
import {recoveryImageFieldValues} from './recoveryImageFieldValues.ts'

test('recovery review offers archived original and replacement separately and deduplicates identical bytes',()=>{
 const original='a'.repeat(64),replacement='b'.repeat(64),a=Uint8Array.of(1),b=Uint8Array.of(2)
 const draft={base:{assetHash:original},assetHash:replacement} as SharedImageDraft
 const resources=new Map([[original,a],[replacement,b]])
 assert.deepEqual(recoveryImageAssets(draft,resources),[{kind:'original',hash:original,bytes:a},{kind:'replacement',hash:replacement,bytes:b}])
 assert.deepEqual(recoveryImageAssets({...draft,assetHash:undefined},resources),[{kind:'original',hash:original,bytes:a}])
 assert.deepEqual(recoveryImageAssets({...draft,assetHash:original},resources),[{kind:'original',hash:original,bytes:a}])
 assert.deepEqual(recoveryImageAssets(draft,new Map([[replacement,b]])),[{kind:'replacement',hash:replacement,bytes:b}])
})

test('the review labels both archived images and exposes their download actions',()=>{
 const original='a'.repeat(64),replacement='b'.repeat(64),geometry={unit:'pt' as const,x:0,y:0,width:20,height:10}
 const draft:SharedImageDraft={intentId:'1'.repeat(36),clientId:1,ancestors:[],base:{nodeId:'n_'+'c'.repeat(32),visualHash:'d'.repeat(64),assetHash:original,geometry},revision:1,geometry,touched:['assetHash'],assetHash:replacement}
 const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(RecoveryImageDraftReview,{current:[],recovered:[draft],resources:new Map([[original,Uint8Array.of(1)],[replacement,Uint8Array.of(2)]]),baselines:null})}))
 assert.match(html,/恢复包中的原图/);assert.match(html,/恢复包中的替换图片/);assert.match(html,/下载恢复包原图/);assert.match(html,/下载恢复包替换图片/)
})

test('a verified image conflict shows the baseline, recovery and saved field values',()=>{
 const geometry={unit:'pt' as const,x:0,y:0,width:20,height:10},saved={nodeId:'n_'+'c'.repeat(32),visualHash:'e'.repeat(64),geometry:{...geometry,width:35}}
 const draft:SharedImageDraft={intentId:'1'.repeat(36),clientId:1,ancestors:[],base:{nodeId:saved.nodeId,visualHash:'d'.repeat(64),geometry},revision:1,geometry:{...geometry,width:25},touched:['width']}
 const baselines={headRevision:2,rootHash:'f'.repeat(64),items:[{intentId:draft.intentId,nodeId:saved.nodeId,revision:1,baseline:'verified' as const,current:'changed' as const,saved,fields:[{field:'width' as const,status:'conflict' as const}]}]}
 const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(RecoveryImageDraftReview,{current:[],recovered:[draft],resources:new Map(),baselines})}))
 assert.match(html,/原始基线: <code[^>]*>20/);assert.match(html,/恢复包草稿: <code[^>]*>25/);assert.match(html,/当前已保存: <code[^>]*>35/)
 assert.deepEqual(recoveryImageFieldValues(draft,saved,'assetHash'),{base:null,draft:null,saved:null})
})

test('image restore requires an explicit conflict choice and blocks an existing room draft',()=>{
 const geometry={unit:'pt' as const,x:0,y:0,width:20,height:10},saved={nodeId:'n_'+'c'.repeat(32),visualHash:'e'.repeat(64),geometry:{...geometry,width:35}}
 const draft:SharedImageDraft={intentId:'1'.repeat(36),clientId:1,ancestors:[],base:{nodeId:saved.nodeId,visualHash:'d'.repeat(64),geometry},revision:1,geometry:{...geometry,width:25},touched:['width']}
 const baselines={headRevision:2,rootHash:'f'.repeat(64),items:[{intentId:draft.intentId,nodeId:saved.nodeId,revision:1,baseline:'verified' as const,current:'changed' as const,saved,fields:[{field:'width' as const,status:'conflict' as const}]}]}
 const render=(current:SharedImageDraft[])=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(RecoveryImageDraftReview,{current,recovered:[draft],resources:new Map(),baselines,canRecover:true,onRecover:()=>{}})}))
 const html=render([]);assert.match(html,/使用恢复包草稿/);assert.match(html,/保留当前已保存值/);assert.match(html,/<button type="button" disabled="">恢复此图片草稿/)
 assert.match(render([draft]),/请先处理当前协作中此图片的草稿/)
})
