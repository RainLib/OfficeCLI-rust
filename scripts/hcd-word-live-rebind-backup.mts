import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {readWordDeviceBackup} from '../examples/hdoc/editor/src/wordDeviceBackupReader.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
const [root,out]=process.argv.slice(2),c=JSON.parse(await readFile(root+'/private.json','utf8')),e=JSON.parse(await readFile(out+'/browser.json','utf8')),projection=JSON.parse(await readFile(out+'/final-projection.json','utf8'))
const session={documentId:c.documentId,token:c.alice,userId:'alice',scope:'write' as const,format:'docx',apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${c.collabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2' as const},raw=await readFile(out+'/device-backup.hcd-word-draft','utf8'),copy=await readWordDeviceBackup(raw,session,c.pages.alice),document=new Y.Doc()
try{
 Y.applyUpdate(document,copy.document);const model=new WordRegionStore(document,wordRegionSchema(),c.documentId,projection.flowLayout,projection.flowLayoutHash),text=model.capture().regions.map(region=>model.project(region.regionId).textContent).join('\n')
 for(const marker of Object.values(e.markers) as string[])assert.ok(text.includes(marker))
 assert.equal(model.layoutState().layout.sections[0].page.widthTwips,e.pageWidthTwips)
 await writeFile(out+'/backup-readback.json',JSON.stringify({schemaVersion:JSON.parse(raw).schemaVersion,documentId:c.documentId,epoch:1,model:'hcd-word-regions/2',pageWidthVerified:true,bothAuthorsVerified:true,localUpdateCount:copy.localUpdates.length,documentBytes:copy.document.length},null,2)+'\n')
}finally{document.destroy()}
