import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {ApiError} from './api.ts'
import {DraftBootstrapError,readServerDraft} from './draftBootstrap.ts'
import {classifyDocumentProblem,documentProblem,documentProblemCodes,documentProblemCopy,documentProblemDiagnostic,EditorDocumentError} from './documentProblems.ts'
import {DocumentProblemView} from './DocumentProblem.tsx'
import {I18nProvider} from './i18n.tsx'
import {legacyProtocol} from './collaborationProtocol.ts'

test('HTTP failures have stable codes independent of backend response text',()=>{
 for(const [status,suffix] of [[400,1000],[401,1001],[403,1003],[404,1004],[408,2003],[409,1009],[410,1004],[415,3002],[422,3001],[426,1026],[429,2004],[500,2002],[503,2002],[504,2003]]){
  const problem=classifyDocumentProblem(new ApiError(status,'Bearer secret-token https://private.test/path?token=secret'),'content')
  assert.equal(problem.code,`HCD-DOC-${suffix}`);assert.equal(problem.httpStatus,status);assert.equal(problem.stage,'content')
  for(const locale of ['zh-CN','en-US','zh-TW'] as const){const diagnostic=documentProblemDiagnostic(problem,locale);assert.doesNotMatch(diagnostic,/secret|private.test|Bearer/);assert.match(diagnostic,new RegExp(`HTTP: ${status}`))}
 }
})
test('controlled failure categories distinguish storage, content, network and render errors',()=>{
 for(const [cause,code]of [[new TypeError('fetch failed'),'2001'],[new SyntaxError('raw content'),'3001'],[new DOMException('deadline','TimeoutError'),'2003'],[new DraftBootstrapError('localDraftUnavailable'),'4001'],[new DraftBootstrapError('localDraftProtocolUnavailable'),'4002'],[new DraftBootstrapError('localDraftAuthorityChanged'),'1009'],[new Error('unsupportedInlineContainerModel'),'1026'],[new Error('private arbitrary response'),'9999']] as const)assert.equal(classifyDocumentProblem(cause,'recovery').code,`HCD-DOC-${code}`)
 assert.equal(classifyDocumentProblem(new TypeError('render bug'),'render').code,'HCD-DOC-9000')
 assert.equal(classifyDocumentProblem(new Error('blank batch superseded'),'recovery').code,'HCD-DOC-1009')
 const identity=documentProblem('HCD-DOC-4003','recovery');assert.deepEqual(classifyDocumentProblem(new EditorDocumentError(identity)),identity)
 assert.equal(new EditorDocumentError(identity).message,identity.code)
 assert.deepEqual(documentProblem('HCD-DOC-9999','open',NaN),{code:'HCD-DOC-9999',stage:'open'})
})
test('all codes have complete locale copy and regional fallbacks',()=>{
 for(const code of documentProblemCodes)for(const locale of ['zh-CN','zh-TW','zh-HK','en-US','en-GB'] as const){const copy=documentProblemCopy(documentProblem(code),locale);assert.ok(copy.title.length>4);assert.ok(copy.description.length>15);assert.ok(copy.stages.recovery);assert.ok(copy.retry);assert.ok(copy.copy)}
 assert.deepEqual(documentProblemCopy(documentProblem('HCD-DOC-1001'),'en-GB'),documentProblemCopy(documentProblem('HCD-DOC-1001'),'en-US'))
 assert.deepEqual(documentProblemCopy(documentProblem('HCD-DOC-1001'),'zh-HK'),documentProblemCopy(documentProblem('HCD-DOC-1001'),'zh-TW'))
})
test('server draft wrappers preserve original network/HTTP identity rather than claiming storage failed',async()=>{
 const fetch=globalThis.fetch,session={documentId:'qa',token:'secret',scope:'write' as const,format:'docx',collaborationProtocol:legacyProtocol}
 try{
  for(const [cause,expected]of [[new TypeError('offline'),'HCD-DOC-2001'],[new ApiError(401,'private'),'HCD-DOC-1001'],[new ApiError(503,'private'),'HCD-DOC-2002']] as const){globalThis.fetch=async()=>{throw cause};await assert.rejects(readServerDraft(session,new AbortController().signal),error=>classifyDocumentProblem(error,'recovery').code===expected)}
 }finally{globalThis.fetch=fetch}
})
test('error screens expose recovery, safe details and heading hierarchy without a fake return control',()=>{
 const render=(compact=false,onClose?:()=>void)=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(DocumentProblemView,{problem:documentProblem('HCD-DOC-1003','content',403),documentId:'qa-document',compact,onRetry:()=>{},onClose})}))
 const full=render();assert.match(full,/<h1[^>]*>暂时无法访问此文档/);assert.match(full,/问题详情/);assert.match(full,/重新尝试/);assert.match(full,/HTTP 403/);assert.doesNotMatch(full,/返回原应用/)
 assert.match(render(false,()=>{}),/返回原应用/);assert.match(render(true),/<h2/);assert.doesNotMatch(render(true),/<h1/)
})
