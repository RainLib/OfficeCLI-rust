/** Independent signed draft readback after normal UI link recovery. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHmac} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {WordCheckpointJournal} from '../examples/hdoc/editor/src/wordCheckpointJournal.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {wordTopologyRecovery} from '../examples/hdoc/editor/src/wordTopologyRecoveryClient.ts'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),historical=process.argv[4]==='historical',c=JSON.parse(await readFile(join(root,'private.json'),'utf8')),e=JSON.parse(await readFile(join(out,'interrupted.json'),'utf8'))
assert.equal(c.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
const binary=resolve('target/debug/officecli'),bundle=join(root,'region-test.hcd')
const cli=(...args:string[])=>JSON.parse(execFileSync(binary,['hdoc',...args,'--json'],{encoding:'utf8',timeout:60000})).data
const lineage=createHmac('sha256',c.secret).update(`word-room/1:${c.origin}:region-test:1`).digest('hex').slice(0,32),journal=new WordCheckpointJournal(join(root,'sidecar'),c.origin,'region-test',1,lineage,c.secret,true,true,true),saved=await journal.load();assert.ok(saved)
const head=cli('editor-state',bundle);assert.equal(head.revision,3)
assert.equal(saved.capsule.version,historical?5:3);assert.equal(saved.capsule.base.revision,historical?2:3)
const projection=cli('editor-state',bundle,'--revision',String(saved.capsule.base.revision)),document=new Y.Doc()
try{
 Y.applyUpdate(document,Buffer.from(saved.capsule.document,'base64'));const model=new WordRegionStore(document,wordRegionSchema(),'region-test',projection.flowLayout,projection.flowLayoutHash),text=model.capture().regions.map(region=>model.project(region.regionId).textContent).join('\n')
 for(const marker of Object.values(e.markers) as string[])assert.equal(text.split(marker).length-1,1)
 let confirmation:unknown
 if(historical){
  assert.ok(saved.capsule.linkAcknowledgement);assert.equal(saved.capsule.pendingLink,undefined);assert.deepEqual(saved.capsule.actors.map(actor=>actor.userId).sort(),['alice','bob'])
  const session:any={documentId:'region-test',token:c.alice,userId:'alice',displayName:'Alice 王',scope:'write',format:'docx',apiUrl:c.origin+'/v1/documents',collabUrl:'ws://127.0.0.1:'+c.collabPort,collaborationProtocol:'hcd-word-regions/2',collaborationEpoch:1}
  confirmation=await wordTopologyRecovery(session,'resume',new AbortController().signal,e.selection.transactionId);assert.deepEqual(confirmation,{transactionId:e.selection.transactionId,kind:'link',baseRevision:1,revision:2,headRevision:3,status:'historical'})
  assert.equal((await journal.load())?.hash,saved.hash);assert.equal(cli('editor-state',bundle).revision,3)
  for(const marker of Object.values(e.markers) as string[])assert.equal(JSON.stringify(head).includes(marker),false)
 }
 const result={scope:'independent native and signed-journal check after recovery through the normal browser UI',initial:1,linkRevision:2,headRevision:3,selection:e.selection,markers:e.markers,historical,normalRecoveryUI:true,signedCapsuleVersion:saved.capsule.version,signedBaseRevision:saved.capsule.base.revision,bothDraftsRetained:true,canonicalHeadUnchangedByRecovery:true,...(confirmation?{repeatedHistoricalConfirmation:confirmation}:{}),normalLinkCreationUI:false,originalWindowBridge:false,production:false,physicalDevice:false}
 await writeFile(join(out,'recovery.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({historical,signedVersion:saved.capsule.version,bothDraftsRetained:true,headRevision:head.revision}))
}finally{document.destroy()}
