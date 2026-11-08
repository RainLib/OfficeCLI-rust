import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {Session} from './api.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import {parseWorkbookCombinedBackup,serializeWorkbookCombinedBackup,stageWorkbookCombinedBackup} from './workbookCombinedBackup.ts'
import {parseBlankBatchBackup} from './workbookBlankBatchBackup.ts'

const session:Session={documentId:'doc',userId:'alice',scope:'write',token:'secret',format:'xlsx',apiUrl:'https://owned.test/v1/documents'}
const source='a'.repeat(64),base='https://owned.test/editor',sheet='s_'+'c'.repeat(32),fixed:FixedDraftState={version:4,texts:[],images:[],attempt:null,workbookBuffer:{base:{nodeId:'node',nodeHash:'b'.repeat(64),text:'old'},revision:0,text:'local',initial:'old',sheetId:'sheet',row:0,column:0}}
const input={documentId:'doc',sourceSha256:source,baseRevision:4,rootHash:'b'.repeat(64),cells:[{sheetId:sheet,row:2,column:1,text:'甲😀'},{sheetId:sheet,row:2,column:2,text:'乙'}]}
test('combined workbook backup retains fixed input and every batch, with identity binding',()=>{
 const states=[{input,attempt:null},{input:{...input,cells:input.cells.map(cell=>({...cell,row:cell.row+1}))},attempt:null}],raw=serializeWorkbookCombinedBackup(session,source,base,fixed,states),result=parseWorkbookCombinedBackup(raw,session,source,base)
 assert.equal(result.fixed.workbookBuffer?.text,'local');assert.deepEqual(result.batches.map(part=>parseBlankBatchBackup(part,session,source,base)),states);assert.ok(!raw.includes('secret'))
 for(const changed of [{...session,userId:'bob'},{...session,documentId:'other'},{...session,apiUrl:'https://other.test/v1/documents'}])assert.throws(()=>parseWorkbookCombinedBackup(raw,changed,source,base))
 assert.throws(()=>parseWorkbookCombinedBackup(raw,session,'f'.repeat(64),base))
 const tampered=JSON.parse(raw);tampered.batches[1].state.input.cells[0].row=-1;assert.throws(()=>parseWorkbookCombinedBackup(JSON.stringify(tampered),session,source,base))
})
test('empty bundles and legacy unbound fixed records are refused',()=>{
 const empty:FixedDraftState={version:3,texts:[],images:[],attempt:null};assert.throws(()=>serializeWorkbookCombinedBackup(session,source,base,empty,[]))
 const value=JSON.parse(serializeWorkbookCombinedBackup(session,source,base,fixed,[]));value.fixed.schemaVersion='hcd-fixed-recovery/1';assert.throws(()=>parseWorkbookCombinedBackup(JSON.stringify(value),session,source,base))
})
test('partial staging can be retried without dropping later batch copies',async()=>{
 const states=[{input,attempt:null},{input:{...input,cells:input.cells.map(cell=>({...cell,row:cell.row+1}))},attempt:null}],bundle=parseWorkbookCombinedBackup(serializeWorkbookCombinedBackup(session,source,base,fixed,states),session,source,base)
 const fixedCopies=new Set<string>(),batches=new Set<string>();let interrupted=true,started=0
 const saveFixed=async(raw:string)=>{fixedCopies.add(raw)},saveBatch=async(raw:string)=>{if(interrupted&&batches.size===1){interrupted=false;throw Error('storage unavailable')}batches.add(raw)}
 await assert.rejects(stageWorkbookCombinedBackup(bundle,saveFixed,saveBatch,()=>started++),/storage unavailable/);assert.equal(started,3);assert.equal(fixedCopies.size,1);assert.equal(batches.size,1)
 await stageWorkbookCombinedBackup(bundle,saveFixed,saveBatch,()=>started++);assert.equal(fixedCopies.size,1);assert.equal(batches.size,2)
})
