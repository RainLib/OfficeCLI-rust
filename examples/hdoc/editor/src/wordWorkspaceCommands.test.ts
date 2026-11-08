import assert from 'node:assert/strict'
import {test} from 'node:test'
import {CommandRegistry,CommandError} from './commands/registry.ts'
import {builtinCommands} from './commands/builtins.ts'
import type {CommandContext,EditorCommand} from './commands/types.ts'
import {wordWorkspaceActions,wordWorkspaceCommand,wordWorkspaceZoom,type WordWorkspaceView} from './wordWorkspaceCommands.ts'

function fixture(){
 let view:WordWorkspaceView={navigation:false,panel:null,zoom:100},selected=false,ready=true
 const context=():CommandContext=>({instanceId:'word',documentId:'regional',format:'docx',profile:'flow',locale:'zh-CN',platform:'mac',ready,readOnly:true,revision:2,historical:true,selection:{kind:'object',empty:false,anchor:'protected',protected:true,parentTypes:[]},capabilities:{},actions:wordWorkspaceActions(view)})
 const host:EditorCommand={id:'host.zoom',label:'Host zoom',access:'read',ready:false,selectionSensitive:false,execute:({commands},input)=>commands.run('view.zoom.set',input)}
 const setters={navigation:(update:(value:boolean)=>boolean)=>{view={...view,navigation:update(view.navigation)}},panel:(update:(value:WordWorkspaceView['panel'])=>WordWorkspaceView['panel'])=>{view={...view,panel:update(view.panel)}},zoom:(value:number)=>{view={...view,zoom:value}}}
 const registry=new CommandRegistry(context,(id,input)=>wordWorkspaceCommand(id,input,setters,selected),builtinCommands,{commands:[host]});registry.connect()
 return{registry,view:()=>view,select:()=>{selected=true},loading:()=>{ready=false}}
}
test('regional Word host commands use the shared percent envelope, validate it before changing local state and remain usable without write authority',async()=>{
 const f=fixture();f.loading();try{
  assert.equal(await f.registry.execute('host.zoom',{percent:125}),true);assert.equal(f.view().zoom,125)
  for(const input of [{value:100},{percent:'100'},{percent:NaN},{percent:Infinity},{percent:24},{percent:201},{percent:100.5},null]){const before=f.view();await assert.rejects(f.registry.execute('host.zoom',input),CommandError);assert.equal(f.view(),before)}
  for(const percent of [wordWorkspaceZoom.min,wordWorkspaceZoom.max]){await f.registry.execute('view.zoom.set',{percent});assert.equal(f.view().zoom,percent)}
  await assert.rejects(f.registry.execute('text.insert',{text:'not authorized'}),CommandError);assert.equal(f.view().panel,null)
 }finally{f.registry.dispose()}
})
test('explicit regional panel visibility is idempotent and hiding another panel preserves the current one',async()=>{
 const f=fixture();try{
  await f.registry.execute('view.collaboration',{enabled:true});await f.registry.execute('view.collaboration',{enabled:true});assert.equal(f.view().panel,'collaboration')
  await f.registry.execute('view.properties',{enabled:false});await f.registry.execute('view.images',{enabled:false});assert.equal(f.view().panel,'collaboration')
  f.select();await f.registry.execute('view.properties',{enabled:true});assert.equal(f.view().panel,'properties');assert.equal(wordWorkspaceActions(f.view())['view.properties'].active,true)
  await f.registry.execute('view.images',{enabled:false});assert.equal(f.view().panel,'properties')
  await f.registry.execute('view.properties',{enabled:false});assert.equal(f.view().panel,null)
  await f.registry.execute('view.images',{enabled:true});await f.registry.execute('view.properties',{enabled:true});assert.equal(f.view().panel,'images')
  await f.registry.execute('view.properties');assert.equal(f.view().panel,null)
 }finally{f.registry.dispose()}
})
test('regional navigation and panel commands reject malformed toggles before publishing any view change',async()=>{
 const f=fixture();try{
  await f.registry.execute('view.navigation',{enabled:true});await f.registry.execute('view.navigation',{enabled:true});assert.equal(f.view().navigation,true)
  for(const id of ['view.navigation','view.properties','view.images','view.collaboration'])for(const input of [{enabled:'false'},{enabled:1},{},[],null]){const before=f.view();await assert.rejects(f.registry.execute(id,input),CommandError);assert.equal(f.view(),before)}
  await f.registry.execute('view.collaboration',{enabled:true});await f.registry.execute('view.panel.close');assert.equal(f.view().panel,null);assert.equal(f.view().navigation,true)
  await f.registry.execute('view.navigation',{enabled:false});assert.equal(f.view().navigation,false)
 }finally{f.registry.dispose()}
})
test('regional command state reports the visible property category and each editor keeps independent local views',async()=>{
 const a=fixture(),b=fixture();try{
  a.select();await a.registry.execute('view.properties',{enabled:true});await a.registry.execute('view.zoom.set',{percent:75});await a.registry.execute('view.navigation',{enabled:true})
  assert.equal(wordWorkspaceActions(a.view())['view.properties'].active,true);assert.equal(wordWorkspaceActions(a.view())['view.images'].active,false);assert.equal(wordWorkspaceActions(a.view())['view.actualSize'].active,false)
  assert.deepEqual(b.view(),{navigation:false,panel:null,zoom:100});await a.registry.execute('view.actualSize');assert.equal(a.view().zoom,100)
  const before=a.view(),unexpected=()=>assert.fail('unknown command invoked a view setter');assert.equal(wordWorkspaceCommand('node.update',{},{navigation:unexpected,panel:unexpected,zoom:unexpected}),false);assert.equal(a.view(),before)
 }finally{a.registry.dispose();b.registry.dispose()}
})
test('batched host view commands update only their own fields against queued current values',()=>{
 let view:WordWorkspaceView={navigation:false,panel:null,zoom:100};const queue:Array<()=>void>=[]
 const setters={navigation:(update:(value:boolean)=>boolean)=>queue.push(()=>{view={...view,navigation:update(view.navigation)}}),panel:(update:(value:WordWorkspaceView['panel'])=>WordWorkspaceView['panel'])=>queue.push(()=>{view={...view,panel:update(view.panel)}}),zoom:(value:number)=>queue.push(()=>{view={...view,zoom:value}})}
 for(const [id,input]of [['view.collaboration',{enabled:true}],['view.properties',{enabled:false}],['view.navigation',{enabled:true}],['view.zoom.set',{percent:125}],['view.navigation',{enabled:true}]] as const)assert.equal(wordWorkspaceCommand(id,input,setters),true)
 assert.deepEqual({...view},{navigation:false,panel:null,zoom:100});queue.splice(0).forEach(apply=>apply());assert.deepEqual({...view},{navigation:true,panel:'collaboration',zoom:125})
 wordWorkspaceCommand('view.collaboration',undefined,setters);wordWorkspaceCommand('view.collaboration',undefined,setters);queue.splice(0).forEach(apply=>apply());assert.equal(view.panel,'collaboration')
 assert.throws(()=>wordWorkspaceCommand('view.zoom.set',{percent:Infinity},setters),CommandError);assert.equal(queue.length,0)
})
