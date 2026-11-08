import {inlineContainerEditStatus} from './inlineContainerEdits.ts'
import type * as Y from 'yjs'
import type {Node as PmNode} from '@tiptap/pm/model'
import {documentReferences,referenceEditIndex} from './referenceEdits.ts'
import {nodeEditStatus} from './extensionEdits.ts'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {deletionReviews} from './deletionReview.ts'

/** Read live metadata at the decision boundary. A body digest alone cannot
 * distinguish an unchanged saved atom from a conflicted reference placeholder. */
export function businessDraftProblem(document:Y.Doc,doc:PmNode,provided?:SemanticBlockStore){
 if(provided&&(provided.document!==document||provided.schema!==doc.type.schema))throw new Error('business-draft-store-scope')
 const structure=provided??new SemanticBlockStore(document,doc.type.schema)
 if(structure.initialized&&deletionReviews(structure).length)return 'deletion-drafts-conflict'
 const active=documentReferences(doc)
 if([...referenceEditIndex(document)].some(([id,group])=>active.has(id)&&group.conflicted))return 'reference-drafts-conflict'
 const nodes=nodeEditStatus(document,doc)
 const containers=structure.flow.containers?inlineContainerEditStatus(document,doc):undefined
 return nodes.conflicts.length||containers?.conflicts.length?'node-drafts-conflict':nodes.pending.length||containers?.pending.length?'node-drafts-not-ready':undefined
}
