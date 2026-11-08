import type {Session} from './api.ts'
import {sameBlankBatchAttempt,validateBlankBatchInput,type BlankBatchState} from './workbookBlankBatch.ts'
import {validateBlankCreateAttempt} from './workbookBlankSave.ts'

export const blankBatchBackupLimit=12*1024*1024
function service(session:Session,base:string){const url=new URL(session.apiUrl||'/v1/documents',base);if(url.username||url.password||url.search||url.hash)throw new Error('invalid batch backup');return url.href.replace(/\/$/,'')}
function state(value:BlankBatchState,session:Session,source:string):BlankBatchState{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid batch backup')
 const input=validateBlankBatchInput(value.input,session,source),attempt=value.attempt===null?null:validateBlankCreateAttempt(value.attempt,session,source)
 if(attempt&&!sameBlankBatchAttempt(input,attempt))throw new Error('invalid batch backup')
 return{input,attempt}
}
export function serializeBlankBatchBackup(value:BlankBatchState,session:Session,source:string,base:string){
 if(!session.userId)throw new Error('invalid batch backup')
 const checked=state(value,session,source),schemaVersion=checked.input.cells.length===1?'hcd-blank-batch-backup/2':'hcd-blank-batch-backup/1'
 const result=JSON.stringify({schemaVersion,owner:session.userId,service:service(session,base),state:checked})
 if(new TextEncoder().encode(result).byteLength>blankBatchBackupLimit)throw new Error('invalid batch backup')
 return result
}
export function parseBlankBatchBackup(raw:string,session:Session,source:string,base:string):BlankBatchState{
 if(!session.userId||typeof raw!=='string'||raw.length>blankBatchBackupLimit||new TextEncoder().encode(raw).byteLength>blankBatchBackupLimit)throw new Error('invalid batch backup')
 let value:any;try{value=JSON.parse(raw)}catch{throw new Error('invalid batch backup')}
 if(!value||!['hcd-blank-batch-backup/1','hcd-blank-batch-backup/2'].includes(value.schemaVersion)||value.owner!==session.userId||value.service!==service(session,base))throw new Error('invalid batch backup')
 const checked=state(value.state,session,source)
 if((value.schemaVersion==='hcd-blank-batch-backup/1')!==(checked.input.cells.length>=2))throw new Error('invalid batch backup')
 return checked
}
