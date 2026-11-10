import {ApiError,api,type Session} from './api.ts'
import {legacyProtocol} from './collaborationProtocol.ts'

/** Narrowed view of `hcd_core::ApplyResult` (crates/hcd-core/src/types.rs).
 * Only the fields an entry needs to follow the new head are typed; the rest
 * stay opaque so future receipt fields cannot be mistaken for local state. */
export type DirectRestoreResult={documentId:string;patchId?:string;baseRevision?:number;revision:number;rootHash?:string}

export type DirectRestoreFailure='conflict'|'coordinator'|'outcome-unknown'|'failed'
export class DirectRestoreError extends Error{
	constructor(readonly status:number,readonly kind:DirectRestoreFailure,message:string){super(message);this.name='DirectRestoreError'}
}

/** `POST /restore/{revision}` (hdoc_server.rs) answers 426 for every protocol
 * except `hcd-default/1`; documents that joined a coordinator must restore
 * through their room, so the direct entry stays closed for them. */
export function directRestoreSupported(session:Session):boolean{
	return session.collaborationProtocol===undefined||session.collaborationProtocol===legacyProtocol
}

export async function submitDirectRestore(session:Session,target:number,expectedRevision:number,signal?:AbortSignal):Promise<DirectRestoreResult>{
	if(!Number.isSafeInteger(target)||target<0||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new DirectRestoreError(0,'failed','invalid-restore-request')
	let response:Response
	try{
		response=await api(session,`/restore/${target}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision}),signal})
	}catch(cause){
		if(cause instanceof ApiError&&cause.status===409)throw new DirectRestoreError(409,'conflict',cause.message)
		if(cause instanceof ApiError&&cause.status===426)throw new DirectRestoreError(426,'coordinator',cause.message)
		if(signal?.aborted)throw cause instanceof Error?cause:new DirectRestoreError(0,'failed','restore-request-aborted')
		throw new DirectRestoreError(cause instanceof ApiError?cause.status:0,'failed',cause instanceof Error?cause.message:String(cause))
	}
	// The mutation may have committed even when the response is unusable, so a
	// bad answer is an unknown outcome to verify, never a safe retry signal.
	// Parsing lives outside the transport classification for exactly this
	// reason: a committed restore whose body is truncated or swapped for an
	// HTML error page is unparseable — more unusable than a field mismatch —
	// and must land on the unknown side, not be read as a safe retry.
	let value:DirectRestoreResult
	try{value=await response.json() as DirectRestoreResult}
	catch{throw new DirectRestoreError(0,'outcome-unknown','restore-response-unparseable')}
	if(!value||typeof value!=='object'||value.documentId!==session.documentId||!Number.isSafeInteger(value.revision)||value.revision<=expectedRevision){
		throw new DirectRestoreError(0,'outcome-unknown','restore-response-invalid')
	}
	return value
}

/** The direct endpoint has no idempotent replay, so an outcome-unknown submit
 * may only be adopted as "this restore committed" when the head revision's
 * own record says so: hcd-core writes the deterministic
 * `restore-{target}-{revision}` patch id (crates/hcd-core/src/restore.rs) and
 * the coordinated path self-verifies the same shape (hdoc_restore.rs). A
 * plain save — or a restore to a different target — that merely lands on
 * comparedWith+1 fails the identity check and stays a comparison change,
 * instead of silently closing the window over content that never moved.
 * An unreadable record (missing revision, transport error, malformed body)
 * is treated as not-this-restore; the caller's abort still propagates so a
 * cancelled recheck is never mistaken for a mismatch. */
export async function committedRestoreAdvance(session:Session,target:number,head:number,signal?:AbortSignal):Promise<boolean>{
	let value:{documentId?:string;revision?:number;patchId?:string}
	try{value=await (await api(session,`/revisions/${head}`,{signal})).json() as {documentId?:string;revision?:number;patchId?:string}}
	catch(cause){if(signal?.aborted)throw cause;return false}
	return !!value&&value.documentId===session.documentId&&value.revision===head&&value.patchId===`restore-${target}-${head}`
}
