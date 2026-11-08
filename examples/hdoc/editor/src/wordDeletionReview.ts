import * as Y from 'yjs'
import {resolveDeletionReview,type DeletionReview} from './deletionReview.ts'
import {WordRegionStore,type WordRegionProjection} from './wordRegionStore.ts'
import {wordRoomGuard} from './wordRoomGuard.ts'
import {wordCanonicalSources} from './wordCanonicalSources.ts'
import {wordImageRegions} from './wordImages.ts'

/** Validate the exact review against a clone and the same regional admission
 * rules before publishing a single local Yjs transaction. */
export function resolveWordDeletionReview(model:WordRegionStore,projection:WordRegionProjection,expected:Pick<DeletionReview,'key'|'receipt'|'snapshot'>,choice:'restore'|'delete'){
 if(projection.documentId!==model.documentId||projection.flowLayoutHash!==model.layoutState().layoutHash)throw Error('deletion-review-changed')
 const original=Y.encodeStateAsUpdate(model.document),vector=Y.encodeStateVector(model.document),candidateDoc=new Y.Doc({gc:false}),canonicalDoc=new Y.Doc({gc:false})
 let guard:ReturnType<typeof wordRoomGuard>|undefined
 try{
  Y.applyUpdate(candidateDoc,original)
  const layout=model.layoutState(),candidate=new WordRegionStore(candidateDoc,model.schema,model.documentId,layout.layout,layout.layoutHash)
  const canonical=new WordRegionStore(canonicalDoc,model.schema,model.documentId,projection.flowLayout,projection.flowLayoutHash);canonical.initialize(projection)
  const sources=wordCanonicalSources(canonical),images=wordImageRegions(projection)
  guard=wordRoomGuard(model,id=>images.get(id),sources)
  resolveDeletionReview(candidate.structure,expected,choice)
  candidate.capture()
  guard.accept(Y.encodeStateAsUpdate(candidateDoc,vector))
  // No await between preflight and commit: the reviewed snapshot is checked
  // again by resolveDeletionReview in the live document.
  resolveDeletionReview(model.structure,expected,choice)
 }finally{guard?.destroy();candidateDoc.destroy();canonicalDoc.destroy()}
}
