import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
const assets=process.argv[3]??'docs/assets/hcd-inline-deletion-2026-10-26'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8')),path=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`,digest=async()=>createHash('sha256').update(await readFile(path)).digest('hex'),before=await digest(),document=new Y.Doc();let rejected=false
let done!:()=>void;const complete=new Promise<void>(resolve=>{done=resolve}),provider=new HocuspocusProvider({url:`ws://127.0.0.1:${c.ports[1]}?hcdNodeEdits=5`,name:`mentions-docx:${meta.epoch}:structure3:save4`,document,token:c.alice,WebSocketPolyfill:WebSocket,onAuthenticationFailed:()=>{rejected=true;done()},onSynced:()=>done()});const timer=setTimeout(done,10000)
try{await complete;assert.equal(rejected,true);assert.equal(provider.isSynced,false);assert.equal(await digest(),before);assert.equal(JSON.parse(await readFile(c.root+'/mentions-docx.hcd/manifest.json','utf8')).revision,7);await writeFile(assets+'/old-socket-fence.json',JSON.stringify({wire:5,rejectedBeforeSync:true,nativeBytesUnchanged:true,head:7},null,2)+'\n');console.log('PASS old wire5 rejected before sync; persisted bytes and head7 unchanged')}finally{clearTimeout(timer);provider.disconnect();provider.destroy();await provider.configuration.websocketProvider.destroy();document.destroy()}
