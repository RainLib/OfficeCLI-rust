/** Fresh real Socket members after stopped recovery, not a live link bridge. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {WordBrowserState} from '../examples/hdoc/editor/src/wordBrowserState.ts'
import {readWordBrowserProjection} from '../examples/hdoc/editor/src/wordBrowserProjection.ts'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),c=JSON.parse(await readFile(join(root,'private.json'),'utf8')),prior=JSON.parse(await readFile(join(out,'recovered-save.json'),'utf8'));assert.equal(c.root,root)
const clients:any[]=[],until=async(check:()=>boolean,label:string)=>{const deadline=Date.now()+45000;while(!check()){assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,25))}}
async function open(person:string){
 const document=new Y.Doc(),session={documentId:'region-test',format:'docx',scope:person==='reader'?'read':'write',userId:person,displayName:{alice:'Alice 王',bob:'Bob 李',reader:'reader'}[person],token:c[person],collaborationProtocol:'hcd-word-regions/2',collaborationEpoch:1,apiUrl:c.origin+'/v1/documents',collabUrl:'ws://127.0.0.1:'+c.collabPort} as any
 const provider=new HocuspocusProvider({url:session.collabUrl+'?hcdNodeEdits=7&hcdWordRegions=2&hcdWordLayout=1&hcdWordTopology=1&hcdWordStory=1',name:'region-test:1:wordregions2:save6',document,token:session.token})
 const controller=new WordBrowserState({document,provider,scope:session.scope,protocol:session.collaborationProtocol,projection:(r,s)=>readWordBrowserProjection(session,r,s),onDisconnect:()=>provider.disconnect()})
 const value={document,provider,controller};clients.push(value);await until(()=>{const state=controller.state();if(state.problem)throw Error(state.problem);return state.ready},person+' ready');return value
}
const text=(client:any)=>client.controller.model.capture().regions.map((region:any)=>client.controller.model.project(region.regionId).textContent).join('\n')
function append(client:any,marker:string){const model=client.controller.model,region=model.layoutState().layout.sections[0].id,blocks=model.region(region),first=blocks.find((block:any)=>block.node.firstChild?.isText);assert.ok(first);model.reconcile(region,blocks,blocks.map((block:any)=>block.key===first.key?{key:block.key,node:first.node.type.createChecked(first.node.attrs,model.schema.text(first.node.textContent+' · '+marker,first.node.firstChild.marks))}:block))}
try{
 const alice=await open('alice'),bob=await open('bob'),reader=await open('reader');for(const client of clients){assert.ok(text(client).includes(prior.marker));assert.equal(client.controller.model.layoutState().layout.sections[1].headers.even,undefined)}
 const own='After link Alice',peer='After link Bob';append(bob,peer);await until(()=>text(alice).includes(peer),'Bob shared');const first=await bob.controller.save();assert.equal(first,prior.finalRevision+1)
 for(const client of clients)await until(()=>client.controller.state().saved&&client.controller.state().revision===first,'first peer save')
 append(alice,own);await until(()=>text(reader).includes(own),'Alice shared');const finalRevision=await alice.controller.save();assert.equal(finalRevision,first+1)
 for(const client of clients)await until(()=>client.controller.state().saved&&client.controller.state().revision===finalRevision,'final peer save')
 await writeFile(join(out,'peers.json'),JSON.stringify({scope:'actual sidecar loads promoted journal containing signed v5 history; three fresh Socket members continue normal content collaboration',initial:prior.initial,linkRevision:prior.linkRevision,recoverySaveRevision:prior.finalRevision,finalRevision,markers:{draft:prior.marker,own,peer},freshMembers:true,threeRolesSynchronized:true,linkStillApplied:true,liveLinkReplacement:false,normalLinkUI:false,personalHistoryAcrossLink:false,production:false},null,2)+'\n');console.log(JSON.stringify({finalRevision,threeRoles:true,freshMembers:true}))
}finally{for(const client of clients){client.controller.dispose();client.provider.destroy();client.document.destroy()}}
