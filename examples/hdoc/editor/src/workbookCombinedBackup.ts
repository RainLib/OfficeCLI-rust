import type {Session} from './api.ts'
import type {FixedDraftState} from './fixedSaveController.ts'
import type {BlankBatchState} from './workbookBlankBatch.ts'
import {parseFixedDraftBackup,serializeFixedDraft} from './fixedDraftJournal.ts'
import {parseBlankBatchBackup,serializeBlankBatchBackup} from './workbookBlankBatchBackup.ts'

// A single file is deliberately bounded independently of device quota.
export const workbookCombinedBackupLimit=32*1024*1024
export function hasFixedWorkbookDraft(state:FixedDraftState){return !!(state.texts.length||state.images.length||state.attempt||state.workbookBuffer||state.uploadInterrupted||state.blankAttempt||state.blankInput)}
export function serializeWorkbookCombinedBackup(session:Session,source:string,base:string,fixed:FixedDraftState,batches:readonly BlankBatchState[]){
 if(session.format!=='xlsx'||!session.userId||batches.length>64)throw Error('invalid workbook backup')
 if(!hasFixedWorkbookDraft(fixed)&&!batches.length)throw Error('empty workbook backup')
 const fixedRaw=serializeFixedDraft(session,fixed,source,base)
 parseFixedDraftBackup(fixedRaw,session,source,base)
 const value={schemaVersion:'hcd-workbook-backup/1',fixed:JSON.parse(fixedRaw),batches:batches.map(batch=>JSON.parse(serializeBlankBatchBackup(batch,session,source,base)))}
 const raw=JSON.stringify(value);if(new TextEncoder().encode(raw).byteLength>workbookCombinedBackupLimit)throw Error('workbook backup too large')
 return raw
}
export function parseWorkbookCombinedBackup(raw:string,session:Session,source:string,base:string){
 if(session.format!=='xlsx'||!session.userId||raw.length>workbookCombinedBackupLimit||new TextEncoder().encode(raw).byteLength>workbookCombinedBackupLimit)throw Error('invalid workbook backup')
 let value:any;try{value=JSON.parse(raw)}catch{throw Error('invalid workbook backup')}
 if(!value||value.schemaVersion!=='hcd-workbook-backup/1'||value.fixed?.schemaVersion!=='hcd-fixed-recovery/2'||!Array.isArray(value.batches)||value.batches.length>64)throw Error('invalid workbook backup')
 const fixedRaw=JSON.stringify(value.fixed),fixed=parseFixedDraftBackup(fixedRaw,session,source,base)
 const batches:string[]=value.batches.map((item:unknown)=>{const part=JSON.stringify(item);parseBlankBatchBackup(part,session,source,base);return part})
 if(!hasFixedWorkbookDraft(fixed)&&!batches.length)throw Error('empty workbook backup')
 return {fixedRaw,fixed,batches}
}
/** Validation precedes all writes. Separate device databases cannot share an
 * atomic transaction: callers must preserve the file and report uncertainty
 * if any staging step fails. Existing importers handle exact duplicates. */
export async function stageWorkbookCombinedBackup(bundle:ReturnType<typeof parseWorkbookCombinedBackup>,fixed:(raw:string)=>Promise<unknown>,batch:(raw:string)=>Promise<unknown>,started:()=>void){
 if(hasFixedWorkbookDraft(bundle.fixed)){started();await fixed(bundle.fixedRaw)}
 for(const raw of bundle.batches){started();await batch(raw)}
}
