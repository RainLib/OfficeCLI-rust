import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHmac,timingSafeEqual} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {schemaExtensions,jsonToSnapshot,projectionToJson} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),head=Number(process.argv[3]),assets='docs/assets/hcd-custom-marks-2026-10-26',schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8')),path=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`,bytes=new Uint8Array(await readFile(path)),document=new Y.Doc();assert.ok([6,10].includes(head));assert.equal(meta.nodeEdits,7);assert.equal(JSON.parse(await readFile(c.root+'/mentions-docx.hcd/manifest.json','utf8')).revision,head);Y.applyUpdate(document,bytes)
try{
 const before=Y.encodeStateAsUpdate(document),store=new SemanticBlockStore(document,schema),snapshot=jsonToSnapshot(store.project().toJSON()),marks=snapshot.flatMap(block=>block.content.inlines).filter(inline=>inline.customMarks?.length);assert.equal(marks.length,1);assert.deepEqual(marks[0].customMarks!.map(mark=>mark.type),['example.project','example.review']);assert.deepEqual(Y.encodeStateAsUpdate(document),before)
 const [encoded,signature]=String(document.getMap('hcdSave').get('receipt')).split('.'),decoded=Buffer.from(encoded,'base64url'),actual=Buffer.from(signature,'base64url'),mac=createHmac('sha256',c.secret).update(decoded).digest();assert.equal(mac.length,actual.length);assert.ok(timingSafeEqual(mac,actual));const receipt=JSON.parse(decoded.toString('utf8'));assert.equal(receipt.revision,head);assert.equal(receipt.digest,await checkpointDigest(snapshot));const response=await fetch(c.origin+'/v1/documents/mentions-docx/editor?revision='+head,{headers:{Authorization:'Bearer '+c.reader,'X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1'}});assert.equal(response.status,200);assert.equal(receipt.digest,await checkpointDigest(jsonToSnapshot(projectionToJson(await response.json()))))
 await writeFile(`${assets}/persisted-r${head}.json`,JSON.stringify({scope:'Actual native Yjs bytes into a new codec-free Y.Doc. No service restart.',head,wire:meta.nodeEdits,byteLength:bytes.length,readPure:true,customMarks:marks[0].customMarks,signedReceiptAndCanonicalMatch:true},null,2)+'\n');console.log('PASS persisted',head,'new codec-free doc, custom marks and signed canonical digest')
}finally{document.destroy()}
