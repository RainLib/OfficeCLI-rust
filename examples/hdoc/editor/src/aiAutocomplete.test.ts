import {test} from 'node:test'
import assert from 'node:assert/strict'
import {autocompletePolicy,AiCompletionScheduler,completionKey,isCompletionInput,type CompletionClock} from './ai/autocomplete.ts'
function clock(){let now=0,next=0;const work=new Map<number,{at:number;run:()=>void}>(),clock:CompletionClock={now:()=>now,set:(run,delay)=>{const id=++next;work.set(id,{at:now+delay,run});return id},clear:id=>{work.delete(id as number)}};return{clock,advance:(ms:number)=>{const until=now+ms;while(true){const entry=[...work].sort((a,b)=>a[1].at-b[1].at)[0];if(!entry||entry[1].at>until)break;work.delete(entry[0]);now=entry[1].at;entry[1].run()}now=until},work}}
test('autocomplete is opt-in and enforces context, output and request-rate budgets',()=>{
 assert.equal(autocompletePolicy(undefined).enabled,false);assert.equal(autocompletePolicy(undefined).available,true);assert.equal(autocompletePolicy(false).available,false)
 for(const patch of [{delayMs:249},{cooldownMs:0},{minPrefix:257},{maxOutput:2049},{enabled:'yes'},{instruction:'\0'}])assert.throws(()=>autocompletePolicy(patch as any))
 assert.equal(autocompletePolicy({enabled:true,maxOutput:128,minPrefix:4}).maxOutput,128)
})
test('only trailing local activity starts a request; context changes, cancellation and stale timers cannot start one',()=>{
 const c=clock();let key:string|null='a',cancelled=0;const runs:string[]=[]
 const scheduler=new AiCompletionScheduler({delayMs:900,cooldownMs:1500,context:()=>key,run:value=>runs.push(value),cancel:()=>{cancelled++}},c.clock)
 c.advance(5000);assert.deepEqual(runs,[]);scheduler.activity();c.advance(500);key='ab';scheduler.activity();c.advance(899);assert.deepEqual(runs,[]);c.advance(1);assert.deepEqual(runs,['ab'])
 scheduler.activity();c.advance(5000);assert.deepEqual(runs,['ab'],'duplicate context does not re-request')
 key='new';scheduler.activity();const stale=[...c.work.values()][0].run;scheduler.cancel();stale();c.advance(5000);assert.deepEqual(runs,['ab'])
 key='changed';scheduler.activity();key='peer changed';c.advance(900);assert.deepEqual(runs,['ab']);assert.ok(cancelled>=4)
})
test('cooldown coalesces new input and provider failures never schedule their own retry',()=>{
 const c=clock();let key='a',calls=0,cancelled=0
 const scheduler=new AiCompletionScheduler({delayMs:300,cooldownMs:1500,context:()=>key,run:()=>{calls++;if(calls===2)throw new Error('unavailable')},cancel:()=>{cancelled++}},c.clock)
 scheduler.activity();c.advance(300);assert.equal(calls,1);key='b';scheduler.activity();c.advance(1499);assert.equal(calls,1);c.advance(1);assert.equal(calls,2);assert.equal(scheduler.pending(),false);c.advance(100000);assert.equal(calls,2);assert.ok(cancelled>=3)
})
test('Tab requires a finished, visible, focused-context suggestion; menus, modifiers and IME win',()=>{
 const ready={active:true,ready:true,applying:false,visible:true,blocked:false,composing:false}
 assert.equal(completionKey({key:'Tab'},ready),'accept')
 assert.equal(completionKey({key:'Tab'},{...ready,applying:true,ready:false}),'wait')
 for(const patch of [{blocked:true},{composing:true}])assert.equal(completionKey({key:'Tab'},{...ready,...patch}),'none')
 for(const patch of [{shiftKey:true},{ctrlKey:true},{metaKey:true},{altKey:true},{isComposing:true},{keyCode:229},{defaultPrevented:true},{getModifierState:()=>true}])assert.equal(completionKey({key:'Tab',...patch},ready),'none')
 assert.equal(completionKey({key:'Tab'},{...ready,visible:false}),'cancel-tab');assert.equal(completionKey({key:'Tab'},{...ready,ready:false}),'cancel-tab');assert.equal(completionKey({key:'Escape'},ready),'dismiss');assert.equal(completionKey({key:'Escape'},{...ready,blocked:true}),'none')
 assert.equal(completionKey({key:'Tab'},{...ready,active:false,ready:false,visible:false}),'none')
})

test('typing, deletion, IME commit and autocorrect may trigger; clipboard batches and structural edits may not',()=>{
 for(const kind of ['insertText','insertFromComposition','insertCompositionText','insertReplacementText','deleteContentBackward','deleteWordForward'])assert.equal(isCompletionInput(kind),true,kind)
 for(const kind of ['insertFromPaste','insertFromDrop','insertParagraph','insertLineBreak','historyUndo','deleteByCut',''])assert.equal(isCompletionInput(kind),false,kind)
})
