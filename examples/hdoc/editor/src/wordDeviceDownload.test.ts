import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {IDBFactory} from 'fake-indexeddb'
import * as Y from 'yjs'
import type {Session} from './api.ts'
import {WordDeviceDraft,wordDeviceIdentity} from './wordDeviceDraft.ts'
import {WordDeviceDownload,wordDeviceDownloadError} from './wordDeviceDownload.ts'
import {WordDeviceDownloadStatus} from './WordDeviceDownloadButton.tsx'
import {I18nProvider} from './i18n.tsx'
const session={documentId:'word',token:'private',scope:'write',format:'docx'} as Session,cache={} as WordDeviceDraft
const deferred=()=>{let resolve!:()=>void,reject!:(cause:unknown)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
test('backup preparation is single-flight and only reports browser handoff',async()=>{
 const waiting=deferred();let calls=0,current:()=>boolean=()=>false
 const operation=new WordDeviceDownload(cache,session,check=>{calls++;current=check;return waiting.promise})
 const a=operation.run(),b=operation.run();assert.equal(a,b);assert.equal(operation.snapshot().phase,'preparing');await Promise.resolve();assert.equal(calls,1);assert.equal(current(),true)
 waiting.resolve();await a;assert.deepEqual(operation.snapshot(),{phase:'requested'});operation.dispose()
})
test('failed backup keeps a retryable state and never exposes raw private errors',async()=>{
 let calls=0;const operation=new WordDeviceDownload(cache,session,async()=>{if(++calls===1)throw Error('private endpoint/token')})
 await operation.run();assert.deepEqual(operation.snapshot(),{phase:'failed',error:'unavailable'});await operation.run();assert.equal(calls,2);assert.deepEqual(operation.snapshot(),{phase:'requested'});operation.dispose()
})
test('disposing during preparation invalidates handoff and ignores its late failure',async()=>{
 const waiting=deferred();let current:()=>boolean=()=>false,notifications=0
 const old=new WordDeviceDownload(cache,session,check=>{current=check;return waiting.promise}),unsubscribe=old.subscribe(()=>notifications++)
 const pending=old.run();await Promise.resolve();assert.equal(current(),true);old.dispose();assert.equal(current(),false)
 const next=new WordDeviceDownload({} as WordDeviceDraft,{...session,documentId:'other'},async()=>{});await next.run();waiting.reject(Error('word-device-scope-changed'));await pending
 assert.equal(notifications,1);assert.deepEqual(next.snapshot(),{phase:'requested'});unsubscribe();next.dispose()
})
test('unmount before preparation starts never reads the old device cache',async()=>{
 let calls=0;const operation=new WordDeviceDownload(cache,session,async()=>{calls++}),pending=operation.run();operation.dispose();await pending;await operation.run();assert.equal(calls,0)
})
test('scope changes before effect cleanup prevent an old file handoff or completion',async()=>{
 const waiting=deferred();let bound=true,current:()=>boolean=()=>false
 const operation=new WordDeviceDownload(cache,session,check=>{current=check;return waiting.promise},()=>bound),pending=operation.run()
 await Promise.resolve();assert.equal(current(),true);bound=false;assert.equal(current(),false);waiting.resolve();await pending;assert.notEqual(operation.snapshot().phase,'requested');operation.dispose()
})
test('synchronous subscribers cannot launch a duplicate preparation',async()=>{
 let calls=0;const waiting=deferred(),operation=new WordDeviceDownload(cache,session,()=>{calls++;return waiting.promise})
 const unsubscribe=operation.subscribe(()=>{if(operation.snapshot().phase==='preparing')void operation.run()});const pending=operation.run();await Promise.resolve();assert.equal(calls,1);waiting.resolve();await pending;unsubscribe();operation.dispose()
})
test('scope/change and size failures have separate safe classifications',()=>{
 for(const message of ['word-device-scope','word-device-scope-changed','word-device-backup-changed'])assert.equal(wordDeviceDownloadError(Error(message)),'changed')
 for(const message of ['word-device-backup-limit','word-device-limit'])assert.equal(wordDeviceDownloadError(Error(message)),'limit')
 assert.equal(wordDeviceDownloadError({message:'word-device-scope'}),'unavailable')
})
test('backup controls expose waiting, actionable safe errors and accurate handoff language',async()=>{
 const waiting=deferred(),operation=new WordDeviceDownload(cache,session,()=>waiting.promise),render=()=>renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordDeviceDownloadStatus,{operation})}))
 const pending=operation.run();operation.dismiss();assert.equal(operation.snapshot().phase,'preparing');assert.match(render(),/disabled=""/);assert.match(render(),/aria-busy="true"/);assert.match(render(),/正在准备备份/)
 waiting.reject(Error('word-device-backup-limit'));await pending;assert.match(render(),/HCD-BACKUP-1003/);assert.match(render(),/本机草稿仍保留/);assert.match(render(),/role="alert"/);assert.doesNotMatch(render(),/disabled=""/);operation.dispose()
 const success=new WordDeviceDownload(cache,session,async()=>{});await success.run();const requested=renderToStaticMarkup(createElement(I18nProvider,{initialLocale:'zh-CN',children:createElement(WordDeviceDownloadStatus,{operation:success})}));assert.match(requested,/请确认浏览器已保存文件/);assert.match(requested,/关闭备份提示/);assert.doesNotMatch(requested,/下载成功/);success.dismiss();assert.deepEqual(success.snapshot(),{phase:'idle'});success.dispose()
})
test('production backup preparation cannot emit a stale file or consume the device journal',async()=>{
 const scoped={...session,userId:'alice',collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2' as const,apiUrl:'https://example.test/v1/documents',collabUrl:'wss://example.test/collab'},identity=await wordDeviceIdentity(scoped,'alice','https://example.test/editor'),device=await WordDeviceDraft.open(identity.name,new IDBFactory()),doc=new Y.Doc(),waiting=deferred(),entered=deferred()
 const originalRecords=device.records.bind(device),createURL=URL.createObjectURL;let bound=true,emitted=0
 URL.createObjectURL=()=>{emitted++;throw Error('unexpected file handoff')}
 try{
  doc.getText('body').insert(0,'base');await device.bind(doc);doc.getText('body').insert(4,' private changes');await device.flush();const before=await device.records()
  device.records=async()=>{entered.resolve();await waiting.promise;return originalRecords()}
  const operation=new WordDeviceDownload(device,scoped,undefined,()=>bound),pending=operation.run();await entered.promise;bound=false;waiting.resolve();await pending
  assert.equal(emitted,0);assert.deepEqual(await originalRecords(),before);assert.notEqual(operation.snapshot().phase,'requested');operation.dispose()
 }finally{waiting.resolve();URL.createObjectURL=createURL;await device.close();doc.destroy()}
})
