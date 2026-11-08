import {recoveryDigest} from './recoveryDigest.ts'
import {validateSemanticImageChoice,type SemanticImageChoice} from './semanticImageFiles.ts'
import {ordinaryNodeResourceModel,inlineNodeResourceModel,type ResourceNodePayload} from './nodeResourceModel.ts'
import {imageDraftMap,imageIntents} from './collaborativeImages.ts'
/** Portable recovery transport. Checksums prove file consistency, never write
 * authority. Opening creates an isolated candidate; it cannot join a room. */
import * as Y from 'yjs'
import type {Schema,Node as PmNode} from '@tiptap/pm/model'
import {SemanticBlockStore} from './semanticBlockStore.ts'
import {extensionNodes,readExtensionNode} from './extensionNode.ts'
import {extensionEditIndex} from './extensionEdits.ts'
import {inlineContainerEditIndex} from './inlineContainerEdits.ts'
import {readInlineContainerPayload} from './inlineContainerPayload.ts'
import {inlineDeletionField,validateInlineDeletionReceipts} from './inlineDeletionReview.ts'
import {deletionReviews} from './deletionReview.ts'
import {validateNodeResources,type NodeResource} from './extensionPortable.ts'
import {validateResourceDraft,pendingNodeResource,type WordNodeResourceDraft} from './wordNodeResources.ts'
import {recoveryResourcePool} from './recoveryResourceBatch.ts'
import {awaitRecoveryPreparation} from './boundedResponse.ts'
import {writeRecoveryJson} from './recoveryJsonWriter.ts'

const MiB=1024*1024
export const semanticRecoveryLimits=Object.freeze({file:96*MiB,canonical:48*MiB,state:8*MiB,resources:16*MiB,resourceCount:256,pendingFiles:16})
export type RecoveryScope={documentId:string;epoch:number;model:'structure3'|'structure3-inline1';revision:number;rootHash:string}
type Binary={byteLength:number;sha256:string;base64:string}
type Pending=Omit<WordNodeResourceDraft<ResourceNodePayload>,'bytes'>
type PendingImage=Omit<SemanticImageChoice,'bytes'>
type Archive={schemaVersion:'hcd-semantic-recovery/1'|'hcd-semantic-recovery/2'|'hcd-semantic-recovery/3';scope:RecoveryScope;canonical:Binary;state:Binary;resources:Binary[];pendingFiles:Pending[];pendingImages?:PendingImage[]}
function* archiveJson(archive:Archive):Generator<string>{
 yield '{"schemaVersion":';yield JSON.stringify(archive.schemaVersion);yield ',"scope":';yield JSON.stringify(archive.scope)
 const binaryParts=function*(value:Binary){yield `{"byteLength":${value.byteLength},"sha256":${JSON.stringify(value.sha256)},"base64":"`;yield value.base64;yield '"}'}
 yield ',"canonical":';yield* binaryParts(archive.canonical);yield ',"state":';yield* binaryParts(archive.state);yield ',"resources":['
 for(let i=0;i<archive.resources.length;i++){if(i)yield ',';yield* binaryParts(archive.resources[i])}
 yield '],"pendingFiles":';yield JSON.stringify(archive.pendingFiles)
 if(archive.pendingImages!==undefined){yield ',"pendingImages":';yield JSON.stringify(archive.pendingImages)}
 yield '}'
}
export type CanonicalRecoveryVerifier=(bytes:Uint8Array,scope:Readonly<RecoveryScope>)=>Promise<void>
export type RecoveryCandidate={kind:'isolated-recovery-candidate';scope:Readonly<RecoveryScope>;canonical:Uint8Array;document:Y.Doc;store:SemanticBlockStore;resources:Map<string,Uint8Array>;pendingFiles:WordNodeResourceDraft<ResourceNodePayload>[];pendingImages:SemanticImageChoice[];dispose:()=>void}
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',')
const hex=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const fail=(code='semantic-recovery-invalid'):never=>{throw new Error(code)}
const digest=recoveryDigest
function scope(input:unknown):RecoveryScope{const value=input as RecoveryScope;if(!exact(value,['documentId','epoch','model','revision','rootHash'])||typeof value.documentId!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(value.documentId)||![value.epoch,value.revision].every(n=>Number.isSafeInteger(n)&&n>=0)||!['structure3','structure3-inline1'].includes(value.model)||!hex(value.rootHash))fail();return{documentId:value.documentId,epoch:value.epoch,model:value.model,revision:value.revision,rootHash:value.rootHash}}
async function encode(bytes:Uint8Array,signal:AbortSignal){
 // A multiple of three keeps padding confined to the final segment, so the
 // concatenation is exactly the canonical encoding of the complete input.
 const output:string[]=[],segment=192*1024
 for(let start=0;start<bytes.length;start+=segment){
  signal.throwIfAborted();const end=Math.min(start+segment,bytes.length),parts:string[]=[]
  for(let i=start;i<end;i+=8192)parts.push(String.fromCharCode(...bytes.subarray(i,Math.min(i+8192,end))))
  output.push(btoa(parts.join('')))
  if(end<bytes.length){await new Promise<void>(resolve=>setTimeout(resolve,0));signal.throwIfAborted()}
 }
 signal.throwIfAborted();return output.join('')
}
const base64Digit=(code:number)=>code>=65&&code<=90?code-65:code>=97&&code<=122?code-71:code>=48&&code<=57?code+4:code===43?62:code===47?63:-1
async function binary(bytes:Uint8Array,max:number,signal:AbortSignal):Promise<Binary>{if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>max)fail('semantic-recovery-limit');const sha256=await awaitRecoveryPreparation(()=>digest(bytes),signal);signal.throwIfAborted();return{byteLength:bytes.length,sha256,base64:await encode(bytes,signal)}}
async function decode(input:unknown,max:number,signal:AbortSignal):Promise<Uint8Array>{
 // Worker-transferred bytes are accepted only with the same envelope and
 // integrity checks. The worker validates canonical Base64 before transfer.
 if(exact(input,['byteLength','sha256','bytes'])){
  const value=input as {byteLength:number;sha256:string;bytes:Uint8Array}
  if(!Number.isSafeInteger(value.byteLength)||value.byteLength<1||value.byteLength>max||!hex(value.sha256)||!(value.bytes instanceof Uint8Array)||value.bytes.length!==value.byteLength)fail()
  signal.throwIfAborted();if(await awaitRecoveryPreparation(()=>digest(value.bytes),signal)!==value.sha256)fail('semantic-recovery-integrity');signal.throwIfAborted();return value.bytes
 }
 const value=input as Binary;if(!exact(value,['byteLength','sha256','base64'])||!Number.isSafeInteger(value.byteLength)||value.byteLength<1||value.byteLength>max||!hex(value.sha256)||typeof value.base64!=='string'||value.base64.length!==4*Math.ceil(value.byteLength/3))fail()
 const pad=(3-value.byteLength%3)%3,end=value.base64.length-pad,last=base64Digit(value.base64.charCodeAt(end-1))
 if(value.base64.slice(end)!=='='.repeat(pad)||last<0||pad===1&&(last&3)!==0||pad===2&&(last&15)!==0)fail()
 const bytes=new Uint8Array(value.byteLength),chunkSize=256*1024;let offset=0
 for(let start=0;start<value.base64.length;start+=chunkSize){
  signal.throwIfAborted();const stop=Math.min(start+chunkSize,value.base64.length)
  for(let i=start;i<Math.min(stop,end);i++)if(base64Digit(value.base64.charCodeAt(i))<0)fail()
  let raw:string;try{raw=atob(value.base64.slice(start,stop))}catch{fail()}
  if(offset+raw!.length>bytes.length)fail('semantic-recovery-integrity')
  for(let i=0;i<raw!.length;i++)bytes[offset+i]=raw!.charCodeAt(i)
  offset+=raw!.length
  if(stop<value.base64.length){await new Promise<void>(resolve=>setTimeout(resolve,0));signal.throwIfAborted()}
 }
 if(offset!==value.byteLength||await awaitRecoveryPreparation(()=>digest(bytes),signal)!==value.sha256)fail('semantic-recovery-integrity');signal.throwIfAborted();return bytes
}
function isolated(bytes:Uint8Array,expected:RecoveryScope,schema:Schema,allowImages=false){
 const document=new Y.Doc({gc:false})
 try{Y.applyUpdate(document,bytes,'hcd-recovery-isolated');if(document.getMap(imageDraftMap).size){if(!allowImages)fail('semantic-recovery-image-tasks-unsupported');imageIntents(document)}const store=new SemanticBlockStore(document,schema,undefined,expected.model==='structure3-inline1'?{inlineContainers:true}:{})
  if(!store.initialized||document.getXmlFragment('default').length||document.getMap('hcdSchema').get('inlineContainers')!==undefined&&document.getMap('hcdSchema').get('inlineContainers')!==(expected.model==='structure3-inline1'?1:undefined))fail('semantic-recovery-model')
  store.project().check();validateInlineDeletionReceipts(document);deletionReviews(store);return{document,store}
 }catch(error){document.destroy();throw error}
}
/** Retained bodies/definitions, hidden blocks, inline tombstones and all causal
 * envelope candidates can need bytes absent from the visible current document. */
export function semanticRecoveryResources(store:SemanticBlockStore,distinctNames=false):NodeResource[]{
 const found=new Map<string,NodeResource>(),lengths=new Map<string,number>()
 const image=(value:NodeResource)=>['image/png','image/jpeg','image/gif','image/webp'].includes(value.mediaType)
 // Assets are stored once per hash. Prefer an image descriptor so that the
 // staged asset has an image extension and is served with an image MIME type,
 // even when the same bytes also have generic attachment references.
 const add=(resources:NodeResource[]|undefined)=>{if(!resources)return;validateNodeResources(resources);for(const resource of resources){const length=lengths.get(resource.hash);if(length!==undefined&&length!==resource.byteLength)fail('semantic-recovery-resource-identity');lengths.set(resource.hash,resource.byteLength);const key=distinctNames?JSON.stringify([resource.hash,resource.name]):resource.hash,old=found.get(key);if(!old||image(resource)&&!image(old))found.set(key,structuredClone(resource))}}
 const node=(value:PmNode)=>{for(const entry of extensionNodes(value).values())add(entry.value.resources);if(value.attrs.extension)add(readExtensionNode(value.attrs.extension).resources)}
 for(const key of store.contents.keys()){try{node(store.content(key))}catch(error){if(error instanceof Error&&error.message==='missingBlock')continue;throw error}}
 if(store.flow.containers){
  for(const definition of store.flow.containers.definitions.values())add(readInlineContainerPayload(definition.node.attrs.extension).resources)
  for(const id of store.flow.containers.bodies.keys()){const body=store.flow.containers.readBody(id);body.descendants(child=>{if(child.type.name==='hcdExtensionInline')add(readExtensionNode(child.attrs.extension).resources)})}
  for(const group of inlineContainerEditIndex(store.document).values())for(const intent of group.intents)for(const value of [intent.root,intent.before,intent.after])add(value.resources)
 }
 for(const group of extensionEditIndex(store.document).values())for(const intent of group.intents)for(const value of [intent.root,intent.before,intent.after])add(value.resources)
 for(const raw of store.document.getMap(inlineDeletionField).values()){const value=raw as {version:number;node:{type:string;attrs:{extension?:unknown}}};if(value.node.type==='hcdExtensionInline')add(readExtensionNode(value.node.attrs.extension).resources)}
 return [...found.values()].sort((a,b)=>a.hash.localeCompare(b.hash)||a.name.localeCompare(b.name))
}
function pending(input:readonly WordNodeResourceDraft<ResourceNodePayload>[],model:RecoveryScope['model']){
 if(!Array.isArray(input)||input.length>semanticRecoveryLimits.pendingFiles)fail('semantic-recovery-limit')
 const seen=new Set<string>(),out:WordNodeResourceDraft<ResourceNodePayload>[]=[]
 for(const value of input){validateResourceDraft(value,model==='structure3-inline1'?inlineNodeResourceModel:ordinaryNodeResourceModel);if(!pendingNodeResource(value)||seen.has(value.id))fail('semantic-recovery-pending-file');seen.add(value.id);out.push(structuredClone(value))}
 return out
}
function pendingImageChoices(input:readonly SemanticImageChoice[]){
 if(!Array.isArray(input)||input.length>16)fail('semantic-recovery-limit')
 const allowed=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key))
 const image=(value:any)=>allowed(value,['nodeId','visualHash','assetHash','geometry','label'])&&allowed(value.geometry,['unit','x','y','width','height'])
 const seen=new Set<string>();return input.map(value=>{
  validateSemanticImageChoice(value)
  if(!allowed(value,['version','id','name','extension','hash','bytes','base','revision','page','phase','capture'])||!image(value.base)||!allowed(value.capture,['base','revision','clientId','seen','page'])||!image(value.capture.base)||value.capture.seen.some(entry=>!allowed(entry,['intentId','clientId','ancestors','touched','base','geometry','assetHash','revision','page'])||!image(entry.base)||!allowed(entry.geometry,['unit','x','y','width','height']))||!['chosen','staged','applying'].includes(value.phase)||seen.has(value.id))fail('semantic-recovery-pending-image')
  seen.add(value.id);return structuredClone(value)
 })
}
function inventory(store:SemanticBlockStore,files:readonly WordNodeResourceDraft<ResourceNodePayload>[],images:readonly SemanticImageChoice[]=[]){const resources=new Map(semanticRecoveryResources(store).map(value=>[value.hash,value]));for(const file of files)for(const value of [...(file.expected.resources??[]),file.resource]){const old=resources.get(value.hash);if(old&&old.byteLength!==value.byteLength)fail('semantic-recovery-resource-identity');resources.set(value.hash,value)}for(const image of images){const old=resources.get(image.hash);if(old&&old.byteLength!==image.bytes.length)fail('semantic-recovery-resource-identity');if(!old)resources.set(image.hash,{key:'image',hash:image.hash,byteLength:image.bytes.length,name:image.name,mediaType:'application/octet-stream'})}if(resources.size>semanticRecoveryLimits.resourceCount||[...resources.values()].reduce((sum,value)=>sum+value.byteLength,0)>semanticRecoveryLimits.resources)fail('semantic-recovery-limit');return resources}
async function verifiedCanonical(bytes:Uint8Array,value:RecoveryScope,verify:CanonicalRecoveryVerifier){if(typeof verify!=='function')fail('semantic-recovery-canonical-verifier-required');await verify(Uint8Array.from(bytes),Object.freeze({...value}))}
export async function createSemanticRecoveryArchive(input:{scope:RecoveryScope;document:Y.Doc;schema:Schema;canonical:Uint8Array;verifyCanonical:CanonicalRecoveryVerifier;readResource:(resource:Readonly<NodeResource>,signal:AbortSignal)=>Promise<Uint8Array>;pendingFiles:readonly WordNodeResourceDraft<ResourceNodePayload>[];pendingImages?:readonly SemanticImageChoice[];readImageResource?:(hash:string,signal:AbortSignal)=>Promise<Uint8Array>;signal?:AbortSignal}):Promise<Uint8Array>{
 const signal=input.signal??new AbortController().signal;signal.throwIfAborted()
 const captured=Y.encodeStateAsUpdate(input.document);if(captured.length>semanticRecoveryLimits.state||!(input.canonical instanceof Uint8Array)||input.canonical.length>semanticRecoveryLimits.canonical)fail('semantic-recovery-limit')
 const value=scope(input.scope),canonical=Uint8Array.from(input.canonical),files=pending(input.pendingFiles,value.model),images=pendingImageChoices(input.pendingImages??[]),copy=isolated(captured,value,input.schema,true)
 try{
  const state=await binary(captured,semanticRecoveryLimits.state,signal),base=await binary(canonical,semanticRecoveryLimits.canonical,signal);await awaitRecoveryPreparation(()=>verifiedCanonical(canonical,value,input.verifyCanonical),signal)
  signal.throwIfAborted()
  const required=inventory(copy.store,files,images),items=[...required.values()].sort((a,b)=>a.hash.localeCompare(b.hash))
  const resources=await recoveryResourcePool(items.map(item=>async batchSignal=>{const local=files.find(file=>file.resource.hash===item.hash),image=images.find(value=>value.hash===item.hash),bytes=local?local.bytes:image?image.bytes:await input.readResource(Object.freeze({...item}),batchSignal);batchSignal.throwIfAborted();const entry=await binary(Uint8Array.from(bytes),8*MiB,batchSignal);batchSignal.throwIfAborted();if(entry.byteLength!==item.byteLength||entry.sha256!==item.hash)fail('semantic-recovery-integrity');return entry}),signal)
  const drafts=imageIntents(copy.document),hashes=new Set(drafts.flatMap(draft=>[draft.base.assetHash,draft.assetHash].filter((hash):hash is string=>!!hash)))
  let resourceBytes=resources.reduce((sum,item)=>sum+item.byteLength,0)
  const missing=[...hashes].filter(hash=>!required.has(hash));if(resources.length+missing.length>semanticRecoveryLimits.resourceCount)fail('semantic-recovery-limit');if(missing.length&&!input.readImageResource)fail('semantic-recovery-image-resource-required')
  const extra=await recoveryResourcePool(missing.map(hash=>async batchSignal=>{const bytes=await input.readImageResource!(hash,batchSignal);batchSignal.throwIfAborted();const entry=await binary(Uint8Array.from(bytes),8*MiB,batchSignal);batchSignal.throwIfAborted();if(entry.sha256!==hash)fail('semantic-recovery-integrity');resourceBytes+=entry.byteLength;if(resourceBytes>semanticRecoveryLimits.resources)fail('semantic-recovery-limit');return entry}),signal)
  resources.push(...extra)
  signal.throwIfAborted()
  const archive:Archive={schemaVersion:drafts.length?'hcd-semantic-recovery/3':images.length?'hcd-semantic-recovery/2':'hcd-semantic-recovery/1',scope:value,canonical:base,state,resources,pendingFiles:files.map(({bytes:_bytes,...file})=>file),...(drafts.length||images.length?{pendingImages:images.map(({bytes:_bytes,...image})=>image)}:{})}
  return await writeRecoveryJson(archiveJson(archive),semanticRecoveryLimits.file,signal)
 }finally{copy.document.destroy()}
}
function validateArchive(value:Archive):Archive{
 if(!value||typeof value!=='object'||Array.isArray(value))fail()
 if(value!.schemaVersion==='hcd-semantic-recovery/1'?!exact(value!,['schemaVersion','scope','canonical','state','resources','pendingFiles']):(value!.schemaVersion==='hcd-semantic-recovery/2'||value!.schemaVersion==='hcd-semantic-recovery/3')?!exact(value!,['schemaVersion','scope','canonical','state','resources','pendingFiles','pendingImages']):true)fail()
 return value
}
function parseArchive(bytes:Uint8Array):Archive{
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>semanticRecoveryLimits.file)fail('semantic-recovery-limit')
 let value!:Archive;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{fail()}
 return validateArchive(value)
}
export function semanticRecoveryArchiveScope(bytes:Uint8Array):RecoveryScope{return scope(parseArchive(bytes).scope)}
type OpenOptions={scope:RecoveryScope;schema:Schema;verifyCanonical:CanonicalRecoveryVerifier;signal?:AbortSignal}
/** Parse once for comparison while keeping the untrusted archive private. */
export function parseSemanticRecoveryArchive(bytes:Uint8Array){
 const archive=parseArchive(bytes),value=Object.freeze(scope(archive.scope))
 return{scope:value,open:(options:OpenOptions)=>openParsedArchive(archive,options)}
}
/** One bounded, cancellable worker lifecycle for byte and immutable file inputs. */
async function readRecoveryWorker(input:Uint8Array|Blob,signal:AbortSignal):Promise<{value:Archive;packetHash?:unknown}>{
 signal.throwIfAborted()
 if(typeof Worker==='undefined')throw Error('semantic-recovery-worker-unavailable')
 let worker:Worker
 try{worker=new Worker(new URL('./semanticRecoveryParseWorker.ts',import.meta.url),{type:'module'})}catch{throw Error('semantic-recovery-worker-unavailable')}
 return new Promise((resolve,reject)=>{
  let done=false;const timer=setTimeout(()=>finish(new Error('semantic-recovery-worker-unavailable')),30_000)
  const finish=(error?:unknown,value?:{value:Archive;packetHash?:unknown})=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);worker.terminate();error===undefined?resolve(value!):reject(error)}
  const aborted=()=>finish(signal.reason??new DOMException('Aborted','AbortError'))
  signal.addEventListener('abort',aborted,{once:true})
  worker.onmessage=event=>{const message=event.data as {ok?:boolean;value?:Archive;packetHash?:unknown};if(message?.ok!==true)finish(new Error('semantic-recovery-invalid'));else finish(undefined,{value:message.value!,packetHash:message.packetHash})}
  worker.onerror=()=>finish(new Error('semantic-recovery-worker-unavailable'))
  worker.onmessageerror=()=>finish(new Error('semantic-recovery-worker-unavailable'))
  if(signal.aborted){aborted();return}
  try{if(input instanceof Uint8Array){const copy=Uint8Array.from(input);worker.postMessage(copy.buffer,[copy.buffer])}else worker.postMessage({file:input})}catch{finish(new Error('semantic-recovery-worker-unavailable'))}
 })
}
/** Byte callers retain ownership of their input. Validate worker output on the
 * UI thread before any candidate or network request can be exposed. */
export async function parseSemanticRecoveryArchiveAsync(bytes:Uint8Array,signal:AbortSignal){
 signal.throwIfAborted();if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>semanticRecoveryLimits.file)fail('semantic-recovery-limit')
 let result:Awaited<ReturnType<typeof readRecoveryWorker>>
 try{result=await readRecoveryWorker(bytes,signal)}catch(error){signal.throwIfAborted();if(error instanceof Error&&error.message==='semantic-recovery-worker-unavailable')return parseSemanticRecoveryArchive(bytes);throw error}
 signal.throwIfAborted();const archive=validateArchive(result.value),value=Object.freeze(scope(archive.scope))
 return{scope:value,open:(options:OpenOptions)=>openParsedArchive(archive,options)}
}
/** File inputs are immutable: clone the Blob handle, not the complete JSON
 * bytes, into the worker. Keep the byte API for programmatic callers. A worker
 * result still passes the same envelope, per-binary digest and inventory checks. */
export async function parseSemanticRecoveryFileAsync(file:Blob,signal:AbortSignal){
 signal.throwIfAborted();if(!(file instanceof Blob)||!file.size||file.size>semanticRecoveryLimits.file)fail('semantic-recovery-limit')
 let result:Awaited<ReturnType<typeof readRecoveryWorker>>
 try{result=await readRecoveryWorker(file,signal)}catch(error){
  signal.throwIfAborted();if(!(error instanceof Error)||error.message!=='semantic-recovery-worker-unavailable')throw error
  const buffer=await awaitRecoveryPreparation(()=>file.arrayBuffer(),signal);signal.throwIfAborted()
  if(buffer.byteLength!==file.size)fail('semantic-recovery-invalid')
  const bytes=new Uint8Array(buffer),parsed=parseSemanticRecoveryArchive(bytes),packetHash=await awaitRecoveryPreparation(()=>digest(bytes),signal)
  signal.throwIfAborted();return{...parsed,packetHash}
 }
 signal.throwIfAborted();if(!hex(result.packetHash))fail('semantic-recovery-invalid')
 const archive=validateArchive(result.value),value=Object.freeze(scope(archive.scope))
 return{scope:value,packetHash:result.packetHash as string,open:(options:OpenOptions)=>openParsedArchive(archive,options)}
}
export async function openSemanticRecoveryArchive(bytes:Uint8Array,options:OpenOptions):Promise<RecoveryCandidate>{options.signal?.throwIfAborted();return parseSemanticRecoveryArchive(bytes).open(options)}
async function openParsedArchive(archive:Archive,options:OpenOptions):Promise<RecoveryCandidate>{
 const signal=options.signal??new AbortController().signal;signal.throwIfAborted()
 if(!Array.isArray(archive!.resources)||archive!.resources.length>semanticRecoveryLimits.resourceCount||!Array.isArray(archive!.pendingFiles)||archive!.pendingFiles.length>semanticRecoveryLimits.pendingFiles||archive!.schemaVersion!=='hcd-semantic-recovery/1'&&(!Array.isArray(archive!.pendingImages)||archive!.pendingImages.length>16||archive!.schemaVersion==='hcd-semantic-recovery/2'&&!archive!.pendingImages.length))fail()
 const value=scope(archive!.scope),expected=scope(options.scope);if(JSON.stringify(value)!==JSON.stringify(expected))fail('semantic-recovery-scope')
 const canonical=await decode(archive!.canonical,semanticRecoveryLimits.canonical,signal),state=await decode(archive!.state,semanticRecoveryLimits.state,signal);await awaitRecoveryPreparation(()=>verifiedCanonical(canonical,value,options.verifyCanonical),signal);signal.throwIfAborted()
 const copy=isolated(state,value,options.schema,archive!.schemaVersion==='hcd-semantic-recovery/3')
 try{
  const resources=new Map<string,Uint8Array>();let total=0
  for(const entry of archive!.resources){const bytes=await decode(entry,8*MiB,signal);if(resources.has(entry.sha256)||(total+=bytes.length)>semanticRecoveryLimits.resources)fail('semantic-recovery-resource-inventory');resources.set(entry.sha256,bytes)}
  const files=pending(archive!.pendingFiles.map(file=>{if(!file||!exact(file,['version','id','regionId','expected','resource','phase']))fail();const bytes=resources.get(file.resource?.hash);if(!bytes)fail('semantic-recovery-resource-inventory');return{...file,bytes:bytes!}}),value.model),images=pendingImageChoices((archive!.pendingImages??[]).map(image=>{const keys=['version','id','name','extension','hash','base','revision','phase','capture',...(image?.page!==undefined?['page']:[])];if(!exact(image,keys))fail();const bytes=resources.get(image.hash);if(!bytes)fail('semantic-recovery-resource-inventory');return{...image,bytes:bytes!}})),required=inventory(copy.store,files,images)
  const drafts=imageIntents(copy.document),draftHashes=new Set(drafts.flatMap(draft=>[draft.base.assetHash,draft.assetHash].filter((hash):hash is string=>!!hash)))
  if(archive!.schemaVersion==='hcd-semantic-recovery/3'&&!drafts.length)fail('semantic-recovery-invalid')
  const all=new Set([...required.keys(),...draftHashes]);if(resources.size!==all.size)fail('semantic-recovery-resource-inventory')
  for(const [hash,bytes]of resources)if(!all.has(hash)||required.has(hash)&&required.get(hash)?.byteLength!==bytes.length)fail('semantic-recovery-resource-inventory')
  signal.throwIfAborted();return{kind:'isolated-recovery-candidate',scope:Object.freeze(value),canonical,document:copy.document,store:copy.store,resources,pendingFiles:files,pendingImages:images,dispose:()=>copy.document.destroy()}
 }catch(error){copy.document.destroy();throw error}
}
