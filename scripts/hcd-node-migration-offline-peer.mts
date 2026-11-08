import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {nodeSdkFixture} from '../examples/hdoc/editor/fixtures/nodeSdk.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
import {nodeEditStatus} from '../examples/hdoc/editor/src/extensionEdits.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'

const c=JSON.parse(await readFile(process.argv[2],'utf8')),base=c.origin+'/v1/documents/mentions-docx',headers={'X-HCD-Node-Edits-Version':'4',Authorization:'Bearer '+c.bob},auth=await(await fetch(base+'/auth',{headers})).json(),doc=new Y.Doc(),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),store=new SemanticBlockStore(doc,schema),registry=new NodeExtensionRegistry(nodeSdkFixture)
const provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${c.ports[1]}`),name:`mentions-docx:${auth.collaborationEpoch}:structure3:save4`,document:doc,token:c.bob,WebSocketPolyfill:WebSocket})
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+90000;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('Timeout: '+label)}
try{
 await until(()=>provider.isSynced&&store.initialized&&!provider.hasUnsyncedChanges,'initial peer')
 const entry=[...extensionNodes(store.project()).values()].find(item=>item.value.type==='example.notice')!;assert.equal(entry.value.version,1)
 provider.disconnect();await until(()=>provider.configuration.websocketProvider.status==='disconnected','offline')
 const blocks=store.blocks(),before=store.project(),after=registry.update(entry.value,{...entry.value.data,title:'离线成员修改保留'}),node=before.nodeAt(entry.position)!,{nodeId:_receipt,...fallback}=node.attrs.fallbackInline??{},tr=EditorState.create({schema,doc:before}).tr.setNodeMarkup(entry.position,undefined,{...node.attrs,extension:after,fallbackInline:{...fallback,text:after.fallback.text}})
 store.reconcile(blocks,tr.doc.content.content.map(node=>({key:node.attrs.hcdStructureKey,node})))
 await writeFile(c.root+'/migration-offline-peer-buffer.bin',Y.encodeStateAsUpdate(doc))
 await writeFile(c.root+'/migration-offline-peer-ready.json',JSON.stringify({epoch:auth.collaborationEpoch,instanceId:after.instanceId,version:after.version}))
 console.log('READY offline version-1 candidate captured')
 await until(async()=>{try{await readFile(c.root+'/migration-offline-peer-resume');return true}catch{return false}},'explicit resume signal')
 provider.connect();await until(()=>provider.isSynced&&!provider.hasUnsyncedChanges&&nodeEditStatus(doc,store.project()).conflicts.length===1,'whole-node schema conflict synchronized')
 const head=await(await fetch(base,{headers})).json()
 await writeFile(c.root+'/migration-offline-peer-evidence.json',JSON.stringify({scope:'Real independent WebSocket peer uses current wire model 2 with old business codec 1. Its offline property change races the browser migration.',canonicalRevisionAtConflict:head.revision,checks:{offlineCandidateRetained:true,wholeSchemaConflictObserved:true}},null,2)+'\n')
 console.log('PASS offline old-schema candidate joined the browser migration as an explicit conflict')
}finally{provider.destroy();doc.destroy()}
