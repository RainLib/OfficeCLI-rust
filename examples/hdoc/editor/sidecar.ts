import { SemanticSaveCoordinator } from './src/semanticSaveCoordinator.ts'
import {WordSaveCoordinator,type WordSaveStatus} from './src/wordSaveCoordinator.ts'
import {WordCheckpointJournal} from './src/wordCheckpointJournal.ts'
import {recoverPreparedWordCheckpoint} from './src/wordCheckpointRecovery.ts'
import {saveStoppedWordDraft} from './src/wordStoppedSave.ts'
import {inspectStoppedWordDraft,inspectStaleWordDraft,downloadStaleWordDraftText} from './src/wordStoppedDraftReview.ts'
import {inspectStoppedWordLayout,applyStoppedWordLayout} from './src/wordStoppedLayout.ts'
import {previewStoppedWordStory,applyStoppedWordStory} from './src/wordStoppedStory.ts'
import {validContributor} from './src/referenceAuthors.ts'
import {recoverCommittedWordStory,submitPreparedWordStory,promoteStoppedWordStory} from './src/wordStoryRecovery.ts'
import {submitPreparedWordLayout,promoteRecoveredWordLayout} from './src/wordLayoutRecovery.ts'
import {wordUploadHttp} from './src/wordUploadHttp.ts'
import {wordLargeRecoveryHttp} from './src/wordLargeRecoveryHttp.ts'
import type {WordUploadActor} from './src/wordUploads.ts'
import {wordRoomGuard} from './src/wordRoomGuard.ts'
import {WordRoomRetirements,retireWordRoom} from './src/wordRoomRetirement.ts'
import {WordRoomBinding} from './src/wordRoomBinding.ts'
import {WordRoomStages} from './src/wordRoomStages.ts'
import {WordTopologyRounds} from './src/wordTopologyRounds.ts'
import {WordActiveLayout,activeWordLayoutPending,type WordActiveLayoutContext} from './src/wordActiveLayout.ts'
import {cancelActiveWordLayout,confirmCancelledActiveWordLayout} from './src/wordActiveLayoutCancel.ts'
import {inspectActiveWordLayoutReceipt} from './src/wordActiveLayoutReceipt.ts'
import {WordActiveStory} from './src/wordActiveStory.ts'
import {transitionWordStory} from './src/wordStoryRoomTransition.ts'
import {promoteRecoveredWordStory} from './src/wordStoryRecovery.ts'
import {wordActiveStoryHttp} from './src/wordActiveStoryHttp.ts'
import {submitPreparedWordLink,promoteRecoveredWordLink} from './src/wordLinkRecovery.ts'
import {wordLinkRecoveryDetails} from './src/wordLinkRecoveryDetails.ts'
import {WordActiveLink} from './src/wordActiveLink.ts'
import {transitionWordLink,promoteHeldWordLink} from './src/wordLinkRoomTransition.ts'
import {wordActiveLinkHttp} from './src/wordActiveLinkHttp.ts'
import {transitionWordLayout} from './src/wordLayoutRoomTransition.ts'
import {promoteHeldWordLayout} from './src/wordLayoutRecovery.ts'
import {installLayoutDraftRoom} from './src/wordLayoutRoomInstall.ts'
import {authorizeWordMember} from './src/wordMemberAuthority.ts'
import {wordSidecarRequestModel,wordSidecarHeaders,wordSidecarRoomName} from './src/wordSidecarTransport.ts'
import {readWordLayout} from './src/wordRegions.ts'
import {readBoundedResponse,awaitRecoveryResponse} from './src/boundedResponse.ts'
import {collaborationMaxFrameBytes} from './src/wordTransportLimits.ts'
import {WordRecoveryReview,WordRecoveryError} from './src/wordRecoveryReview.ts'
import {WordRoomLease,wordRecoveryStoreId} from './src/wordRoomLease.ts'
import { upgradeTypography } from './src/typographyMigration.ts'
import { createHmac,createHash } from 'node:crypto'
import {observeCoordinatorChanges} from './src/referenceAuthors.ts'
import { Server,isTransactionOrigin, type Connection } from '@hocuspocus/server'
import { TiptapTransformer } from '@hocuspocus/transformer'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {SemanticBlockStore} from './src/semanticBlockStore.ts'
import {SemanticStructureIdentity} from './src/semanticStructureIdentity.ts'
import {parseCollaborationRoom,roomMatches,requireCollaborationSession,nodeEditWireVersion,legacyProtocol,structuralProtocol,wordRegionalProtocol,wordLayoutProtocol,inlineProtocol,type CollaborationSession} from './src/collaborationProtocol.ts'
import {requireWordRoomClient} from './src/wordRoomClient.ts'
import {isWordRoomProtocol,wordLayoutHostEnabled,wordRoomStatus,requireWordHttpModel} from './src/wordRoomHost.ts'
import {wordRoomProjectionHttp} from './src/wordRoomProjectionHttp.ts'
import {requireCollaborationAccess,type CollaborationAccess} from './src/collaborationAccess.ts'
import {SemanticInlineContainerNode} from './src/semanticInlineNode.ts'
import {inlineRoomGuard} from './src/inlineRoomGuard.ts'
import {inlineRoomBootstrap} from './src/sidecarInline.ts'
import {RoomMigrationGate,MigrationUncertain} from './src/roomMigrationGate.ts'
import {MigrationJournal} from './src/migrationJournal.ts'
import {RoomProtocolGuard} from './src/roomProtocolGuard.ts'
import {SidecarMigration,MigrationRejected} from './src/sidecarMigration.ts'
import {restoreProtocol,RestoreJournal} from './src/restoreJournal.ts'
import {SidecarRestore,type RestoreContext} from './src/sidecarRestore.ts'
import { projectionToJson, schemaExtensions, type Projection } from './src/schema.ts'

const api = process.env.HCD_API_URL || 'http://127.0.0.1:8766'
const secret = process.env.HCD_TOKEN_SECRET || ''
if (Buffer.byteLength(secret) < 32) throw new Error('HCD_TOKEN_SECRET must contain at least 32 bytes')

const wordLayoutRoomsEnabled=wordLayoutHostEnabled(process.env)
const room=(name:string,options?:{wordLayoutV2?:boolean})=>parseCollaborationRoom(name,{wordLayoutV2:wordLayoutRoomsEnabled||options?.wordLayoutV2===true})
const selectedSession=(selected:ReturnType<typeof room>):CollaborationSession=>({collaborationEpoch:selected.epoch,collaborationProtocol:selected.protocol})
const structureSchema=getSchema([...schemaExtensions,SemanticStructureIdentity])
const inlineSchema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
const inlineRoomsEnabled=process.env.HCD_INLINE_ROOMS==='1'
const migrationGate=new RoomMigrationGate()
const wordRetirements=new WordRoomRetirements()
const wordStages=new WordRoomStages()
const wordTopologyRounds=new WordTopologyRounds<Connection>((peer,value)=>peer.sendStateless(JSON.stringify(value)),peer=>(peer.context as User).wordTopologyVersion===1)
const wordActiveLayouts=new WordActiveLayout()
const wordActiveStories=new WordActiveStory()
const wordActiveLinks=new WordActiveLink()
const migrationJournal=new MigrationJournal(process.env.HCD_SIDECAR_STATE_DIR||join(homedir(),'.officecli','hcd-sidecar'),api)
const protocolReady=new WeakSet<Connection>()
const restoreJournal=new RestoreJournal(process.env.HCD_SIDECAR_STATE_DIR||join(homedir(),'.officecli','hcd-sidecar'),api)
type RestoreRound=RestoreContext&{requestId:string;asked:Set<Connection>;ready:Set<Connection>;failed:boolean}
const restoreRounds=new Map<string,RestoreRound>()
const packetReleases=new WeakMap<Connection,()=>void>()
const loadReleases=new Map<string,()=>void>()
const protocolGuards=new Map<string,RoomProtocolGuard>()
const wordRoomsEnabled=process.env.HCD_WORD_ROOMS==='1'
const wordCoordinators=new Map<string,WordSaveCoordinator>()
const wordBindings=new Map<string,WordRoomBinding>()
const wordUploadTokens=new Map<string,Map<string,string>>()
const wordLeases=new Map<string,WordRoomLease>()
const wordStateRoot=process.env.HCD_SIDECAR_STATE_DIR||join(homedir(),'.officecli','hcd-sidecar')
const requireWordLease=(name:string)=>{const lease=wordLeases.get(name);if(!lease)throw new Error('word-owner-unavailable');lease.assert();return lease}
function closeWordBinding(name:string){const binding=wordBindings.get(name);if(binding)binding.close();else wordCoordinators.get(name)?.dispose();wordBindings.delete(name)}
function wordJournal(selected:ReturnType<typeof room>,allowStory=false){
 const lineage=createHmac('sha256',secret).update(`word-room/1:${api}:${selected.documentId}:${selected.epoch}`).digest('hex').slice(0,32)
 return new WordCheckpointJournal(wordStateRoot,api,selected.documentId,selected.epoch,lineage,secret,allowStory,allowStory,allowStory&&selected.protocol===wordLayoutProtocol)
}
async function wordRequest(selected:ReturnType<typeof room>,route:string,init:RequestInit={}){
 const name=wordSidecarRoomName(selected),lease=requireWordLease(name)
 const model=selected.protocol===wordLayoutProtocol?await wordSidecarRequestModel(route,selected.documentId,()=>request(selected.documentId,'',{signal:init.signal},selectedSession(selected)),()=>{if(requireWordLease(name)!==lease)throw new Error('word-owner-unavailable')}):undefined
 const send=(headers:Record<string,string>)=>request(selected.documentId,route,{...init,headers:wordSidecarHeaders(route,init.headers,headers,model)},selectedSession(selected))
 return selected.protocol===wordLayoutProtocol&&route.split('?',1)[0]==='/editor'?lease.readProjection(send):send(lease.headers())
}
const wordState=wordRoomStatus
const enterRoom=(selected:ReturnType<typeof room>)=>selected.fixed?()=>{}:migrationGate.enter(selected.documentId)
function rememberUploadToken(name:string,actor:WordUploadActor,token:string){let tokens=wordUploadTokens.get(name);if(!tokens){tokens=new Map();wordUploadTokens.set(name,tokens)}tokens.set(actor.userId,token)}
async function uploadMember(selected:ReturnType<typeof room>,actor:WordUploadActor){
 const name=wordSidecarRoomName(selected)
 try{return (await authorizeWordMember({room:selected,userId:actor.userId,token:()=>wordUploadTokens.get(name)?.get(actor.userId),access:token=>access(selected.documentId,token,selected.protocol===wordLayoutProtocol?{wordLayoutV2:true}:undefined),assertLease:()=>{requireWordLease(name)}})).token}
 catch{throw new Error('word-upload-authority-changed')}
}

function serviceToken(documentId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  // A checkpoint may contain updates from several people. Attribute it to the
  // collaboration service rather than claiming a single person authored it.
  const payload = Buffer.from(JSON.stringify({ doc: documentId, scope: 'write', sub: 'hcd-collaboration', name: 'Collaboration autosave', aud: 'hcd-core', iat: now, exp: now + 60 })).toString('base64url')
  const signed = `${header}.${payload}`
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`
}

async function request(documentId: string, route: string, init: RequestInit = {}, session?: CollaborationSession): Promise<Response> {
  const response=await fetch(`${api}/v1/documents/${encodeURIComponent(documentId)}${route}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
    headers: (()=>{const headers=new Headers({'X-HCD-Node-Edits-Version':String(nodeEditWireVersion),'X-HCD-Custom-Marks-Version':'1',...(session?.collaborationProtocol===inlineProtocol?{'X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3'}:{}),...([wordRegionalProtocol,wordLayoutProtocol].includes(session?.collaborationProtocol as typeof wordRegionalProtocol|typeof wordLayoutProtocol)?{'X-HCD-Flow-Layout-Version':'2'}:{}),Authorization:`Bearer ${serviceToken(documentId)}`,...(session===undefined?{}:{'X-HCD-Collaboration-Epoch':String(session.collaborationEpoch),'X-HCD-Collaboration-Protocol':session.collaborationProtocol})});new Headers(init.headers).forEach((value,key)=>headers.set(key,value));return headers})(),
  })
  return response
}

async function currentProjection(documentId: string, session?:CollaborationSession): Promise<Projection> {
  let response = await request(documentId, '/editor',{},session)
  if (!response.ok) throw new Error(`HCD editor projection failed: ${response.status} ${await response.text()}`)
  let projection = await response.json() as Projection
  if (projection.revision === 0) {
    const manifestResponse = await request(documentId, '')
    const manifest = await manifestResponse.json() as { capabilities?: { structurePatch?: boolean } }
    if (!manifest.capabilities?.structurePatch) {
      response = await request(documentId, '/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 0 }) },session)
      if (!response.ok && response.status !== 400) throw new Error(`HCD editor projection creation failed: ${await response.text()}`)
      projection = await (await request(documentId, '/editor',{},session)).json() as Projection
    }
  }
  return projection
}

const coordinators = new Map<string, SemanticSaveCoordinator>()
const changeObservers=new Map<string,()=>void>()
const loaded = new Map<string, { projection: Projection; legacyProblem: boolean; stateHash: string }>()
type Access = CollaborationAccess
type User = Access & { token: string;wordTopologyVersion?:1;wordStoryVersion?:1;wordLinkVersion?:1 }

async function access(documentId: string, token: string,options?:{wordLayoutV2?:boolean}): Promise<Access> {
  const response = await fetch(`${api}/v1/documents/${encodeURIComponent(documentId)}/auth`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('Unauthorized HCD collaboration connection')
  return requireCollaborationAccess(await response.json(),options)
}

// Every packet is checked before Hocuspocus applies it. Idle connections also
// revalidate so a revoked reader stops receiving room broadcasts without typing.
async function revalidate(documentName:string,connection:Connection):Promise<User>{
  const selected=room(documentName)
  const token=(connection.context as User).token
  try{
    const user=await access(selected.documentId,token,wordLayoutRoomsEnabled?{wordLayoutV2:true}:undefined)
    if((connection.context as User).token!==token) return revalidate(documentName,connection)
    if(Date.now()>=user.expiresAt*1000||!['read','write'].includes(user.scope)||(!selected.fixed&&!roomMatches(selected,user)))throw new Error('Stale HCD collaboration authority')
    if(!selected.fixed&&(connection.context as User).scope==='write'&&user.scope!=='write')throw new Error('HCD collaboration write access revoked')
    if(isWordRoomProtocol(selected.protocol))requireWordLease(documentName)
    connection.readOnly=selected.fixed||user.scope!=='write'
    Object.assign(connection.context,user)
    return {...user,token}
  }catch(error){
    connection.readOnly=true
    connection.close({code:4403,reason:'HCD collaboration authority unavailable or revoked'})
    throw error
  }
}
let accessTimer:ReturnType<typeof setInterval>|undefined
const checking=new WeakSet<Connection>()
const server = new Server({
  address: process.env.HCD_COLLAB_BIND || '127.0.0.1',
  port: Number(process.env.HCD_COLLAB_PORT || 8768),
  debounce: 1000,
  maxDebounce: 5000,
  websocketOptions: { maxPayload: collaborationMaxFrameBytes },
  async onCreateDocument({documentName}) {
    // The receiving room must retain removed characters before onLoadDocument
    // merges the durable replica; setting gc afterwards is already too late.
    return room(documentName).protocol===inlineProtocol?{gc:false}:{}
  },
  async onAuthenticate({ documentName, token, connectionConfig,requestParameters }) {
    const selected=room(documentName),leave=enterRoom(selected)
    try{
      const user=await access(selected.documentId,token,wordLayoutRoomsEnabled?{wordLayoutV2:true}:undefined)
      if(!roomMatches(selected,user))throw new Error('Stale HCD collaboration room or protocol')
      if(selected.protocol===inlineProtocol&&(!inlineRoomsEnabled||requestParameters.get('hcdInlineContainers')!=='1'))throw new Error('HCD inline room requires explicit host and client support')
      if(isWordRoomProtocol(selected.protocol))requireWordRoomClient(selected,user,requestParameters,selected.protocol===wordLayoutProtocol?wordLayoutRoomsEnabled:wordRoomsEnabled)
      if(!selected.fixed&&requestParameters.get('hcdNodeEdits')!==String(nodeEditWireVersion))throw new Error('HCD node-edit-aware client required; local changes were not sent')
      if(!selected.fixed&&(await migrationJournal.load(selected.documentId))?.status==='prepared')throw new Error('HCD migration must be reconciled before opening a room')
      if(!selected.fixed&&(await restoreJournal.load(selected.documentId))?.status==='prepared')throw new Error('HCD restore must be reconciled before opening a room')
      if(Date.now()>=user.expiresAt*1000)throw new Error('Stale HCD collaboration authority')
      connectionConfig.readOnly=selected.fixed||user.scope!=='write'
      return{...user,token,...(selected.protocol===wordLayoutProtocol&&requestParameters.getAll('hcdWordTopology').length===1&&requestParameters.get('hcdWordTopology')==='1'?{wordTopologyVersion:1 as const}:{}),...(selected.protocol===wordLayoutProtocol&&requestParameters.getAll('hcdWordStory').length===1&&requestParameters.get('hcdWordStory')==='1'?{wordStoryVersion:1 as const}:{}),...(selected.protocol===wordLayoutProtocol&&requestParameters.getAll('hcdWordLink').length===1&&requestParameters.get('hcdWordLink')==='1'?{wordLinkVersion:1 as const}:{})}
    }finally{leave()}
  },
  async onTokenSync({ documentName, token, connection }) {
    const selected = room(documentName), user = await access(selected.documentId, token,wordLayoutRoomsEnabled?{wordLayoutV2:true}:undefined)
    if(!roomMatches(selected,user))throw new Error('Stale HCD collaboration room or protocol')
    connection.readOnly = selected.fixed || user.scope !== 'write'
    Object.assign(connection.context, user, { token })
  },
  async beforeHandleMessage({documentName,connection}) {
    const leave=enterRoom(room(documentName));packetReleases.set(connection,leave)
    try{await revalidate(documentName,connection)}catch(error){packetReleases.delete(connection);leave();throw error}
  },
  async afterHandleMessage({connection}){packetReleases.get(connection)?.();packetReleases.delete(connection)},
  async beforeSync({documentName,connection,type,payload}){if(isWordRoomProtocol(room(documentName).protocol)){requireWordLease(documentName);const owner=wordCoordinators.get(documentName);if(!owner)throw new Error('word-owner-unavailable');owner.assertAcceptingPackets()}if(!connection.readOnly&&(type===1||type===2))protocolGuards.get(documentName)?.accept(payload)},
  async onRequest({request:incoming,response}){
    if(await wordActiveLinkHttp(incoming,response,{enabled:wordLayoutRoomsEnabled,access:(id,token)=>access(id,token,{wordLayoutV2:true}),enter:id=>migrationGate.enter(id),status:(id,epoch,transactionId)=>wordActiveLinks.status(id,epoch,transactionId),cancel:(id,epoch,pending,reviewHash,authorize)=>wordActiveLinks.cancel({...pending,activeReviewHash:reviewHash},authorize,()=>cancelActiveLayoutContext(room(`${id}:${epoch}:wordregions2:save6`),pending,authorize),epoch),submit:(id,epoch,pending,reviewHash,authorize)=>wordActiveLinks.run({...pending,activeReviewHash:reviewHash},authorize,()=>activeTopologyContext(room(`${id}:${epoch}:wordregions2:save6`),{kind:'link',pending,reviewHash}),epoch),owner:activeWordOwner}))throw undefined
    if(await wordActiveStoryHttp(incoming,response,{enabled:wordLayoutRoomsEnabled,access:(id,token)=>access(id,token,{wordLayoutV2:true}),enter:id=>migrationGate.enter(id),status:(id,epoch,transactionId)=>wordActiveStories.status(id,epoch,transactionId),cancel:(id,epoch,pending,reviewHash,authorize)=>wordActiveStories.cancel({...pending,reviewHash},authorize,()=>cancelActiveLayoutContext(room(`${id}:${epoch}:wordregions2:save6`),pending,authorize),epoch),submit:(id,epoch,pending,reviewHash,authorize)=>wordActiveStories.run({...pending,reviewHash},authorize,()=>activeTopologyContext(room(`${id}:${epoch}:wordregions2:save6`),{kind:'story',pending,reviewHash}),epoch),owner:activeWordOwner}))throw undefined
    if(await wordRoomProjectionHttp(incoming,response,{enabled:wordLayoutRoomsEnabled,access:(id,token)=>access(id,token,{wordLayoutV2:true}),enter:id=>migrationGate.enter(id),owner:(id,epoch)=>{const name=wordSidecarRoomName({documentId:id,epoch,fixed:false,protocol:wordLayoutProtocol});requireWordLease(name);return wordCoordinators.get(name)},projection:(id,epoch,revision,signal)=>wordRequest({documentId:id,epoch,fixed:false,protocol:wordLayoutProtocol},`/editor?revision=${revision}`,{signal})}))throw undefined
    if(await wordLargeRecoveryHttp(incoming,response,{enabled:wordRoomsEnabled,layoutEnabled:wordLayoutRoomsEnabled,access:(id,token)=>access(id,token,wordLayoutRoomsEnabled?{wordLayoutV2:true}:undefined),enter:id=>migrationGate.enter(id),owner:(id,epoch,protocol)=>{const name=wordSidecarRoomName({documentId:id,epoch,protocol,fixed:false});requireWordLease(name);return wordCoordinators.get(name)}}))throw undefined
    if(await wordUploadHttp(incoming,response,{enabled:wordRoomsEnabled,layoutEnabled:wordLayoutRoomsEnabled,access:(id,token)=>access(id,token,wordLayoutRoomsEnabled?{wordLayoutV2:true}:undefined),enter:id=>migrationGate.enter(id),owner:(id,epoch,protocol)=>{const name=wordSidecarRoomName({documentId:id,epoch,protocol,fixed:false});requireWordLease(name);return wordCoordinators.get(name)},remember:(id,epoch,actor,token,protocol)=>rememberUploadToken(wordSidecarRoomName({documentId:id,epoch,protocol,fixed:false}),actor,token)}))throw undefined
    const path=new URL(incoming.url||'/', 'http://sidecar').pathname
    const match=/^\/v1\/documents\/([A-Za-z0-9_-]{1,128})\/collaboration\/(negotiate|word-recovery|word-checkpoint-recovery|word-topology-recovery|word-stopped-draft|word-stopped-draft-cancel|word-stopped-layout|word-stopped-story|word-topology-cancel|word-active-layout|word-active-layout-status|word-active-layout-cancel|word-active-layout-check|inline-restore|restore\/(\d+))$/.exec(path)
    if(!match)return
    response.setHeader('Access-Control-Allow-Origin','*');response.setHeader('Access-Control-Allow-Headers','authorization,content-type,x-hcd-node-edits-version,x-hcd-inline-containers-version,x-hcd-extension-version,x-hcd-custom-marks-version,x-hcd-word-regions-version,x-hcd-word-layout-version,x-hcd-word-link-version');response.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');response.setHeader('Cache-Control','no-store')
    if(incoming.method==='OPTIONS'){response.writeHead(204);response.end();throw undefined}
    let status=200,result:unknown
    try{
      if(incoming.method!=='POST')throw new MigrationRejected(405)
      const authorization=incoming.headers.authorization
      if(!authorization?.startsWith('Bearer '))throw new MigrationRejected(401)
      // Coordinated restore is the one shared route a layout document can hit,
      // so the authority read must accept the `/2` protocol there too. The
      // restore branch still fails closed for `/2` unless layout rooms are on.
      const user=await access(match[1],authorization.slice(7),['negotiate',...(wordLayoutRoomsEnabled?['word-recovery']:[]),'word-checkpoint-recovery','word-topology-recovery','word-stopped-draft','word-stopped-draft-cancel','word-stopped-layout','word-stopped-story','word-topology-cancel','word-active-layout','word-active-layout-status','word-active-layout-cancel','word-active-layout-check'].includes(match[2])||match[2].startsWith('restore/')?{wordLayoutV2:true}:undefined)
      if(!['read','write'].includes(user.scope))throw new MigrationRejected(403)
      if(match[2]==='word-active-layout'||match[2]==='word-active-layout-status'||match[2]==='word-active-layout-cancel'||match[2]==='word-active-layout-check'){
       const statusOnly=match[2]==='word-active-layout-status'
       if(!wordLayoutRoomsEnabled||user.coordinatedRestore!==true||user.collaborationProtocol!==wordLayoutProtocol)throw new WordRecoveryError('word-recovery-unavailable',426)
       try{requireWordHttpModel(user.collaborationProtocol,incoming.headers,true)}catch{throw new WordRecoveryError('word-room-client-upgrade-required',426)}
       if(!statusOnly&&(user.scope!=='write'||!user.userId||!user.displayName||!validContributor({userId:user.userId,displayName:user.displayName,generation:1})))throw new WordRecoveryError('word-recovery-not-allowed',403)
       const chunks:Buffer[]=[];let size=0;for await(const chunk of incoming){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>270*1024)throw new WordRecoveryError('word-active-layout-invalid',413);chunks.push(bytes)}
       let body:any;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{throw new WordRecoveryError('word-active-layout-invalid',400)}
       const id=match[1],token=authorization.slice(7),selected=room(`${id}:${user.collaborationEpoch}:wordregions2:save6`)
       if(!body||Object.keys(body).sort().join(',')!==(statusOnly?'epoch,transactionId':'epoch,request')||body.epoch!==user.collaborationEpoch||statusOnly&&(typeof body.transactionId!=='string'||!/^[a-f0-9]{32}$/.test(body.transactionId)))throw new WordRecoveryError('word-active-layout-invalid',400)
       if(statusOnly)result=wordActiveLayouts.status(id,user.collaborationEpoch,body.transactionId)
       else{
       try{
        const pending=activeWordLayoutPending(body.request,id,{userId:user.userId!,displayName:user.displayName!,scope:'write'})
        const authorize=async()=>{const current=await access(id,token,{wordLayoutV2:true});if(!roomMatches(selected,current)||current.scope!=='write'||current.userId!==user.userId||current.displayName!==user.displayName||Date.now()>=current.expiresAt*1000)throw Error('word-topology-actor-unauthorized');return{userId:current.userId!,displayName:current.displayName!,scope:'write' as const}}
        if(match[2]==='word-active-layout-check'){
         const release=migrationGate.enter(id)
         try{const name=wordSidecarRoomName(selected),binding=wordBindings.get(name),owner=wordCoordinators.get(name),lease=requireWordLease(name);if(!binding||!owner||!owner.ownsJournal(binding.journal))throw Error('word-active-layout-room-unavailable');const guard=()=>{lease.assert();if(requireWordLease(name)!==lease||wordBindings.get(name)!==binding||wordCoordinators.get(name)!==owner)throw Error('word-owner-unavailable')};result=await inspectActiveWordLayoutReceipt({journal:binding.journal,pending,guard,authorize,request:(route,init)=>wordRequest(selected,route,init)})}finally{release()}
        }else result=match[2]==='word-active-layout-cancel'?await wordActiveLayouts.cancel(pending,authorize,()=>cancelActiveLayoutContext(selected,pending,authorize),user.collaborationEpoch):await wordActiveLayouts.run(pending,authorize,()=>activeLayoutContext(selected,pending),user.collaborationEpoch)
       }catch(error){const code=error instanceof Error?error.message:'word-active-layout-unavailable';throw new WordRecoveryError(code,code==='word-active-layout-invalid'?400:code==='word-topology-actor-unauthorized'?403:409)}
       }
      }else if(match[2]==='word-stopped-layout'||match[2]==='word-stopped-story'||match[2]==='word-topology-cancel'){
       if(!wordRoomsEnabled||user.coordinatedRestore!==true||user.collaborationProtocol!==wordLayoutProtocol)throw new WordRecoveryError('word-recovery-unavailable',426)
       if(user.scope!=='write'||!user.userId||!user.displayName||!validContributor({userId:user.userId,displayName:user.displayName,generation:1}))throw new WordRecoveryError('word-recovery-not-allowed',403)
       if(incoming.headers['x-hcd-node-edits-version']!==String(nodeEditWireVersion)||incoming.headers['x-hcd-word-regions-version']!=='2'||incoming.headers['x-hcd-word-layout-version']!=='1')throw new WordRecoveryError('word-recovery-unavailable',426)
       let raw='';for await(const chunk of incoming){raw+=chunk;if(Buffer.byteLength(raw)>270*1024)throw new WordRecoveryError('word-recovery-invalid',413)}
       const body=JSON.parse(raw),id=match[1],epoch=user.collaborationEpoch,selected=room(`${id}:${epoch}:wordregions2:save6`,{wordLayoutV2:true}),name=wordSidecarRoomName(selected),token=authorization.slice(7)
       const story=match[2]==='word-stopped-story',cancel=match[2]==='word-topology-cancel'
       if(!body||body.epoch!==epoch)throw new WordRecoveryError('word-recovery-invalid',400)
       if(cancel){
        if(Object.keys(body).sort().join(',')!=='epoch,transactionId'||!/^[a-f0-9]{32}$/.test(body.transactionId??''))throw new WordRecoveryError('word-recovery-invalid',400)
       }else if(story){
        if(!['preview','apply'].includes(body.operation)||Object.keys(body).sort().join(',')!==(body.operation==='preview'?'epoch,kind,operation,sectionId,transactionId,variant':'epoch,kind,operation,reviewHash,sectionId,transactionId,variant')||!/^n_[a-f0-9]{32}$/.test(body.sectionId??'')||!['header','footer'].includes(body.kind)||!['default','first','even'].includes(body.variant)||!/^[a-f0-9]{32}$/.test(body.transactionId??'')||body.operation==='apply'&&!/^[a-f0-9]{64}$/.test(body.reviewHash??''))throw new WordRecoveryError('word-recovery-invalid',400)
       }else if(!['inspect','apply'].includes(body.operation)||Object.keys(body).sort().join(',')!==(body.operation==='inspect'?'epoch,operation':'edits,epoch,operation,reviewHash,revision,transactionId')||body.operation==='apply'&&(!/^[a-f0-9]{64}$/.test(body.reviewHash??'')||!/^[a-f0-9]{32}$/.test(body.transactionId??'')||!Number.isSafeInteger(body.revision)||body.revision<0||!body.edits||typeof body.edits!=='object'||Array.isArray(body.edits)))throw new WordRecoveryError('word-recovery-invalid',400)
       result=await migrationGate.exclusive(id,async()=>{
        const stopped=()=>{if(!migrationGate.blocked(id)||[...server.hocuspocus.documents.keys(),...wordCoordinators.keys(),...wordBindings.keys(),...[...wordLeases.keys()].filter(key=>key!==name)].some(key=>{const roomId=room(key,{wordLayoutV2:true});return !roomId.fixed&&roomId.documentId===id})||wordCoordinators.has(name)||wordBindings.has(name))throw new WordRecoveryError('word-recovery-room-active')}
        stopped();if(wordLeases.has(name))throw new WordRecoveryError('word-recovery-room-active')
        const journal=wordJournal(selected,true);await journal.load();stopped();const storeId=await wordRecoveryStoreId(wordStateRoot,api,secret);stopped()
        const lease=new WordRoomLease({epoch,storeId,journalHashes:journal.knownHashes(),request:(route,init)=>request(id,route,{...init,headers:{...init.headers,'X-HCD-Word-Story-Recovery':'1'}},selectedSession(selected))});wordLeases.set(name,lease)
        try{
         await lease.acquire();const guard=()=>{stopped();if(requireWordLease(name)!==lease)throw new Error('word-owner-unavailable')}
         const authorize=async()=>{await authorizeWordMember({room:selected,userId:user.userId!,displayName:user.displayName!,token:()=>token,access:value=>access(id,value,{wordLayoutV2:true}),assertLease:guard});guard()}
         await authorize();const options={journal,lease,request:(route:string,init?:RequestInit)=>wordRequest(selected,route,init),assertStopped:guard,authorizeMember:authorize}
         if(cancel){
          await journal.abandonUnpreparedTopology(body.transactionId,guard);await authorize();guard()
          const response=await wordRequest(selected,'/word/topology-cancel',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Story-Version':'1'},body:JSON.stringify({transactionId:body.transactionId,actor:{userId:user.userId,displayName:user.displayName}})})
          if(!response.ok)throw new WordRecoveryError('word-topology-cancel-unavailable');const receipt=await response.json();guard()
          if(!receipt||receipt.transactionId!==body.transactionId||receipt.status!=='not-prepared'||Object.keys(receipt).sort().join(',')!=='status,transactionId')throw new Error('word-topology-cancel-invalid')
          await authorize();guard();return receipt
         }
         if(body.operation==='inspect')return await inspectStoppedWordLayout(options)
         const actor={userId:user.userId!,displayName:user.displayName!}
         if(story){const selection={sectionId:body.sectionId,kind:body.kind,variant:body.variant,transactionId:body.transactionId},storyOptions={...options,actor};return body.operation==='preview'?await previewStoppedWordStory(storyOptions,selection):await applyStoppedWordStory(storyOptions,selection,body.reviewHash)}
         const pending={actor:{...actor,generation:1},request:{schemaVersion:'hcd-word-layout-transaction/1' as const,documentId:id,transactionId:body.transactionId,baseRevision:body.revision,expectedRevision:body.revision,actor,edits:body.edits}}
         return await applyStoppedWordLayout(options,pending,body.reviewHash)
        }finally{await lease.close();if(wordLeases.get(name)===lease)wordLeases.delete(name)}
       },undefined,match[2],false,`${user.userId}:${body.operation}:${body.transactionId??''}`,false)
      }else if(match[2]==='word-stopped-draft'||match[2]==='word-stopped-draft-cancel'){
       if(!wordRoomsEnabled||user.coordinatedRestore!==true||user.collaborationProtocol!==wordLayoutProtocol)throw new WordRecoveryError('word-recovery-unavailable',426)
       if(user.scope!=='write'||!user.userId||!user.displayName)throw new WordRecoveryError('word-recovery-not-allowed',403)
       if(incoming.headers['x-hcd-node-edits-version']!==String(nodeEditWireVersion)||incoming.headers['x-hcd-word-regions-version']!=='2'||incoming.headers['x-hcd-word-layout-version']!=='1')throw new WordRecoveryError('word-recovery-unavailable',426)
       let raw='';for await(const chunk of incoming){raw+=chunk;if(Buffer.byteLength(raw)>2048)throw new WordRecoveryError('word-recovery-invalid',413)}
       const body=JSON.parse(raw),id=match[1],epoch=user.collaborationEpoch,selected=room(`${id}:${epoch}:wordregions2:save6`,{wordLayoutV2:true}),name=wordSidecarRoomName(selected),token=authorization.slice(7)
       const cancel=match[2]==='word-stopped-draft-cancel'
       if(!body||body.epoch!==epoch)throw new WordRecoveryError('word-recovery-invalid',400)
       if(cancel){if(Object.keys(body).sort().join(',')!=='checkpointId,epoch'||!/^[a-f0-9]{32}$/.test(body.checkpointId??''))throw new WordRecoveryError('word-recovery-invalid',400)}
       else if(!['inspect','inspect-stale','download-stale-text','rebase-stale','save'].includes(body.operation)||Object.keys(body).sort().join(',')!==(body.operation==='inspect'?'epoch,offset,operation':body.operation==='inspect-stale'?'checkpointId,epoch,offset,operation':['download-stale-text','rebase-stale'].includes(body.operation)?'checkpointId,epoch,headRevision,operation,reviewHash':body.checkpointId===undefined?'epoch,operation,reviewHash':'checkpointId,epoch,operation,reviewHash')||['inspect','inspect-stale'].includes(body.operation)&&(!Number.isSafeInteger(body.offset)||body.offset<0||body.offset%25!==0)||['inspect-stale','download-stale-text','rebase-stale'].includes(body.operation)&&!/^[a-f0-9]{32}$/.test(body.checkpointId??'')||['download-stale-text','rebase-stale'].includes(body.operation)&&(!/^[a-f0-9]{64}$/.test(body.reviewHash??'')||!Number.isSafeInteger(body.headRevision)||body.headRevision<0)||body.operation==='save'&&(!/^[a-f0-9]{64}$/.test(body.reviewHash??'')||body.checkpointId!==undefined&&!/^[a-f0-9]{32}$/.test(body.checkpointId)))throw new WordRecoveryError('word-recovery-invalid',400)
       result=await migrationGate.exclusive(id,async()=>{
        const stopped=()=>{if(!migrationGate.blocked(id)||[...server.hocuspocus.documents.keys(),...wordCoordinators.keys(),...wordBindings.keys(),...[...wordLeases.keys()].filter(key=>key!==name)].some(key=>{const roomId=room(key,{wordLayoutV2:true});return !roomId.fixed&&roomId.documentId===id})||wordCoordinators.has(name)||wordBindings.has(name))throw new WordRecoveryError('word-recovery-room-active')}
        stopped();if(wordLeases.has(name))throw new WordRecoveryError('word-recovery-room-active')
        const journal=wordJournal(selected,true);await journal.load();stopped()
        const storeId=await wordRecoveryStoreId(wordStateRoot,api,secret);stopped()
        const lease=new WordRoomLease({epoch,storeId,journalHashes:journal.knownHashes(),request:(route,init)=>request(id,route,{...init,headers:{...init.headers,'X-HCD-Word-Story-Recovery':'1'}},selectedSession(selected))})
        wordLeases.set(name,lease)
        try{
         await lease.acquire();const guard=()=>{stopped();if(requireWordLease(name)!==lease)throw new Error('word-owner-unavailable')}
         const authorize=async()=>{await authorizeWordMember({room:selected,userId:user.userId!,displayName:user.displayName!,token:()=>token,access:value=>access(id,value,{wordLayoutV2:true}),assertLease:guard});guard()}
         await authorize()
         if(cancel){await journal.abandonUnpreparedCheckpoint(body.checkpointId,guard);await authorize();guard();const response=await wordRequest(selected,'/word/checkpoint-cancel',{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'7','X-HCD-Word-Story-Version':'1'},body:JSON.stringify({checkpointId:body.checkpointId,actor:{userId:user.userId,displayName:user.displayName}})});if(!response.ok)throw new WordRecoveryError('word-checkpoint-cancel-unavailable');const receipt=await response.json();guard();if(!receipt||Object.keys(receipt).sort().join(',')!=='checkpointId,status'||receipt.checkpointId!==body.checkpointId||receipt.status!=='not-prepared')throw new Error('word-checkpoint-cancel-invalid');await authorize();guard();return receipt}
         if(body.operation==='inspect'){const result=await inspectStoppedWordDraft(journal,route=>wordRequest(selected,route),guard,body.offset);await authorize();return result}
         if(body.operation==='inspect-stale'){const identity=await journal.checkpointRecoveryIdentity(body.checkpointId);guard();if(!identity.acknowledged||identity.initiator.userId!==user.userId||identity.initiator.displayName!==user.displayName)throw new WordRecoveryError('word-recovery-not-allowed',403);const result=await inspectStaleWordDraft(journal,route=>wordRequest(selected,route),guard,body.offset);await authorize();return result}
         if(body.operation==='download-stale-text'){const identity=await journal.checkpointRecoveryIdentity(body.checkpointId);guard();if(!identity.acknowledged||identity.initiator.userId!==user.userId||identity.initiator.displayName!==user.displayName)throw new WordRecoveryError('word-recovery-not-allowed',403);const result=await downloadStaleWordDraftText(journal,route=>wordRequest(selected,route),guard,body.reviewHash,body.headRevision);await authorize();return result}
         if(body.operation==='rebase-stale'){
          const identity=await journal.checkpointRecoveryIdentity(body.checkpointId);guard();if(!identity.acknowledged||identity.initiator.userId!==user.userId||identity.initiator.displayName!==user.displayName)throw new WordRecoveryError('word-recovery-not-allowed',403)
          const current=await journal.load();guard();if(!current||current.capsule.version!==3||current.capsule.pending||current.hash!==body.reviewHash&&current.capsule.staleRebase?.sourceTip!==body.reviewHash)throw new WordRecoveryError('word-recovery-review-changed')
          const proof=current.capsule.staleRebase,base=proof&&proof.sourceTip===body.reviewHash?proof.baseRevision:current.capsule.base.revision,read=async(route:string)=>{const response=await wordRequest(selected,route);if(!response.ok)throw new WordRecoveryError('word-recovery-baseline-unavailable');return response.json()}
          const [head,previous,previousRecord,latest,latestRecord]=await Promise.all([read('/revisions?limit=1'),read(`/editor?revision=${base}`),read(`/revisions/${base}`),read(`/editor?revision=${body.headRevision}`),read(`/revisions/${body.headRevision}`)]);guard();if(head.headRevision!==body.headRevision)throw new WordRecoveryError('word-recovery-review-changed')
          await lease.renew();await authorize();guard();if((await read('/revisions?limit=1')).headRevision!==body.headRevision)throw new WordRecoveryError('word-recovery-review-changed');guard();const result=await journal.stageStaleRebase(previous,previousRecord,latest,latestRecord,body.reviewHash,{userId:user.userId!,displayName:user.displayName!},guard);await lease.recordJournal(journal.knownHashes());await authorize();guard();if((await read('/revisions?limit=1')).headRevision!==body.headRevision)throw new WordRecoveryError('word-recovery-review-changed');guard()
          return{checkpointId:body.checkpointId,revision:result.capsule.base.revision,status:'rebased'}
         }
         const current=await journal.load();guard();if(!current||current.hash!==body.reviewHash||current.capsule.version!==3||current.capsule.pending)throw new WordRecoveryError('word-recovery-review-changed')
         await authorize();const result=await saveStoppedWordDraft({journal,lease,request:(route,init)=>wordRequest(selected,route,init),assertStopped:guard,initiator:{userId:user.userId!,displayName:user.displayName!},authorizeMember:authorize,...(body.checkpointId?{checkpointId:body.checkpointId}:{})});return{saved:result.saved,revision:result.revision,checkpointId:body.checkpointId??null}
        }finally{await lease.close();if(wordLeases.get(name)===lease)wordLeases.delete(name)}
       },undefined,match[2],false,`${user.userId}:${body.operation}:${body.reviewHash??body.offset}`,false)
      }else if(match[2]==='word-checkpoint-recovery'||match[2]==='word-topology-recovery'){
       if(!wordRoomsEnabled||user.coordinatedRestore!==true||user.collaborationProtocol!==wordLayoutProtocol)throw new WordRecoveryError('word-recovery-unavailable',426)
       if(user.scope!=='write'||!user.userId||!user.displayName)throw new WordRecoveryError('word-recovery-not-allowed',403)
       if(incoming.headers['x-hcd-node-edits-version']!==String(nodeEditWireVersion)||incoming.headers['x-hcd-word-regions-version']!=='2'||incoming.headers['x-hcd-word-layout-version']!=='1')throw new WordRecoveryError('word-recovery-unavailable',426)
       let raw='';for await(const chunk of incoming){raw+=chunk;if(Buffer.byteLength(raw)>2048)throw new WordRecoveryError('word-recovery-invalid',413)}
       const body=JSON.parse(raw),id=match[1],epoch=user.collaborationEpoch,selected=room(`${id}:${epoch}:wordregions2:save6`,{wordLayoutV2:true}),name=wordSidecarRoomName(selected),token=authorization.slice(7),topology=match[2]==='word-topology-recovery',key=topology?'transactionId':'checkpointId'
       if(!body||body.epoch!==epoch||!['inspect','resume',...(topology?['details']:[])].includes(body.operation)||Object.keys(body).sort().join(',')!==(body.operation==='inspect'?'epoch,operation':body.operation==='details'?'epoch,offset,operation,transactionId':`epoch,operation,${key}`.split(',').sort().join(','))||body.operation!=='inspect'&&!/^[a-f0-9]{32}$/.test(body[key]??'')||body.operation==='details'&&(!Number.isSafeInteger(body.offset)||body.offset<0||body.offset%20!==0))throw new WordRecoveryError('word-recovery-invalid',400)
       result=await migrationGate.exclusive(id,async()=>{
        const stopped=()=>{if(!migrationGate.blocked(id)||[...server.hocuspocus.documents.keys(),...wordCoordinators.keys(),...wordBindings.keys(),...[...wordLeases.keys()].filter(key=>key!==name)].some(key=>{const roomId=room(key,{wordLayoutV2:true});return !roomId.fixed&&roomId.documentId===id})||wordCoordinators.has(name)||wordBindings.has(name))throw new WordRecoveryError('word-recovery-room-active')}
        stopped();if(wordLeases.has(name))throw new WordRecoveryError('word-recovery-room-active')
        const journal=wordJournal(selected,true),saved=await journal.load();stopped()
        const checkpointId=topology?undefined:body.operation==='resume'?body.checkpointId:saved?.capsule.pending?.request.checkpointId??saved?.capsule.checkpointAcknowledgement?.request.checkpointId??saved?.capsule.unchangedAcknowledgement?.request.checkpointId??saved?.capsule.staleRebase?.checkpointId
        if(!topology&&!checkpointId)throw new WordRecoveryError('word-recovery-unavailable')
        const identity=topology?await journal.topologyRecoveryIdentity(body.operation==='inspect'?undefined:body.transactionId):await journal.checkpointRecoveryIdentity(checkpointId);stopped()
        if(identity.initiator.userId!==user.userId||identity.initiator.displayName!==user.displayName)throw new WordRecoveryError('word-recovery-not-allowed',403)
        if(topology&&'kind' in identity&&identity.kind==='link'&&incoming.headers['x-hcd-word-link-version']!=='1')throw new WordRecoveryError('word-recovery-unavailable',426)
        const storeId=await wordRecoveryStoreId(wordStateRoot,api,secret);stopped()
        const lease=new WordRoomLease({epoch,storeId,journalHashes:journal.knownHashes(),request:(route,init)=>request(id,route,{...init,headers:{...init.headers,'X-HCD-Word-Story-Recovery':'1'}},selectedSession(selected))})
        wordLeases.set(name,lease)
        try{
         await lease.acquire();const guard=()=>{stopped();if(requireWordLease(name)!==lease)throw new Error('word-owner-unavailable')}
         const authorize=async()=>{await authorizeWordMember({room:selected,userId:identity.initiator.userId,displayName:identity.initiator.displayName,token:()=>token,access:value=>access(id,value,{wordLayoutV2:true}),assertLease:guard});guard()}
         await authorize()
         if(body.operation==='details'&&topology&&'details' in identity){
          const response=await wordRequest(selected,`/word/layout?revision=${identity.baseRevision}`);if(!response.ok)throw new Error('word-topology-layout-unavailable')
          const bytes=await readBoundedResponse(response,16*1024*1024,AbortSignal.timeout(30_000),'word-topology-layout-limit'),value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),layout=readWordLayout(value,identity.baseRevision,2);guard()
          if(value.layoutHash!==identity.details.layoutHash)throw new Error('word-topology-layout-changed')
          const section=(sectionId:string)=>{const index=layout.sections.findIndex(entry=>entry.id===sectionId);if(index<0)throw new Error('word-topology-section-missing');return index+1}
          const detail=identity.details.kind==='layout'?{total:identity.details.changes.length,offset:body.offset,changes:identity.details.changes.slice(body.offset,body.offset+20).map(change=>({section:change.sectionId===undefined?null:section(change.sectionId),field:change.field,before:change.expected,after:change.value}))}:identity.details.kind==='link'?wordLinkRecoveryDetails(layout,identity.details.link,identity.transactionId,body.offset):{total:1,offset:body.offset,changes:body.offset===0?[{section:section(identity.details.intent.sectionId),kind:identity.details.intent.kind,variant:identity.details.intent.variant,inherited:identity.details.intent.expectedInheritedStoryId!==null,blockCount:identity.details.blockCount}]:[]}
          if(body.offset>=detail.total)throw new WordRecoveryError('word-recovery-invalid',400)
          await authorize();const checked=await journal.topologyRecoveryIdentity(identity.transactionId);guard();if(JSON.stringify(checked.details)!==JSON.stringify(identity.details))throw new Error('word-topology-review-changed')
          return{transactionId:identity.transactionId,kind:identity.kind,...detail}
         }
         if(body.operation==='resume'){
          if(topology&&'kind' in identity){const options={journal,lease,request:(route:string,init?:RequestInit)=>wordRequest(selected,route,init),assertStopped:guard,authorizeMember:authorize,protocol:wordLayoutProtocol};if(identity.kind==='layout'){if(identity.status!=='promoted')await submitPreparedWordLayout(options);await promoteRecoveredWordLayout(options)}else if(identity.kind==='link'){const original=await journal.linkRecoveryIdentity(identity.transactionId);guard();const authorizeLink=async()=>{await authorize();return{scope:'write' as const,userId:identity.initiator.userId,displayName:identity.initiator.displayName}},linkOptions={...options,authorize:authorizeLink};if(!original.promoted){const recovered=await submitPreparedWordLink(linkOptions);if(!recovered.historical)await promoteRecoveredWordLink(linkOptions,original.pending)}else{await lease.recordJournal(journal.knownHashes());guard()}}else{if(identity.status!=='promoted')await submitPreparedWordStory(options);await promoteStoppedWordStory(options)}}
          else if(!('rebased' in identity&&identity.rebased))await recoverPreparedWordCheckpoint({journal,lease,request:(route,init)=>wordRequest(selected,route,init),assertStopped:guard,authorizeMember:authorize,receiptFirst:true})
         }
         await authorize();const final=topology?await journal.topologyRecoveryIdentity(body.operation==='resume'?body.transactionId:undefined):await journal.checkpointRecoveryIdentity(checkpointId);guard()
         if(final.initiator.userId!==identity.initiator.userId||final.initiator.displayName!==identity.initiator.displayName)throw new Error('word-checkpoint-initiator-mismatch')
         if(topology&&'kind' in final){
          if(final.kind==='link'){
           const response=await wordRequest(selected,'/revisions?limit=1',{signal:AbortSignal.timeout(30000)});guard();if(!response.ok)throw Error('word-link-head-unavailable')
           const head=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedResponse(response,16384,AbortSignal.timeout(30000),'word-link-response-limit'))).headRevision;guard()
           if(!Number.isSafeInteger(head)||head<final.revision)throw Error('word-link-head-invalid')
           await authorize();return{transactionId:final.transactionId,kind:'link',baseRevision:final.baseRevision,revision:final.revision,headRevision:head,status:final.status==='promoted'?(head===final.revision?'confirmed':'historical'):final.status==='confirmed'&&head>final.revision?'historical':'pending'}
          }
          return{transactionId:final.transactionId,kind:final.kind,baseRevision:final.baseRevision,revision:final.revision,status:final.status==='promoted'?'confirmed':'pending'}
         }
         let status='pending'
         if('acknowledged' in final&&final.acknowledged){if('rebased' in final&&final.rebased){await lease.recordJournal(journal.knownHashes());guard()}const response=await wordRequest(selected,'/revisions?limit=1');if(!response.ok)throw new Error('word-checkpoint-head-unavailable');const head=await response.json();guard();if(!Number.isSafeInteger(head.headRevision)||head.headRevision<final.revision)throw new Error('word-checkpoint-head-invalid');status='rebased' in final&&final.rebased?(head.headRevision===final.revision?'rebased':'rebased-stale'):(head.headRevision===final.revision?'confirmed':'confirmed-stale')}
         await authorize();guard();return{checkpointId,baseRevision:final.baseRevision,revision:final.revision,status}
        }finally{await lease.close();if(wordLeases.get(name)===lease)wordLeases.delete(name)}
       },undefined,match[2],false,`${user.userId}:${body.operation}:${body[key]??''}`,false)
      }else if(match[2]==='word-recovery'){
       if(!wordRoomsEnabled||user.coordinatedRestore!==true||!isWordRoomProtocol(user.collaborationProtocol)||user.collaborationProtocol===wordLayoutProtocol&&!wordLayoutRoomsEnabled)throw new WordRecoveryError('word-recovery-unavailable',426)
       const protocol=user.collaborationProtocol,layout=protocol===wordLayoutProtocol
       try{requireWordHttpModel(protocol,incoming.headers,wordLayoutRoomsEnabled)}catch{throw new WordRecoveryError('word-recovery-unavailable',426)}
       let raw='';for await(const chunk of incoming){raw+=chunk;if(Buffer.byteLength(raw)>8192)throw new WordRecoveryError('word-recovery-invalid',413)}
       const body=JSON.parse(raw),id=match[1],epoch=user.collaborationEpoch,selected={documentId:id,epoch,fixed:false,protocol},journal=wordJournal(selected,layout),name=wordSidecarRoomName(selected)
       if(!body||body.epoch!==epoch||!['list','preview','download','resolve'].includes(body.operation))throw new WordRecoveryError('word-recovery-session-changed')
       const expected=body.operation==='list'?['epoch','operation']:body.operation==='preview'?['archiveId','epoch','offset','operation']:body.operation==='download'?['archiveId','epoch','operation']:['choice','epoch','operation'];if(Object.keys(body).sort().join(',')!==expected.sort().join(','))throw new WordRecoveryError('word-recovery-invalid',400)
       const authorize=async(write=false)=>{const current=await access(id,authorization.slice(7),layout?{wordLayoutV2:true}:undefined);if(!['read','write'].includes(current.scope)||write&&current.scope!=='write'||current.userId!==user.userId||!roomMatches(selected,current)||Date.now()>=current.expiresAt*1000)throw new WordRecoveryError('word-recovery-not-allowed',403)}
       const nativeFor=(lease?:WordRoomLease)=>async(revision:number)=>{
        const signal=AbortSignal.timeout(30_000),read=async(route:string)=>{
         await authorize();lease?.assert()
         const model=layout?await wordSidecarRequestModel(route,id,()=>request(id,'',{signal},selectedSession(selected)),()=>lease!.assert()):undefined
         const response=await awaitRecoveryResponse(()=>request(id,route,{signal,...(lease?{headers:wordSidecarHeaders(route,undefined,lease.headers(),model)}:{})},selectedSession(selected)),signal)
         if(!response.ok)throw new WordRecoveryError('word-recovery-baseline-unavailable')
         const bytes=await readBoundedResponse(response,16*1024*1024,signal,'word-recovery-baseline-limit');await authorize();lease?.assert();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))
        }
        const [projection,record]=await Promise.all([read(`/editor?revision=${revision}`),read(`/revisions/${revision}`)]);return{projection,rootHash:record.rootHash}
       }
       const stopped=()=>{if(wordLeases.has(name)||wordCoordinators.has(name)||wordBindings.has(name)||server.hocuspocus.documents.has(name))throw new WordRecoveryError('word-recovery-room-active')}
       const withStoppedOwner=async<T,>(work:(lease:WordRoomLease)=>Promise<T>)=>{
        stopped();await journal.load();const storeId=await wordRecoveryStoreId(wordStateRoot,api,secret),lease=new WordRoomLease({epoch,storeId,journalHashes:journal.knownHashes(),request:(route,init)=>request(id,route,init,selectedSession(selected))})
        try{await authorize(body.operation==='resolve');await lease.acquire();return await work(lease)}finally{await lease.close()}
       }
       const identity=createHash('sha256').update(JSON.stringify([user.userId,body])).digest('hex')
       if(body.operation==='resolve'){
        if(user.scope!=='write'||!user.userId)throw new WordRecoveryError('word-recovery-not-allowed',403)
        result=await migrationGate.exclusive(id,()=>withStoppedOwner(lease=>new WordRecoveryReview({protocol,journal,native:nativeFor(lease),assertOwnership:()=>lease.assert(),authorize:()=>authorize(true),recordDurable:(_hash,ancestors)=>lease.recordJournal(ancestors)}).resolve(body.choice,{userId:user.userId!,displayName:user.displayName,scope:'write'})),undefined,'word-recovery',false,identity,false)
       }else if(body.operation==='preview'&&layout){
        const live=wordCoordinators.get(name)
        if(live){const leave=migrationGate.enter(id);try{const lease=requireWordLease(name),guard=()=>{live.assertAcceptingPackets();if(wordCoordinators.get(name)!==live||requireWordLease(name)!==lease)throw new WordRecoveryError('word-recovery-room-active')};guard();result=await new WordRecoveryReview({protocol,journal,native:async revision=>{guard();const value=await nativeFor(lease)(revision);guard();return value}}).preview(body.archiveId,body.offset)}finally{leave()}}
        else result=await migrationGate.exclusive(id,()=>withStoppedOwner(lease=>new WordRecoveryReview({protocol,journal,native:nativeFor(lease)}).preview(body.archiveId,body.offset)),undefined,'word-recovery-preview',false,identity,false)
       }else{
        const leave=migrationGate.enter(id)
        try{const review=new WordRecoveryReview({protocol,journal,native:nativeFor()});if(body.operation==='list')result={...await review.list(),canResolve:!wordLeases.has(name)&&!wordCoordinators.has(name)&&!wordBindings.has(name)&&!server.hocuspocus.documents.has(name)};else if(body.operation==='download')result=await review.download(body.archiveId);else result=await review.preview(body.archiveId,body.offset)}finally{leave()}
       }
       await authorize();if(layout)result={...(result as object),nodeEditVersion:nodeEditWireVersion,wordRegionVersion:2,wordLayoutVersion:1}
      }else if(match[2]==='inline-restore'){
       if(user.scope!=='write'||!user.userId||user.collaborationProtocol!==structuralProtocol&&user.collaborationProtocol!==inlineProtocol)throw new MigrationRejected(403,'restore-not-allowed')
       if(user.collaborationProtocol===inlineProtocol&&(!inlineRoomsEnabled||incoming.headers['x-hcd-inline-containers-version']!=='1'))throw new MigrationRejected(426,'restore-model-upgrade')
       if(incoming.headers['x-hcd-node-edits-version']!==String(nodeEditWireVersion))throw new MigrationRejected(426,'restore-model-upgrade')
       let raw='';for await(const chunk of incoming){raw+=chunk;if(Buffer.byteLength(raw)>4*1024*1024)throw new MigrationRejected(413,'restore-invalid')}
       const body=JSON.parse(raw)
       if(!body||Object.keys(body).sort().join(',')!=='epoch,review'||body.epoch!==user.collaborationEpoch)throw new MigrationRejected(409,'restore-session-changed')
       const coordinator=coordinators.get(`${match[1]}:${user.collaborationEpoch}:${user.collaborationProtocol===inlineProtocol?'inlinecontainers1':'structure3'}:save4`)
       if(!coordinator)throw new MigrationRejected(409,'restore-room-unavailable')
       const leave=migrationGate.enter(match[1]);try{result=await coordinator.restoreInline(body.review,{userId:user.userId,displayName:user.displayName})}finally{leave()}
      }else if(match[2]!=='negotiate'){
       if(user.coordinatedRestore!==true)throw new MigrationRejected(409,'restore-unavailable')
       if(user.scope!=='write'||!user.userId||user.collaborationProtocol!==structuralProtocol&&user.collaborationProtocol!==inlineProtocol&&user.collaborationProtocol!==wordLayoutProtocol)throw new MigrationRejected(403,'restore-not-allowed')
       if(user.collaborationProtocol===inlineProtocol)requireInlineRestoreModel(incoming.headers)
       // A layout restore may only come from the exact model the layout room
       // guards require; a downgraded client is refused before any journal work.
       if(user.collaborationProtocol===wordLayoutProtocol){
        if(!wordLayoutRoomsEnabled)throw new MigrationRejected(426,'word-layout-room-unavailable')
        try{requireWordHttpModel(wordLayoutProtocol,incoming.headers,true)}catch{throw new MigrationRejected(426,'restore-model-upgrade')}
       }
       let raw='';for await(const chunk of incoming){raw+=chunk;if(raw.length>2048)throw new MigrationRejected(413,'restore-invalid')}
       const body=JSON.parse(raw),target=Number(match[3])
       if(!body||Object.keys(body).sort().join(',')!=='expectedRevision,fromEpoch,requestId'||!/^[a-f0-9]{32}$/.test(body.requestId??'')||!Number.isSafeInteger(body.expectedRevision)||!Number.isSafeInteger(target)||target<0||target>=body.expectedRevision||!Number.isSafeInteger(body.fromEpoch)||body.fromEpoch<0)throw new MigrationRejected(400,'restore-invalid')
       // An earlier process may have left a durable migration whose outcome
       // is unknown even though this process has no in-memory gate owner.
       let migration
       try{migration=await migrationJournal.load(match[1])}catch{throw new MigrationUncertain()}
       if(migration?.status==='prepared')throw new MigrationUncertain()
       result=await restores.run(match[1],{requestId:body.requestId,expectedRevision:body.expectedRevision,target,fromEpoch:body.fromEpoch,fromProtocol:user.collaborationProtocol,authorId:user.userId,authorName:user.displayName??user.userId})
      }else{
       // Do not route layout-aware documents through legacy migration or a
       // coordinator that cannot persist their version-3 room state.
       if(user.collaborationProtocol===wordLayoutProtocol){
        if(!wordLayoutRoomsEnabled||user.coordinatedRestore!==true)throw new MigrationRejected(426,'word-layout-room-unavailable')
        try{requireWordHttpModel(user.collaborationProtocol,incoming.headers,true)}catch{throw new MigrationRejected(426,'word-layout-client-upgrade')}
        // Replay a committed-but-unacknowledged layout restore journal before
        // admitting a new room; an unknown outcome stays fenced as 503.
        await restores.recover(match[1])
        result={collaborationEpoch:user.collaborationEpoch,collaborationProtocol:wordLayoutProtocol,wordRegionVersion:2,wordLayoutVersion:1}
       }else{
       const manifestResponse=await request(match[1],'');if(!manifestResponse.ok)throw new MigrationRejected(409,'document-unavailable');const manifest=await manifestResponse.json()
       const requestedInline=incoming.headers['x-hcd-inline-containers-version'],inlineDocument=user.collaborationProtocol===inlineProtocol||manifest.capabilities?.extensionNodes===3
       if(requestedInline!==undefined&&(requestedInline!=='1'||!inlineDocument))throw new MigrationRejected(426,'inline-room-model-upgrade')
       if(inlineDocument){
        if(!inlineRoomsEnabled||incoming.headers['x-hcd-inline-containers-version']!=='1')throw new MigrationRejected(426,'inline-room-model-upgrade')
        requireInlineRestoreModel(incoming.headers)
        await restores.recover(match[1])
        result={...await inlineMigrations.negotiate(match[1]),inlineContainers:1}
       }else if(user.collaborationProtocol===wordRegionalProtocol){if(!wordRoomsEnabled)throw new MigrationRejected(426,'word-room-disabled');result={collaborationEpoch:user.collaborationEpoch,collaborationProtocol:wordRegionalProtocol,wordRegionVersion:1}}
       else{
       const recovered=await restores.recover(match[1]);const effective=recovered??user
       result=effective.collaborationProtocol===structuralProtocol&&!migrationGate.blocked(match[1])&&(await migrationJournal.load(match[1]))?.status!=='prepared'?{collaborationEpoch:effective.collaborationEpoch,collaborationProtocol:structuralProtocol}:await migrations.negotiate(match[1])
       }
       }
      }
    }catch(error){status=error instanceof WordRecoveryError?error.status:error instanceof MigrationRejected?error.status:error instanceof MigrationUncertain?503:409;result={code:error instanceof WordRecoveryError?error.code:match[2]==='word-recovery'?'word-recovery-unavailable':error instanceof MigrationUncertain?'restore-or-migration-pending':error instanceof MigrationRejected?error.code:'restore-or-migration-rejected',retryAfter:status===503?2:undefined}}
    if(status===200&&match[2]==='negotiate')result={...(result as object),nodeEditVersion:nodeEditWireVersion}
    response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(result));throw undefined
  },
  async onListen(){
    accessTimer=setInterval(()=>{
      for(const [name,document] of server.hocuspocus.documents){
        for(const connection of document.getConnections()){
          if(checking.has(connection))continue
          checking.add(connection)
          void revalidate(name,connection).catch(()=>{}).finally(()=>checking.delete(connection))
        }
      }
    },2000)
    accessTimer.unref()
  },
  async onDestroy(){clearInterval(accessTimer);for(const [name,owner] of wordCoordinators){try{await owner.drain()}catch{await owner.archiveRecovery('word-owner-shutdown')}closeWordBinding(name)}for(const binding of wordBindings.values())binding.close();wordBindings.clear();await Promise.all([...wordLeases.values()].map(lease=>lease.close()))},
  async onLoadDocument({ documentName,context,document }) {
    if(wordStages.has(documentName)){
     const selected=room(documentName);if(selected.protocol!==wordLayoutProtocol||!wordLayoutRoomsEnabled)throw new Error('word-host-stage-protocol')
     requireWordLease(documentName);const binding=wordStages.binding(documentName,context);if(wordBindings.has(documentName)||wordCoordinators.has(documentName))throw new Error('word-host-stage-occupied');wordBindings.set(documentName,binding)
     try{return await wordStages.load(documentName,context,document)}catch(error){closeWordBinding(documentName);throw error}
    }
    const selected=room(documentName),leave=enterRoom(selected);loadReleases.set(documentName,leave)
    try{
      if(selected.fixed){loadReleases.delete(documentName);leave();return new Y.Doc()}
      if(isWordRoomProtocol(selected.protocol)){
       const layout=selected.protocol===wordLayoutProtocol
       if(!wordRoomsEnabled||layout&&!wordLayoutRoomsEnabled)throw new Error('HCD regional room is disabled')
       const journal=wordJournal(selected,true),saved=await journal.load(),storyRecovery=!layout&&saved?.capsule.version===4
       // Version 2/3 still belongs to the layout-aware coordinator, not this
       // legacy room. Opting into story recovery must not open those journals.
       if(saved&&!storyRecovery&&saved.capsule.version!==(layout?3:1))throw new Error('word-layout-coordinator-required')
       const storeId=await wordRecoveryStoreId(wordStateRoot,api,secret),lease=new WordRoomLease({epoch:selected.epoch,storeId,journalHashes:journal.knownHashes(),request:(route,init)=>request(selected.documentId,route,{...init,headers:{...init?.headers,...((storyRecovery||layout)&&route==='/collaboration/word-owner'?{'X-HCD-Word-Story-Recovery':'1'}:{})}},selectedSession(selected)),onLost:async reason=>{
        console.error('[word-owner-lost]',{room:documentName,reason})
        const owner=wordCoordinators.get(documentName);owner?.freeze()
        const document=server.hocuspocus.documents.get(documentName);for(const connection of document?.getConnections()??[]){connection.readOnly=true;connection.close({code:4409,reason:'HCD regional room owner lost; reconnect'})}
        if(owner)await owner.archiveRecovery(reason)
       }})
       wordLeases.set(documentName,lease);await lease.acquire()
       if(storyRecovery){
        await recoverCommittedWordStory({journal,lease,protocol:wordRegionalProtocol,request:(route,init)=>wordRequest(selected,route,init),assertStopped:()=>{if(wordCoordinators.has(documentName)||wordBindings.has(documentName))throw new Error('word-story-room-active')}})
        // Recovery does not upgrade the wire protocol. Keep legacy rooms
        // closed until a layout-aware editor and packet fence are available.
        throw new Error('word-story-recovery-complete-editor-upgrade-required')
       }
       const binding=new WordRoomBinding({journal,protocol:selected.protocol,...(layout?{layoutAwareLive:true}:{}),assertOwnership:()=>lease.assert(),maintainOwnership:()=>lease.renew(),recordDurable:(_hash,ancestors)=>lease.recordJournal(ancestors),request:(route,init)=>wordRequest(selected,route,init)},()=>{if(!loadReleases.has(documentName))throw new Error('word-host-load-not-admitted')})
       wordBindings.set(documentName,binding);return await binding.load()
      }
      const session=selectedSession(selected),response=await request(selected.documentId,'/collaboration/state',{},session)
      if(selected.protocol===inlineProtocol&&!inlineRoomsEnabled)throw new Error('HCD inline room is disabled')
      const projection=await currentProjection(selected.documentId,session)
      let document:Y.Doc,legacyProblem=false
      if(response.ok){
        document=new Y.Doc({gc:selected.protocol!==inlineProtocol});Y.applyUpdate(document,new Uint8Array(await response.arrayBuffer()))
        if(selected.protocol===structuralProtocol||selected.protocol===inlineProtocol){const store=new SemanticBlockStore(document,selected.protocol===inlineProtocol?inlineSchema:structureSchema,undefined,selected.protocol===inlineProtocol?{inlineContainers:true}:{});if(!store.initialized)throw new Error('Structural state is not initialized');store.project()}
        else try{upgradeTypography(document,projection)}catch{legacyProblem=true}
      }else{
        if(response.status!==404)throw new Error(`HCD collaboration load failed: ${response.status}`)
        if(selected.protocol===structuralProtocol||selected.protocol===inlineProtocol){const inline=selected.protocol===inlineProtocol,schema=inline?inlineSchema:structureSchema;document=new Y.Doc({gc:!inline});new SemanticBlockStore(document,schema,undefined,inline?{inlineContainers:true}:{}).initialize(schema.nodeFromJSON(projectionToJson(projection,inline?{inlineContainers:true}:{})));if(inline)document.getMap('hcdSchema').set('inlineContainers',1)}
        else document=TiptapTransformer.toYdoc(projectionToJson(projection),'default',schemaExtensions)
        document.getMap('hcdSchema').set('typography',2);document.getMap('hcdSchema').set('sourceIdentity',1)
      }
      loaded.set(documentName,{projection,legacyProblem,stateHash:response.ok?response.headers.get('x-hcd-state-hash')??'invalid':'none'})
      return document
    }catch(error){closeWordBinding(documentName);await wordLeases.get(documentName)?.close();wordLeases.delete(documentName);loaded.delete(documentName);loadReleases.delete(documentName);leave();throw error}
  },
  async afterLoadDocument({ documentName, document,context }) {
    const selected=room(documentName)
    if(selected.fixed)return
    try{
      if(isWordRoomProtocol(selected.protocol)){
       const protocol=selected.protocol
       requireWordLease(documentName);const binding=wordBindings.get(documentName);if(!binding)throw new Error('word-host-binding-unavailable')
       if(wordStages.has(documentName)&&wordStages.binding(documentName,context,document)!==binding)throw new Error('word-host-stage-context')
       const owner=await binding.attach(document,{autoSave:!wordStages.has(documentName),
        uploadActorAuthorized:async actor=>{try{await uploadMember(selected,actor);return true}catch{return false}},uploadRequest:async(actor,route,init={})=>{const token=await uploadMember(selected,actor);return fetch(`${api}/v1/documents/${encodeURIComponent(selected.documentId)}${route}`,{...init,headers:{'X-HCD-Node-Edits-Version':String(nodeEditWireVersion),'X-HCD-Flow-Layout-Version':'2','X-HCD-Collaboration-Epoch':String(selected.epoch),'X-HCD-Collaboration-Protocol':selected.protocol,...init.headers,Authorization:`Bearer ${token}`}})},
        actorForOrigin:origin=>{if(!isTransactionOrigin(origin)||origin.source!=='connection'||origin.connection.readOnly)return;const user=origin.connection.context as User;if(user.scope!=='write'||Date.now()>=user.expiresAt*1000||!roomMatches(selected,user)||!user.userId)return;return{userId:user.userId,displayName:user.displayName,scope:'write'}},
        broadcast:state=>document.broadcastStateless(JSON.stringify(wordState(state,protocol)))})
       if(wordStages.has(documentName))wordStages.attached(documentName,context,document,owner)
       wordCoordinators.set(documentName,owner);protocolGuards.set(documentName,wordRoomGuard(owner.model,id=>owner.imageRegion(id),{block:id=>owner.canonicalBlockRegion(id),text:id=>owner.canonicalTextRegion(id)},selected.protocol));return
      }
      const initial=loaded.get(documentName);if(!initial)throw new Error('Missing collaboration baseline');loaded.delete(documentName)
      const inline=selected.protocol===inlineProtocol
      const coordinator=new SemanticSaveCoordinator({...selected,document,secret,stateHash:initial.stateHash,...(inline?{inlineContainers:1 as const}:{}),...(selected.protocol===structuralProtocol||inline?{structure:new SemanticBlockStore(document,inline?inlineSchema:structureSchema,undefined,inline?{inlineContainers:true}:{})}:{}),request:(route,init)=>request(selected.documentId,route,init,selectedSession(selected)),broadcast:state=>document.broadcastStateless(JSON.stringify(state))})
      coordinators.set(documentName,coordinator)
      await coordinator.initialize(initial.projection,initial.legacyProblem)
      changeObservers.set(documentName,observeCoordinatorChanges(document,(user,origin)=>coordinator.changed(user,origin),origin=>isTransactionOrigin(origin)&&origin.source==='connection'&&!origin.connection.readOnly?origin.connection.context as User:undefined))
      protocolGuards.set(documentName,inline?inlineRoomGuard(document,inlineSchema):new RoomProtocolGuard(document,selected.protocol))
    }catch(error){closeWordBinding(documentName);wordCoordinators.delete(documentName);if(!wordStages.has(documentName)){await wordLeases.get(documentName)?.close();wordLeases.delete(documentName)}coordinators.get(documentName)?.dispose();coordinators.delete(documentName);throw error}
    finally{loadReleases.get(documentName)?.();loadReleases.delete(documentName)}
  },
  async onStoreDocument({documentName}){if(!migrationGate.blocked(room(documentName).documentId)){await coordinators.get(documentName)?.persist();if(wordCoordinators.has(documentName)){try{requireWordLease(documentName)}catch{return}await wordCoordinators.get(documentName)?.persist()}}},
  async onStateless({ documentName, connection, payload }) {
    const regional=wordCoordinators.get(documentName)
    if(regional){
     const protocol=room(documentName).protocol;if(!isWordRoomProtocol(protocol))return
     if(payload.length>4096)return
     let message:any;try{message=JSON.parse(payload)}catch{return}
     if(message.type==='hcd-restore-ready'){const round=restoreRounds.get(room(documentName).documentId);if(round&&message.requestId===round.requestId&&round.asked.has(connection)){if(message.ready===true)round.ready.add(connection);else round.failed=true}return}
     if(message.type==='hcd-word-topology-ready'){if(protocol===wordLayoutProtocol){await revalidate(documentName,connection);wordTopologyRounds.accept(room(documentName).documentId,connection,message)}return}
     if(message.type==='hcd-save-state'){connection.sendStateless(JSON.stringify(wordState(regional.state(),protocol)));return}
     if(message.type!=='hcd-save'||!/^[a-f0-9-]{36}$/.test(message.requestId??'')||!/^[a-f0-9]{64}$/.test(message.digest??'')||!/^[a-f0-9]{64}$/.test(message.imageDigest??''))return
     const reply=(state:WordSaveStatus)=>connection.sendStateless(JSON.stringify({...wordState(state,protocol),requestId:message.requestId}))
     try{const user=await revalidate(documentName,connection);if(connection.readOnly||user.scope!=='write'){reply({...regional.state(),status:'failed',problem:'read-only'});return}reply(await regional.save(message.digest,message.imageDigest))}catch{reply({...regional.state(),status:'failed'})}
     return
    }
    const coordinator = coordinators.get(documentName)
    if (!coordinator || payload.length > 4096) return
    let message: { type?: string; version?:number; requestId?: string; digest?: string; imageDigest?: string }
    try { message = JSON.parse(payload) } catch { return }
    if(message.type==='hcd-restore-ready'){
      const round=restoreRounds.get(room(documentName).documentId)
      if(round&&message.requestId===round.requestId&&round.asked.has(connection)){
        if((message as {ready?:boolean}).ready===true)round.ready.add(connection);else round.failed=true
      }
      return
    }
    if(message.type==='hcd-protocol-ready'&&message.version===1&&/^[a-f0-9-]{36}$/.test(message.requestId??'')){
      protocolReady.add(connection)
      connection.sendStateless(JSON.stringify({type:'hcd-protocol-ready',version:1,requestId:message.requestId,ready:true}));return
    }
    if (message.type === 'hcd-save-state') {
      try { connection.sendStateless(JSON.stringify(await coordinator.inspect())) }
      catch { connection.sendStateless(JSON.stringify(coordinator.state('failed'))) }
      return
    }
    if (message.type !== 'hcd-save' || !/^[a-f0-9-]{36}$/.test(message.requestId ?? '') || !/^[a-f0-9]{64}$/.test(message.digest ?? '') || !/^[a-f0-9]{64}$/.test(message.imageDigest ?? '')) return
    const reply = (state: object) => connection.sendStateless(JSON.stringify({ ...state, requestId: message.requestId }))
    try {
      const user = await revalidate(documentName,connection)
      if (connection.readOnly || user.scope !== 'write') { reply({ type: 'hcd-save-status', status: 'failed', conflict: 'read-only' }); return }
      const result = await coordinator.save(message.digest,message.imageDigest)
      reply(result)
    } catch(error) { console.error('HCD coordinated save failed:',error instanceof Error?error.message:'unknown error');reply({ type: 'hcd-save-status', status: 'failed' }) }
  },
  async beforeUnloadDocument({ documentName,document }) {
    if(wordStages.beforeUnload(documentName,document,wordCoordinators.get(documentName)))return
    if(wordRetirements.before(documentName,document,wordCoordinators.get(documentName)))return
    if(migrationGate.blocked(room(documentName).documentId))throw new Error('HCD room migration is in progress')
    await coordinators.get(documentName)?.prepareUnload()
    if(wordCoordinators.has(documentName)){try{requireWordLease(documentName)}catch{await wordLeases.get(documentName)?.settled();return}await wordCoordinators.get(documentName)?.drain()}
    if(migrationGate.blocked(room(documentName).documentId))throw new Error('HCD room migration is in progress')
  },
  async afterUnloadDocument({ documentName }) {
    if(wordStages.afterUnload(documentName,wordCoordinators.get(documentName))){
      // The installer disposes the candidate only after rollback is proven.
      wordBindings.delete(documentName);wordCoordinators.delete(documentName);wordUploadTokens.delete(documentName)
      protocolGuards.get(documentName)?.destroy();protocolGuards.delete(documentName);loaded.delete(documentName)
      return
    }
    if(wordRetirements.finish(documentName,wordCoordinators.get(documentName))){
      closeWordBinding(documentName);wordCoordinators.delete(documentName);wordUploadTokens.delete(documentName)
      protocolGuards.get(documentName)?.destroy();protocolGuards.delete(documentName);loaded.delete(documentName)
      loadReleases.get(documentName)?.();loadReleases.delete(documentName)
      return // The next coordinated room inherits the still-held lease.
    }
    changeObservers.get(documentName)?.();changeObservers.delete(documentName)
    coordinators.get(documentName)?.dispose()
    coordinators.delete(documentName)
    closeWordBinding(documentName);wordCoordinators.delete(documentName);wordUploadTokens.delete(documentName)
    await wordLeases.get(documentName)?.close();wordLeases.delete(documentName)
    protocolGuards.get(documentName)?.destroy();protocolGuards.delete(documentName)
    loaded.delete(documentName)
    loadReleases.get(documentName)?.();loadReleases.delete(documentName)
  },
})

function activeWordPeers(selected:ReturnType<typeof room>){
 const result:Connection[]=[]
 for(const [key,document] of server.hocuspocus.documents){const other=room(key);if(other.documentId!==selected.documentId)continue
  if(document.getConnectionsCount()&&(other.fixed||other.protocol!==wordLayoutProtocol||other.epoch!==selected.epoch))throw Error('word-topology-client-upgrade-required')
  for(const peer of document.getConnections()){const current=peer.context as User;if(!['read','write'].includes(current.scope)||Date.now()>=current.expiresAt*1000)throw Error('word-topology-client-busy');result.push(peer)}
 }
 return result
}
function activeWordOwner(id:string,epoch:number){
     const selected=room(`${id}:${epoch}:wordregions2:save6`),name=wordSidecarRoomName(selected),binding=wordBindings.get(name),owner=wordCoordinators.get(name),lease=requireWordLease(name)
     if(!binding||!owner||!owner.ownsJournal(binding.journal))return undefined
     return{room:owner,journal:binding.journal,assertOwnership:()=>{lease.assert();if(requireWordLease(name)!==lease||wordBindings.get(name)!==binding||wordCoordinators.get(name)!==owner)throw Error('word-owner-unavailable')},request:(route:string,init?:RequestInit)=>wordRequest(selected,route,init)}
}
async function cancelActiveLayoutContext(selected:ReturnType<typeof room>,pending:import('./src/wordCheckpointJournal.ts').WordLayoutPending|import('./src/wordCheckpointJournal.ts').WordPendingStory|import('./src/wordLinkProof.ts').WordPendingLink,authorize:()=>Promise<import('./src/wordTopologyAuthority.ts').WordTopologyMember>){
 const name=wordSidecarRoomName(selected),id=selected.documentId,owner=wordCoordinators.get(name),binding=wordBindings.get(name),lease=requireWordLease(name),transactionId=pending.request.transactionId
 if(!owner||!binding||!owner.isLayoutAwareLive()||!owner.ownsJournal(binding.journal))throw Error('word-active-layout-room-unavailable')
 const ownership=()=>{lease.assert();if(requireWordLease(name)!==lease||wordCoordinators.get(name)!==owner||wordBindings.get(name)!==binding)throw Error('word-owner-unavailable')}
 const ready=()=>wordTopologyRounds.assertReady(id,transactionId,activeWordPeers(selected))
 const options={gate:migrationGate,room:owner,journal:binding.journal,pending,assertOwnership:ownership,assertClientsReady:ready,authorize,request:async(route:string,init?:RequestInit)=>{ownership();const response=await wordRequest(selected,route,init);ownership();return response}}
 try{
  if(await confirmCancelledActiveWordLayout(options))return
  await wordTopologyRounds.prepare(id,transactionId,()=>activeWordPeers(selected),()=>{ownership();if(migrationGate.blocked(id))throw Error('word-active-layout-room-unavailable')})
  await cancelActiveWordLayout(options)
 }finally{if(!migrationGate.blocked(id))wordTopologyRounds.release(id,transactionId)}
}
type ActiveTopologyAction={kind:'layout';pending:import('./src/wordCheckpointJournal.ts').WordLayoutPending}|{kind:'story';pending:import('./src/wordCheckpointJournal.ts').WordPendingStory;reviewHash:string}|{kind:'link';pending:import('./src/wordLinkProof.ts').WordPendingLink;reviewHash:string}
function activeLayoutContext(selected:ReturnType<typeof room>,pending:import('./src/wordCheckpointJournal.ts').WordLayoutPending):WordActiveLayoutContext{return activeTopologyContext(selected,{kind:'layout',pending})}
function activeTopologyContext(selected:ReturnType<typeof room>,action:ActiveTopologyAction):WordActiveLayoutContext{
 const pending=action.pending

 const name=wordSidecarRoomName(selected),id=selected.documentId,previous=wordCoordinators.get(name),binding=wordBindings.get(name),lease=requireWordLease(name),host=server.hocuspocus
 if(!previous||!binding||!previous.isLayoutAwareLive()||!previous.ownsJournal(binding.journal))throw Error('word-active-layout-room-unavailable')
 const journal=binding.journal,operation=action.kind==='story'?'word-story-unlink':action.kind==='link'?'word-story-link':'word-layout-change',identity=JSON.stringify(pending),transactionId=pending.request.transactionId
 const ownership=()=>{if(requireWordLease(name)!==lease)throw Error('word-owner-unavailable')}
 const requestFor=async(route:string,init?:RequestInit)=>{ownership();const response=await wordRequest(selected,route,init);ownership();return response}
 const held=()=>migrationGate.heldIdentity(id,operation,identity)
 const source=()=>{ownership();if(!previous.ownsJournal(journal))throw Error('word-layout-journal-mismatch');if(!wordRetirements.retired(name,previous,migrationGate,journal))previous.assertTopologyHeld()}
 const peers=()=>{const current=activeWordPeers(selected);if((action.kind==='story'&&current.some(peer=>(peer.context as User).wordStoryVersion!==1))||(action.kind==='link'&&current.some(peer=>(peer.context as User).wordLinkVersion!==1)))throw Error('word-topology-client-upgrade-required');return current}
 const cleanup=async(dispose:boolean)=>{
  const retained=wordStages.retained(name)
  await wordStages.rollback(name,host,()=>{
   if(wordBindings.has(name)&&wordBindings.get(name)!==retained.binding||wordCoordinators.has(name)&&wordCoordinators.get(name)!==retained.owner)throw Error('word-host-stage-registry-changed')
   wordBindings.delete(name);wordCoordinators.delete(name);wordUploadTokens.delete(name);protocolGuards.get(name)?.destroy();protocolGuards.delete(name)
  })
  if(dispose)retained.owner?.dispose()
 }
 const create=async()=>{
  source();if(wordStages.has(name))await cleanup(true)
  let context:object
  const nextBinding=new WordRoomBinding({journal,protocol:wordLayoutProtocol,layoutAwareLive:true,assertOwnership:ownership,maintainOwnership:()=>lease.renew(),recordDurable:(_hash,ancestors)=>lease.recordJournal(ancestors),request:requestFor},()=>{wordStages.binding(name,context)})
  context=wordStages.reserve({name,id,operation,identity,gate:migrationGate,lease,binding:nextBinding,assertSource:source},host)
  try{
   const document=await host.createDocument(name,new Request('http://127.0.0.1/internal-word-layout-install'),'word-layout-install',{isAuthenticated:true,readOnly:false},context),owner=wordCoordinators.get(name)
   if(!owner||owner.model.document!==document||wordBindings.get(name)!==nextBinding)throw Error('word-host-stage-not-installed')
   wordStages.assertInstalled(name,owner,host);return owner
  }catch(error){try{await cleanup(true)}catch(cleanupError){throw Error('word-active-layout-stage-cleanup-uncertain',{cause:cleanupError})}throw error}
 }
 let next:WordSaveCoordinator|undefined
 return{
  held,
  prepare:async()=>{
   ownership()
   // Reject a durably cancelled replay before asking live members to pause.
   // The transition checks again under its exclusive gate before preparation.
   if(await journal.topologyAbandoned(transactionId))throw Error('word-topology-cancelled')
   ownership();await wordTopologyRounds.prepare(id,transactionId,peers,()=>{ownership();if(migrationGate.blocked(id)||wordCoordinators.get(name)!==previous||wordBindings.get(name)!==binding)throw Error('word-active-layout-room-unavailable')})
  },
  transition:async authorize=>{const common={gate:migrationGate,room:previous,journal,lease,authorize:()=>authorize(),request:requestFor,protocol:wordLayoutProtocol,assertClientsReady:()=>wordTopologyRounds.assertReady(id,transactionId,peers())};if(action.kind==='story')await transitionWordStory({...common,pending:action.pending,reviewHash:action.reviewHash});else if(action.kind==='link')await transitionWordLink({...common,pending:action.pending,reviewHash:action.reviewHash});else await transitionWordLayout({...common,pending:action.pending})},
  promote:async authorize=>{const common={gate:migrationGate,journal,lease,authorize:()=>authorize(),request:requestFor,protocol:wordLayoutProtocol,assertStopped:source};if(action.kind==='story')await promoteRecoveredWordStory({...common,pending:action.pending});else if(action.kind==='link')await promoteHeldWordLink({...common,pending:action.pending});else await promoteHeldWordLayout({...common,pending:action.pending})},
  isRetired:()=>wordRetirements.retired(name,previous,migrationGate,journal),
  retire:()=>retireWordRoom({host,registry:wordRetirements,name,id,operation,owner:previous,gate:migrationGate,lease,journal}),
  install:async authorize=>{const common={mode:'layout-live' as const,gate:migrationGate,authorize:()=>authorize(),previous,journal,lease,request:requestFor,retirement:{registry:wordRetirements,name},create,install:async()=>{},assertInstalled:(owner:WordSaveCoordinator)=>{wordStages.assertInstalled(name,owner,host);if(wordCoordinators.get(name)!==owner)throw Error('word-host-stage-not-installed')},uninstall:async(owner:WordSaveCoordinator)=>{if(wordStages.retained(name).owner!==owner)throw Error('word-host-stage-owner');await cleanup(false)},assertUninstalled:()=>{if(wordStages.has(name)||host.documents.has(name)||wordBindings.has(name)||wordCoordinators.has(name))throw Error('word-host-stage-still-installed')}};next=await(action.kind==='story'?installLayoutDraftRoom({...common,operation:'word-story-unlink',pending:action.pending}):action.kind==='link'?installLayoutDraftRoom({...common,operation:'word-story-link',pending:action.pending}):installLayoutDraftRoom({...common,operation:'word-layout-change',pending:action.pending}))},
  activate:()=>{if(!next)throw Error('word-active-layout-not-installed');wordStages.activate(name,next,host)},
  release:()=>wordTopologyRounds.release(id,transactionId),
 }
}

type FrozenSource={document:Y.Doc;coordinator:SemanticSaveCoordinator;release:()=>void;owned:boolean}
const frozenSources=new Map<string,FrozenSource>()
async function sessionForService(id:string){const response=await request(id,'/auth');if(!response.ok)throw new Error('HCD authority unavailable');return requireCollaborationSession(await response.json(),{wordLayoutV2:true})}
const inlineMigrations=inlineRoomBootstrap(migrationGate,migrationJournal,inlineSchema,{
 session:sessionForService,request,
 active:id=>[...server.hocuspocus.documents].some(([name])=>{const selected=room(name);return !selected.fixed&&selected.documentId===id&&selected.protocol!==inlineProtocol}),
 canonical:async(id,session)=>{const response=await request(id,'/editor',{headers:{'X-HCD-Inline-Containers-Version':'1','X-HCD-Extension-Version':'3'}},session);if(!response.ok)throw new MigrationRejected(response.status,'inline-projection-unavailable');return response.json()},
 stateAbsent:async(id,session)=>{const response=await request(id,'/collaboration/state',{},session);if(response.status===404)return true;if(!response.ok)throw new MigrationRejected(response.status,'inline-state-unavailable');return false},
})
const migrations=new SidecarMigration(migrationGate,migrationJournal,{
 session:sessionForService,request,
 freeze(id){
  // A legacy editor may still own private uploads or an unflushed device journal.
  // Only the no-edit handoff surface can attest this connection is ready.
  for(const [name,document]of server.hocuspocus.documents){const selected=room(name);if(selected.fixed||selected.documentId!==id||selected.protocol!==legacyProtocol)continue
   for(const connection of document.getConnections())if(!connection.readOnly&&!protocolReady.has(connection))throw new MigrationRejected(409,'migration-online-clients')
  }
  for(const [name,coordinator]of coordinators){const selected=room(name);if(!selected.fixed&&selected.documentId===id&&selected.protocol===legacyProtocol){coordinator.dispose();server.hocuspocus.documents.get(name)?.broadcastStateless(JSON.stringify({type:'hcd-save-status',status:'conflict',conflict:'protocol-transition'}))}}},
 async prepare(id,session){
  const retained=frozenSources.get(id);if(retained)return retained.coordinator.prepareMigration(structureSchema,session.collaborationEpoch+1)
  const manifestResponse=await request(id,'');if(!manifestResponse.ok)throw new Error('HCD manifest unavailable')
  const manifest=await manifestResponse.json() as {source:{format:string}}
  if(!['docx','html','md','txt'].includes(manifest.source.format))throw new MigrationRejected(409)
  const existing=[...server.hocuspocus.documents].find(([name])=>{const selected=room(name);return !selected.fixed&&selected.documentId===id&&selected.epoch===session.collaborationEpoch&&selected.protocol===legacyProtocol})
  let source:FrozenSource
  if(existing){
    const [name,document]=existing,coordinator=coordinators.get(name);if(!coordinator)throw new Error('HCD room baseline unavailable')
    document.addDirectConnection();source={document,coordinator,release:()=>document.removeDirectConnection(),owned:false}
    document.broadcastStateless(JSON.stringify({type:'hcd-save-status',status:'conflict',conflict:'protocol-transition'}))
  }else{
    const response=await request(id,'/collaboration/state',{},session),projection=await currentProjection(id,session)
    let document:Y.Doc,legacyProblem=false
    if(response.ok){document=new Y.Doc();Y.applyUpdate(document,new Uint8Array(await response.arrayBuffer()));try{upgradeTypography(document,projection)}catch{legacyProblem=true}}
    else{if(response.status!==404)throw new Error('HCD source unavailable');document=TiptapTransformer.toYdoc(projectionToJson(projection),'default',schemaExtensions);document.getMap('hcdSchema').set('typography',2);document.getMap('hcdSchema').set('sourceIdentity',1)}
    const coordinator=new SemanticSaveCoordinator({documentId:id,epoch:session.collaborationEpoch,document,secret,autoSave:false,stateHash:response.ok?response.headers.get('x-hcd-state-hash')??'invalid':'none',request:(route,init)=>request(id,route,init,session),broadcast:()=>{}})
    source={document,coordinator,release:()=>{},owned:true};frozenSources.set(id,source)
    await coordinator.initialize(projection,legacyProblem)
  }
  frozenSources.set(id,source)
  return source.coordinator.prepareMigration(structureSchema,session.collaborationEpoch+1)
 },
 async rollback(id){
  const source=frozenSources.get(id)
  if(source){if(source.owned){source.coordinator.dispose();source.document.destroy()}source.release();frozenSources.delete(id)}
  for(const [name,coordinator]of coordinators){const selected=room(name);if(selected.fixed||selected.documentId!==id||selected.protocol!==legacyProtocol)continue;coordinator.resume();server.hocuspocus.documents.get(name)?.broadcastStateless(JSON.stringify(coordinator.state()))}
 },
 async committed(id){
  for(const [name,document]of server.hocuspocus.documents){const selected=room(name);if(selected.fixed||selected.documentId!==id||selected.protocol!==legacyProtocol)continue
    const coordinator=coordinators.get(name);if(coordinator){await coordinator.archive();coordinator.dispose();coordinators.delete(name)}
    for(const connection of document.getConnections())connection.close({code:4409,reason:'HCD document protocol upgraded; reload'})
    setTimeout(()=>{void server.hocuspocus.unloadDocument(document)},0)
  }
  const source=frozenSources.get(id);if(source){source.coordinator.dispose();if(source.owned)source.document.destroy();source.release();frozenSources.delete(id)}
 },
})
function requireInlineRestoreModel(headers:import('node:http').IncomingHttpHeaders){
 if(!inlineRoomsEnabled||headers['x-hcd-inline-containers-version']!=='1'||headers['x-hcd-extension-version']!=='3'||headers['x-hcd-node-edits-version']!==String(nodeEditWireVersion)||headers['x-hcd-custom-marks-version']!=='1')throw new MigrationRejected(426,'restore-model-upgrade')
}
function restoreWriters(id:string,context:RestoreContext){
 const writers:Connection[]=[]
 for(const[name,document]of server.hocuspocus.documents){const selected=room(name);if(selected.documentId!==id)continue
  for(const connection of document.getConnections())if((connection.context as User).scope==='write'){
   if(selected.fixed||selected.protocol!==restoreProtocol(context)||selected.epoch!==context.fromEpoch)throw new MigrationRejected(409,'restore-online-clients')
   writers.push(connection)
  }
 }
 return writers
}
const restores=new SidecarRestore(migrationGate,restoreJournal,{
 async quiesce(id,requestId,context){
  if(migrationGate.blocked(id))throw new MigrationRejected(409,'restore-pending')
  const round:RestoreRound={...context,requestId,asked:new Set(),ready:new Set(),failed:false};restoreRounds.set(id,round)
  // Layout-word writers drain through the same hcd-restore-prepare handshake;
  // a client predating it never answers, so the round fails closed on the
  // timeout below. Writers in a mismatched room (v1, presence, stale epoch)
  // still throw from restoreWriters.
  const deadline=Date.now()+15000
  while(true){const writers=restoreWriters(id,round)
   for(const connection of writers)if(!round.asked.has(connection)){round.asked.add(connection);connection.sendStateless(JSON.stringify({type:'hcd-restore-prepare',requestId}))}
   if(round.failed)throw new MigrationRejected(409,'restore-client-busy')
   if(writers.every(connection=>round.ready.has(connection)))return
   if(Date.now()>deadline)throw new MigrationRejected(409,'restore-online-clients')
   await new Promise(resolve=>setTimeout(resolve,50))
  }
 },
 freeze(id){const round=restoreRounds.get(id);if(round){if(round.failed||restoreWriters(id,round).some(connection=>!round.ready.has(connection)))throw new MigrationRejected(409,'restore-online-clients')}},
 async prepare(id,expected,context){
  const session=await sessionForService(id)
  if(session.collaborationProtocol!==restoreProtocol(context)||session.collaborationEpoch!==context.fromEpoch)throw new MigrationRejected(409,'restore-session-changed')
  if(restoreProtocol(context)===wordLayoutProtocol){
   // quiesce/freeze proved every writer is paused and synced; flush the room
   // checkpoint once more so a drained update lands durably and moves the
   // journal tip. Native refuses `/collaboration/state` for regional rooms,
   // so the fence is the tip the owner store confirmed from this lease, not
   // room bytes: any durable room write after quiesce advances it and the
   // native journal fails the commit closed.
   const name=wordSidecarRoomName({documentId:id,epoch:context.fromEpoch,fixed:false,protocol:wordLayoutProtocol})
   const lease=wordLeases.get(name)
   if(!lease)throw new MigrationRejected(409,'restore-room-unavailable')
   const roomCoordinator=wordCoordinators.get(name)
   if(roomCoordinator){try{await roomCoordinator.persist()}catch{throw new MigrationRejected(409,'restore-room-unavailable')}}
   return lease.headers()['X-HCD-Word-Journal-Hash']
  }
  const entry=[...coordinators].find(([name])=>{const selected=room(name);return selected.documentId===id&&selected.epoch===session.collaborationEpoch&&selected.protocol===restoreProtocol(context)})
  if(!entry)throw new MigrationRejected(409,'restore-room-unavailable')
  try{return await entry[1].prepareRestore(expected)}catch{throw new MigrationRejected(409,'restore-comparison-changed')}
 },
 submit:job=>request(job.documentId,`/collaboration/restore/${job.target}`,{method:'POST',headers:{'Content-Type':'application/json','X-HCD-Coordinator-Version':'4',...(restoreProtocol(job.request)===wordLayoutProtocol?{'X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'}:{})},body:JSON.stringify(job.request)},{collaborationEpoch:job.request.fromEpoch,collaborationProtocol:restoreProtocol(job.request)}),
 async release(id){
  const round=restoreRounds.get(id);restoreRounds.delete(id)
  for(const[name,document]of server.hocuspocus.documents){if(room(name).documentId!==id)continue;if(!migrationGate.blocked(id))coordinators.get(name)?.resume();if(round)document.broadcastStateless(JSON.stringify({type:'hcd-restore-release',requestId:round.requestId}))}
 },
 async committed(id,receipt){
  restoreRounds.delete(id)
  const rounds=[...server.hocuspocus.documents].filter(([name])=>{const selected=room(name);return selected.documentId===id&&!selected.fixed&&selected.epoch<receipt.collaborationEpoch})
  // Broadcast before any teardown: closing a layout room binding can drop
  // the room's connections, and a member that misses the committed frame
  // can only fence and reload instead of following the rotated epoch. The
  // client follow already tolerates the 4409 close that lands right behind
  // this broadcast, so delivering first is what makes the follow reliable.
  for(const[,document]of rounds)document.broadcastStateless(JSON.stringify({type:'hcd-restore-committed',...receipt}))
  for(const[name,document]of rounds){const selected=room(name)
   coordinators.get(name)?.dispose()
   coordinators.delete(name)
   if(isWordRoomProtocol(selected.protocol)){closeWordBinding(name);wordCoordinators.delete(name);await wordLeases.get(name)?.close();wordLeases.delete(name);wordUploadTokens.delete(name)}
   for(const connection of document.getConnections())connection.close({code:4409,reason:'HCD document restored; reopen current revision'})
   setTimeout(()=>{void server.hocuspocus.unloadDocument(document)},0)
  }
 },
})
server.listen()
let stopping=false
const stop=()=>{if(stopping)return;stopping=true;void server.destroy().then(()=>process.exit(0),()=>process.exit(1))}
process.once('SIGTERM',stop);process.once('SIGINT',stop)
