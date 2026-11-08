import * as Y from 'yjs'
/** Local runtime identity, never accepted from serialized file metadata. */
export const recoveryImportOrigin=Object.freeze({kind:'hcd-recovery-import/1'})
export function applyRecoveryUpdate(document:Y.Doc,bytes:Uint8Array,history:Y.UndoManager){
 history.stopCapturing();history.trackedOrigins.add(recoveryImportOrigin)
 try{Y.applyUpdate(document,bytes,recoveryImportOrigin)}finally{history.trackedOrigins.delete(recoveryImportOrigin);history.stopCapturing()}
}
