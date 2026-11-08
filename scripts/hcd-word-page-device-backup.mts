/** Read the actually downloaded /6 backup and reject a cancelled late replay. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {readWordDeviceBackup} from '../examples/hdoc/editor/src/wordDeviceBackupReader.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
const [root,out]=process.argv.slice(2).map(value=>resolve(value)),c=JSON.parse(await readFile(root+'/private.json','utf8')),e=JSON.parse(await readFile(out+'/browser.json','utf8')),projection=JSON.parse(await readFile(out+'/final-projection.json','utf8'))
assert.equal(c.root,root)
const session={documentId:c.documentId,token:c.alice,userId:'alice',scope:'write' as const,format:'docx',apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${c.browserCollabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2' as const},raw=await readFile(out+'/device-backup.hcd-word-draft','utf8'),copy=await readWordDeviceBackup(raw,session,c.pages.alice),document=new Y.Doc()
try{
 Y.applyUpdate(document,copy.document);const model=new WordRegionStore(document,wordRegionSchema(),c.documentId,projection.flowLayout,projection.flowLayoutHash),text=model.capture().regions.map(region=>model.project(region.regionId).textContent).join('\n')
 for(const marker of Object.values(e.markers) as string[])assert.equal(text.split(marker).length-1,1)
 assert.equal(model.layoutState().layout.sections[0].page.widthTwips,11906)
 assert.equal(model.layoutState().layout.sections[0].page.heightTwips,16838)
 await writeFile(out+'/backup-readback.json',JSON.stringify({schemaVersion:JSON.parse(raw).schemaVersion,model:'hcd-word-regions/2',allMarkersOnce:true,pageChangeRetained:true,localUpdates:copy.localUpdates.length,documentBytes:copy.document.length},null,2)+'\n')
}finally{document.destroy()}
const record=JSON.parse(await readFile(out+'/cancelled.hcd-word-page-request','utf8')),response=await fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/region-test/collaboration/word-active-layout`,{method:'POST',headers:{Authorization:'Bearer '+c.alice,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1'},body:JSON.stringify({epoch:1,request:record.request}),signal:AbortSignal.timeout(30000)}),body=await response.json()
assert.equal(response.status,409);assert.ok(['word-topology-cancelled','word-active-layout-cancelled'].includes(body.code))
await writeFile(out+'/cancelled-replay.json',JSON.stringify({status:response.status,body},null,2)+'\n')
