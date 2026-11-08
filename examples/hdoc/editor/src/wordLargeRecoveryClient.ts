import type {Session} from './api.ts'
import {wordBrowserHeaders,requireWordBrowserProtocol} from './wordBrowserProtocol.ts'
import {negotiationURL} from './protocolClient.ts'
import {wordRecoveryMaxBytes} from './wordRecoveryChunks.ts'

const hash=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes)))].map(value=>value.toString(16).padStart(2,'0')).join('')
/** Errors after dispatch have an unknown outcome; callers must keep their
 * device log and reconnect for a fresh comparison, never blindly replay. */
export async function sendWordLargeRecovery(session:Session,update:Uint8Array,baseline:Uint8Array,signal:AbortSignal){
 requireWordBrowserProtocol(session.collaborationProtocol)
 if(session.scope!=='write'||!Number.isSafeInteger(session.collaborationEpoch)||!update.length||update.length>wordRecoveryMaxBytes)throw Error('word-large-recovery-unavailable')
 signal.throwIfAborted();const [updateHash,baselineHash]=await Promise.all([hash(update),hash(baseline)]);signal.throwIfAborted()
 const response=await fetch(negotiationURL(session).replace(/\/negotiate$/,'/word-large-recovery'),{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/octet-stream',...wordBrowserHeaders(session),'X-HCD-Collaboration-Epoch':String(session.collaborationEpoch),'X-HCD-Recovery-Baseline':baselineHash,'X-HCD-Recovery-Hash':updateHash},body:Uint8Array.from(update),signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)])})
 if(!response.ok)throw Error('word-large-recovery-unavailable')
 const value=await response.json();if(value?.version!==1||value.hash!==updateHash)throw Error('word-large-recovery-unavailable')
}
