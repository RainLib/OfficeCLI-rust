import type {Editor} from '@tiptap/core'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
import {canEditReference} from './referenceCommands.ts'
import {readReferenceSnapshot} from './referenceIndex.ts'
import {referenceEditIndex,resolveReferenceValue} from './referenceEdits.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'

export type SavedReferenceChoice={mentionId:string;ids:readonly string[];revision:number}
type Options={documentId:string;signal:AbortSignal;ready:()=>boolean;stopCapturing:()=>void;read:(route:string,signal:AbortSignal)=>Promise<unknown>;inlineRegistry?:Pick<InlineContainerRegistry,'resolve'>}
/** Fetch the exact reviewed revision, bracketed by head reads. The final native
 * checkpoint still uses CAS: a head advancing after this read cannot be replaced. */
export async function keepSavedReference(editor:Editor,store:SemanticBlockStore,registry:NodeExtensionRegistry,input:SavedReferenceChoice,options:Options){
 input=structuredClone(input)
 const signal=AbortSignal.any([options.signal,AbortSignal.timeout(15000)])
 const check=()=>{signal.throwIfAborted();if(!options.ready()||!canEditReference(editor,registry,input.mentionId,options.inlineRegistry)||editor.view.composing)throw new Error('reference-changed');const group=referenceEditIndex(store.document).get(input.mentionId);if(!group?.conflicted||JSON.stringify(group.ids)!==JSON.stringify(input.ids))throw new Error('reference-changed')}
 check()
 if(!Number.isSafeInteger(input.revision)||input.revision<0)throw new Error('reference-changed')
 const head=async()=>{const value=await options.read('/revisions?limit=1',signal) as {headRevision?:unknown};check();if(value?.headRevision!==input.revision)throw new Error('reference-saved-changed')}
 await head()
 const snapshot=readReferenceSnapshot(await options.read(`/references?revision=${input.revision}`,signal),options.documentId,input.revision);check()
 const saved=snapshot.items.find(item=>item.reference.mentionId===input.mentionId)?.reference
 if(saved?.target.kind!=='person')throw new Error('reference-saved-changed')
 await head();check()
 options.stopCapturing()
 try{return resolveReferenceValue(store.document,input.mentionId,input.ids,saved,store.origin)}finally{options.stopCapturing()}
}
