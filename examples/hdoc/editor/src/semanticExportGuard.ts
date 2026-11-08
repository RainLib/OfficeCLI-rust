import type {Session} from './api.ts'
import {readDocumentHead} from './fixedExportGuard.ts'

type Anchor={revision:number;sourceSha256:string;generation:number}

/** Inspect the local CRDT generation and file journal around each async read. */
export async function semanticExportHead(session:Session,revision:number,generation:number,currentGeneration:()=>number,blocked:()=>boolean,filesPending:()=>Promise<boolean>,signal:AbortSignal,expected?:Anchor):Promise<Anchor>{
 const unchanged=()=>currentGeneration()===generation&&!blocked()
 if(!unchanged()||await filesPending()||!unchanged())throw new Error('semantic-export-changed')
 const head=await readDocumentHead(session,signal)
 if(!unchanged()||head.revision!==revision||expected&&head.sourceSha256!==expected.sourceSha256)throw new Error('semantic-export-changed')
 return {...head,generation}
}
