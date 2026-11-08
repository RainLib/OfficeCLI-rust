import test from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {I18nProvider} from './i18n.tsx'
import {WordStoppedDraftRecovery,checkpointAllowsFreshDraftReview} from './WordStoppedDraftRecovery.tsx'
import {WordCompatibilityProblem} from './WordCompatibilityProblem.tsx'
import {documentProblem} from './documentProblems.ts'
import type {Session} from './api.ts'

test('stopped draft requires explicit review and hides the entry from readers',()=>{
 const session={documentId:'doc',token:'token',userId:'alice',scope:'write',format:'docx',collabUrl:'ws://localhost:1234',collaborationEpoch:0,collaborationProtocol:'hcd-word-regions/2'} as Session
 const render=(value:Session)=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordStoppedDraftRecovery,{session:value})}))
 const html=render(session);assert.match(html,/核对停房协作草稿/);assert.match(html,/比较草稿/);assert.doesNotMatch(html,/保存草稿/)
 const blocked=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordStoppedDraftRecovery,{session,blocked:true})}));assert.match(blocked,/<button[^>]*disabled[^>]*>比较草稿<\/button>/)
 const invalid=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordStoppedDraftRecovery,{session,attemptId:'invalid'})}));assert.match(invalid,/本地保存身份不可用或已损坏/);assert.match(invalid,/<button[^>]*disabled[^>]*>检查并取消未准备的请求<\/button>/)
 const cancellation=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordStoppedDraftRecovery,{session,attemptId:'a'.repeat(32),pendingAction:'cancel'})}));assert.match(cancellation,/取消结果尚未确认/);assert.doesNotMatch(cancellation,/保存结果未知/)
 assert.equal(render({...session,scope:'read'}),'')
})

test('a recovery page awaiting device discovery blocks saves and topology without claiming corruption',()=>{
 const session={documentId:'doc',token:'token',userId:'alice',displayName:'Alice',scope:'write',format:'docx',collabUrl:'ws://localhost:1234',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'} as Session
 const html=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordCompatibilityProblem,{session,checkpointSession:session,problem:documentProblem('HCD-DOC-1026')})}))
 for(const label of ['比较草稿','读取页面设置','选择节','检查待确认的保存'])assert.match(html,new RegExp(`<button[^>]*disabled[^>]*>${label}</button>`))
 assert.doesNotMatch(html,/本地保存身份不可用或已损坏|保存结果未知|本机停房草稿请求/)
})

test('only a later confirmation for the same base permits a fresh comparison',()=>{
 const confirmed={checkpointId:'a'.repeat(32),baseRevision:2,revision:3,status:'confirmed' as const}
 assert.equal(checkpointAllowsFreshDraftReview(true,2,confirmed),true)
 assert.equal(checkpointAllowsFreshDraftReview(false,2,confirmed),false)
 assert.equal(checkpointAllowsFreshDraftReview(true,1,confirmed),false)
 assert.equal(checkpointAllowsFreshDraftReview(true,2,{...confirmed,status:'pending'}),false)
 assert.equal(checkpointAllowsFreshDraftReview(true,2,{...confirmed,status:'confirmed-stale'},confirmed.checkpointId),false)
 assert.equal(checkpointAllowsFreshDraftReview(true,2,{...confirmed,status:'rebased'},confirmed.checkpointId),true)
 assert.equal(checkpointAllowsFreshDraftReview(true,2,{...confirmed,status:'rebased-stale'},confirmed.checkpointId),false)
 assert.equal(checkpointAllowsFreshDraftReview(true,undefined,confirmed),false)
 assert.equal(checkpointAllowsFreshDraftReview(true,undefined,confirmed,'a'.repeat(32)),true)
 assert.equal(checkpointAllowsFreshDraftReview(true,2,confirmed,'b'.repeat(32)),false)
})
