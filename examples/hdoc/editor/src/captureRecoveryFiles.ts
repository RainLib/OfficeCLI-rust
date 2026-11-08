import * as Y from 'yjs'
import type {ResourceNodePayload} from './nodeResourceModel.ts'
import type {WordNodeResourceDraft} from './wordNodeResources.ts'
import type {SemanticImageChoice} from './semanticImageFiles.ts'

/** Capture all private file journals and the document under their shared
 * device lock. In-memory file preparation must have settled first. */
export async function captureRecoveryFiles(input:{document:Y.Doc;signal:AbortSignal;withLock:<T>(work:()=>Promise<T>)=>Promise<T>;busy:()=>boolean;nodeFiles:()=>Promise<WordNodeResourceDraft<ResourceNodePayload>[]>;images:()=>Promise<SemanticImageChoice[]>}){
 return input.withLock(async()=>{
  input.signal.throwIfAborted();if(input.busy())throw new Error('recoveryArchiveFileBusy')
  const [files,images]=await Promise.all([input.nodeFiles(),input.images()]);input.signal.throwIfAborted();if(input.busy())throw new Error('recoveryArchiveFileBusy')
  const document=new Y.Doc({gc:false});try{Y.applyUpdate(document,Y.encodeStateAsUpdate(input.document));input.signal.throwIfAborted();if(input.busy())throw new Error('recoveryArchiveFileBusy');return{document,files,images}}catch(error){document.destroy();throw error}
 })
}
