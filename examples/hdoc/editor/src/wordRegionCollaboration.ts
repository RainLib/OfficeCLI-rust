import {Extension} from '@tiptap/core'
import type {Awareness} from 'y-protocols/awareness'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {semanticStructureBinding,type StructureBindingStore} from './semanticStructureBinding.ts'
import {semanticStructureCarets,type StructureUser,type StructureCursorContext} from './semanticStructureCarets.ts'
import {WordRegionStore,WordRegionBoundary} from './wordRegionStore.ts'
type Options={model:WordRegionStore|null;regionId:string;awareness:Awareness|null;user:StructureUser|null;canWrite:()=>boolean;canMaintain?:()=>boolean;onError:(cause:unknown)=>void;cursorContext?:()=>StructureCursorContext|undefined}
/** Every editor projects one native region from the same permanent Yjs store.
 * The boundary nodes remain outside the editable ProseMirror document. */
export const WordRegionCollaboration=Extension.create<Options>({
 name:'hcdWordRegionCollaboration',priority:50,
 addOptions(){return{model:null,regionId:'',awareness:null,user:null,canWrite:()=>false,onError:()=>{}}},
 addStorage(){return{store:null as StructureBindingStore|null}},
 addExtensions(){return[SemanticStructureIdentity,WordRegionBoundary]},
 addProseMirrorPlugins(){
  const model=this.options.model;if(!model)throw new Error('word-region-model-required')
  const initial=model.layoutState(),scoped=new WordRegionStore(model.document,this.editor.schema,model.documentId,initial.layout,initial.layoutHash),view=scoped.view(this.options.regionId)
  // NodeType identities belong to this editor's schema. Share permanent Yjs
  // carriers, never foreign-schema PM nodes. Layouts advance only after the
  // controller has verified an immutable native projection.
  const ensure=()=>{const current=model.layoutState();if(scoped.layoutState().layoutHash!==current.layoutHash)scoped.syncLayout(current.layout,current.layoutHash)}
  const store={...view,get initialized(){ensure();return view.initialized},project:()=>{ensure();return view.project()},blocks:()=>{ensure();return view.blocks()}}
  this.storage.store=store
  const plugins=[semanticStructureBinding(store,this.options)];if(this.options.awareness&&this.options.user)plugins.push(semanticStructureCarets(store,this.options.awareness,this.options.user,undefined,this.options.regionId,this.options.cursorContext));return plugins
 },
})
