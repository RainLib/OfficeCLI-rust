/** Real native/sidecar preflight and ordinary saves. This does not submit a
 * link transaction, replace rooms, or claim a normal link UI is available. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {WordBrowserState} from '../examples/hdoc/editor/src/wordBrowserState.ts'
import {readWordBrowserProjection} from '../examples/hdoc/editor/src/wordBrowserProjection.ts'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),c=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(c.root,root);assert.equal(c.clean,true);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/);await mkdir(out,{recursive:true})
const headers={'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Link-Version':'1'},clients:any[]=[],checks:Record<string,unknown>={}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await sleep(25)}throw Error(label+' timeout')}
async function post(selection:unknown,person='alice',version=true){const supplied={...headers,Authorization:'Bearer '+c[person]};if(!version)delete(supplied as Partial<typeof supplied>)['X-HCD-Word-Link-Version'];const response=await fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/region-test/collaboration/word-active-link-preview`,{method:'POST',headers:supplied,body:JSON.stringify({epoch:1,selection}),signal:AbortSignal.timeout(45000)});return{status:response.status,body:await response.json()}}
async function head(){const response=await fetch(c.origin+'/v1/documents/region-test',{headers:{Authorization:'Bearer '+c.reader,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7'},signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);return(await response.json()).revision}
async function open(person:string){
 const document=new Y.Doc(),session={documentId:'region-test',format:'docx',scope:person==='reader'?'read':'write',userId:person,displayName:{alice:'Alice 王',bob:'Bob 李',reader:'reader'}[person],token:c[person],collaborationProtocol:'hcd-word-regions/2',collaborationEpoch:1,apiUrl:c.origin+'/v1/documents',collabUrl:'ws://127.0.0.1:'+c.collabPort} as any
 const provider=new HocuspocusProvider({url:session.collabUrl+'?hcdNodeEdits=7&hcdWordRegions=2&hcdWordLayout=1&hcdWordTopology=1&hcdWordStory=1',name:'region-test:1:wordregions2:save6',document,token:session.token})
 const controller=new WordBrowserState({document,provider,scope:session.scope,protocol:session.collaborationProtocol,projection:(r,s)=>readWordBrowserProjection(session,r,s),onDisconnect:()=>provider.disconnect()})
 const client={document,provider,controller,close(){controller.dispose();provider.destroy();document.destroy()}};clients.push(client)
 await until(()=>{const state=controller.state();if(state.problem)throw Error(state.problem);return state.ready},person+' ready');return client
}
function append(client:any,region:string,text:string){
 const model=client.controller.model,blocks=model.region(region),first=blocks.find((block:any)=>block.node.type.name==='paragraph');assert.ok(first)
 const marks=first.node.firstChild?.isText?first.node.firstChild.marks:undefined
 const replacement=first.node.type.createChecked(first.node.attrs,[...Array.from({length:first.node.childCount},(_,i)=>first.node.child(i)),model.schema.text(' · '+text,marks)])
 model.reconcile(region,blocks,blocks.map((block:any)=>block.key===first.key?{key:block.key,node:replacement}:block))
}
const text=(client:any,region:string)=>client.controller.model.project(region).textContent
try{
 const alice=await open('alice'),bob=await open('bob'),reader=await open('reader'),initial=await head(),layout=alice.controller.model!.layoutState().layout,section=layout.sections[1]
 assert.ok(section.headers.even);const selection={sectionId:section.id,kind:'header',variant:'even',transactionId:randomUUID().replaceAll('-','')}
 const inherited=layout.sections[0].headers.even??null
 const first=await post(selection);checks.firstResponse=first;assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.summary.inheritedStoryId,inherited);assert.equal(first.body.summary.retainedStoryId,section.headers.even);assert.equal(first.body.summary.affectedSections,1)
 assert.deepEqual(await post(selection),first);assert.equal(await head(),initial);checks.stableReadOnlyPreview=true
 assert.equal((await post(selection,'reader')).status,403);assert.equal((await post(selection,'alice',false)).status,426);checks.readerAndLegacyRefused=true
 const marker='Link body retained '+randomUUID().slice(0,8),bodyRegion=layout.sections[0].id;append(alice,bodyRegion,marker)
 await until(()=>text(bob,bodyRegion).includes(marker),'shared body draft');assert.equal((await post(selection)).status,200);assert.equal(await head(),initial);checks.unrelatedDraftPreserved=true
 const saved=await alice.controller.save();for(const client of [alice,bob,reader])await until(()=>client.controller.state().saved&&client.controller.state().revision===saved,'body saved')
 const fresh=await post(selection);assert.equal(fresh.status,200);assert.equal(fresh.body.revision,saved);assert.notEqual(fresh.body.reviewHash,first.body.reviewHash)
 const headerMarker='Retained header draft '+randomUUID().slice(0,8);append(bob,section.headers.even!,headerMarker);await until(()=>text(alice,section.headers.even!).includes(headerMarker),'shared displaced header draft')
 const pending=await post(selection);assert.equal(pending.status,409);assert.equal(pending.body.code,'word-story-source-draft-pending');assert.equal(await head(),saved);checks.displacedDraftRefused=true
 let finalRevision=await bob.controller.save();for(const client of [alice,bob,reader])await until(()=>client.controller.state().saved&&client.controller.state().revision===finalRevision,'header saved')
 let inheritedMarker:string|undefined
 if(inherited){inheritedMarker='Inherited image header draft '+randomUUID().slice(0,8);append(alice,inherited,inheritedMarker);await until(()=>text(bob,inherited).includes(inheritedMarker!),'inherited draft shared');const pending=await post(selection);assert.equal(pending.status,409);assert.equal(pending.body.code,'word-story-source-draft-pending');checks.inheritedDraftRefused=true;finalRevision=await alice.controller.save();for(const client of [alice,bob,reader])await until(()=>client.controller.state().saved&&client.controller.state().revision===finalRevision,'inherited header saved')}
 const final=await post(selection);assert.equal(final.status,200);assert.equal(final.body.revision,finalRevision);assert.equal(await head(),finalRevision)
 assert.equal(alice.controller.model!.layoutState().layout.sections[1].headers.even,section.headers.even)
 const auth={Authorization:'Bearer '+c.reader,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7'}
 for(const [format,route]of [['docx',`/export/docx?revision=${finalRevision}`],['hcdz',`/export/hcdz?revision=${finalRevision}`]]){const response=await fetch(c.origin+'/v1/documents/region-test'+route,{headers:auth,signal:AbortSignal.timeout(60000)});assert.equal(response.status,200,format+' export');await writeFile(join(out,'ordinary-save.'+format),Buffer.from(await response.arrayBuffer()))}
 await writeFile(join(out,'service.json'),JSON.stringify({scope:'actual native/sidecar and three authenticated Socket clients; read-only link review and ordinary collaborative content saves',nativeBinarySha256:c.nativeBinarySha256,initial,bodyRevision:saved,finalRevision,selection,checks,markers:{body:marker,header:headerMarker,...(inheritedMarker?{inherited:inheritedMarker}:{})},first:first.body,final:final.body,linkSubmitted:false,normalUI:false,physicalDevice:false,production:false},null,2)+'\n');console.log(JSON.stringify({initial,finalRevision,checks,linkSubmitted:false}))
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({message:error instanceof Error?error.message:String(error),checks},null,2)+'\n');throw error}
finally{for(const client of clients)client.close()}
