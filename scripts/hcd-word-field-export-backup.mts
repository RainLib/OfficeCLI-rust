/** Decode the actual device download with the production reader, in isolation. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {readWordDeviceBackup} from '../examples/hdoc/editor/src/wordDeviceBackupReader.ts'
import {WordRegionStore,wordRegionSchema} from '../examples/hdoc/editor/src/wordRegionStore.ts'
const [root,out]=process.argv.slice(2).map(value=>resolve(value)),config=JSON.parse(await readFile(root+'/private.json','utf8')),projection=JSON.parse(await readFile(out+'/final-projection.json','utf8'))
assert.equal(config.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/);assert.equal(config.numericFields,true)
const session={documentId:config.documentId,token:config.alice,userId:'alice',scope:'write' as const,format:'docx',apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${config.collabPort}`,collaborationEpoch:1,collaborationProtocol:'hcd-word-regions/2' as const}
const raw=await readFile(out+'/fields-device-r5.hcd-draft','utf8'),copy=await readWordDeviceBackup(raw,session,config.pages.alice),document=new Y.Doc(),expectedDocument=new Y.Doc()
try{
 assert.equal(copy.sameScope,true);assert.equal(copy.schemaVersion,'hcd-word-device/6')
 Y.applyUpdate(document,copy.document)
 const schema=wordRegionSchema(),model=new WordRegionStore(document,schema,config.documentId,projection.flowLayout,projection.flowLayoutHash),expected=new WordRegionStore(expectedDocument,schema,config.documentId,projection.flowLayout,projection.flowLayoutHash)
 expected.initialize(projection)
 assert.equal(model.contents(),expected.contents());assert.deepEqual(model.layoutState(),expected.layoutState())
 const text=model.capture().regions.flatMap(region=>region.blocks.map(block=>block.content.inlines.map(inline=>inline.text).join(''))).join('\n')
 for(const marker of ['Alice 页码域保留','Bob 页码协同正文','VIII','12','total pages','Saved field date','Saved char format'])assert.equal(text.split(marker).length-1,1,marker)
 const result={schemaVersion:copy.schemaVersion,sameScope:true,exactCanonicalSemanticContents:true,exactLayout:true,cachedFieldsAndBothActors:true,documentBytes:copy.document.length,localUpdates:copy.localUpdates.length,scope:'read-only isolated production decoder; field instructions are verified separately in canonical HCDZ'}
 await writeFile(out+'/backup.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{document.destroy();expectedDocument.destroy()}
