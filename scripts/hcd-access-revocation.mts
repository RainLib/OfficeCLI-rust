import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
/** Real API + Hocuspocus test; private fixture config stays outside evidence. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {TiptapTransformer} from '../examples/hdoc/editor/node_modules/@hocuspocus/transformer/dist/hocuspocus-transformer.esm.js'
const config=JSON.parse(await readFile(process.argv[2],'utf8'))
async function call(token:string,route:string,method='GET',body?:unknown,headers:Record<string,string>={}){
 return fetch(`${config.apiUrl}/doc${route}`,{method,headers:{'X-HCD-Node-Edits-Version':'4',Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)})
}
async function until(predicate:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45_000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,50))}throw new Error(`Timeout: ${label}`)}
async function policy(expectedGeneration:number,readers:string[]|null,writers:string[]|null){const response=await call(config.manager,'/access','POST',{expectedGeneration,readers,writers});assert.equal(response.status,200);return response.json()}
const clients:HocuspocusProvider[]=[],docs:Y.Doc[]=[]
try{
 assert.equal((await call(config.alice,'/access')).status,403)
 assert.equal((await call(config.alice,'/access','POST',{expectedGeneration:0,readers:null,writers:[]})).status,403)
 assert.equal((await call(config.manager,'/auth')).status,403)
 const first=await policy(0,['alice','bob'],['alice','bob']);assert.equal(first.collaborationEpoch,1)
 const before=(await(await call(config.bob,'')).json()).revision
 let closed=0
 const doc=new Y.Doc();docs.push(doc)
 const provider=new HocuspocusProvider({url:nodeEditCollaborationUrl(config.collabUrl),name:'doc:1:typography2:save4',token:config.alice,document:doc,WebSocketPolyfill:WebSocket,onClose:()=>{closed++}})
 clients.push(provider)
 await until(()=>provider.isSynced,'initial room sync')
 const fragment=doc.getXmlFragment('default')
 const findText=(node:any):Y.XmlText|undefined=>{if(node instanceof Y.XmlText)return node;for(const child of node.toArray?.()??[]){const found=findText(child);if(found)return found}}
 const text=findText(fragment);assert.ok(text)
 text.insert(0,'Authorized ',text.toDelta()[0]?.attributes)
 await until(()=>!provider.hasUnsyncedChanges,'authorized update sync')
 const saved=await requestCoordinatedSave(provider,await checkpointDigest(jsonToSnapshot(TiptapTransformer.fromYdoc(doc,'default'))),undefined,15_000,await imageDraftDigest(doc))
 assert.equal(saved.status,'saved',JSON.stringify(saved))
 await until(async()=>(await(await call(config.bob,'')).json()).revision>before,'authorized autosave')
 const canonical=(await(await call(config.bob,'')).json()).revision
 const second=await policy(1,['alice','bob'],['bob']);assert.equal(second.collaborationEpoch,2)
 assert.equal((await call(config.alice,'/auth')).status,200)
 assert.equal((await(await call(config.alice,'/auth')).json()).scope,'read')
 await until(()=>closed>0,'idle stale-room close')
 text.insert(0,'Queued after revoke ')
 // A mutation service credential is restricted to coordinator routes.
 assert.equal((await call(config.service,'/edits','POST',{})).status,403)
 assert.equal((await call(config.service,'/collaboration/state','PUT',{}, {'X-HCD-Collaboration-Epoch':'1','X-HCD-Coordinator-Version':'4','X-HCD-State-Hash':'none'})).status,409)
 assert.equal((await call(config.alice,'/collaboration/reset','POST')).status,403)
 assert.equal((await call(config.manager,'/access','POST',{expectedGeneration:0,readers:null,writers:null})).status,409)
 const third=await policy(2,['bob'],['bob']);assert.equal(third.collaborationEpoch,3)
 assert.equal((await call(config.alice,'/auth')).status,403)
 await new Promise(r=>setTimeout(r,2500))
 assert.equal((await(await call(config.bob,'')).json()).revision,canonical)
 // The draft is retained locally; granting access does not validate its old room.
 assert.ok(fragment.toString().includes('Queued after revoke'))
 const grant=await policy(3,['alice','bob'],['alice','bob']);assert.equal(grant.collaborationEpoch,3)
 assert.equal((await call(config.service,'/collaboration/state','PUT',{}, {'X-HCD-Collaboration-Epoch':'1','X-HCD-Coordinator-Version':'4','X-HCD-State-Hash':'none'})).status,409)
 const result={schemaVersion:'hcd-access-evidence/1',initialEpoch:1,finalEpoch:3,authorizedRevision:canonical,finalRevision:canonical,ordinaryTokensCannotManage:true,managerCannotReadContent:true,staleGenerationRejected:true,serviceMutationRestricted:true,oldRoomFenced:true,idleConnectionClosed:true,localQueuedContentRetained:true,revokedWriteRejected:true,revokedReadRejected:true,grantDoesNotReviveOldRoom:true}
 await writeFile(config.root+'/access-evidence.json',JSON.stringify(result,null,2)+'\n')
 console.log('PASS real API + Hocuspocus: revocation, epoch fence, local draft and scoped authority')
}finally{for(const client of clients)client.destroy();for(const doc of docs)doc.destroy()}
