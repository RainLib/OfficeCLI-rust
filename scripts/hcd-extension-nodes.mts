import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import assert from 'node:assert/strict'
import {readFile,writeFile,open} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),log=await open(config.root+'/sidecar.log','a')
const child=spawn(process.execPath,['--import','tsx','sidecar.ts'],{cwd:fileURLToPath(new URL('../examples/hdoc/editor/',import.meta.url)),env:{...process.env,HCD_API_URL:config.origin,HCD_COLLAB_BIND:'127.0.0.1',HCD_COLLAB_PORT:String(config.collabPort),HCD_TOKEN_SECRET:config.secret,HCD_SIDECAR_STATE_DIR:config.root+'/sidecar-state'},stdio:['ignore',log.fd,log.fd]})
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check:()=>boolean|Promise<boolean>,name:string){const until=Date.now()+25000;while(Date.now()<until){if(await check())return;await pause(50)}throw new Error('Timeout: '+name)}
let provider:HocuspocusProvider|undefined,document:Y.Doc|undefined
try{
 await until(async()=>{try{return(await fetch(`http://127.0.0.1:${config.collabPort}`,{signal:AbortSignal.timeout(500)})).status===200}catch{return false}},'sidecar listens')
 const selected=await fetch(`http://127.0.0.1:${config.collabPort}/v1/documents/doc/collaboration/negotiate`,{method:'POST',headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.alice}`},signal:AbortSignal.timeout(45000)});assert.equal(selected.status,200,await selected.clone().text());const authority=await selected.json()
 document=new Y.Doc();const store=new SemanticBlockStore(document,schema)
 provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${config.collabPort}`),name:`doc:${authority.collaborationEpoch}:structure3:save4`,document,token:config.alice,WebSocketPolyfill:WebSocket})
 await until(()=>provider!.isSynced&&store.initialized&&!provider!.hasUnsyncedChanges,'extension-aware room')
 const envelopes=()=>jsonToSnapshot(store.project().toJSON()).flatMap(block=>[...(block.content.extension?[block.content.extension]:[]),...block.content.inlines.flatMap(inline=>inline.extension?[inline.extension]:[])])
 const original=envelopes();assert.equal(original.length,2)
 store.insert([schema.node('paragraph',null,schema.text('Unrelated collaborative input retained'))],null)
 await until(()=>!provider!.hasUnsyncedChanges,'input synchronized')
 const saved=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,30000,await imageDraftDigest(document));assert.equal(saved.status,'saved',JSON.stringify(saved));assert.equal(saved.pending,false)
 const response=await fetch(config.origin+'/v1/documents/doc/editor',{headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${config.alice}`}});assert.equal(response.status,200);const projected=await response.json()
 const actual=projected.blocks.flatMap((block:any)=>[...(block.content.extension?[block.content.extension]:[]),...block.content.inlines.flatMap((inline:any)=>inline.extension?[inline.extension]:[])])
 assert.deepEqual(actual,original);assert.ok(projected.blocks.some((block:any)=>block.content.inlines.some((inline:any)=>inline.text.includes('Unrelated collaborative input retained'))))
 await writeFile(config.root+'/socket-evidence.json',JSON.stringify({realStructuralSocketSavePreservedUnknownEnvelopes:true,savedRevision:saved.revision,unrelatedInputRetained:true}))
 console.log('PASS real structural socket save preserved unknown inline/block extension payloads')
}finally{provider?.destroy();document?.destroy();child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',()=>resolve());setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL')},3000).unref()});await log.close()}
