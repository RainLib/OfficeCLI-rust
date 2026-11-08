import type {Session} from './api.ts'
import {readDocumentHead} from './fixedExportGuard.ts'

type RegionalExportState={saved:boolean;ready:boolean;revision:number|null}
type Head={revision:number;sourceSha256:string}
const current=(state:RegionalExportState,revision:number)=>state.ready&&state.saved&&state.revision===revision

/** The room receipt and both resource checks must still cover the exported
 * version after every asynchronous read. */
export async function regionalExportHead(session:Session,revision:number,state:()=>RegionalExportState,boundary:()=>Promise<void>,signal:AbortSignal,expected?:Head):Promise<Head>{
 if(!current(state(),revision))throw new Error('regional-export-changed')
 await boundary()
 if(!current(state(),revision))throw new Error('regional-export-changed')
 const head=await readDocumentHead(session,signal)
 if(!current(state(),revision)||head.revision!==revision||expected&&head.sourceSha256!==expected.sourceSha256)throw new Error('regional-export-changed')
 return head
}
