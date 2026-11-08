/** Actual sidecar/native story transaction and lost-response acceptance.
 * Uses explicit Socket clients, not the unfinished normal story UI. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {WordBrowserState} from '../examples/hdoc/editor/src/wordBrowserState.ts'
import {readWordBrowserProjection} from '../examples/hdoc/editor/src/wordBrowserProjection.ts'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),c=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(c.root,root);assert.equal(c.clean,true);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/);await mkdir(out,{recursive:true})
const origin=`http://127.0.0.1:${c.collabPort}`,headers={'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Story-Version':'1'},clients:any[]=[],errors:string[]=[]
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(check:()=>boolean|Promise<boolean>,label:string){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await sleep(25)}throw Error(label+' timeout')}
async function post(action:string,body:unknown,person='alice',base=origin){const response=await fetch(`${base}/v1/documents/region-test/collaboration/word-active-story-${action}`,{method:'POST',headers:{...headers,Authorization:'Bearer '+c[person]},body:typeof body==='string'?body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});return{status:response.status,body:await response.json()}}
async function head(){const r=await fetch(c.origin+'/v1/documents/region-test',{headers:{Authorization:'Bearer '+c.reader,'X-HCD-Flow-Layout-Version':'2','X-HCD-Node-Edits-Version':'7'}});assert.equal(r.status,200);return(await r.json()).revision}
async function open(person:string,story=true){
 const document=new Y.Doc(),session={documentId:'region-test',format:'docx',scope:person==='reader'?'read':'write',userId:person,displayName:{alice:'Alice 王',bob:'Bob 李',reader:'reader'}[person],token:c[person],collaborationProtocol:'hcd-word-regions/2',collaborationEpoch:1,apiUrl:c.origin+'/v1/documents',collabUrl:'ws://127.0.0.1:'+c.collabPort} as any
 const provider=new HocuspocusProvider({url:session.collabUrl+'?hcdNodeEdits=7&hcdWordRegions=2&hcdWordLayout=1&hcdWordTopology=1'+(story?'&hcdWordStory=1':''),name:'region-test:1:wordregions2:save6',document,token:session.token})
 const controller=new WordBrowserState({document,provider,scope:session.scope,protocol:session.collaborationProtocol,projection:(r,s)=>readWordBrowserProjection(session,r,s),onDisconnect:()=>provider.disconnect()})
 let paused=false;controller.setTopologyInputPause(()=>{paused=true;return()=>{paused=false}})
 const value={document,provider,controller,get paused(){return paused},close(){controller.dispose();provider.destroy();document.destroy()}};clients.push(value)
 await until(()=>{const s=controller.state();if(s.problem)throw Error(s.problem);return s.ready},person+' ready');return value
}
function append(client:any,text:string){assert.equal(client.paused,false);const model=client.controller.model,region=model.layoutState().layout.sections[0].id,blocks=model.region(region),first=blocks.find((b:any)=>b.node.type.name==='paragraph'&&b.node.firstChild?.isText);assert.ok(first);const node=first.node.type.createChecked(first.node.attrs,model.schema.text(first.node.textContent+' · '+text,first.node.firstChild.marks));model.reconcile(region,blocks,blocks.map((b:any)=>b.key===first.key?{key:b.key,node}:b))}
const text=(client:any)=>client.controller.model?.capture().regions.map((r:any)=>client.controller.model.project(r.regionId).textContent).join('\n')??''
let proxy:any,dropped=false,submits=0;const sent:string[]=[],nativeResponses:unknown[]=[]
try{
 const alice=await open('alice'),bob=await open('bob'),reader=await open('reader'),initial=await head(),layout=alice.controller.projection!.flowLayout
 const selection={sectionId:layout.sections[1].id,kind:'footer',variant:'default',transactionId:randomUUID().replaceAll('-','')}
 const preview=await post('preview',{epoch:1,selection});assert.equal(preview.status,200);const reviewed=preview.body
 const body={epoch:1,pending:reviewed.pending,reviewHash:reviewed.reviewHash},request=JSON.stringify(body)
 const readOnly=await post('submit',body,'reader');assert.equal(readOnly.status,403)
 const old=await open('reader',false),oldRefusal=await post('submit',body);assert.equal(oldRefusal.status,409);assert.equal(oldRefusal.body.code,'word-topology-client-upgrade-required');old.close()
 await until(async()=>{const retry=await post('submit',{...body,reviewHash:'0'.repeat(64)});return retry.body.code==='word-story-review-changed'},'old member left, stale review rejected');assert.equal(await head(),initial)
 const forged=structuredClone(body);forged.pending.blocks[0].content.inlines[0].text+=' forged';const forgedResult=await post('submit',forged);assert.equal(forgedResult.status,409);assert.equal(forgedResult.body.code,'word-story-review-changed');assert.equal(await head(),initial)
 for(const client of [alice,bob,reader])await until(()=>client.controller.state().ready&&!client.controller.state().topologyPending,'members released')
 const own='Active story Alice '+randomUUID().slice(0,8),peer='Active story Bob '+randomUUID().slice(0,8)
 append(alice,own);await until(()=>text(bob).includes(own),'Alice shared');append(bob,peer);await until(()=>text(alice).includes(peer),'Bob shared');assert.equal(await head(),initial)
 // Retain the exact reviewed payload before dispatch; no credentials in it.
 await writeFile(join(root,'story-original-request.json'),request,{mode:0o600})
 proxy=createServer(async(req,res)=>{try{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const raw=Buffer.concat(chunks).toString('utf8');sent.push(raw);submits++;const upstream=await fetch(origin+req.url,{method:'POST',headers:{...headers,Authorization:'Bearer '+c.alice},body:raw}),bytes=await upstream.arrayBuffer();nativeResponses.push({status:upstream.status,body:JSON.parse(Buffer.from(bytes).toString('utf8'))});if(upstream.status===200&&!dropped){dropped=true;res.socket!.destroy();return}res.writeHead(upstream.status,{'Content-Type':'application/json'});res.end(Buffer.from(bytes))}catch(e){errors.push(String(e));res.socket?.destroy()}})
 await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyBase='http://127.0.0.1:'+proxy.address().port
 await assert.rejects(post('submit',request,'alice',proxyBase));assert.equal(dropped,true);assert.equal(await head(),initial+1)
 const same=await readFile(join(root,'story-original-request.json'),'utf8'),retried=await post('submit',same,'alice',proxyBase);assert.equal(retried.status,200);assert.equal(retried.body.revision,initial+1);assert.equal(submits,2);assert.deepEqual(sent,[request,request]);assert.equal(await head(),initial+1)
 const status=await post('status',{epoch:1,transactionId:selection.transactionId},'reader');assert.equal(status.status,200);assert.equal(status.body.schemaVersion,'hcd-word-active-story-status/1');assert.equal(status.body.status,'installed')
 for(const client of [alice,bob,reader])client.close()
 const nextAlice=await open('alice'),nextBob=await open('bob'),nextReader=await open('reader')
 for(const client of [nextAlice,nextBob,nextReader]){assert.ok(text(client).includes(own)&&text(client).includes(peer));assert.ok(client.controller.model!.layoutState().layout.stories.some((s:any)=>s.id===reviewed.pending.story.id))}
 const finalRevision=await nextAlice.controller.save();assert.equal(finalRevision,initial+2)
 for(const client of [nextAlice,nextBob,nextReader])await until(()=>client.controller.state().saved&&client.controller.state().revision===finalRevision,'new-room save verified')
 const replayAfterSave=await post('submit',same);assert.equal(replayAfterSave.status,200);assert.equal(replayAfterSave.body.revision,initial+1);assert.equal(await head(),finalRevision)
 const otherMember=await post('submit',same,'bob');assert.equal(otherMember.status,403)
 const result={scope:'actual native and sidecar active story submission with explicit Socket capability; fresh documents manually joined after replacement',initial,storyRevision:initial+1,finalRevision,selection,reviewHash:reviewed.reviewHash,pending:reviewed.pending,markers:{own,peer},lostSuccessfulResponse:true,exactRetryCount:submits,exactRetryVerified:true,readOnly,oldClient:oldRefusal,forgedCandidate:forgedResult,status:status.body,otherMember,lateDraftsPreserved:true,threeRolesSaved:true,normalStoryUI:false,automaticStoryRebind:false,personalHistoryAfterStory:false,production:false,physicalDevice:false,realIme:false,errors}
 assert.deepEqual(errors,[]);await writeFile(join(out,'service.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({initial,storyRevision:initial+1,finalRevision,lostResponse:true,exactRetryVerified:true,oldClient:oldRefusal.body.code,lateDraftsPreserved:true,threeRolesSaved:true}))
}catch(error){await writeFile(join(out,'failure.json'),JSON.stringify({message:error instanceof Error?error.message:String(error),nativeResponses,errors},null,2)+'\n');throw error}
finally{for(const client of clients)client.close();if(proxy)await new Promise<void>(r=>proxy.close(()=>r()))}
