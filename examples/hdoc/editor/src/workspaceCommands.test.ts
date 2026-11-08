import {test} from 'node:test'
import assert from 'node:assert/strict'
import {CommandError,CommandRegistry} from './commands/registry.ts'
import {builtinCommands} from './commands/builtins.ts'
import {workspaceCommands,toggleInput,zoomInput,revisionInput,panelTarget} from './commands/workspace.ts'
import type {CommandContext,EditorCommand} from './commands/types.ts'

function fixture(){
 let context:CommandContext={instanceId:'one',documentId:'doc',format:'docx',profile:'flow',locale:'zh-CN',platform:'mac',ready:false,readOnly:true,revision:2,historical:true,selection:{kind:'object',empty:false,protected:true,anchor:'old',parentTypes:[]},capabilities:{},actions:Object.fromEntries(workspaceCommands.map(command=>[command.id,{enabled:true}]))}
 const calls:string[]=[]
 const commands:EditorCommand[]=[{id:'host.open',label:'Host workspace',access:'read',ready:false,selectionSensitive:false,execute:({commands})=>commands.run('view.collaboration',{enabled:true})}]
 const registry=new CommandRegistry(()=>context,(id,input)=>{if(id==='view.zoom.set')zoomInput(input,context.profile as 'flow'|'fixed');if(id==='revision.open')revisionInput(input,context.revision);calls.push(id);return true},builtinCommands,{commands,keymap:{'view.collaboration':['Mod+Alt+J']},menuOverrides:{palette:{hidden:['view.properties']}}})
 registry.connect()
 return{registry,calls,set:(patch:Partial<CommandContext>)=>{context={...context,...patch};registry.refresh()}}
}
test('view commands remain usable in read-only historical protected and loading states without granting writes',async()=>{
 const{registry,calls}=fixture()
 assert.equal(await registry.execute('host.open'),true)
 for(const id of ['view.properties','view.actualSize','revision.history'])assert.equal(await registry.execute(id),true)
 await assert.rejects(registry.execute('text.insert',{text:'unsafe'}),CommandError)
 assert.deepEqual(calls,['view.collaboration','view.properties','view.actualSize','revision.history'])
 assert.equal(registry.list('palette').some(command=>command.id==='view.properties'),false)
 assert.equal(registry.item('view.collaboration')?.shortcuts[0],'Mod+Alt+J')
})
test('profile and adapter authority still reject unsupported or revoked actions from nested host commands',async()=>{
 const{registry,set,calls}=fixture()
 set({profile:'fixed',format:'pdf'})
 assert.equal(registry.list('palette').some(command=>command.id==='revision.history'),false)
 await assert.rejects(registry.execute('revision.open',{revision:0}),CommandError)
 assert.equal(await registry.execute('view.fit'),true)
 set({actions:{'view.collaboration':{enabled:false}}})
 await assert.rejects(registry.execute('host.open'),CommandError)
 set({profile:'sheet',format:'xlsx'})
 await assert.rejects(registry.execute('view.properties'),CommandError)
 assert.deepEqual(calls,['view.fit'])
})
test('external toggle zoom and revision inputs reject coercion, invalid ranges and future revisions',async()=>{
 assert.equal(toggleInput('view.properties',undefined,true),false)
 assert.equal(toggleInput('view.properties',{enabled:true},true),true)
 for(const input of [null,false,[],{},{enabled:1},{enabled:'false'}])assert.throws(()=>toggleInput('view.properties',input,false),CommandError)
 assert.equal(zoomInput({percent:70},'flow'),70);assert.equal(zoomInput({percent:200},'fixed'),200)
 for(const percent of ['100',NaN,Infinity,24,201,99.5])assert.throws(()=>zoomInput({percent},'fixed'),CommandError)
 assert.throws(()=>zoomInput({percent:101},'flow'),CommandError)
 assert.equal(revisionInput({revision:0},2),0)
 for(const revision of [-1,3,1.1,'1',Infinity])assert.throws(()=>revisionInput({revision},2),CommandError)
 assert.throws(()=>revisionInput({revision:0},null),CommandError)
 const{registry,calls}=fixture()
 await assert.rejects(registry.execute('view.zoom.set',{percent:Infinity}),CommandError)
 await assert.rejects(registry.execute('revision.open',{revision:3}),CommandError)
 assert.deepEqual(calls,[])
})
test('explicit panel visibility is idempotent and preserves unrelated and aliased panels',()=>{
 assert.equal(panelTarget(false,'collaboration','properties'),'collaboration')
 assert.equal(panelTarget(false,null,'properties'),null)
 assert.equal(panelTarget(true,'properties','properties'),'properties')
 assert.equal(panelTarget(true,'images','properties',['images']),'images')
 assert.equal(panelTarget(false,'images','properties',['images']),null)
 assert.equal(panelTarget(undefined,'collaboration','properties'),'properties')
 assert.equal(panelTarget(undefined,'properties','properties'),null)
})
test('sheet workspace exposes collaboration and file commands without enabling flow content operations',async()=>{
 const {registry,set,calls}=fixture()
 set({profile:'sheet',format:'xlsx',historical:false,readOnly:false,ready:true,selection:{kind:'none',empty:true,anchor:null,protected:false,parentTypes:[]},actions:{'file.save':{enabled:true},'file.export':{enabled:true},'editor.palette':{enabled:true},'view.collaboration':{enabled:true},'view.panel.close':{enabled:true}}})
 assert.equal(await registry.execute('host.open'),true)
 assert.equal(await registry.execute('file.save'),true)
 assert.equal(await registry.execute('view.panel.close'),true)
 await assert.rejects(registry.execute('text.insert',{text:'unsafe'}),CommandError)
 await assert.rejects(registry.execute('view.zoom.set',{percent:100}),CommandError)
 set({actions:{'file.save':{enabled:false},'view.collaboration':{enabled:false}}})
 await assert.rejects(registry.execute('file.save'),CommandError)
 await assert.rejects(registry.execute('host.open'),CommandError)
 assert.deepEqual(calls,['view.collaboration','file.save','view.panel.close'])
})
