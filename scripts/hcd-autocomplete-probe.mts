import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')),phase=process.argv[3],expected=Number(process.argv[4]);assert.ok(/^[a-z-]{1,32}$/.test(phase)&&[0,1].includes(expected))
const actor=process.argv.includes('--peer-text')?config.bob:config.alice
const base=config.origin+'/v1/documents/mentions-docx',headers={Authorization:'Bearer '+actor,'X-HCD-Node-Edits-Version':'4'},authority=await(await fetch(base+'/auth',{headers})).json(),document=new Y.Doc(),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),store=new SemanticBlockStore(document,schema)
const provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(`ws://127.0.0.1:${config.ports[1]}`),name:`mentions-docx:${authority.collaborationEpoch}:structure3:save4`,document,token:actor,WebSocketPolyfill:WebSocket})
try{
 const deadline=Date.now()+30000;while(!provider.isSynced||!store.initialized||provider.hasUnsyncedChanges){if(Date.now()>deadline)throw new Error('probe sync timeout');await new Promise(resolve=>setTimeout(resolve,40))}
 if(process.argv.includes('--peer-text')){assert.ok(!store.project().textContent.includes('Bob 补全时输入'));store.insert([schema.nodes.paragraph.createChecked(null,schema.text('Bob 补全时输入'))],null);while(provider.hasUnsyncedChanges){if(Date.now()>deadline)throw new Error('peer edit sync timeout');await new Promise(resolve=>setTimeout(resolve,40))}}
 const text=store.project().textContent;assert.ok(text.includes('Originalab'));assert.equal(text.split('自动补全验证。').length-1,expected)
 const sharedKeys=[...document.share.keys()];assert.ok(!sharedKeys.some(key=>/ghost|autocomplete|ai-private/.test(key)))
 if(expected===0&&phase==='before')assert.ok(!JSON.stringify(document.toJSON()).includes('自动补全验证。'))
 let revision=(await(await fetch(base,{headers})).json()).revision
 if(process.argv.includes('--save')){const reply=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(store.project().toJSON())),undefined,30000,await imageDraftDigest(document));assert.equal(reply.status,'saved',JSON.stringify(reply));assert.equal(reply.pending,false);revision=reply.revision}
 const folder=new URL('../docs/assets/hcd-ai-2026-10-24/',import.meta.url);await mkdir(folder,{recursive:true});await writeFile(new URL(`autocomplete-${phase}-socket-evidence.json`,folder),JSON.stringify({boundary:'independent real WebSocket client and coordinator; no browser hidden-state access',phase,revision,expectedAcceptedCount:expected,sharedKeys,validation:{manualInputPresent:true,peerRootEditInserted:process.argv.includes('--peer-text'),noPrivateGhostMap:true,acceptedTextCountVerified:true,...(phase==='before'?{noUnacceptedTextAnywhereInLiveSharedState:true}:{})}},null,2)+'\n');console.log(`PASS ${phase}: shared projection count ${expected}, canonical r${revision}, no private ghost maps`)
}finally{provider.destroy();document.destroy()}
