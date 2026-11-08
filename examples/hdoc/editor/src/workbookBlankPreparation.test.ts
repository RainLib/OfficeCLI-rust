import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WorkbookBlankPreparation} from './workbookBlankPreparation.ts'
import type {Session} from './api.ts'
import type {BlankObservation} from './workbookBlankInspection.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',format:'xlsx',token:'secret'}
const source='a'.repeat(64),root='b'.repeat(64),sheetId='s_'+'c'.repeat(32),nodeId='n_'+'d'.repeat(32)
const target={sheetId,row:2,column:1},cell:BlankObservation={...target,sheetPart:'xl/worksheets/sheet1.xml',sheetName:'Sheet',sheetIndex:0,sheetState:'visible',address:'B3',nodeId}
const result={revision:4,rootHash:root,cells:[cell]}
test('blank preparation is bound to the selected coordinate, source head and permission',async()=>{
 let count=0,allowed=true
 const gate=new WorkbookBlankPreparation(session,source,async()=>{count++;return result})
 assert.equal(await gate.prepare(target,4,root,()=>allowed),true);assert.deepEqual(gate.prepared(target,4,root),cell)
 assert.equal(await gate.prepare(target,4,root,()=>allowed),true);assert.equal(count,1)
 assert.equal(gate.prepared({...target,column:2},4,root),null);assert.equal(gate.prepared(target,5,root),null);assert.equal(gate.prepared(target,4,'f'.repeat(64)),null)
 allowed=false;assert.equal(await gate.prepare(target,4,root,()=>allowed),false);assert.equal(gate.prepared(target,4,root),null)
 gate.dispose();assert.equal(await gate.prepare(target,4,root,()=>true),false)
})
test('superseded or disposed lookups cannot enable a later edit even if transport ignores abort',async()=>{
 let release!:(value:typeof result)=>void,started!:()=>void
 const entered=new Promise<void>(resolve=>{started=resolve}),pending=new Promise<typeof result>(resolve=>{release=resolve})
 const gate=new WorkbookBlankPreparation(session,source,async()=>{started();return pending})
 const work=gate.prepare(target,4,root,()=>true);await entered;gate.clear();release(result)
 assert.equal(await work,false);assert.equal(gate.prepared(target,4,root),null)
})
test('a stale server head or revoked permission does not populate the cache',async()=>{
 let allowed=true
 const gate=new WorkbookBlankPreparation(session,source,async()=>{allowed=false;return result})
 assert.equal(await gate.prepare(target,4,root,()=>allowed),false);assert.equal(gate.prepared(target,4,root),null)
 const stale=new WorkbookBlankPreparation(session,source,async()=>({...result,rootHash:'f'.repeat(64)}))
 assert.equal(await stale.prepare(target,4,root,()=>true),false);assert.equal(stale.prepared(target,4,root),null)
})
