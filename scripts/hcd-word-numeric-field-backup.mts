/** Production decoder for an actual product download; never opens browser storage. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {readWordDeviceBackup} from '../examples/hdoc/editor/src/wordDeviceBackupReader.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
import {extensionNodes} from '../examples/hdoc/editor/src/extensionNode.ts'
const [root,out]=process.argv.slice(2).map(value=>resolve(value)),c=JSON.parse(await readFile(root+'/private.json','utf8')),projection=JSON.parse(await readFile(out+'/socket-final-projection.json','utf8'))
assert.equal(c.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
const session={documentId:c.documentId,token:c.alice,userId:'alice',scope:'write' as const,format:'docx',apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${c.collabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2' as const},raw=await readFile(out+'/field-device-r8.hcd-word-draft','utf8'),copy=await readWordDeviceBackup(raw,session,c.pages.alice),document=new Y.Doc(),expectedDocument=new Y.Doc()
try{
 assert.equal(copy.sameScope,true);assert.equal(copy.schemaVersion,'hcd-word-device/6');Y.applyUpdate(document,copy.document)
 const schema=wordRegionSchema(),model=new WordRegionStore(document,schema,c.documentId,projection.flowLayout,projection.flowLayoutHash),expected=new WordRegionStore(expectedDocument,schema,c.documentId,projection.flowLayout,projection.flowLayoutHash);expected.initialize(projection)
 assert.equal(model.contents(),expected.contents());assert.deepEqual(model.layoutState(),expected.layoutState())
 const fields=projection.flowLayout.sections.map((section:any)=>section.id).concat(projection.flowLayout.stories.map((story:any)=>story.id)).flatMap((region:string)=>[...extensionNodes(model.project(region)).values()].map(entry=>({id:entry.value.instanceId,data:entry.value.data})))
 assert.equal(new Set(fields.map((field:any)=>field.id)).size,2);assert.ok(fields.some((field:any)=>field.data.kind==='NUMPAGES'&&field.data.format==='upperRoman'));assert.ok(fields.some((field:any)=>field.data.kind==='SECTIONPAGES'&&field.data.format==='arabic'))
 assert.match(model.project(projection.flowLayout.sections[0].id).textContent,/Bob 页码协同/)
 const evidence={schemaVersion:copy.schemaVersion,sameScope:true,exactCanonicalSemanticContents:true,exactLayout:true,editableFieldIdentityAndData:true,peerTextPreserved:true,documentBytes:copy.document.length,localUpdates:copy.localUpdates.length,scope:'Actual browser product download decoded in isolation; no upload/merge or cross-device acceptance'}
 await writeFile(out+'/backup.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
}finally{document.destroy();expectedDocument.destroy()}
