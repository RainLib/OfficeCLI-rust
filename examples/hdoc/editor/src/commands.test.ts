import {test} from 'node:test'
import assert from 'node:assert/strict'
import {CommandError,CommandRegistry} from './commands/registry.ts'
import {builtinCommands} from './commands/builtins.ts'
import {eventKey,shortcutKey,type KeyEvent} from './commands/keymap.ts'
import type {CommandContext,CommandExtensions,EditorCommand} from './commands/types.ts'
const context=():CommandContext=>({instanceId:'one',documentId:'doc',format:'docx',profile:'flow',locale:'zh-CN',platform:'mac',ready:true,readOnly:false,revision:1,historical:false,selection:{kind:'text',empty:false,anchor:'a',protected:false,text:'text',parentTypes:['paragraph']},actions:{'text.insert':{enabled:true},'file.save':{enabled:true},'editor.palette':{enabled:true},'text.bold':{enabled:true}},capabilities:{text:true}})
const insert:EditorCommand={id:'text.insert',label:'Insert',surfaces:[]}
const custom=(id:string,rest:Partial<EditorCommand>={}):EditorCommand=>({id,label:id,execute:()=>true,...rest})
function fixture(commands:readonly EditorCommand[]=[],configuration:CommandExtensions={},builtins:readonly EditorCommand[]=[insert]){
 let current=context();const calls:Array<{id:string;input:unknown}>=[]
 const registry=new CommandRegistry(()=>current,(id,input)=>{calls.push({id,input});return true},builtins,{...configuration,commands})
 const disconnect=registry.connect()
 return{registry,calls,disconnect,set:(patch:Partial<CommandContext>)=>{current={...current,...patch};registry.refresh()},get:()=>current}
}
const key=(name:string,patch:Partial<KeyEvent>={}):KeyEvent=>({key:name,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,isComposing:false,keyCode:0,...patch})
const deferred=()=>{let resolve!:()=>void;return{promise:new Promise<void>(yes=>{resolve=yes}),resolve:()=>resolve()}}
const rejects=(promise:Promise<unknown>,code:CommandError['code'])=>assert.rejects(promise,(error:unknown)=>error instanceof CommandError&&error.code===code)

test('builtins validate on both platforms and all profiles; reserved SDK features are explicit',()=>{
 const {registry,set}=fixture([],{},builtinCommands)
 assert.deepEqual(registry.capabilities(),{version:'hcd-commands/1',commands:true,customNodes:'reserved',mentions:'reserved',ai:'reserved',autocomplete:'reserved'})
 set({capabilities:{text:true,mentions:true}});assert.equal(registry.capabilities().mentions,'person')
 assert.ok(registry.list('ribbon').some(item=>item.id==='file.save'))
})
test('outline snapshot command requires the host capability and current write access',async()=>{
 const f=fixture([],{},builtinCommands),actions={'outline.snapshot.insert':{enabled:true}},capabilities={text:true,outlineSnapshot:true}
 try{
  f.set({actions,capabilities});assert.equal(await f.registry.execute('outline.snapshot.insert'),true)
  for(const patch of [{readOnly:true},{historical:true},{ready:false},{selection:{...context().selection,protected:true}},{capabilities:{text:true}},{actions:{'outline.snapshot.insert':{enabled:false}}}]){
   f.set({...context(),actions,capabilities,...patch});await assert.rejects(f.registry.execute('outline.snapshot.insert'),CommandError)
  }
  assert.equal(f.calls.length,1)
 }finally{f.disconnect()}
})

test('font-size command uses the shared flow selection, authority and host action gates',async()=>{
 const f=fixture([],{},builtinCommands),actions={'text.fontSize.set':{enabled:true}}
 try{
  f.set({actions});assert.equal(await f.registry.execute('text.fontSize.set',{sizePt:18}),true)
  for(const patch of [{readOnly:true},{historical:true},{ready:false},{profile:'fixed' as const},{profile:'sheet' as const},{selection:{...context().selection,protected:true}},{actions:{'text.fontSize.set':{enabled:false}}}]){f.set({...context(),actions,...patch});await assert.rejects(f.registry.execute('text.fontSize.set',{sizePt:18}),CommandError)}
  assert.equal(f.calls.length,1)
 }finally{f.disconnect()}
})
test('normal Word link commands require capability, current target and current write authority',async()=>{
 const f=fixture([],{},builtinCommands),actions={'word.link.header':{enabled:true},'word.link.footer':{enabled:false}},capabilities={text:true,wordLinks:true}
 try{
  f.set({actions,capabilities});assert.equal(await f.registry.execute('word.link.header'),true);await assert.rejects(f.registry.execute('word.link.footer'),CommandError)
  for(const patch of [{readOnly:true},{historical:true},{ready:false},{profile:'fixed' as const},{capabilities:{text:true}},{actions:{'word.link.header':{enabled:false}}}]){f.set({...context(),actions,capabilities,...patch});await assert.rejects(f.registry.execute('word.link.header'),CommandError)}
  assert.equal(f.calls.length,1)
 }finally{f.disconnect()}
})
test('ribbon tab filtering builds one context and execution still checks current authority',async()=>{
 let current=context(),reads=0
 const commands=[custom('ribbon.start',{surfaces:['ribbon'],tabs:['start']}),custom('ribbon.insert',{surfaces:['ribbon'],tabs:['insert']}),custom('ribbon.common',{surfaces:['ribbon']})]
 const registry=new CommandRegistry(()=>{reads++;return current},()=>true,[insert],{commands,menuOverrides:{ribbon:{hidden:['ribbon.common']}}})
 const close=registry.connect()
 try{
  reads=0;assert.deepEqual(registry.list('ribbon','','start').map(item=>item.id),['ribbon.start']);assert.equal(reads,1)
  assert.deepEqual(registry.list('ribbon','','insert').map(item=>item.id),['ribbon.insert'])
  current={...current,readOnly:true};await rejects(registry.execute('ribbon.start'),'readOnly')
 }finally{close()}
})
test('registration validates IDs, duplicate IDs, missing dependencies and cycles atomically',()=>{
 const {registry}=fixture()
 for(const definitions of [[custom('bad id')],[custom('business.a'),custom('business.a')],[custom('a',{requires:['missing']})],[custom('a',{requires:['b']}),custom('b',{requires:['a']})]]){
  assert.throws(()=>registry.register(definitions),CommandError)
  assert.equal(registry.item('a'),undefined);assert.equal(registry.item('business.a'),undefined)
 }
 const remove=registry.register([custom('business.ok')]);assert.equal(registry.item('business.ok')?.enabled,true);remove();remove();assert.equal(registry.item('business.ok'),undefined)
})
test('shortcut collisions are checked for mac and other platforms; disjoint profiles are allowed',()=>{
 assert.throws(()=>fixture([custom('a',{shortcuts:['Mod+K']}),custom('b',{shortcuts:['Ctrl+K']})]),CommandError)
 assert.throws(()=>fixture([custom('a',{shortcuts:['Mod+K']}),custom('b',{shortcuts:['Meta+K']})]),CommandError)
 assert.throws(()=>fixture([custom('a',{shortcuts:['Mod+Mod+K']})]),CommandError)
 assert.doesNotThrow(()=>fixture([custom('a',{shortcuts:['Mod+K'],profiles:['flow']}),custom('b',{shortcuts:['Mod+K'],profiles:['fixed']})]))
})
test('menu hiding and ordering never grant or revoke execute authority',async()=>{
 const {registry,set}=fixture([custom('business.a'),custom('business.b')],{menuOverrides:{palette:{hidden:['business.a'],order:['business.b']}}})
 assert.deepEqual(registry.list('palette').map(item=>item.id),['business.b'])
 assert.equal(await registry.execute('business.a'),true)
 set({readOnly:true});await rejects(registry.execute('business.a'),'readOnly')
})
test('search includes aliases and labels in all locales; context is deeply immutable',()=>{
 const {registry,set}=fixture([custom('business.resume',{label:{'zh-CN':'简历','en-US':'Résumé'},aliases:['候选人']})])
 assert.equal(registry.list('palette','resume')[0]?.label,'简历')
 assert.equal(registry.list('palette','候选')[0]?.id,'business.resume')
 set({locale:'en-US'});assert.equal(registry.list('palette','简历')[0]?.label,'Résumé')
 assert.throws(()=>{(registry.context().selection.parentTypes as string[]).push('injection')})
 assert.throws(()=>{(registry.context().actions['text.insert'] as {enabled:boolean}).enabled=false})
})
test('write commands reject read-only, historical, protected, unready and wrong-profile state',async()=>{
 const {registry,set,get,calls}=fixture([custom('business.insert',{execute:({commands})=>commands.run('text.insert',{text:'value'})})])
 for(const patch of [{readOnly:true},{historical:true},{ready:false},{profile:'sheet' as const},{selection:{...get().selection,protected:true}}]){
  set({...context(),...patch})
  // Restrict the custom command to flow for the profile case.
  if(patch.profile)continue
  await assert.rejects(registry.execute('business.insert'),CommandError)
 }
 assert.equal(calls.length,0)
 const other=fixture([custom('flow.only',{profiles:['flow']})]);other.set({profile:'fixed'});await rejects(other.registry.execute('flow.only'),'unavailable')
})
test('nested edits recheck permission after async work and cannot use stale selection or document',async()=>{
 for(const patch of [{readOnly:true},{selection:{...context().selection,anchor:'new'}},{documentId:'other'}]){
  const gate=deferred(),{registry,set,calls}=fixture([custom('business.async',{access:'read',execute:async({commands})=>{await gate.promise;return commands.run('text.insert',{text:'late'})}})])
  const pending=registry.execute('business.async');set(patch);gate.resolve();await rejects(pending,'readOnly'in patch?'readOnly':'selectionChanged');assert.equal(calls.length,0)
 }
})
test('appending outside a protected selection retains read-only, history and action guards',async()=>{
 const f=fixture([],{},builtinCommands)
 f.set({selection:{...f.get().selection,protected:true},actions:{'block.appendParagraph':{enabled:true}}})
 assert.equal(await f.registry.execute('block.appendParagraph'),true)
 for(const patch of [{readOnly:true},{historical:true},{actions:{'block.appendParagraph':{enabled:false}}}]){
  f.set({...context(),selection:{...context().selection,protected:true},actions:{'block.appendParagraph':{enabled:true}},...patch})
  await assert.rejects(f.registry.execute('block.appendParagraph'),CommandError)
 }
 assert.equal(f.calls.length,1)
})
test('command invocation snapshot cannot be changed by later state updates',async()=>{
 const gate=deferred();let captured=''
 const {registry,set}=fixture([custom('inspect',{access:'read',execute:async({context})=>{await gate.promise;captured=context.documentId}})])
 const pending=registry.execute('inspect');set({documentId:'next'});gate.resolve();await pending;assert.equal(captured,'doc')
})
test('dispose aborts pending host work; stale cleanup cannot dispose a reconnected registry',async()=>{
 const gates=[deferred(),deferred()];let count=0;const signals:AbortSignal[]=[]
 const {registry,disconnect}=fixture([custom('async',{execute:async({signal})=>{signals.push(signal);await gates[count++].promise;return true}})])
 const first=registry.execute('async');disconnect();assert.equal(signals[0].aborted,true)
 const cleanup=registry.connect();disconnect();assert.equal(registry.item('async')?.enabled,true)
 const second=registry.execute('async');gates[0].resolve();await rejects(first,'disposed')
 assert.equal(registry.item('async')?.enabled,false);await rejects(registry.execute('async'),'busy')
 gates[1].resolve();await second;assert.equal(signals[1].aborted,false);assert.equal(registry.item('async')?.enabled,true);cleanup()
})
test('dependency unregister disables dependents and recursive commands cannot loop',async()=>{
 const {registry}=fixture();const remove=registry.register([custom('dependency')]);registry.register([custom('dependent',{requires:['dependency']})]);remove()
 await rejects(registry.execute('dependent'),'unavailable')
 registry.register([custom('cycle.a',{execute:({commands})=>commands.run('cycle.b')}),custom('cycle.b',{execute:({commands})=>commands.run('cycle.a')})])
 await rejects(registry.execute('cycle.a'),'cycle')
})
test('instances have isolated adapters, pending work and permissions',async()=>{
 const definition=custom('business.insert',{execute:({commands})=>commands.run('text.insert',{text:'isolated'})})
 const a=fixture([definition]),b=fixture([definition]);b.set({readOnly:true,instanceId:'two'})
 await a.registry.execute(definition.id);await rejects(b.registry.execute(definition.id),'readOnly')
 assert.deepEqual(a.calls,[{id:'text.insert',input:{text:'isolated'}}]);assert.equal(b.calls.length,0)
})
test('keyboard routing uses exact modifier masks, consumes disabled bindings, ignores IME and leaves form fields alone',async()=>{
 const {registry,set,calls}=fixture([],{},builtinCommands)
 assert.equal(registry.handleKey(key('b',{metaKey:true}),'input'),false)
 assert.equal(registry.handleKey(key('s',{metaKey:true}),'input'),true)
 await Promise.resolve();assert.equal(calls[0].id,'file.save')
 assert.equal(registry.handleKey(key('b',{metaKey:true,ctrlKey:true})),false)
 for(const patch of [{isComposing:true},{keyCode:229},{getModifierState:(name:string)=>name==='AltGraph'},{key:'Dead'}])assert.equal(registry.handleKey(key('b',{metaKey:true,...patch})),false)
 set({readOnly:true});assert.equal(registry.handleKey(key('b',{metaKey:true})),true);await Promise.resolve();assert.equal(calls.length,1)
})
test('keymap overrides remove old shortcut and route replacement exactly once',async()=>{
 const {registry,calls}=fixture([], {keymap:{'file.save':['Mod+Alt+S'],'text.bold':null}},builtinCommands)
 assert.equal(registry.handleKey(key('s',{metaKey:true})),false);assert.equal(registry.handleKey(key('b',{metaKey:true})),false)
 assert.equal(registry.handleKey(key('s',{metaKey:true,altKey:true})),true);await Promise.resolve();assert.equal(calls.length,1)
})
test('platform shortcut aliases and IME event normalization are deterministic',()=>{
 assert.equal(shortcutKey('Mod+Shift+P','mac'),eventKey(key('P',{metaKey:true,shiftKey:true})))
 assert.equal(shortcutKey('Mod+Shift+P','other'),eventKey(key('P',{ctrlKey:true,shiftKey:true})))
 assert.equal(shortcutKey('Ctrl+Space','other'),eventKey(key(' ',{ctrlKey:true})))
 assert.equal(eventKey(key('Process')),null)
})
test('detached dependencies disable transitive consumers without breaking unrelated registration',async()=>{
 const {registry}=fixture();const remove=registry.register([custom('base')]);registry.register([custom('middle',{requires:['base']}),custom('leaf',{requires:['middle']})]);remove()
 assert.equal(registry.item('leaf')?.enabled,false);await rejects(registry.execute('leaf'),'unavailable')
 registry.register([custom('unrelated')]);assert.equal(registry.item('unrelated')?.enabled,true)
 registry.register([custom('base')]);assert.equal(registry.item('leaf')?.enabled,true)
})
test('caller mutation cannot silently replace validated shortcuts or placements',()=>{
 const keys=['Mod+Alt+J'],hidden:string[]=[]
 const {registry}=fixture([custom('business.test',{shortcuts:['Mod+J']})],{keymap:{'business.test':keys},menuOverrides:{palette:{hidden}}})
 keys[0]='Mod+S';hidden.push('business.test')
 assert.deepEqual(registry.item('business.test')?.shortcuts,['Mod+Alt+J']);assert.equal(registry.list('palette').length,1)
})
test('file/history actions do not require a loaded text selection; receipt retry remains available',async()=>{
 const {registry,set,calls}=fixture([],{},builtinCommands)
 set({ready:false,readOnly:true,actions:{'file.save':{enabled:true},'file.export':{enabled:true},'edit.undo':{enabled:false},'text.insert':{enabled:true}}})
 await registry.execute('file.save');await registry.execute('file.export');assert.deepEqual(calls.map(call=>call.id),['file.save','file.export'])
 await rejects(registry.execute('edit.undo'),'unavailable');await rejects(registry.execute('text.insert'),'unavailable')
})
const slashTarget={from:1,to:7,text:'/token',anchor:'a'}
function stagedFixture(execute:NonNullable<EditorCommand['execute']>){
 let current=context();const mutations:string[]=[],commands=[{...insert,surfaces:['slash'] as const},custom('host.slash',{surfaces:['slash'],execute})]
 const registry=new CommandRegistry(()=>current,(id,_input,_signal,insertion)=>{assert.ok(insertion);insertion.stage(()=>{mutations.push(id);return true});return true},[commands[0]],{commands:[commands[1]]})
 const dispose=registry.connect()
 return{registry,mutations,dispose,set:(patch:Partial<CommandContext>)=>{current={...current,...patch}}}
}
test('slash host stages a nested edit and commits only after the outer callback succeeds',async()=>{
 let fixture!:ReturnType<typeof stagedFixture>
 fixture=stagedFixture(async({commands})=>{const result=await commands.run('text.insert',{text:'yes'});assert.equal(fixture.mutations.length,0);return result})
 assert.equal(await fixture.registry.executeInsertion('host.slash',slashTarget),true);assert.deepEqual(fixture.mutations,['text.insert'])
})
test('outer cancellation or failure after staging never commits or consumes the trigger',async()=>{
 for(const fail of [false,true]){
  const fixture=stagedFixture(async({commands})=>{await commands.run('text.insert');if(fail)throw new Error('host failure');return false})
  if(fail)await assert.rejects(fixture.registry.executeInsertion('host.slash',slashTarget),/host failure/)
  else assert.equal(await fixture.registry.executeInsertion('host.slash',slashTarget),false)
  assert.equal(fixture.mutations.length,0)
 }
})
test('permission and selection are rechecked after host callback completes, even if already staged',async()=>{
 for(const patch of [{readOnly:true},{selection:{...context().selection,anchor:'changed'}},{documentId:'other'}]){
  const gate=deferred(),fixture=stagedFixture(async({commands})=>{await commands.run('text.insert');await gate.promise;return true})
  const pending=fixture.registry.executeInsertion('host.slash',slashTarget);await Promise.resolve();fixture.set(patch);gate.resolve()
  await assert.rejects(pending,CommandError);assert.equal(fixture.mutations.length,0)
 }
})
test('an unregistered intermediate extension cannot publish its staged content later',async()=>{
 const gate=deferred(),fixture=stagedFixture(async({commands})=>{await commands.run('temporary');await gate.promise;return true})
 const remove=fixture.registry.register([custom('temporary',{execute:({commands})=>commands.run('text.insert')})])
 const pending=fixture.registry.executeInsertion('host.slash',slashTarget);await Promise.resolve();remove();gate.resolve()
 await rejects(pending,'unavailable');assert.equal(fixture.mutations.length,0)
})
test('multiple staged writes, missing targets and disposal cannot leave partial content',async()=>{
 const fixture=stagedFixture(async({commands})=>{await commands.run('text.insert');return commands.run('text.insert')})
 await rejects(fixture.registry.executeInsertion('host.slash',slashTarget),'configuration');assert.equal(fixture.mutations.length,0)
 await rejects(fixture.registry.executeInsertion('host.slash',{...slashTarget,anchor:'old'}),'selectionChanged')
 await rejects(fixture.registry.executeInsertion('file.save',slashTarget),'unavailable')
 const gate=deferred(),closing=stagedFixture(async({commands})=>{await commands.run('text.insert');await gate.promise;return true})
 const pending=closing.registry.executeInsertion('host.slash',slashTarget);await Promise.resolve();closing.dispose();gate.resolve();await rejects(pending,'disposed');assert.equal(closing.mutations.length,0)
})

test('closing slash or block UI aborts pending staged commands without a partial commit',async()=>{
 for(const mode of ['slash','block'] as const){
  const gate=deferred(),mutations:string[]=[],controller=new AbortController()
  const registry=new CommandRegistry(context,(_id,_input,_signal,placement)=>{placement!.stage(()=>{mutations.push('committed');return true});return true},[insert],{commands:[custom('host.cancel',{surfaces:['slash','block'],execute:async({commands,signal})=>{await commands.run('text.insert');await gate.promise;assert.equal(signal.aborted,true);return true}})]})
  registry.connect()
  const pending=mode==='slash'?registry.executeInsertion('host.cancel',slashTarget,controller.signal):registry.executeBlock('host.cancel',{kind:'block',from:0,to:5,fingerprint:'test',anchor:'a',intent:'operate'},controller.signal)
  await Promise.resolve();controller.abort();gate.resolve();await rejects(pending,'disposed');assert.deepEqual(mutations,[])
 }
})
test('block surfaces can run nonmutating host actions; insert surfaces require a staged edit',async()=>{
 const registry=new CommandRegistry(context,()=>true,[],{commands:[custom('host.inspect',{surfaces:['block','slash'],access:'read'})]});registry.connect()
 const target={kind:'block' as const,from:0,to:5,fingerprint:'test',anchor:'a',intent:'operate' as const}
 assert.equal(await registry.executeBlock('host.inspect',target),true)
 assert.equal(await registry.executeBlock('host.inspect',{...target,intent:'after'}),false)
 assert.equal(await registry.executeInsertion('host.inspect',slashTarget),false)
 await rejects(registry.executeBlock('host.inspect',{...target,anchor:'stale'}),'selectionChanged')
})

test('registered Tab bindings run before completion handling, including disabled binding ownership',async()=>{
 const events:string[]=[],f=fixture([custom('business.tab',{shortcuts:['Tab'],execute:()=>{events.push('execute');return true}})])
 assert.equal(f.registry.handleKey(key('Tab'),'editor',id=>events.push(`before:${id}`)),true);await Promise.resolve();assert.deepEqual(events,['before:business.tab','execute'])
 events.length=0;f.set({readOnly:true});assert.equal(f.registry.handleKey(key('Tab'),'editor',id=>events.push(`before:${id}`)),true);await Promise.resolve();assert.deepEqual(events,['before:business.tab'])
 events.length=0;assert.equal(f.registry.handleKey(key('Tab',{isComposing:true,keyCode:229}),'editor',id=>events.push(id)),false);assert.deepEqual(events,[]);f.disconnect()
})
