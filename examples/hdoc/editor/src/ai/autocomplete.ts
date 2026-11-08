import {AiError,aiText} from './core.js'
import type {AiAutocompleteOptions} from './types.js'
export type AutocompletePolicy=Readonly<{available:boolean;enabled:boolean;delayMs:number;cooldownMs:number;minPrefix:number;maxOutput:number;instruction:string}>
export function autocompletePolicy(input:AiAutocompleteOptions|false|undefined):AutocompletePolicy{
 const source=input||{}
 const number=(key:'delayMs'|'cooldownMs'|'minPrefix'|'maxOutput',fallback:number,min:number,max:number)=>{const value=source[key]??fallback;if(!Number.isSafeInteger(value)||value<min||value>max)throw new AiError('limit');return value}
 if(source.enabled!==undefined&&typeof source.enabled!=='boolean')throw new AiError('protocol')
 const instruction=source.instruction??'Suggest a short continuation at the cursor in the same language and style. Return only new text, without repeating either context. Do not include explanations.'
 if(typeof instruction!=='string'||instruction.length>2000||!aiText(instruction))throw new AiError('limit')
 return Object.freeze({available:input!==false,enabled:source.enabled??false,delayMs:number('delayMs',900,250,10000),cooldownMs:number('cooldownMs',1500,250,60000),minPrefix:number('minPrefix',8,1,256),maxOutput:number('maxOutput',256,1,2048),instruction})
}
export type CompletionClock={now:()=>number;set:(run:()=>void,delay:number)=>unknown;clear:(timer:unknown)=>void}
const defaultClock:CompletionClock={now:Date.now,set:(run,delay)=>setTimeout(run,delay),clear:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>)}
/** Only local typing calls activity. Focus, remote updates and completion results
 * never start generation; no retry loop is attached to provider failures. */
export class AiCompletionScheduler{
 private timer:unknown;private generation=0;private lastKey:string|null=null;private lastStart=-Infinity
 constructor(private options:{delayMs:number;cooldownMs:number;context:()=>string|null;run:(key:string)=>void;cancel:()=>void},private clock:CompletionClock=defaultClock){}
 pending=()=>this.timer!==undefined
 cancel=()=>{this.generation++;if(this.timer!==undefined)this.clock.clear(this.timer);this.timer=undefined;this.options.cancel()}
 activity=()=>{
  this.cancel();const key=this.options.context();if(key===null||key===this.lastKey)return
  const generation=this.generation,delay=Math.max(this.options.delayMs,this.lastStart+this.options.cooldownMs-this.clock.now())
  this.timer=this.clock.set(()=>{this.timer=undefined;if(generation!==this.generation||this.options.context()!==key)return;this.lastStart=this.clock.now();this.lastKey=key;try{this.options.run(key)}catch{this.options.cancel()}},delay)
 }
}
export type CompletionKey={key:string;defaultPrevented?:boolean;isComposing?:boolean;keyCode?:number;shiftKey?:boolean;ctrlKey?:boolean;metaKey?:boolean;altKey?:boolean;getModifierState?:(key:string)=>boolean}
export function completionKey(event:CompletionKey,state:{active:boolean;ready:boolean;applying:boolean;visible:boolean;blocked:boolean;composing:boolean}):'accept'|'wait'|'dismiss'|'cancel-tab'|'none'{
 if(event.defaultPrevented||event.isComposing||event.keyCode===229||state.composing||state.blocked||event.ctrlKey||event.metaKey||event.altKey||event.getModifierState?.('AltGraph'))return'none'
 if(event.key==='Escape'&&state.active)return'dismiss'
 if(event.key!=='Tab'||event.shiftKey)return'none'
 if(state.applying&&state.visible)return'wait'
 if(state.ready&&state.visible)return'accept'
 return state.active?'cancel-tab':'none'
}

/** Local keyboard deletion, IME commits and autocorrect are ordinary editing.
 * Clipboard batches and structural commands never generate unsolicited AI. */
export function isCompletionInput(inputType:string){return new Set(['insertText','insertReplacementText','insertFromComposition','insertCompositionText','deleteContentBackward','deleteContentForward','deleteWordBackward','deleteWordForward','deleteSoftLineBackward','deleteSoftLineForward']).has(inputType)}
