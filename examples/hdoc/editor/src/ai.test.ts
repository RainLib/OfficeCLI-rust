import {test} from 'node:test'
import assert from 'node:assert/strict'
import {AiSuggestionController,AiError} from './ai/core.ts'
import type {AiAdapter,AiAction,AiEvent,AiProvider,AiRequest} from './ai/types.ts'
const action:AiAction={id:'rewrite',label:'Rewrite',mode:'replace'}
const context={documentId:'test',format:'docx',revision:0,locale:'zh-CN',source:{text:'Original',digest:'digest'},before:'Before',after:'After'}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
function stream(events:(request:Readonly<AiRequest>)=>unknown[]):AiProvider{return{async *generate(request){for(const event of events(request))yield event as AiEvent}}}
const good=stream(r=>[{version:'hcd-ai/1',requestId:r.requestId,seq:0,type:'delta',text:'改写结果'},{version:'hcd-ai/1',requestId:r.requestId,seq:1,type:'done'}])
function harness(provider:AiProvider=good,patch:Partial<AiAdapter<string>>={},limits={}){
 let valid=true,commits=0,text=''
 const adapter:AiAdapter<string>={prepare:async()=>({target:'target',context}),valid:()=>valid,authorize:async()=>{},commit:(_,value)=>{commits++;text=value;return true},...patch}
 const controller=new AiSuggestionController(provider,adapter,{limits})
 return{controller,adapter,setValid:(value:boolean)=>{valid=value},get:()=>({commits,text})}
}
test('private stream needs explicit accept; repeated acceptance and callback failure cannot duplicate it',async()=>{
 const h=harness();await h.controller.start(action);assert.equal(h.controller.snapshot().phase,'ready');assert.equal(h.get().commits,0)
 const id=h.controller.snapshot().requestId!,first=h.controller.accept(id);assert.equal(h.controller.accept(id),first);assert.equal(await first,true);assert.equal(await h.controller.accept(id),true);assert.deepEqual(h.get(),{commits:1,text:'改写结果'})
 let count=0;const c=new AiSuggestionController(good,{...h.adapter,commit:()=>{count++;return true}},{onAccepted:()=>{throw new Error('host callback')}})
 await c.start(action);assert.equal(await c.accept(c.snapshot().requestId!),true);assert.equal(c.snapshot().phase,'accepted');assert.equal(count,1)
})
test('protocol faults and invalid XML/Unicode never apply incomplete output',async()=>{
 const bad=[(r:Readonly<AiRequest>)=>[{version:'hcd-ai/1',requestId:'wrong',seq:0,type:'done'}],(r:Readonly<AiRequest>)=>[{version:'hcd-ai/1',requestId:r.requestId,seq:2,type:'done'}],(r:Readonly<AiRequest>)=>[{version:'hcd-ai/1',requestId:r.requestId,seq:0,type:'delta',text:'incomplete'}],...['','\0','\ud800'].map(text=>(r:Readonly<AiRequest>)=>[{version:'hcd-ai/1',requestId:r.requestId,seq:0,type:'delta',text},{version:'hcd-ai/1',requestId:r.requestId,seq:1,type:'done'}])]
 for(const events of bad){const h=harness(stream(events));await h.controller.start(action);assert.equal(h.controller.snapshot().phase,'failed');assert.equal(await h.controller.accept(h.controller.snapshot().requestId!),false);assert.equal(h.get().commits,0)}
})
test('split surrogate chunks validate at completion; output and event budgets fail closed',async()=>{
 const h=harness(stream(r=>[...['\ud83d','\ude00'].map((text,seq)=>({version:'hcd-ai/1',requestId:r.requestId,seq,type:'delta',text})),{version:'hcd-ai/1',requestId:r.requestId,seq:2,type:'done'}]));await h.controller.start(action);assert.equal(h.controller.snapshot().output,'😀');assert.equal(h.controller.snapshot().phase,'ready')
 for(const limits of [{maxOutput:1},{maxEvents:1}]){const h=harness(good,{},limits);await h.controller.start(action);assert.equal(h.controller.snapshot().phase,'failed');assert.equal(h.get().commits,0)}
})
test('cancel and timeout settle providers ignoring AbortSignal and iterator return',async()=>{
 for(const timeout of [false,true]){const entered=deferred<void>(),h=harness({generate(){entered.resolve();return{[Symbol.asyncIterator](){return{next:()=>new Promise(()=>{}),return:()=>new Promise(()=>{})}}}}},{},{timeoutMs:timeout?10:1000});const work=h.controller.start(action);await entered.promise;if(!timeout)h.controller.cancel();await work;assert.equal(h.controller.snapshot().error,timeout?'timeout':'cancelled');assert.equal(h.get().commits,0)}
})
test('cancel during prepare or stale source prevents data upload',async()=>{
 let calls=0;const entered=deferred<void>(),finish=deferred<void>(),provider:AiProvider={generate:(r,o)=>{calls++;return good.generate(r,o)}}
 const h=harness(provider,{prepare:async()=>{entered.resolve();await finish.promise;return{target:'target',context}}});const work=h.controller.start(action);await entered.promise;h.controller.cancel();await work;finish.resolve();assert.equal(calls,0)
 const stale=harness(provider);stale.setValid(false);await stale.controller.start(action);assert.equal(stale.controller.snapshot().phase,'stale');assert.equal(calls,0)
})
test('replaced request ignores late events and rejects old acceptance IDs',async()=>{
 const pending=deferred<IteratorResult<AiEvent>>(),entered=deferred<void>();let n=0
 const provider:AiProvider={generate(r,o){if(n++)return good.generate(r,o);entered.resolve();return{[Symbol.asyncIterator](){return{next:()=>pending.promise,return:async()=>({done:true,value:undefined})}}}}}
 const h=harness(provider),old=h.controller.start(action);await entered.promise;const oldId=h.controller.snapshot().requestId!;await h.controller.start(action);await old;pending.resolve({done:false,value:{version:'hcd-ai/1',requestId:oldId,seq:0,type:'delta',text:'LATE'}});await Promise.resolve();assert.equal(h.controller.snapshot().output,'改写结果');assert.equal(await h.controller.accept(oldId),false)
})
test('accept rechecks authorization; timeout, cancel and peer source changes during await forbid commit',async()=>{
 for(const kind of ['timeout','cancel','stale','denied']as const){const entered=deferred<void>(),finish=deferred<void>(),h=harness(good,{authorize:async()=>{entered.resolve();if(kind==='denied')throw new AiError('denied');await finish.promise}},{timeoutMs:kind==='timeout'?10:1000});await h.controller.start(action);const applying=h.controller.accept(h.controller.snapshot().requestId!);await entered.promise;if(kind==='cancel')h.controller.cancel();if(kind==='stale'){h.setValid(false);h.controller.invalidate()}if(kind!=='timeout')finish.resolve();assert.equal(await applying,false);assert.equal(h.get().commits,0);assert.equal(h.controller.snapshot().error,kind==='cancel'?'cancelled':kind)}
})
test('request allowlist excludes tokens/anchors; provider errors cannot expose credentials',async()=>{
 let request:Readonly<AiRequest>|undefined;const h=harness({generate(r){request=r;throw new Error('Bearer secret credential')}},{prepare:async()=>({target:'target',context:{...context,token:'SECRET',anchor:{internal:true}} as any})});await h.controller.start(action);assert.equal('token'in request!,false);assert.equal('anchor'in request!,false);assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request?.source));assert.equal(h.controller.snapshot().error,'network');assert.ok(!JSON.stringify(h.controller.snapshot()).includes('secret'))
})
test('own mutation invalidation is suppressed; disposal and reconnect retain task isolation',async()=>{
 let c:AiSuggestionController<string>;const h=harness();c=new AiSuggestionController(good,{...h.adapter,commit:()=>{h.setValid(false);c.invalidate();return true}});await c.start(action);assert.equal(await c.accept(c.snapshot().requestId!),true);assert.equal(c.snapshot().phase,'accepted');c.dispose();c.connect();h.setValid(true);await c.start(action);assert.equal(c.snapshot().phase,'ready')
})
