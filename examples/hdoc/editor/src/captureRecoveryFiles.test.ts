import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {captureRecoveryFiles} from './captureRecoveryFiles.ts'
const signal=()=>new AbortController().signal
const empty=async()=>[]
test('capture reads both private journals while locked and freezes the document before release',async()=>{
 const doc=new Y.Doc();doc.getMap('text').set('value','before');let locked=false
 try{const result=await captureRecoveryFiles({document:doc,signal:signal(),busy:()=>false,withLock:async work=>{locked=true;try{return await work()}finally{locked=false;doc.getMap('text').set('value','after')}},nodeFiles:async()=>{assert.equal(locked,true);return[]},images:async()=>{assert.equal(locked,true);return[]}});try{assert.equal(result.document.getMap('text').get('value'),'before');assert.equal(doc.getMap('text').get('value'),'after')}finally{result.document.destroy()}}finally{doc.destroy()}
})
test('file preparation starting during capture invalidates it and device errors propagate',async()=>{
 const doc=new Y.Doc();let busy=false,release!:(v:never[])=>void;const gate=new Promise<never[]>(resolve=>{release=resolve})
 try{const work=captureRecoveryFiles({document:doc,signal:signal(),busy:()=>busy,withLock:work=>work(),nodeFiles:()=>gate,images:empty});busy=true;release([]);await assert.rejects(work,/recoveryArchiveFileBusy/);await assert.rejects(captureRecoveryFiles({document:doc,signal:signal(),busy:()=>false,withLock:work=>work(),nodeFiles:async()=>{throw Error('storage')},images:empty}),/storage/)}finally{doc.destroy()}
})
