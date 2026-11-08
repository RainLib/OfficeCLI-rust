import type {AiAction,AiAdapter,AiErrorCode,AiEvent,AiExtensions,AiProvider,AiRequest,AiSnapshot} from './types.js'
export class AiError extends Error{constructor(readonly code:AiErrorCode){super(code);this.name='AiError'}}
const codes=new Set<AiErrorCode>(['unavailable','invalid-target','stale','denied','network','rate-limited','protocol','limit','timeout','cancelled'])
export function aiCode(error:unknown):AiErrorCode{return error instanceof AiError&&codes.has(error.code)?error.code:'network'}
export function aiText(text:string){return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)}
export function abortable<T>(work:PromiseLike<T>|T,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{if(signal.aborted){reject(signal.reason??new AiError('cancelled'));return}
  const cancel=()=>reject(signal.reason??new AiError('cancelled'));signal.addEventListener('abort',cancel,{once:true})
  Promise.resolve(work).then(value=>{signal.removeEventListener('abort',cancel);resolve(value)},error=>{signal.removeEventListener('abort',cancel);reject(error)})
 })
}
type Task<T>={id:string;abort:AbortController;target?:T;request?:Readonly<AiRequest>;apply?:Promise<boolean>}
const initial:AiSnapshot=Object.freeze({phase:'idle',requestId:null,output:'',source:''})
/** Private suggestion lifecycle, independent of React, Tiptap, Yjs and providers. */
export class AiSuggestionController<T>{
 private value=initial;private listeners=new Set<()=>void>();private task?:Task<T>;private disposed=false;private committing=false
 private readonly timeout:number;private readonly outputLimit:number;private readonly eventLimit:number
 constructor(private provider:AiProvider,private adapter:AiAdapter<T>,private options:Pick<AiExtensions,'limits'|'onAccepted'|'onError'>={}){
  const limit=(value:number|undefined,fallback:number,min:number,max:number)=>{if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||value<min||value>max)throw new AiError('limit');return value}
  this.timeout=limit(options.limits?.timeoutMs,120000,10,600000);this.outputLimit=limit(options.limits?.maxOutput,16000,1,100000);this.eventLimit=limit(options.limits?.maxEvents,20000,1,100000)
 }
 snapshot=()=>this.value
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private publish(value:AiSnapshot){this.value=Object.freeze(value);for(const listener of this.listeners){try{listener()}catch{/* Host observers cannot change task results. */}}}
 private current(task:Task<T>){return !this.disposed&&this.task===task&&!task.abort.signal.aborted}
 private stop(code:AiErrorCode,phase:AiSnapshot['phase']){const task=this.task;if(!task||['accepted','dismissed','cancelled','failed','stale'].includes(this.value.phase))return;task.abort.abort(new AiError(code));this.publish({...this.value,phase,error:code})}
 cancel=()=>this.stop('cancelled','cancelled')
 dismiss=()=>{this.cancel();if(!this.disposed)this.publish({...initial,phase:'dismissed'})}
 invalidate=()=>{if(this.committing)return;const task=this.task;if(task?.target!==undefined&&this.current(task)&&!this.adapter.valid(task.target))this.stop('stale','stale')}
 locate=()=>this.task?.target!==undefined?this.adapter.locate?.(this.task.target)??false:false
 connect=()=>{this.disposed=false;return this.dispose}
 dispose=()=>{this.cancel();this.disposed=true;this.listeners.clear()}
 async start(action:AiAction,instruction=''){
  if(this.disposed)return
  this.cancel();const task:Task<T>={id:crypto.randomUUID(),abort:new AbortController()};this.task=task
  this.publish({...initial,phase:'requesting',requestId:task.id,action:action.id,mode:action.mode,instruction})
  let iterator:AsyncIterator<AiEvent>|undefined
  const timer=setTimeout(()=>{if(this.current(task))this.stop('timeout','failed')},this.timeout)
  try{
   if(!/^[a-z][a-z0-9_.-]{0,63}$/.test(action.id)||!['insert','replace'].includes(action.mode)||typeof instruction!=='string'||instruction.length>2000||!aiText(instruction))throw new AiError('limit')
   const prepared=await abortable(this.adapter.prepare(action.mode,task.abort.signal),task.abort.signal)
   if(!this.current(task))return;task.target=prepared.target
   if(!this.adapter.valid(task.target))throw new AiError('stale')
   const context=prepared.context
   if(context.source.text.length>8000||context.before.length+context.after.length>8000||!context.source.digest||[context.source.text,context.before,context.after].some(text=>!aiText(text)))throw new AiError('limit')
   // Copy only protocol fields: no token, DOM, Y.Doc, anchor or arbitrary host object.
   const request:Readonly<AiRequest>=Object.freeze({version:'hcd-ai/1',requestId:task.id,action:action.id,mode:action.mode,instruction:instruction||action.instruction||'',documentId:context.documentId,format:context.format,revision:context.revision,locale:context.locale,source:Object.freeze({...context.source}),before:context.before,after:context.after})
   if(request.instruction.length>2000||!aiText(request.instruction))throw new AiError('limit')
   task.request=request;this.publish({...this.value,source:request.source.text})
   const stream=await abortable(this.provider.generate(request,{signal:task.abort.signal}),task.abort.signal)
   if(!stream||typeof stream[Symbol.asyncIterator]!=='function')throw new AiError('protocol')
   iterator=stream[Symbol.asyncIterator]();let seq=0,output=''
   while(this.current(task)){
    const next=await abortable(iterator.next(),task.abort.signal)
    if(!this.current(task))return
    if(next.done)throw new AiError('protocol')
    const event=next.value
    if(!event||event.version!=='hcd-ai/1'||event.requestId!==task.id||event.seq!==seq++||seq>this.eventLimit)throw new AiError('protocol')
    if(event.type==='error')throw new AiError(codes.has(event.code)?event.code:'protocol')
    if(event.type==='delta'){
     if(typeof event.text!=='string'||!event.text.length||event.text.length>8192||output.length+event.text.length>this.outputLimit)throw new AiError('limit')
     output+=event.text;this.publish({...this.value,phase:'streaming',output})
    }else if(event.type==='done'){
     output=output.replaceAll('\r\n','\n').replaceAll('\r','\n');if(!output.trim()||!aiText(output))throw new AiError('protocol')
     if(!this.adapter.valid(task.target))throw new AiError('stale')
     this.publish({...this.value,phase:'ready',output});return
    }else throw new AiError('protocol')
   }
  }catch(error){if(this.current(task)){const code=aiCode(error);task.abort.abort(new AiError(code));this.publish({...this.value,phase:code==='stale'?'stale':'failed',error:code});try{this.options.onError?.(code)}catch{}}}
  finally{clearTimeout(timer);try{void Promise.resolve(iterator?.return?.()).catch(()=>{})}catch{/* A provider that ignores cancellation cannot block the UI. */}}
 }
 accept=(requestId:string):Promise<boolean>=>{
  const task=this.task
  if(!task||task.id!==requestId)return Promise.resolve(false)
  if(this.value.phase==='accepted')return Promise.resolve(true)
  if(task.apply)return task.apply
  if(this.value.phase!=='ready'||task.target===undefined||!task.request||!this.current(task))return Promise.resolve(false)
  const output=this.value.output,target=task.target,request=task.request
  task.apply=Promise.resolve().then(async()=>{
   if(!this.current(task))return false
   this.publish({...this.value,phase:'applying'})
   const timer=setTimeout(()=>{if(this.current(task))this.stop('timeout','failed')},this.timeout)
   try{
    await abortable(this.adapter.authorize(target,task.abort.signal),task.abort.signal)
    if(!this.current(task))return false
    if(!this.adapter.valid(target))throw new AiError('stale')
    this.committing=true
    try{if(!this.adapter.commit(target,output))throw new AiError('stale')}finally{this.committing=false}
    this.publish({...this.value,phase:'accepted'})
    try{this.options.onAccepted?.(Object.freeze({requestId,action:request.action,mode:request.mode,sourceDigest:request.source.digest,output}))}catch{/* Already applied; do not report a false failure or retry the mutation. */}
    return true
   }catch(error){if(this.current(task)){const code=aiCode(error);this.publish({...this.value,phase:code==='stale'?'stale':'failed',error:code})}return false}finally{clearTimeout(timer)}
  })
  return task.apply
 }
}
