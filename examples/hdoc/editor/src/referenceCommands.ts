import type {Editor} from '@tiptap/core'
import {NodeSelection} from '@tiptap/pm/state'
import {readInlineReference,type InlineReference} from './inlineReference.ts'
import {documentReferences,referenceEditIndex,resolveReferenceEdit} from './referenceEdits.ts'
import type {MentionCandidate} from './mentionSuggestion.ts'
import type {SemanticBlockStore} from './semanticBlockStore.ts'
import type {NodeExtensionRegistry} from './extensionRegistry.ts'
import type {InlineContainerRegistry} from './inlineContainerRegistry.ts'
import {readInlineContainerPayload} from './inlineContainerPayload.ts'
const same=(a:InlineReference,b:InlineReference)=>a.mentionId===b.mentionId&&a.target.kind===b.target.kind&&a.target.id===b.target.id&&a.snapshot.label===b.snapshot.label
export function canEditReference(editor:Editor|null,registry:NodeExtensionRegistry,mentionId:string,inlineRegistry?:Pick<InlineContainerRegistry,'resolve'>){
 if(!editor||editor.isDestroyed||!editor.isEditable)return false
 const entry=documentReferences(editor.state.doc).get(mentionId);if(!entry||entry.reference.target.kind!=='person')return false
 const position=editor.state.doc.resolve(entry.position)
 for(let depth=1;depth<=position.depth;depth++){
  const parent=position.node(depth)
  if(parent.type.name==='hcdExtensionContainer'&&!registry.resolve(parent.attrs.extension))return false
  if(parent.type.name==='hcdExtensionInlineContainer'&&!inlineRegistry?.resolve(readInlineContainerPayload(parent.attrs.extension)))return false
 }
 return true
}
/** Explicit identity + exact old value; moving a cursor never retargets a new occurrence. */
export function retargetReference(editor:Editor,store:SemanticBlockStore,registry:NodeExtensionRegistry,expected:unknown,candidate:MentionCandidate,inlineRegistry?:Pick<InlineContainerRegistry,'resolve'>){
 if(editor.isDestroyed||!editor.isEditable||editor.view.composing||candidate?.kind!=='person')return false
 const before=readInlineReference(expected),current=documentReferences(editor.state.doc).get(before.mentionId)
 if(!canEditReference(editor,registry,before.mentionId,inlineRegistry))return false
 if(!current||!same(before,current.reference)||referenceEditIndex(store.document).get(before.mentionId)?.conflicted)throw new Error('reference-changed')
 const after=readInlineReference({...before,target:{kind:candidate.kind,id:candidate.id},snapshot:{label:candidate.label}})
 if(same(before,after))return after
 const node=editor.state.doc.nodeAt(current.position)!,tr=editor.state.tr.setNodeMarkup(current.position,undefined,{...node.attrs,reference:after})
 tr.setSelection(NodeSelection.create(tr.doc,current.position));editor.view.dispatch(tr.scrollIntoView())
 const saved=documentReferences(editor.state.doc).get(before.mentionId)?.reference
 if(!saved||!same(saved,after))throw new Error('reference-changed')
 return saved
}
export function chooseReferenceCandidate(editor:Editor,store:SemanticBlockStore,registry:NodeExtensionRegistry,input:{mentionId:string;ids:readonly string[];candidateId:string},inlineRegistry?:Pick<InlineContainerRegistry,'resolve'>){
 if(editor.isDestroyed||!editor.isEditable||editor.view.composing||!canEditReference(editor,registry,input.mentionId,inlineRegistry))return false
 const candidate=referenceEditIndex(store.document).get(input.mentionId)?.candidates.find(value=>value.id===input.candidateId)
 if(candidate?.after.target.kind!=='person')return false
 return resolveReferenceEdit(store.document,input.mentionId,input.ids,input.candidateId,store.origin)
}
