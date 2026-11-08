import {api,type Session} from './api.ts'
import {readExportPreflight} from './exportPreflight.ts'

export async function workbookServerHead(session:Session,sourceHash:string,signal:AbortSignal):Promise<number>{
 const value=await readExportPreflight(inner=>api(session,'/head',{signal:inner,cache:'no-store'}),signal,30_000)
 if(!value||typeof value!=='object')throw new Error('invalid-workbook-head')
 const head=value as {documentId?:unknown;revision?:unknown;sourceSha256?:unknown}
 if(head.documentId!==session.documentId||head.sourceSha256!==sourceHash||!Number.isSafeInteger(head.revision)||(head.revision as number)<0)throw new Error('invalid-workbook-head')
 return head.revision as number
}

/** The downloaded revision must match the latest observed and queried head. */
export async function verifyWorkbookDownload(revision:number,currentRevision:()=>number|null,blocked:()=>boolean,imagesPending:()=>Promise<boolean>,serverHead:()=>Promise<number>):Promise<void>{
 const pending=await imagesPending()
 if(pending||blocked()||currentRevision()!==revision)throw new Error('workbook-export-changed')
 const head=await serverHead()
 if(blocked()||currentRevision()!==revision||head!==revision)throw new Error('workbook-export-changed')
}
