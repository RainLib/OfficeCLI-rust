import {test} from 'node:test'
import assert from 'node:assert/strict'
import {markWorkbookPeers} from './workbookPeerMarks.ts'
import type {FWorkbook} from '@univerjs/preset-sheets-core'
import type {FixedPeer} from './FixedPresence.tsx'

test('peer marks stay on the current sheet and are disposed without editing cells',()=>{
 const ranges:Array<number[]>=[],styles:unknown[]=[],removed:number[]=[]
 const sheet={getSheetId:()=> 's1',getMaxRows:()=>100,getMaxColumns:()=>20,getRange:(...coordinates:number[])=>{ranges.push(coordinates);return{highlight:(style:unknown)=>{styles.push(style);const index=styles.length;return{dispose:()=>removed.push(index)}}}}}
 const book={getActiveSheet:()=>sheet} as unknown as FWorkbook
 const peer=(id:string,sheetId:string,row:number):FixedPeer=>({id,name:id,color:'#13866a',clientId:row,workbook:{version:1,sheetId,row,column:0,selection:{row,column:1,height:2,width:3}}})
 const release=markWorkbookPeers(book,[peer('me','s1',0),peer('bob','s1',4),peer('other','s2',8),peer('beyond','s1',99)],'me')
 assert.deepEqual(ranges,[[4,1,2,3]]);assert.deepEqual(styles,[{stroke:'#13866a',strokeWidth:2,fill:'rgba(0,0,0,0)',widgets:{},widgetSize:0}]);release();assert.deepEqual(removed,[1])
})
test('overlapping peers share one border and label; both overlays are disposed',()=>{
 const labels:Array<()=>any>=[],removed:string[]=[],ranges:number[][]=[]
 const sheet={getSheetId:()=> 's1',getMaxRows:()=>100,getMaxColumns:()=>20,getRange:(...value:number[])=>{ranges.push(value);return{highlight:()=>({dispose:()=>removed.push('border')}),attachRangePopup:({componentKey}:{componentKey:()=>any})=>{labels.push(componentKey);return{dispose:()=>removed.push('label')}}}}}
 const book={getActiveSheet:()=>sheet} as unknown as FWorkbook
 const peers:FixedPeer[]=Array.from({length:4},(_,i)=>({id:`user${i}`,name:`Name ${i}`,color:'#13866a',clientId:i+1,workbook:{version:1,sheetId:'s1',row:1,column:1,selection:{row:1,column:1,height:1,width:1}}}))
 const dispose=markWorkbookPeers(book,peers,'self');assert.deepEqual(ranges,[[1,1,1,1]]);assert.equal(labels.length,1)
 const items=labels[0]().props.children;assert.deepEqual(items.map((item:any)=>item.props.children),['Name 0','Name 1','Name 2','+1'])
 dispose();assert.deepEqual(removed,['border','label'])
})
