import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readWorkbookPresence,workbookPresence,workbookFollowCycle} from './workbookPresence.ts'

test('workbook awareness publishes bounded coordinates without cell content',()=>{
 const valid={version:1,sheetId:'sheet-1',row:20,column:3,selection:{row:21,column:3,width:2,height:1},following:8,cellText:'private'}
 assert.deepEqual(readWorkbookPresence(valid),{version:1,sheetId:'sheet-1',row:20,column:3,selection:valid.selection,following:8})
 for(const changes of [{sheetId:''},{sheetId:'x'.repeat(129)},{row:-1},{column:16384},{row:1_048_576},{selection:{row:1_048_575,column:0,width:1,height:2}},{selection:null},{following:-1},{row:NaN}])assert.equal(readWorkbookPresence({...valid,...changes}),null)
 assert.deepEqual(workbookPresence({sheetId:'s',row:1,column:2,zoom:2},null),{version:1,sheetId:'s',row:1,column:2})
})
test('workbook following prevents direct and transitive cycles',()=>{
 const location={version:1 as const,sheetId:'s',row:0,column:0}
 const peers=[{clientId:2,workbook:{...location,following:3}},{clientId:3,workbook:{...location,following:1}}]
 assert.equal(workbookFollowCycle(peers,1,2),true);assert.equal(workbookFollowCycle(peers,4,2),false);assert.equal(workbookFollowCycle(peers,1,1),true)
})
