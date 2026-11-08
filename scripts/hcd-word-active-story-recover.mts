/** Recover the original active story after a real owner-loss failure. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHmac} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import {WordCheckpointJournal} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {WordBrowserState} from '../examples/hdoc/editor/src/wordBrowserState.ts'
import {readWordBrowserProjection} from '../examples/hdoc/editor/src/wordBrowserProjection.ts'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),c=JSON.parse(await readFile(join(root,'private.json'),'utf8')),original=JSON.parse(await readFile(join(root,'story-original-request.json'),'utf8'))
assert.equal(c.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
const headers={'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'}
async function call(operation:string,person='alice',transactionId?:string){const response=await fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/region-test/collaboration/word-topology-recovery`,{method:'POST',headers:{...headers,Authorization:'Bearer '+c[person]},body:JSON.stringify({epoch:1,operation,...(transactionId?{transactionId}:{})}),signal:AbortSignal.timeout(45000)});return{status:response.status,body:await response.json()}}
const inspected=await call('inspect');assert.equal(inspected.status,200);assert.equal(inspected.body.transactionId,original.pending.request.transactionId)
const refused=await call('resume','bob',inspected.body.transactionId);assert.notEqual(refused.status,200)
const resumed=await call('resume','alice',inspected.body.transactionId);assert.equal(resumed.status,200);assert.equal(resumed.body.status,'confirmed');assert.equal(resumed.body.revision,original.pending.request.expectedRevision+1)
const repeated=await call('resume','alice',inspected.body.transactionId);assert.deepEqual(repeated,resumed)
const lineage=createHmac('sha256',c.secret).update(`word-room/1:${c.origin}:region-test:1`).digest('hex').slice(0,32),journal=new WordCheckpointJournal(root+'/sidecar',c.origin,'region-test',1,lineage,c.secret,true,true),saved=await journal.load();assert.ok(saved);assert.equal(saved.capsule.version,3)
assert.deepEqual(saved.capsule.actors.map(actor=>actor.userId).sort(),['alice','bob'])
const document=new Y.Doc(),session={documentId:'region-test',format:'docx',scope:'write',userId:'alice',displayName:'Alice 王',token:c.alice,collaborationProtocol:'hcd-word-regions/2',collaborationEpoch:1,apiUrl:c.origin+'/v1/documents',collabUrl:'ws://127.0.0.1:'+c.collabPort} as any
const provider=new HocuspocusProvider({url:session.collabUrl+'?hcdNodeEdits=7&hcdWordRegions=2&hcdWordLayout=1&hcdWordTopology=1&hcdWordStory=1',name:'region-test:1:wordregions2:save6',document,token:c.alice}),controller=new WordBrowserState({document,provider,scope:'write',protocol:session.collaborationProtocol,projection:(r,s)=>readWordBrowserProjection(session,r,s),onDisconnect:()=>provider.disconnect()})
try{
 const end=Date.now()+45000;while(!controller.state().ready){if(Date.now()>end)throw Error('recovered room timeout');if(controller.state().problem)throw Error(controller.state().problem);await new Promise(r=>setTimeout(r,25))}
 const text=controller.model!.capture().regions.map(region=>controller.model!.project(region.regionId).textContent).join('\n'),own=text.match(/Active story Alice [a-f0-9]{8}/)?.[0],peer=text.match(/Active story Bob [a-f0-9]{8}/)?.[0];assert.ok(own&&peer)
 const finalRevision=await controller.save();assert.equal(finalRevision,resumed.body.revision+1)
 const result={scope:'actual active request owner-loss followed by process restart and exact signed stopped recovery',initial:original.pending.request.expectedRevision,storyRevision:resumed.body.revision,finalRevision,inspected,refused,resumed,repeated,selection:{sectionId:original.pending.intent.sectionId,kind:original.pending.intent.kind,variant:original.pending.intent.variant,transactionId:original.pending.request.transactionId},pending:original.pending,markers:{own,peer},lateDraftsPreserved:true,normalStoryUI:false,automaticStoryRebind:false,production:false,physicalDevice:false,realIme:false}
 await writeFile(join(out,'lease-failure-recovery.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({storyRevision:resumed.body.revision,finalRevision,originalTransactionConfirmed:true,bothDraftsSaved:true}))
}finally{controller.dispose();provider.destroy();document.destroy()}
