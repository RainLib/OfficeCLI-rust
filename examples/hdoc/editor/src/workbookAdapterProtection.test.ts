import {test} from 'node:test'
import assert from 'node:assert/strict'
import {HcdUniverAdapter, type HcdGridDraftPort} from '../../xlsx-univer-viewer/src/adapter.ts'
import type {NodeLink} from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import {WorkbookInputCapture} from './workbookInputBuffer.ts'
import {TextDraftStore} from './textDrafts.ts'
import {ImageDraftStore} from './imageDrafts.ts'
import {FixedSaveController} from './fixedSaveController.ts'

test('blank batch handoff restores the grid first and rejects mixed or formula edits',async()=>{
 const restored:Array<{row:number;column:number}>=[],accepted:unknown[]=[],statuses:string[]=[]
 const sheet={getRange:(row:number,column:number)=>({setValue:()=>restored.push({row,column})})},workbook={getSheetBySheetId:()=>sheet}
 const client={sheets:()=>[],manifest:{revision:2,rootHash:'a'.repeat(64)},chunkRevision:()=>2}
 const port:HcdGridDraftPort={text:()=>undefined,edit:()=>{},writable:()=>true,stageBlankBatch:(cells,revision,root)=>{assert.equal(restored.length,2);accepted.push({cells,revision,root});return true}}
 const adapter=new HcdUniverAdapter(client as any,{} as any,workbook as any,'editable',status=>statuses.push(status),port),internal=adapter as any
 internal.canInspectBlank=()=>true
 const range=(data:any[][],values:any[][])=>({getSheetId:()=> 'sheet',getRow:()=>2,getColumn:()=>1,getHeight:()=>1,getWidth:()=>2,getValues:()=>values,getCellDataGrid:()=>data})
 try{
  await internal.captureChanges([range([[{v:'a'},{v:'b'}]],[['a','b']])]);assert.deepEqual(accepted,[{cells:[{sheetId:'sheet',row:2,column:1,text:'a'},{sheetId:'sheet',row:2,column:2,text:'b'}],revision:2,root:'a'.repeat(64)}]);assert.deepEqual(statuses,[])
  restored.length=0;internal.linksByCell.set('sheet:2:2',{nodeId:'n',text:'old',editable:true,sheetId:'sheet',row:2,column:2})
  await internal.captureChanges([range([[{v:'a'},{v:'b'}]],[['a','b']])]);assert.equal(accepted.length,1);assert.deepEqual(statuses,['workbookUnsupportedPaste'])
  restored.length=0;internal.linksByCell.clear();await internal.captureChanges([range([[{v:'a'},{f:'=1+1'}]],[['a',1]])]);assert.equal(accepted.length,1);assert.equal(statuses.at(-1),'workbookUnsupportedFormula')
 }finally{adapter.dispose()}
})

test('blank batch handoff is opt-in and owner refusal leaves the grid unchanged',async()=>{
 for(const behavior of ['missing','refuse','throw'] as const){
  const restored:number[]=[],statuses:string[]=[],sheet={getRange:(_row:number,column:number)=>({setValue:()=>restored.push(column)})}
  const port:HcdGridDraftPort={text:()=>undefined,edit:()=>{},writable:()=>true,...(behavior==='missing'?{}:{stageBlankBatch:()=>{if(behavior==='throw')throw Error('owner failed');return false}})}
  const adapter=new HcdUniverAdapter({sheets:()=>[],manifest:{revision:1,rootHash:'a'.repeat(64)},chunkRevision:()=>1} as any,{} as any,{getSheetBySheetId:()=>sheet} as any,'editable',message=>statuses.push(message),port),internal=adapter as any
  internal.canInspectBlank=()=>true
  try{await internal.captureChanges([{getSheetId:()=> 'sheet',getRow:()=>0,getColumn:()=>0,getHeight:()=>1,getWidth:()=>2,getValues:()=>[['a','b']],getCellDataGrid:()=>[[{v:'a'},{v:'b'}]]}]);assert.deepEqual(restored,[0,1]);assert.deepEqual(statuses,['workbookUnsupportedPaste'])}finally{adapter.dispose()}
 }
})

test('blank batch capture can be enabled without enabling ordinary cell edits',async()=>{
 const restored:number[]=[],captured:unknown[]=[],statuses:string[]=[],sheet={getRange:(_row:number,column:number)=>({setValue:()=>restored.push(column)})}
 const port:HcdGridDraftPort={text:()=>undefined,edit:()=>assert.fail('ordinary edits are disabled'),writable:()=>false,blankBatchWritable:()=>true,stageBlankBatch:cells=>{captured.push(cells);return true}}
 const adapter=new HcdUniverAdapter({sheets:()=>[],manifest:{revision:1,rootHash:'a'.repeat(64)},chunkRevision:()=>1} as any,{} as any,{getSheetBySheetId:()=>sheet} as any,'editable',message=>statuses.push(message),port),internal=adapter as any
 internal.canInspectBlank=()=>true
 try{await internal.captureChanges([{getSheetId:()=> 'sheet',getRow:()=>0,getColumn:()=>0,getHeight:()=>1,getWidth:()=>2,getValues:()=>[['a','b']],getCellDataGrid:()=>[[{v:'a'},{v:'b'}]]}]);assert.deepEqual(restored,[0,1]);assert.equal(captured.length,1);assert.deepEqual(statuses,[])}finally{adapter.dispose()}
})

test('adapter passes the observed cell value to the input guard',async()=>{
 const link:NodeLink={nodeId:'n',nodeHash:'a'.repeat(64),text:'old',revision:1,chunkId:'c',sheetId:'sheet',row:0,column:0,editable:true}
 const texts=new TextDraftStore(),controller=new FixedSaveController({documentId:'book',format:'xlsx',scope:'write',token:'test',apiUrl:'https://owned.test/v1/documents'},texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller)
 const port:HcdGridDraftPort={text:()=>undefined,edit:()=>{},writable:()=>true,observed:(id,text)=>input.observed(id,text)}
 const adapter=new HcdUniverAdapter({sheets:()=>[],manifest:{revision:1}} as any,{} as any,{} as any,'editable',()=>{},port)
 try{
  ;(adapter as any).linksByCell.set('sheet:0:0',link)
  input.start(link,1);input.change('n','newer\r\n');input.end('n',true)
  const range={getSheetId:()=> 'sheet',getRow:()=>0,getColumn:()=>0,getHeight:()=>1,getWidth:()=>1,getValues:()=>[['old']],getCellDataGrid:()=>[[{v:'old'}]]}
  await (adapter as any).captureChanges([range]);assert.equal(controller.workbookBuffer?.text,'newer');assert.equal(input.isActive(),false)
 }finally{adapter.dispose();controller.dispose()}
})

test('remote draft refresh does not repaint an active cell editor',()=>{
 const link:NodeLink={nodeId:'n',nodeHash:'a'.repeat(64),text:'old',revision:1,chunkId:'c',sheetId:'sheet',row:0,column:0,editable:true},painted:unknown[]=[]
 let editing=true
 const port:HcdGridDraftPort={text:()=> 'local draft',edit:()=>{},writable:()=>true},sheet={getRange:()=>({setValues:(value:unknown)=>painted.push(value)})},workbook={isCellEditing:()=>editing,getSheetBySheetId:()=>sheet}
 const adapter=new HcdUniverAdapter({sheets:()=>[]} as any,{} as any,workbook as any,'editable',()=>{},port)
 try{(adapter as any).linksByNode.set(link.nodeId,link);adapter.refreshDrafts();assert.equal(painted.length,0);editing=false;adapter.refreshDrafts();assert.equal(painted.length,1)}finally{adapter.dispose()}
})

test('a peer conflict refresh cannot replace unfinished input with the old local draft',()=>{
 const link:NodeLink={nodeId:'n',nodeHash:'a'.repeat(64),text:'old',revision:1,chunkId:'c',sheetId:'sheet',row:0,column:0,editable:true},texts=new TextDraftStore(),controller=new FixedSaveController({documentId:'book',format:'xlsx',scope:'write',token:'test'},texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller)
 let editing=true
 const port:HcdGridDraftPort={text:node=>texts.get(node.nodeId)?.text,edit:()=>{},writable:()=>true},sheet={getRange:()=>({setValues:()=>input.change('n','original draft\r\n')})},workbook={isCellEditing:()=>editing,getSheetBySheetId:()=>sheet},adapter=new HcdUniverAdapter({sheets:()=>[]} as any,{} as any,workbook as any,'editable',()=>{},port)
 try{
  (adapter as any).linksByNode.set('n',link);texts.edit(link,1,'original draft');input.start(link,1);input.change('n','unfinished input\r\n')
  const off=texts.subscribe(()=>adapter.refreshDrafts());texts.reconcile([{...link,nodeHash:'b'.repeat(64),text:'peer content'}],2);off()
  assert.equal(controller.workbookBuffer?.text,'unfinished input');assert.equal(texts.get('n')?.remote?.text,'peer content')
  input.abandon();editing=false;adapter.refreshDrafts();assert.equal(controller.workbookBuffer?.text,'unfinished input')
 }finally{adapter.dispose();controller.dispose()}
})

test('window eviction retains the editing chunk and trims it after editing ends',()=>{
 let editing=true;const writes:unknown[]=[]
 const link:NodeLink={nodeId:'n',nodeHash:'a'.repeat(64),text:'original',chunkId:'old',sheetId:'sheet',row:0,column:0,editable:true}
 const sheet={getRange:()=>({setValues:(values:unknown)=>writes.push(values)})},workbook={isCellEditing:()=>editing,getSheetBySheetId:()=>sheet},adapter=new HcdUniverAdapter({sheets:()=>[]} as any,{} as any,workbook as any,'editable',()=>{})
 try{
  const state=adapter as any;state.runtimes.set('old',{sheetId:'sheet',kind:'cells',cells:[{row:0,column:0,link}],visualIds:[]});state.loaded.add('old');state.linksByCell.set('sheet:0:0',link);state.linksByNode.set('n',link);state.requestedWindow={sheetId:'sheet',keep:new Set(['new'])}
  state.runtimes.set('other',{sheetId:'sheet',kind:'cells',cells:[{row:8,column:0}],visualIds:[]});state.loaded.add('other')
  adapter.trimToVisibleWindow();assert.equal(writes.length,0);assert.equal(adapter.getNodeAt('sheet',0,0),link)
  state.editingChunk='old';adapter.trimToVisibleWindow();assert.equal(writes.length,1);assert.equal(state.loaded.has('other'),false);assert.equal(adapter.getNodeAt('sheet',0,0),link)
  editing=false;adapter.trimToVisibleWindow();assert.equal(writes.length,2);assert.equal(adapter.getNodeAt('sheet',0,0),undefined);assert.equal(state.loaded.has('old'),false)
 }finally{adapter.dispose()}
})

test('draft batch failure releases the editor capture but retains unfinished text',async()=>{
 for(const endFirst of [false,true]){
  const link:NodeLink={nodeId:'n',nodeHash:'a'.repeat(64),text:'old',revision:1,chunkId:'c',sheetId:'sheet',row:0,column:0,editable:true}
  const texts=new TextDraftStore(),controller=new FixedSaveController({documentId:'book',format:'xlsx',scope:'write',token:'test',apiUrl:'https://owned.test/v1/documents'},texts,new ImageDraftStore()),input=new WorkbookInputCapture(texts,controller),statuses:string[]=[],painted:unknown[]=[]
  const port:HcdGridDraftPort={text:()=>undefined,edit:()=>{throw Error('draftsNotReady')},writable:()=>true,observed:(id,text)=>input.observed(id,text),rejected:id=>{input.reject(id)}}
  const sheet={getRange:()=>({setValues:(values:unknown)=>painted.push(values)})},adapter=new HcdUniverAdapter({sheets:()=>[],manifest:{revision:1}} as any,{} as any,{getSheetBySheetId:()=>sheet} as any,'editable',status=>statuses.push(status),port)
  try{
   const internal=adapter as any;internal.linksByCell.set('sheet:0:0',link);internal.linksByNode.set('n',link)
   input.start(link,1);input.change('n','unsaved text\r\n');if(endFirst)input.end('n',true)
   const range={getSheetId:()=> 'sheet',getRow:()=>0,getColumn:()=>0,getHeight:()=>1,getWidth:()=>1,getValues:()=>[['unsaved text']],getCellDataGrid:()=>[[{v:'unsaved text'}]]}
   await internal.captureChanges([range]);if(!endFirst)input.end('n',true)
   assert.equal(input.isActive(),false);assert.equal(controller.workbookBuffer?.text,'unsaved text');assert.equal(input.canStart(),false);assert.equal(texts.size,0);assert.deepEqual(statuses,['draftsNotReady']);assert.equal(painted.length,1)
  }finally{adapter.dispose();controller.dispose()}
 }
})

test('visible window failures can be retried without clearing drafts and stale results are ignored',async()=>{
 const status:string[]=[],sheet={getSheetId:()=> 'sheet'},adapter=new HcdUniverAdapter({sheets:()=>[]} as any,{} as any,{getActiveSheet:()=>sheet} as any,'editable',message=>status.push(message))
 const internal=adapter as any;internal.paintedDrafts.add('retained')
 internal.ensureVisible=async()=>{throw new Error('network')};await adapter.retryVisible();assert.deepEqual(status,['workbookVisibleLoadFailed']);assert.equal(internal.paintedDrafts.has('retained'),true)
 internal.ensureVisible=async()=>{};await adapter.retryVisible();assert.deepEqual(status,['workbookVisibleLoadFailed','workbookVisibleLoaded'])
 let rejectOld!:(reason:Error)=>void;const old=new Promise<void>((_,reject)=>rejectOld=reject);let calls=0
 internal.ensureVisible=()=>++calls===1?old:Promise.resolve();const first=adapter.retryVisible();await adapter.retryVisible();rejectOld(new Error('late failure'));await first
 assert.deepEqual(status,['workbookVisibleLoadFailed','workbookVisibleLoaded','workbookVisibleLoaded']);assert.equal(internal.paintedDrafts.has('retained'),true)
})

test('disposing the adapter ignores a late window failure',async()=>{
 const status:string[]=[],sheet={getSheetId:()=> 'sheet'},adapter=new HcdUniverAdapter({sheets:()=>[]} as any,{} as any,{getActiveSheet:()=>sheet} as any,'editable',message=>status.push(message))
 let fail!:(error:Error)=>void;const pending=new Promise<void>((_,reject)=>fail=reject)
 ;(adapter as any).ensureVisible=()=>pending
 const work=adapter.retryVisible();adapter.dispose();fail(new Error('late'));await work
 assert.deepEqual(status,[]);await adapter.retryVisible();assert.deepEqual(status,[])
})

test('disposing during a chunk read prevents late grid writes and window eviction',async()=>{
 let finish!:(value:unknown)=>void
 const pending=new Promise(resolve=>finish=resolve),status:string[]=[],calls:string[]=[]
 const descriptor={chunkId:'c',grid:{sheetId:'sheet',kind:'cells'}}
 const client={sheets:()=>[],cellWindows:()=>[descriptor],visuals:()=>[],readChunk:()=>pending}
 const adapter=new HcdUniverAdapter(client as any,{} as any,{getSheetBySheetId:()=>{calls.push('sheet');return {}}} as any,'editable',message=>status.push(message))
 const internal=adapter as any;internal.evictOutsideWindow=()=>calls.push('evict')
 const work=adapter.loadRange('sheet',0,10);adapter.dispose();finish({});await work
 assert.deepEqual(calls,[]);assert.deepEqual(status,[]);assert.equal(internal.loaded.size,0);assert.equal(internal.loading.size,0)
 await adapter.loadRange('sheet',0,10);assert.deepEqual(calls,[])
})

test('disposing during image construction prevents late image insertion',async()=>{
 let finish!:(value:unknown)=>void
 const pending=new Promise(resolve=>finish=resolve),calls:string[]=[],builder:any={}
 for(const method of ['setSource','setColumn','setRow','setColumnOffset','setRowOffset','setWidth','setHeight'])builder[method]=()=>builder
 builder.buildAsync=()=>pending
 const sheet={getSheetId:()=> 'sheet',newOverGridImage:()=>builder,insertImages:()=>calls.push('insert')}
 const adapter=new HcdUniverAdapter({sheets:()=>[]} as any,{Enum:{ImageSourceType:{URL:'url'}}} as any,{} as any,'editable',()=>{})
 const internal=adapter as any;internal.resolveVisualGeometry=()=>({column:0,row:0,columnOffset:0,rowOffset:0,width:10,height:10})
 const parsed={cells:[],merges:[],rowHeights:[],columnWidths:[],visuals:[{nodeId:'image',assetUrl:'image.png'}]}
 const work=internal.applyParsedChunk(sheet,{grid:{sheetId:'sheet'}},parsed,0);adapter.dispose();finish({});await work
 assert.deepEqual(calls,[]);assert.equal(internal.appliedDimensions.size,0)
})

test('late chunks from a previous sheet are evicted against the latest window',async()=>{
  let finish!:(value:unknown)=>void
  const old=new Promise(resolve=>finish=resolve),a={chunkId:'a',grid:{sheetId:'one',sheetName:'one',kind:'cells'}},b={chunkId:'b',grid:{sheetId:'two',sheetName:'two',kind:'cells'}}
  const chunk=(descriptor:unknown)=>({html:'',descriptor,map:{entries:[]}})
  const client={sheets:()=>[],cellWindows:(sheetId:string)=>[sheetId==='one'?a:b],visuals:()=>[],readChunk:(descriptor:typeof a)=>descriptor===a?old:Promise.resolve(chunk(descriptor)),chunkRevision:()=>0,resolve:()=>new URL('http://localhost/'),manifest:{revision:0},descriptors:[a,b]}
  const sheet=(id:string)=>({getSheetId:()=>id}),workbook={getSheetBySheetId:(id:string)=>sheet(id)}
  const adapter=new HcdUniverAdapter(client as any,{} as any,workbook as any,'editable',()=>{})
  ;(adapter as any).parseChunk=async()=>({cells:[],merges:[],rowHeights:[],columnWidths:[],visuals:[]})
  const first=adapter.loadRange('one',0,10);await adapter.loadRange('two',0,10)
  finish(chunk(a));await first
  assert.deepEqual([...(adapter as any).loaded],['b']);assert.deepEqual([...(adapter as any).runtimes.keys()],['b'])
})

test('frozen row chunks stay loaded alongside a distant window without retaining the gap',async()=>{
 const descriptors=[{chunkId:'frozen',grid:{sheetId:'sheet',sheetName:'sheet',kind:'cells',rowStart:1,rowEnd:32}},{chunkId:'gap',grid:{sheetId:'sheet',sheetName:'sheet',kind:'cells',rowStart:100,rowEnd:131}},{chunkId:'window',grid:{sheetId:'sheet',sheetName:'sheet',kind:'cells',rowStart:400,rowEnd:431}}]
 const calls:string[]=[],client={sheets:()=>[],cellWindows:(_id:string,start:number,end:number)=>descriptors.filter(({grid})=>grid.rowEnd>=start&&grid.rowStart<=end),visuals:()=>[],readChunk:async(descriptor:any)=>{calls.push(descriptor.chunkId);return {descriptor}},chunkRevision:()=>0,manifest:{revision:0},descriptors}
 const sheet={getSheetId:()=> 'sheet',getMaxRows:()=>600,getVisibleRange:()=>({startRow:400,endRow:420}),getFreeze:()=>({ySplit:1})},workbook={getSheetBySheetId:()=>sheet}
 const adapter=new HcdUniverAdapter(client as any,{} as any,workbook as any,'editable',()=>{}),internal=adapter as any
 internal.parseChunk=async()=>({cells:[],merges:[],rowHeights:[],columnWidths:[],visuals:[]})
 await internal.ensureVisible(sheet)
 assert.deepEqual(new Set(calls),new Set(['frozen','window']))
 assert.deepEqual(new Set(internal.loaded),new Set(['frozen','window']))
 assert.equal(internal.requestedWindow.keep.has('gap'),false)
})

test('large frozen area fallback remains bounded until its viewport exists',async()=>{
 const requested:number[][]=[],client={sheets:()=>[],cellWindows:(_id:string,start:number,end:number)=>{requested.push([start,end]);return []},visuals:()=>[]}
 const sheet={getSheetId:()=> 'sheet',getMaxRows:()=>1000,getVisibleRange:()=>({startRow:800,endRow:820}),getFreeze:()=>({ySplit:500})}
 const adapter=new HcdUniverAdapter(client as any,{} as any,{} as any,'editable',()=>{})
 await (adapter as any).ensureVisible(sheet)
 assert.deepEqual(requested,[[673,949],[1,128]])
})

test('both frozen viewports use their visible rows and deduplicate shared chunks',async()=>{
 const frozen={chunkId:'frozen',grid:{sheetId:'sheet',sheetName:'sheet',kind:'cells',rowStart:1,rowEnd:32}},current={chunkId:'current',grid:{sheetId:'sheet',sheetName:'sheet',kind:'cells',rowStart:400,rowEnd:431}},visual={chunkId:'frozen-image',grid:{sheetId:'sheet',sheetName:'sheet',kind:'visual',rowStart:1,rowEnd:1}},reads:string[]=[],ranges:number[][]=[]
 const client={sheets:()=>[],cellWindows:(_id:string,start:number,end:number)=>{ranges.push([start,end]);return [frozen,current].filter(({grid})=>grid.rowEnd>=start&&grid.rowStart<=end)},visuals:()=>[visual],readChunk:async(descriptor:any)=>{reads.push(descriptor.chunkId);return {descriptor}},chunkRevision:()=>0,manifest:{revision:0},descriptors:[frozen,current,visual]}
 const sheet={getSheetId:()=> 'sheet',getMaxRows:()=>600,getVisibleRange:()=>({startRow:400,endRow:420}),getFreeze:()=>({ySplit:1,xSplit:1}),getVisibleRangesOfAllViewports:()=>new Map([['top',{startRow:0,endRow:0}],['corner',{startRow:0,endRow:0}]])}
 const api={Enum:{SHEET_VIEWPORT_KEY:{VIEW_MAIN_TOP:'top',VIEW_MAIN_LEFT_TOP:'corner'}}},adapter=new HcdUniverAdapter(client as any,api as any,{getSheetBySheetId:()=>sheet} as any,'editable',()=>{}),internal=adapter as any
 internal.parseChunk=async()=>({cells:[],merges:[],rowHeights:[],columnWidths:[],visuals:[]})
 await internal.ensureVisible(sheet)
 assert.deepEqual(ranges,[[273,549],[1,1],[1,1]])
 assert.deepEqual(new Set(reads),new Set(['frozen','current','frozen-image']))
 assert.equal(reads.filter(id=>id==='frozen').length,1)
 assert.deepEqual(internal.requestedWindow.keep,new Set(['frozen','current','frozen-image']))
})

test('late old window cannot evict the latest frozen-row chunk',async()=>{
 let finish!:(value:any)=>void
 const oldRequest=new Promise(resolve=>finish=resolve),old={chunkId:'old',grid:{sheetId:'sheet',sheetName:'sheet',kind:'cells',rowStart:100,rowEnd:131}},frozen={chunkId:'frozen',grid:{sheetId:'sheet',sheetName:'sheet',kind:'cells',rowStart:1,rowEnd:32}},current={chunkId:'current',grid:{sheetId:'sheet',sheetName:'sheet',kind:'cells',rowStart:400,rowEnd:431}},descriptors=[old,frozen,current]
 const client={sheets:()=>[],cellWindows:(_id:string,start:number,end:number)=>descriptors.filter(({grid})=>grid.rowEnd>=start&&grid.rowStart<=end),visuals:()=>[],readChunk:(descriptor:any)=>descriptor===old?oldRequest:Promise.resolve({descriptor}),chunkRevision:()=>0,manifest:{revision:0},descriptors}
 const sheet={getSheetId:()=> 'sheet'},adapter=new HcdUniverAdapter(client as any,{} as any,{getSheetBySheetId:()=>sheet} as any,'editable',()=>{}),internal=adapter as any
 internal.parseChunk=async()=>({cells:[],merges:[],rowHeights:[],columnWidths:[],visuals:[]})
 const first=adapter.loadRange('sheet',99,130)
 await adapter.loadRange('sheet',399,430,[{startRow:0,endRow:0}])
 finish({descriptor:old});await first
 assert.deepEqual(new Set(internal.loaded),new Set(['frozen','current']))
 assert.deepEqual(internal.requestedWindow.keep,new Set(['current','frozen']))
})

test('late window eviction preserves a private draft for the next reload',async()=>{
 let finish!:(value:any)=>void,reads=0
 const delayed=new Promise(resolve=>finish=resolve),a={chunkId:'a',grid:{sheetId:'one',sheetName:'one',kind:'cells'}},b={chunkId:'b',grid:{sheetId:'two',sheetName:'two',kind:'cells'}}
 const chunk=(descriptor:typeof a)=>({descriptor})
 const client={sheets:()=>[],cellWindows:(id:string)=>[id==='one'?a:b],visuals:()=>[],readChunk:(descriptor:typeof a)=>descriptor===a&&++reads===1?delayed:Promise.resolve(chunk(descriptor)),chunkRevision:()=>0,manifest:{revision:0},descriptors:[a,b]}
 const writes=new Map<string,unknown>(),sheet=(id:string)=>({getSheetId:()=>id,getRange:()=>({setValues:(values:any)=>writes.set(id,values[0][0].v)})})
 const draftPort:HcdGridDraftPort={text:link=>link.nodeId==='n'?'私有草稿':undefined,edit:()=>{},writable:()=>true}
 const adapter=new HcdUniverAdapter(client as any,{} as any,{getSheetBySheetId:(id:string)=>sheet(id)} as any,'editable',()=>{},draftPort)
 ;(adapter as any).parseChunk=async({descriptor}:any)=>({cells:descriptor===a?[{row:0,column:0,data:{v:'原始值'},formula:false,link:{nodeId:'n',nodeHash:'hash',text:'原始值',chunkId:'a',sheetId:'one',row:0,column:0,editable:true}}]:[],merges:[],rowHeights:[],columnWidths:[],visuals:[]})
 const first=adapter.loadRange('one',0,10);await adapter.loadRange('two',0,10);finish(chunk(a));await first
 assert.equal(writes.get('one'),null);assert.equal(adapter.getNodeAt('one',0,0),undefined)
 await adapter.loadRange('one',0,10);assert.equal(writes.get('one'),'私有草稿');assert.equal(adapter.getNodeAt('one',0,0)?.text,'原始值')
})

test('a current window load failure does not evict the prior window',async()=>{
 const descriptor={chunkId:'broken',grid:{sheetId:'sheet',kind:'cells'}},evictions:unknown[]=[]
 const client={sheets:()=>[],cellWindows:()=>[descriptor],visuals:()=>[],readChunk:async()=>{throw new Error('network')}}
 const adapter=new HcdUniverAdapter(client as any,{} as any,{} as any,'editable',()=>{})
 ;(adapter as any).evictOutsideWindow=(...args:unknown[])=>evictions.push(args)
 await assert.rejects(adapter.loadRange('sheet',0,10),/network/);assert.deepEqual(evictions,[])
})

test('disposing a workbook adapter removes its Univer event handlers',async()=>{
 const handlers=new Map<string,(event:any)=>void>(),disposed:string[]=[]
 const api={Event:{Scroll:'scroll',ActiveSheetChanged:'active',BeforeSheetEditStart:'edit',BeforeCommandExecute:'command',SheetValueChanged:'value',SheetEditStarted:'started',SheetEditEnded:'ended'},Enum:{CommandType:{MUTATION:'mutation'}},addEvent:(name:string,callback:(event:any)=>void)=>{handlers.set(name,callback);return{dispose:()=>{disposed.push(name);handlers.delete(name)}}}}
 const adapter=new HcdUniverAdapter({sheets:()=>[]} as any,api as any,{getActiveSheet:()=>({})} as any,'editable',()=>{})
 ;(adapter as any).ensureVisible=async()=>{}
 await adapter.start();assert.equal(handlers.size,7)
 ;(adapter as any).linksByCell.set('sheet:2:3',{chunkId:'editing-chunk'})
 handlers.get('started')!({worksheet:{getSheetId:()=> 'sheet'},row:2,column:3});assert.equal((adapter as any).editingChunk,'editing-chunk')
 adapter.dispose();adapter.dispose()
 assert.equal(handlers.size,0);assert.deepEqual(disposed.sort(),['active','command','edit','ended','scroll','started','value'])
})

test('remote text for an unloaded cell survives window loading and retains the new baseline',async()=>{
 const written:any[]=[],sheet={getSheetId:()=> 'sheet',getRange:()=>({setValues:(data:unknown)=>written.push(data)})}
 const client={sheets:()=>[],manifest:{revision:0}},adapter=new HcdUniverAdapter(client as any,{} as any,{} as any,'editable',()=>{})
 assert.equal(adapter.applyRemoteText('n1','remote','new-hash',3),true)
 assert.equal(adapter.applyRemoteText('n1','older','old-hash',2),true)
 const parsed=()=>({cells:[{row:10,column:0,data:{v:123,t:2,s:'style'},formula:false,link:{nodeId:'n1',nodeHash:'old-hash',text:'123',chunkId:'c',sheetId:'sheet',row:10,column:0,editable:true}}],merges:[],rowHeights:[],columnWidths:[],visuals:[]})
 await (adapter as any).applyParsedChunk(sheet,{grid:{sheetId:'sheet'}},parsed(),0)
 assert.equal(written[0][10][0].v,'remote');assert.equal(written[0][10][0].t,1);assert.equal(written[0][10][0].s,'style')
 assert.equal(adapter.getNodeAt('sheet',10,0)?.nodeHash,'new-hash');assert.equal(adapter.getNodeAt('sheet',10,0)?.revision,3)
 await (adapter as any).applyParsedChunk(sheet,{grid:{sheetId:'sheet'}},parsed(),0)
 assert.equal(written[1][10][0].v,'remote')
 const loadedSheet={getRange:()=>({setValue:()=>{}})}
 ;(adapter as any).workbook={getSheetBySheetId:()=>loadedSheet}
 assert.equal(adapter.applyRemoteText('n1','next','next-hash',4),true)
 assert.equal((adapter as any).canonicalCells.get('n1').t,1)
 assert.equal((adapter as any).canonicalCells.get('n1').v,'next')
 const protectedCell=parsed();protectedCell.cells[0].formula=true
 await assert.rejects((adapter as any).applyParsedChunk(sheet,{grid:{sheetId:'sheet'}},protectedCell,0),/protected/)
})

test('render-lifecycle scroll events load only the owning workbook window',async()=>{
 const handlers=new Map<string,(event:any)=>void>(),sheet={getSheetId:()=> 'sheet'},scheduled:unknown[]=[]
 const api={Event:{Scroll:'scroll',ActiveSheetChanged:'active',BeforeSheetEditStart:'edit',BeforeCommandExecute:'command',SheetValueChanged:'value'},Enum:{CommandType:{MUTATION:'mutation'}},addEvent:(name:string,callback:(event:any)=>void)=>handlers.set(name,callback)}
 const adapter=new HcdUniverAdapter({sheets:()=>[]} as any,api as any,{getId:()=> 'book',getActiveSheet:()=>sheet} as any,'editable',()=>{})
 const internal=adapter as any;internal.ensureVisible=async()=>{};internal.scheduleVisible=(value:unknown)=>scheduled.push(value);await adapter.start()
 handlers.get('scroll')!({workbook:{getId:()=> 'other'},worksheet:sheet});assert.deepEqual(scheduled,[])
 handlers.get('scroll')!({workbook:{getId:()=> 'book'},worksheet:sheet});assert.deepEqual(scheduled,[sheet])
})

test('starting an unsupported cell edit explains why without opening the editor',async()=>{
 const handlers=new Map<string,(event:any)=>void>(),status:string[]=[]
 const api={Event:{Scroll:'scroll',ActiveSheetChanged:'active',BeforeSheetEditStart:'edit',BeforeCommandExecute:'command',SheetValueChanged:'value'},Enum:{CommandType:{MUTATION:'mutation'}},addEvent:(name:string,callback:(event:any)=>void)=>handlers.set(name,callback)}
 const adapter=new HcdUniverAdapter({sheets:()=>[]} as any,api as any,{getActiveSheet:()=>({})} as any,'editable',message=>status.push(message))
 const internal=adapter as any;internal.ensureVisible=async()=>{}
 const editable:NodeLink={nodeId:'a',nodeHash:'a',text:'x',chunkId:'chunk',sheetId:'sheet',row:0,column:1,editable:true}
 const protectedCell={...editable,nodeId:'b',column:2,editable:false}
 internal.linksByCell.set('sheet:0:1',editable);internal.linksByCell.set('sheet:0:2',protectedCell)
 await adapter.start()
 const start=(column:number)=>{const event={worksheet:{getSheetId:()=> 'sheet'},row:0,column,cancel:false};handlers.get('edit')!(event);return event.cancel}
 assert.equal(start(0),true);assert.equal(status.pop(),'workbookCellUnmapped')
 assert.equal(start(2),true);assert.equal(status.pop(),'workbookCellProtected')
 internal.pending.set('patch',{links:[editable]});assert.equal(start(1),true);assert.equal(status.pop(),'workbookCellPending')
 internal.pending.clear();assert.equal(start(1),false);assert.deepEqual(status,[])
})

test('mixed edits restore every cell and emit no patch in either workbook entry point',async()=>{
 for(const withDrafts of [false,true]){
  const written=new Map<number,any>(),status:string[]=[],edits:unknown[]=[]
  const draftPort:HcdGridDraftPort={text:link=>link.nodeId==='a'?'Existing draft':undefined,edit:changes=>edits.push(changes),writable:()=>true}
  const sheet={getRange:(_row:number,column:number)=>({setValue:(value:unknown)=>written.set(column,value)})}
  const adapter=new HcdUniverAdapter({sheets:()=>[],manifest:{revision:0}} as any,{} as any,{getSheetBySheetId:()=>sheet} as any,'editable',message=>status.push(message),withDrafts?draftPort:undefined)
  const internal=adapter as any
  const link=(nodeId:string,column:number,editable:boolean,text:string):NodeLink=>({nodeId,nodeHash:nodeId,chunkId:'chunk',sheetId:'sheet',row:0,column,editable,text})
  const a=link('a',0,true,'Original'),formula=link('formula',1,false,'3')
  internal.linksByCell.set('sheet:0:0',a);internal.linksByCell.set('sheet:0:1',formula)
  internal.canonicalCells.set('a',{v:'Original',s:'style'})
  internal.canonicalGrid.set('sheet:0:0',{v:'Original',s:'style'});internal.canonicalGrid.set('sheet:0:1',{v:'3',s:'formula-style'})
  const range={getSheetId:()=> 'sheet',getRow:()=>0,getColumn:()=>0,getHeight:()=>1,getWidth:()=>2,getValues:()=>[['Changed','Replaced']],getCellDataGrid:()=>[[{v:'Changed'},{v:'Replaced'}]]}
  await internal.captureChanges([range])
  assert.equal(written.get(0).v,withDrafts?'Existing draft':'Original')
  assert.equal(written.get(0).s,'style');assert.equal(written.get(1).v,'3');assert.equal(written.get(1).s,'formula-style')
  assert.equal(written.get(1).f,null);assert.deepEqual(edits,[]);assert.deepEqual(status,['workbookUnsupportedPaste']);assert.equal(internal.pending.size,0)
 }
})

test('a new formula rejects the whole operation before cached results can become text drafts',async()=>{
 for(const withDrafts of [false,true]){
  const written=new Map<number,any>(),status:string[]=[],edits:unknown[]=[],rejected:string[]=[],observed:string[]=[]
  const port:HcdGridDraftPort={text:link=>link.nodeId==='a'?'Prior draft':undefined,edit:changes=>edits.push(changes),writable:()=>true,rejected:id=>rejected.push(id),observed:id=>observed.push(id)}
  const sheet={getRange:(_row:number,column:number)=>({setValue:(value:unknown)=>written.set(column,value)})}
  const adapter=new HcdUniverAdapter({sheets:()=>[],manifest:{revision:0}} as any,{} as any,{getSheetBySheetId:()=>sheet} as any,'editable',message=>status.push(message),withDrafts?port:undefined)
  const internal=adapter as any
  for(const [column,nodeId] of [[0,'a'],[1,'b']] as const){const link:NodeLink={nodeId,nodeHash:nodeId,text:`Old ${nodeId}`,chunkId:'chunk',sheetId:'sheet',row:0,column,editable:true};internal.linksByCell.set(`sheet:0:${column}`,link);internal.canonicalCells.set(nodeId,{v:link.text});internal.canonicalGrid.set(`sheet:0:${column}`,{v:link.text})}
  const range={getSheetId:()=> 'sheet',getRow:()=>0,getColumn:()=>0,getHeight:()=>1,getWidth:()=>2,getValues:()=>[['Changed',null]],getCellDataGrid:()=>[[{v:'Changed'},{v:null,f:'=8+7',si:'shared'}]]}
  await internal.captureChanges([range])
  assert.equal(written.get(0).v,withDrafts?'Prior draft':'Old a');assert.equal(written.get(1).v,'Old b');assert.equal(written.get(1).f,null);assert.equal(written.get(1).si,null)
  assert.deepEqual(edits,[]);assert.deepEqual(observed,[]);assert.deepEqual(status,['workbookUnsupportedFormula']);assert.equal(internal.pending.size,0)
  if(withDrafts)assert.deepEqual(new Set(rejected),new Set(['a','b']))
 }
})


test('rejected paste preserves displayed values and styles of unmapped cells',async()=>{
 for(const withDrafts of [false,true]){
  const written=new Map<number,any>(),edits:unknown[]=[],status:string[]=[],port:HcdGridDraftPort={text:()=>undefined,edit:changes=>edits.push(changes),writable:()=>true},sheet={getRange:(_row:number,column:number)=>({setValue:(value:unknown)=>written.set(column,value)})},adapter=new HcdUniverAdapter({sheets:()=>[],manifest:{revision:0}} as any,{} as any,{getSheetBySheetId:()=>sheet} as any,'editable',message=>status.push(message),withDrafts?port:undefined),internal=adapter as any
  const link:NodeLink={nodeId:'a',nodeHash:'a',text:'editable',chunkId:'chunk',sheetId:'sheet',row:0,column:0,editable:true};internal.linksByCell.set('sheet:0:0',link);internal.canonicalCells.set('a',{v:'editable',s:'edit-style'});internal.canonicalGrid.set('sheet:0:1',{v:'原始公式结果',s:'formula-style'});internal.canonicalGrid.set('sheet:0:2',{v:0,t:2,s:'numeric-style'})
  const range={getSheetId:()=> 'sheet',getRow:()=>0,getColumn:()=>0,getHeight:()=>1,getWidth:()=>4,getValues:()=>[['new','replaced','replaced','replaced']],getCellDataGrid:()=>[[{v:'new'},{v:'replaced'},{v:'replaced'},{v:'replaced'}]]}
  await internal.captureChanges([range]);assert.equal(written.get(0).v,'editable');assert.equal(written.get(1).v,'原始公式结果');assert.equal(written.get(1).s,'formula-style');assert.equal(written.get(2).v,0);assert.equal(written.get(2).t,2);assert.equal(written.get(3).v,null);assert.deepEqual(edits,[]);assert.deepEqual(status,['workbookUnsupportedPaste'])
 }
})

test('blank inspection requires a fully loaded window and never treats visible cells as gaps',()=>{
 const descriptor={chunkId:'original'},client={sheets:()=>[{sheetId:'sheet'}],sheetDefaults:()=>({columnWidth:64,rowHeight:20}),cellWindows:()=>[descriptor]}
 const adapter=new HcdUniverAdapter(client as any,{} as any,{} as any,'editable',()=>{}),internal=adapter as any
 assert.equal(adapter.canInspectBlank('sheet',2,1),false)
 internal.requestedWindow={sheetId:'sheet',keep:new Set(['original'])}
 assert.equal(adapter.canInspectBlank('sheet',2,1),false)
 internal.loaded.add('original');assert.equal(adapter.canInspectBlank('sheet',2,1),true)
 internal.canonicalGrid.set('sheet:2:1',{v:0});assert.equal(adapter.canInspectBlank('sheet',2,1),false)
 internal.canonicalGrid.delete('sheet:2:1');internal.linksByCell.set('sheet:2:1',{nodeId:'node'});assert.equal(adapter.canInspectBlank('sheet',2,1),false)
 assert.equal(adapter.canInspectBlank('other',2,1),false);assert.equal(adapter.canInspectBlank('sheet',-1,1),false)
 adapter.dispose();assert.equal(adapter.canInspectBlank('sheet',2,1),false)
})
test('only the actively captured blank accepts a single cell value; paste and formulas remain guarded',async()=>{
 const observed:string[]=[],statuses:string[]=[],painted:any[]=[]
 let active=true
 const port:HcdGridDraftPort={text:()=>undefined,edit:()=>{},writable:()=>true,blankActive:()=>active,blankObserved:(_sheet,_row,_column,text)=>observed.push(text)}
 const sheet={getRange:()=>({setValue:(value:unknown)=>painted.push(value)})},adapter=new HcdUniverAdapter({sheets:()=>[],manifest:{revision:0}} as any,{} as any,{getSheetBySheetId:()=>sheet} as any,'editable',message=>statuses.push(message),port)
 const range=(data:any)=>({getSheetId:()=> 'sheet',getRow:()=>2,getColumn:()=>1,getHeight:()=>1,getWidth:()=>1,getValues:()=>[['draft']],getCellDataGrid:()=>[[data]]})
 await (adapter as any).captureChanges([range({v:'draft'})]);assert.deepEqual(observed,['draft'])
 active=false;await (adapter as any).captureChanges([range({v:'paste'})]);assert.deepEqual(observed,['draft']);assert.equal(statuses.at(-1),'workbookUnsupportedPaste')
 active=true;await (adapter as any).captureChanges([range({f:'=1+2'})]);assert.deepEqual(observed,['draft']);assert.equal(statuses.at(-1),'workbookUnsupportedFormula');assert.ok(painted.length>=2)
})
