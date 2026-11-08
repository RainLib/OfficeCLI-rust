/** Server-only seed/host lifecycle. The same journal and lease callbacks must
 * survive the merge into Hocuspocus's receiving document. A staged host passes
 * autoSave:false and an admission assertion; activation remains the installer's
 * responsibility. The binding owns its seed, never the receiving host Y.Doc. */
import * as Y from 'yjs'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'

type Settings=Omit<Parameters<typeof WordSaveCoordinator.open>[0],'document'|'autoSave'|'actorForOrigin'|'broadcast'>
type Attachment=Pick<Parameters<typeof WordSaveCoordinator.open>[0],'actorForOrigin'|'broadcast'|'uploadActorAuthorized'|'uploadRequest'>&{autoSave:boolean}
type Phase='new'|'loading'|'loaded'|'attaching'|'attached'|'closed'
export class WordRoomBinding{
 private phase:Phase='new'
 private seed:WordSaveCoordinator|undefined
 private seedDocument:Y.Doc|undefined
 private owner:WordSaveCoordinator|undefined
 constructor(private readonly settings:Settings,private readonly assertAdmission:()=>void=()=>{}){}
 get journal(){return this.settings.journal}
 private assertOwnership=()=>{if(this.phase==='closed')throw new Error('word-host-binding-closed');this.settings.assertOwnership?.()}
 private guard(phase:Phase){
  if(this.phase!==phase)throw new Error('word-host-binding-phase')
  this.assertOwnership()
  const proof=this.assertAdmission() as unknown
  if(proof&&typeof (proof as PromiseLike<unknown>).then==='function'){void Promise.resolve(proof).catch(()=>{});throw new Error('word-host-admission-proof-must-be-synchronous')}
 }
 private baseline(owner:WordSaveCoordinator){
  if(this.settings.layoutAwareLive&&['canonical-changed','word-owner-lost','word-journal-changed','word-authority-changed'].includes(owner.state().problem??''))throw new Error('word-layout-baseline-unavailable')
 }
 async load():Promise<Y.Doc>{
  if(this.phase!=='new')throw new Error('word-host-binding-phase')
  this.phase='loading';const document=new Y.Doc();this.seedDocument=document
  try{
   this.guard('loading');const saved=await this.journal.load();this.guard('loading')
   const seed=await WordSaveCoordinator.open({...this.settings,document,assertOwnership:this.assertOwnership,autoSave:false,actorForOrigin:undefined,broadcast:undefined});this.seed=seed;this.guard('loading')
   // Only a previously captured request may be settled here. Ordinary retained
   // drafts must not be silently saved while creating a replica for clients.
   if(this.settings.layoutAwareLive&&saved?.capsule.pending){await seed.save();this.guard('loading');if((await this.journal.load())?.capsule.pending)throw new Error('word-layout-pending-unresolved');this.guard('loading')}
   this.baseline(seed);this.phase='loaded';return document
  }catch(error){this.close();throw error}
 }
 async attach(document:Y.Doc,attachment:Attachment):Promise<WordSaveCoordinator>{
  // A duplicate call must not dispose an already active owner.
  if(this.phase!=='loaded')throw new Error('word-host-binding-phase')
  this.phase='attaching'
  try{
   this.guard('attaching');if(document===this.seedDocument||document.isDestroyed)throw new Error('word-host-receiving-document-invalid')
   this.seed?.dispose();this.seed=undefined
   const owner=await WordSaveCoordinator.open({...this.settings,document,assertOwnership:this.assertOwnership,...attachment});this.owner=owner;this.guard('attaching')
   this.baseline(owner);this.phase='attached';return owner
  }catch(error){this.close();throw error}
  finally{this.destroySeed()}
 }
 private destroySeed(){this.seed?.dispose();this.seed=undefined;this.seedDocument?.destroy();this.seedDocument=undefined}
 /** Closing during an asynchronous load/attach also fences the callbacks held
  * by that in-flight open. Its continuation cannot publish a late owner. */
 close(){this.phase='closed';this.destroySeed();this.owner?.dispose();this.owner=undefined}
}
