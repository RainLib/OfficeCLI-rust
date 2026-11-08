/** Controlled read-only WebSocket peer for the ordinary UI follow/wheel check. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {wordBrowserConnection} from '../examples/hdoc/editor/src/wordBrowserProtocol.ts'
import {structureViewportField} from '../examples/hdoc/editor/src/collaborationViewport.ts'
import type {Session} from '../examples/hdoc/editor/src/api.ts'
const root=resolve(process.argv[2]),c=JSON.parse(await readFile(root+'/private.json','utf8'))
assert.equal(c.root,root);assert.equal(c.bookSource,true);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
assert.equal(typeof c.bookQAPeer,'string')
const session={documentId:c.documentId,token:c.bookQAPeer,scope:'read',format:'docx',collabUrl:`ws://127.0.0.1:${c.collabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2'} as Session,connection=wordBrowserConnection(session),document=new Y.Doc(),provider=new HocuspocusProvider({...connection,document,token:session.token,WebSocketPolyfill:WebSocket})
try{
 const deadline=Date.now()+30_000
 while(!provider.isSynced){assert.ok(Date.now()<deadline,'read-only peer sync timed out');await new Promise(resolve=>setTimeout(resolve,50))}
 const sectionId=c.initialProjection.flowLayout.sections[1].id
 provider.awareness!.setLocalStateField('user',{id:'book-qa-peer',name:'Book QA',color:'#6b55b5'})
 provider.awareness!.setLocalStateField(structureViewportField,{version:1,owner:String(document.clientID),progress:.3,bookProgress:.6,anchor:null,book:1,sectionId,regionId:sectionId,variant:'default',paperIndex:1,paperProgress:.2})
 await writeFile(root+'/book-qa-peer.pid',String(process.pid))
 console.log(JSON.stringify({scope:'Controlled read-only WebSocket presence, not a second browser or content edit',sectionId,paperIndex:1,paperProgress:.2,pid:process.pid}))
 await new Promise<void>(resolve=>{const timer=setTimeout(resolve,600_000);const stop=()=>{clearTimeout(timer);resolve()};process.once('SIGINT',stop);process.once('SIGTERM',stop)})
}finally{provider.destroy();document.destroy()}
