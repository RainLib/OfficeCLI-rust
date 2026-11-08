import {Extension} from '@tiptap/core'
import type * as Y from 'yjs'
import type {Awareness} from 'y-protocols/awareness'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {SemanticStructureIdentity} from './semanticStructureIdentity.ts'
import {semanticStructureBinding} from './semanticStructureBinding.ts'
import {semanticStructureCarets,type StructureUser} from './semanticStructureCarets.ts'
type Options={document:Y.Doc|null;awareness:Awareness|null;user:StructureUser|null;inlineContainers?:true;canWrite:()=>boolean;onError:(cause:unknown)=>void}
/** Configure only after negotiating a structural room. The host retains the
 * history/permission lifecycle; the extension does not initialize shared data. */
export const SemanticStructureCollaboration=Extension.create<Options>({
 name:'hcdSemanticStructureCollaboration',priority:50,
 addOptions(){return{document:null,awareness:null,user:null,canWrite:()=>false,onError:()=>{}}},
 addExtensions(){return[SemanticStructureIdentity]},
 addStorage(){return{store:null as SemanticBlockStore|null}},
 addProseMirrorPlugins(){
  if(!this.options.document)throw new Error('Structural collaboration document is required')
  const store=new SemanticBlockStore(this.options.document,this.editor.schema,undefined,this.options.inlineContainers?{inlineContainers:true}:{});this.storage.store=store
  const plugins=[semanticStructureBinding(store,this.options)]
  if(this.options.awareness&&this.options.user)plugins.push(semanticStructureCarets(store,this.options.awareness,this.options.user))
  return plugins
 },
})
