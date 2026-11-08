export type AiMode='replace'|'insert'
export type AiAction={id:string;label:string|Readonly<Record<string,string>>;mode:AiMode;instruction?:string;aliases?:readonly string[]}
export type AiContext={documentId:string;format:string;revision:number|null;locale:string;source:{text:string;digest:string};before:string;after:string}
export type AiRequest=AiContext&{version:'hcd-ai/1';requestId:string;action:string;mode:AiMode;instruction:string}
export type AiErrorCode='unavailable'|'invalid-target'|'stale'|'denied'|'network'|'rate-limited'|'protocol'|'limit'|'timeout'|'cancelled'
export type AiEvent={version:'hcd-ai/1';requestId:string;seq:number}&({type:'delta';text:string}|{type:'done'}|{type:'error';code:AiErrorCode})
/** Implement on the authenticated host server; never put provider credentials in document data. */
export type AiProvider={generate:(request:Readonly<AiRequest>,options:{signal:AbortSignal})=>AsyncIterable<AiEvent>|Promise<AsyncIterable<AiEvent>>}
export type AiPhase='idle'|'requesting'|'streaming'|'ready'|'applying'|'accepted'|'cancelled'|'failed'|'stale'|'dismissed'
export type AiSnapshot={phase:AiPhase;requestId:string|null;output:string;source:string;error?:AiErrorCode;action?:string;mode?:AiMode;instruction?:string}
export type AiLimits={timeoutMs?:number;maxOutput?:number;maxEvents?:number}
export type AiAccepted={requestId:string;action:string;mode:AiMode;sourceDigest:string;output:string}
export type AiAutocompleteOptions={enabled?:boolean;delayMs?:number;cooldownMs?:number;minPrefix?:number;maxOutput?:number;instruction?:string}
export type AiExtensions={autocomplete?:AiAutocompleteOptions|false;provider?:AiProvider;actions?:readonly AiAction[];limits?:AiLimits;onAccepted?:(event:Readonly<AiAccepted>)=>void;onError?:(code:AiErrorCode)=>void}
/** Positions belong to the adapter and are never transmitted to the model. */
export type AiAdapter<T>={
 prepare:(mode:AiMode,signal:AbortSignal)=>Promise<{target:T;context:AiContext}>
 valid:(target:T)=>boolean
 authorize:(target:T,signal:AbortSignal)=>Promise<void>
 /** Synchronous final mutation, after the controller's last cancellation check. */
 commit:(target:T,text:string)=>boolean
 locate?:(target:T)=>boolean
}
