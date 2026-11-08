/** Read only the actual product download, using its production /6 reader. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {readWordDeviceBackup} from '../examples/hdoc/editor/src/wordDeviceBackupReader.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
const [root,out]=process.argv.slice(2).map(value=>resolve(value)),c=JSON.parse(await readFile(root+'/private.json','utf8')),projection=JSON.parse(await readFile(out+'/final-projection.json','utf8'))
assert.equal(c.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
const session={documentId:c.documentId,token:c.alice,userId:'alice',scope:'write' as const,format:'docx',apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${c.browserCollabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2' as const},raw=await readFile(out+'/device-backup.hcd-word-draft','utf8'),copy=await readWordDeviceBackup(raw,session,c.pages.alice),document=new Y.Doc()
try{
 Y.applyUpdate(document,copy.document);const model=new WordRegionStore(document,wordRegionSchema(),c.documentId,projection.flowLayout,projection.flowLayoutHash),text=model.capture().regions.map(region=>model.project(region.regionId).textContent).join('\n')
 for(const marker of ['Bob 页码协同后保留','重开后续存'])assert.equal(text.split(marker).length-1,1)
 assert.deepEqual(model.layoutState().layout,projection.flowLayout)
 await writeFile(out+'/backup-readback.json',JSON.stringify({schemaVersion:JSON.parse(raw).schemaVersion,allBodyMarkersOnce:true,exactFinalLayout:true,firstSectionStart:8,firstSectionFormat:'upperRoman',secondSectionExplicitNumberingRemoved:true,documentBytes:copy.document.length,localUpdates:copy.localUpdates.length},null,2)+'\n')
}finally{document.destroy()}
