import {test} from 'node:test'
import assert from 'node:assert/strict'
import {captureWorkbookViewport,restoreWorkbookViewport} from './workbookViewport.ts'

test('remote refresh restores the active sheet, view and selection without changing data',()=>{
 const calls:unknown[][]=[]
 const sheet={getSheetId:()=> 's2',getVisibleRange:()=>({startRow:432,startColumn:3}),getZoom:()=>.8,getMaxRows:()=>1000,getMaxColumns:()=>26,zoom:(n:number)=>calls.push(['zoom',n]),getRange:(...args:number[])=>args,setActiveRange:(range:unknown)=>calls.push(['selection',range]),scrollToCell:(row:number,column:number)=>calls.push(['scroll',row,column])}
 const workbook={getActiveSheet:()=>sheet,getActiveRange:()=>({getRow:()=>435,getColumn:()=>4,getHeight:()=>2,getWidth:()=>1}),getSheetBySheetId:(id:string)=>id==='s2'?sheet:null,setActiveSheet:(s:unknown)=>calls.push(['sheet',s])}
 const viewport=captureWorkbookViewport(workbook as any);assert.ok(viewport);assert.equal(restoreWorkbookViewport(workbook as any,viewport),true)
 assert.deepEqual(calls,[['sheet',sheet],['zoom',.8],['selection',[435,4,2,1]],['scroll',432,3]])
 assert.equal(restoreWorkbookViewport(workbook as any,{...viewport,sheetId:'removed'}),false)
})
