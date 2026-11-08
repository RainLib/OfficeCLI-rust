// Create a deletion-versus-peer-edit conflict in an owned regional preview.
// Reads credentials only from the preview's private fixture file; never prints them.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {WordRegionStore,wordRegionSchema,wordRegionStoreField} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {deletionReviews} from '../examples/hdoc/editor/src/deletionReview.ts'
const config=JSON.parse(await readFile(process.argv[2],'utf8')), schema=wordRegionSchema()
const response=await fetch(`http://127.0.0.1:${config.ports[0]}/v1/documents/region-ui/editor`,{headers:{Authorization:`Bearer ${config.tokens.alice}`,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7'}})
assert.equal(response.status,200)
const projection=await response.json(), body=projection.flowLayout.sections[0].id
const until=async(check:()=>boolean,label:string)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(check())return;await new Promise(resolve=>setTimeout(resolve,30))}throw Error('Timeout: '+label)}
const clients=['alice','bob'].map(person=>{const document=new Y.Doc({gc:false}),provider=new HocuspocusProvider({url:`ws://127.0.0.1:${config.ports[1]}?hcdNodeEdits=7&hcdWordRegions=1`,name:'region-ui:1:wordregions1:save5',token:config.tokens[person],document,WebSocketPolyfill:WebSocket}),model=new WordRegionStore(document,schema,'region-ui',projection.flowLayout,projection.flowLayoutHash);return{document,provider,model}})
try{
 await until(()=>clients.every(c=>c.provider.isSynced&&!c.provider.hasUnsyncedChanges&&c.document.getMap(wordRegionStoreField).size>0),'connect')
 const [a,b]=clients, ar=a.model.region(body),br=b.model.region(body),idx=ar.findIndex(item=>item.node.textContent.includes('后续冲突'));assert.ok(idx>=0);assert.equal(ar[idx].key,br[idx].key)
 // Both operations are made synchronously before either socket receives an update.
 a.model.structure.remove([ar[idx].key])
 const original=br[idx].node,updated=original.type.createChecked(original.attrs,schema.text(original.textContent+' 同伴并发修改'))
 b.model.reconcile(body,br,br.map((item,i)=>({key:item.key,node:i===idx?updated:item.node})))
 await until(()=>clients.every(c=>!c.provider.hasUnsyncedChanges&&deletionReviews(c.model.structure).length>0),'conflict synchronized')
 console.log(JSON.stringify({conflicts:deletionReviews(a.model.structure).length,retained:deletionReviews(a.model.structure)[0].node.textContent}))
}finally{for(const c of clients){c.provider.destroy();c.document.destroy()}}
