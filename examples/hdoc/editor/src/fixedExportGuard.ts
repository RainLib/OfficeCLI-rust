import {api,type Session} from './api.ts'
import {readExportPreflight} from './exportPreflight.ts'

/** Check both the identity and latest revision of the authenticated document. */
export async function readDocumentHead(session:Session,signal:AbortSignal):Promise<{revision:number;sourceSha256:string}>{
 const value=await readExportPreflight(inner=>api(session,'/head',{signal:inner,cache:'no-store'}),signal,30_000)
 if(!value||typeof value!=='object')throw new Error('invalid-document-head')
 const head=value as {documentId?:unknown;revision?:unknown;sourceSha256?:unknown}
 if(head.documentId!==session.documentId||typeof head.sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(head.sourceSha256)||!Number.isSafeInteger(head.revision)||(head.revision as number)<0)throw new Error('invalid-document-head')
 return {revision:head.revision as number,sourceSha256:head.sourceSha256}
}
export async function fixedDocumentHead(session:Session,sourceHash:string,signal:AbortSignal):Promise<number>{
 const head=await readDocumentHead(session,signal)
 if(head.sourceSha256!==sourceHash)throw new Error('invalid-document-head')
 return head.revision
}

export async function verifyFixedDownload(revision:number,currentRevision:()=>number|null,blocked:()=>boolean,serverHead:()=>Promise<number>):Promise<void>{
 if(blocked()||currentRevision()!==revision)throw new Error('fixed-export-changed')
 const head=await serverHead()
 if(blocked()||currentRevision()!==revision||head!==revision)throw new Error('fixed-export-changed')
}
