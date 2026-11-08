/** Prepare and install a replacement only behind the same exclusive gate.
 * The host must disconnect old connections and attach the replacement in
 * install(), and must gate every connection and packet until release.
 * A factory may allocate a staged host before install(). uninstall() must
 * therefore clean every returned candidate, including pre-install failures,
 * and assertUninstalled() must prove absence even if install() never ran.
 * A factory that rejects without returning a candidate owns that cleanup. */
import * as Y from 'yjs'
import {RoomMigrationGate} from './roomMigrationGate.ts'
import {WordSaveCoordinator} from './wordSaveCoordinator.ts'
import {WordCheckpointJournal} from './wordCheckpointJournal.ts'
import {WordRoomRetirements} from './wordRoomRetirement.ts'
import {requireTopologyMember,type WordTopologyMember} from './wordTopologyAuthority.ts'
import type {WordPendingLink} from './wordLinkProof.ts'
import type {WordLayoutPending,WordPendingStory} from './wordCheckpointJournal.ts'

type Lease={assert:()=>void}
type Actor={userId:string;displayName:string}
type Action={operation:'word-layout-change';pending:WordLayoutPending;authorize:(pending:Readonly<WordLayoutPending>)=>Promise<WordTopologyMember>}|{operation:'word-story-unlink';pending:WordPendingStory;authorize:(pending:Readonly<WordPendingStory>)=>Promise<WordTopologyMember>}|{operation:'word-story-link';pending:WordPendingLink;authorize:(pending:Readonly<WordPendingLink>)=>Promise<WordTopologyMember>}|{operation:'word-layout-room-save';actor:Actor;authorize:(actor:Readonly<Actor>)=>Promise<WordTopologyMember>}
type Options=Action&{mode?:'experimental-draft'|'layout-live';gate:RoomMigrationGate;previous:WordSaveCoordinator;journal:WordCheckpointJournal;lease:Lease;request:(route:string)=>Promise<Response>;create:()=>Promise<WordSaveCoordinator>;install:(next:WordSaveCoordinator)=>Promise<void>;assertInstalled:(next:WordSaveCoordinator)=>void;uninstall:(next:WordSaveCoordinator)=>Promise<void>;assertUninstalled:(next:WordSaveCoordinator)=>void;retirement?:{registry:WordRoomRetirements;name:string}}
const installing=new WeakMap<RoomMigrationGate,Set<string>>()
type Orphan={candidate:WordSaveCoordinator;uninstall:Options['uninstall'];assertUninstalled:Options['assertUninstalled']}
const orphans=new WeakMap<RoomMigrationGate,Map<string,Orphan>>()
async function removeOrphan(orphan:Orphan){
 try{await orphan.uninstall(orphan.candidate);const proof=orphan.assertUninstalled(orphan.candidate) as unknown;if(proof&&typeof (proof as PromiseLike<unknown>).then==='function'){void Promise.resolve(proof).catch(()=>{});throw new Error('word-layout-uninstall-proof-must-be-synchronous')}}catch(error){throw new Error('word-layout-install-rollback-uncertain',{cause:error})}
}
export async function installLayoutDraftRoom(options:Options){
 const {gate,operation,previous,journal,lease,request,create,install,assertInstalled,uninstall,assertUninstalled,retirement}=options
 const mode=options.mode??'experimental-draft'
 if(mode!=='experimental-draft'&&mode!=='layout-live'||mode==='layout-live'&&!previous.isLayoutAwareLive())throw new Error('word-layout-replacement-mode')
 const action=operation==='word-layout-room-save'?structuredClone(options.actor):structuredClone(options.pending)
 const identity=operation==='word-layout-room-save'?JSON.stringify([(action as Actor)?.userId,(action as Actor)?.displayName]):JSON.stringify(action)
 const id=journal.scope.documentId
 let active=installing.get(gate);if(!active){active=new Set();installing.set(gate,active)}
 let detached=orphans.get(gate);if(!detached){detached=new Map();orphans.set(gate,detached)}
 if(active.has(id))throw new Error('word-layout-install-busy');active.add(id)
 try{
 const guard=()=>{lease.assert();if(!gate.readyToReleaseIdentity(id,operation,identity))throw new Error('word-layout-room-active');if(!retirement?.registry.retired(retirement.name,previous,gate,journal))previous.assertTopologyHeld()}
 const authorizeMember=async()=>{if(options.operation==='word-layout-change'){const pending=action as WordLayoutPending,member=await options.authorize(structuredClone(pending));guard();requireTopologyMember(member,pending.actor,pending.request.actor)}else if(options.operation==='word-story-unlink'){const pending=action as WordPendingStory,member=await options.authorize(structuredClone(pending));guard();requireTopologyMember(member,pending.actor,pending.request.actor)}else if(options.operation==='word-story-link'){const pending=action as WordPendingLink,member=await options.authorize(structuredClone(pending));guard();requireTopologyMember(member,pending.actor,pending.request.actor)}else{const actor=action as Actor,member=await options.authorize(structuredClone(actor));guard();requireTopologyMember(member,actor,actor)}}
 const json=async(route:string)=>{const response=await request(route);if(!response.ok)throw new Error(`word-layout-install:${response.status}`);return response.json()}
 guard();if(!previous.ownsJournal(journal))throw new Error('word-layout-journal-mismatch');await authorizeMember()
 const orphan=detached.get(id);if(orphan){await removeOrphan(orphan);detached.delete(id);orphan.candidate.dispose();guard()}
 const initial=await journal.load();guard();if(!initial||initial.capsule.version!==3||initial.capsule.pending)throw new Error('word-layout-pending-unresolved')
 const auth=await json('/auth');guard();if(auth.scope!=='write'||auth.collaborationEpoch!==journal.scope.epoch||auth.collaborationProtocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')
 if((await json('/revisions?limit=1')).headRevision!==initial.capsule.base.revision)throw new Error('canonical-changed')
 let next:WordSaveCoordinator|undefined
 try{
  guard();const candidate=await create();if(candidate===previous)throw new Error('word-layout-replacement-is-previous');next=candidate;guard()
  const latest=await journal.load();guard()
  if(!latest||latest.capsule.version!==3||latest.capsule.pending||!next.ownsJournal(journal)||(mode==='layout-live'?!next.isLayoutAwareLive()||next.isExperimentalLayoutDraftOnly()||next.isAutoSaveEnabled():!next.isExperimentalLayoutDraftOnly())||next.state().revision!==latest.capsule.base.revision||next.state().problem||!Buffer.from(Y.encodeStateAsUpdate(next.model.document)).equals(Buffer.from(latest.capsule.document,'base64')))throw new Error('word-layout-replacement-invalid')
  if((await json('/revisions?limit=1')).headRevision!==latest.capsule.base.revision)throw new Error('canonical-changed')
  guard();await install(next);guard()
  const final=await journal.load();guard();if(!final||final.hash!==latest.hash||!Buffer.from(Y.encodeStateAsUpdate(next.model.document)).equals(Buffer.from(final.capsule.document,'base64')))throw new Error('word-layout-replacement-changed')
  const confirmedAuth=await json('/auth');guard();if(confirmedAuth.scope!=='write'||confirmedAuth.collaborationEpoch!==journal.scope.epoch||confirmedAuth.collaborationProtocol!=='hcd-word-regions/2')throw new Error('word-authority-changed')
  if((await json('/revisions?limit=1')).headRevision!==final.capsule.base.revision)throw new Error('canonical-changed');guard();await authorizeMember();const assertion=assertInstalled(next) as unknown
  if(assertion&&typeof (assertion as PromiseLike<unknown>).then==='function'){void Promise.resolve(assertion).catch(()=>{});throw new Error('word-layout-install-proof-must-be-synchronous')}guard()
  if(!Buffer.from(Y.encodeStateAsUpdate(next.model.document)).equals(Buffer.from(final.capsule.document,'base64'))||next.state().problem)throw new Error('word-layout-replacement-changed')
  gate.release(id,operation);retirement?.registry.forgetRetired(retirement.name,previous,gate,journal);return next
 }catch(error){
  next?.freeze()
  if(next){const orphan={candidate:next,uninstall,assertUninstalled};detached.set(id,orphan);await removeOrphan(orphan);detached.delete(id);next.dispose()}
  throw error
 }
 }finally{active.delete(id)}
}
