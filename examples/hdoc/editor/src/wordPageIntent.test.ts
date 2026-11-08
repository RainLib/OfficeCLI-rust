import {test} from 'node:test'
import assert from 'node:assert/strict'
import {wordPageIntent} from './wordPageIntent.ts'
import {matchesWordLayoutTransition} from './wordLayoutTransition.ts'
import type {WordLayout} from './wordRegions.ts'
const id=(n:number)=>`n_${n.toString(16).padStart(32,'0')}`,hash='a'.repeat(64)
const source:WordLayout={schemaVersion:'hcd-flow-layout/2',evenAndOddHeaders:false,stories:[],sections:[{id:id(1),differentFirstPage:false,page:{widthTwips:12240,heightTwips:15840,orientation:'portrait',marginsTwips:{top:1440}},headers:{},footers:{}},{id:id(2),differentFirstPage:false,page:{},headers:{},footers:{}}]}
test('one page transaction combines size and margins with untouched field preconditions',()=>{
 const before=structuredClone(source),input={layout:source,layoutHash:hash,revision:2,target:{kind:'document' as const},paper:{widthTwips:11906,heightTwips:16838,orientation:'portrait' as const},margins:{top:720,left:900}},result=wordPageIntent(input)
 assert.deepEqual(source,before);assert.deepEqual(result.affectedSections,[id(1),id(2)]);assert.equal(result.intent!.changes.find(entry=>entry.sectionId===id(1)&&entry.field==='marginTop')?.expected,1440)
 assert.equal(matchesWordLayoutTransition(before,result.preview,{schemaVersion:'hcd-word-layout-transaction/1',documentId:'doc',transactionId:'b'.repeat(32),baseRevision:2,expectedRevision:2,actor:{userId:'alice',displayName:'Alice'},edits:result.intent!}),true)
 assert.equal(wordPageIntent({...input,layout:result.preview}).intent,null)
})
test('combined change enforces the native transaction limit',()=>{
 const many=structuredClone(source);many.sections=Array.from({length:205},(_,i)=>({id:id(i+1),differentFirstPage:false,page:{},headers:{},footers:{}}))
 assert.throws(()=>wordPageIntent({layout:many,layoutHash:hash,revision:2,target:{kind:'document'},paper:{widthTwips:11906,heightTwips:16838,orientation:'portrait'},margins:{top:720,left:900}}),/word-page-limit/)
})
