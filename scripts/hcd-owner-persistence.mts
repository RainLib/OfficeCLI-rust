import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHmac,timingSafeEqual} from 'node:crypto'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {schemaExtensions,jsonToSnapshot,projectionToJson} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {structureSourceTargets} from '../examples/hdoc/editor/src/semanticStructureSources.ts'
import {deletionReviews} from '../examples/hdoc/editor/src/deletionReview.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),expected=Number(process.argv[3]??5),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8')),native=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`;assert.equal(meta.nodeEdits,5);assert.equal(JSON.parse(await readFile(c.root+'/mentions-docx.hcd/manifest.json','utf8')).revision,expected)
const snapshots:any[]=[]
for(const revision of [2,3,4,5,expected]){
 const actualNative=revision===expected&&snapshots.length===4,bytes=new Uint8Array(await readFile(actualNative?native:c.root+`/owner-r${revision}.bin`)),document=new Y.Doc();Y.applyUpdate(document,bytes)
 try{
  const before=Y.encodeStateAsUpdate(document),store=new SemanticBlockStore(document,schema),projection=store.project(),targets=structureSourceTargets(store),snapshot=jsonToSnapshot(projection.toJSON());assert.equal(deletionReviews(store).length,0);assert.equal(targets.length,snapshot.length);assert.equal(new Set(targets.map(target=>'owner'in target?target.owner:'xml')).size,targets.length);assert.equal(projection.textContent.match(/Original/g)?.length,1);assert.equal(projection.textContent.includes('Alice 并发新增'),revision!==3);assert.match(projection.textContent,/Bob 并发新增/);assert.deepEqual(Y.encodeStateAsUpdate(document),before)
  if(actualNative){const [encoded,signature]=String(document.getMap('hcdSave').get('receipt')).split('.'),decoded=Buffer.from(encoded,'base64url'),mac=createHmac('sha256',c.secret).update(decoded).digest(),storedMac=Buffer.from(signature,'base64url');assert.equal(mac.length,storedMac.length);assert.ok(timingSafeEqual(mac,storedMac));const receipt=JSON.parse(decoded.toString('utf8'));assert.equal(receipt.revision,expected);assert.equal(receipt.digest,await checkpointDigest(snapshot));const response=await fetch(c.origin+'/v1/documents/mentions-docx/editor?revision='+expected,{headers:{Authorization:'Bearer '+c.reader,'X-HCD-Node-Edits-Version':'5'}});assert.equal(response.status,200);const canonical=await response.json();assert.equal(receipt.digest,await checkpointDigest(jsonToSnapshot(projectionToJson(canonical))));assert.match(projection.textContent,/Bob 后续协作输入/)}
  snapshots.push({revision,source:actualNative?'actual native persisted file':'acknowledged client snapshot',byteLength:bytes.length,targets:targets.length,rawOwnerCount:new Set(store.blocks().flatMap(block=>['bulletList','orderedList'].includes(block.node.type.name)?store.projectedChildren(block.key,block.node):[block]).map(slot=>store.owners.get(slot.key))).size,derivedOwners:targets.filter(target=>'owner'in target&&target.owner.startsWith('branch_')).map(target=>'owner'in target?target.owner:''),readPure:true,reviewCount:0,visibleText:projection.textContent,...(actualNative?{signedReceiptAndCanonicalMatch:true}:{})})
 }finally{document.destroy()}
}
await writeFile(`docs/assets/hcd-owner-race-2026-10-26/persisted-r${expected}.json`,JSON.stringify({scope:'Fresh Y.Docs, no window history. r2-r5 are acknowledged client captures; final entry is actual native file and verified signed clean receipt. Not a service restart.',snapshots},null,2)+'\n');console.log('PASS owner branches survive fresh Y.Doc reads; actual native'+expected+' signed receipt matches snapshot and read changes no bytes')
