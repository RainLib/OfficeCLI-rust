/** Read-only audit of an owned native sidecar state and its signed receipt. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHmac,timingSafeEqual,createHash} from 'node:crypto'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {schemaExtensions,jsonToSnapshot,projectionToJson} from '../src/schema.ts'
import {SemanticStructureIdentity} from '../src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../src/semanticBlockStore.ts'
import {checkpointDigest} from '../src/checkpointSnapshot.ts'
const [privateFile,stage,expected,offsetString]=process.argv.slice(2),c=JSON.parse(await readFile(privateFile,'utf8')),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8')),statePath=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`
const initial=new Y.Doc({gc:false}),current=new Y.Doc({gc:false}),bytes=new Uint8Array(await readFile(statePath))
Y.applyUpdate(initial,new Uint8Array(await readFile(c.root+'/splice-before.yjs')));Y.applyUpdate(current,bytes)
const visible=(text:Y.XmlText)=>{const ids:string[]=[];for(let item=text._start;item;item=item.right)if(!item.deleted&&item.countable)for(let i=0;i<item.length;i++)ids.push(`${item.id.client}:${item.id.clock+i}`);return ids}
try{
 const before=new SemanticBlockStore(initial,schema),after=new SemanticBlockStore(current,schema),root=before.blocks().find(block=>block.node.textContent==='P😀')!;assert.ok(root)
 const node=after.blocks().find(block=>block.key===root.key)!;assert.ok(node);assert.equal(node.node.textContent,expected)
 const original=visible(before.contents.get(root.key)!.get(0) as Y.XmlText),now=visible(after.contents.get(root.key)!.get(0) as Y.XmlText),offset=Number(offsetString);assert.equal(now.indexOf(original[0]),offset);assert.deepEqual(now.filter(id=>original.includes(id)),original)
 const snapshot=jsonToSnapshot(after.project().toJSON()),[encoded,signature]=String(current.getMap('hcdSave').get('receipt')).split('.'),raw=Buffer.from(encoded,'base64url'),mac=createHmac('sha256',c.secret).update(raw).digest(),actual=Buffer.from(signature,'base64url');assert.equal(mac.length,actual.length);assert.ok(timingSafeEqual(mac,actual));const receipt=JSON.parse(raw.toString('utf8'));assert.equal(receipt.digest,await checkpointDigest(snapshot))
 const response=await fetch(c.origin+'/v1/documents/mentions-docx/editor?revision='+receipt.revision,{headers:{Authorization:'Bearer '+c.reader,'X-HCD-Node-Edits-Version':'7','X-HCD-Custom-Marks-Version':'1'}});assert.equal(response.status,200);const canonical=await response.json();assert.equal(receipt.digest,await checkpointDigest(jsonToSnapshot(projectionToJson(canonical))))
 const report={scope:'Actual native persistent Yjs state loaded into fresh Docs; browser edits plus signed receipt and native canonical match. No service restart.',stage,revision:receipt.revision,epoch:meta.epoch,wire:meta.nodeEdits,text:expected,originalUtf16Ids:original,originalPCurrentOffset:offset,originalItemsRetainedExactly:true,stableRootKey:root.key,signedReceiptVerified:true,canonicalDigestVerified:true,readPure:true,stateSha256:createHash('sha256').update(bytes).digest('hex')}
 await writeFile(`../../../docs/assets/hcd-text-splice-2026-10-26/persisted-${stage}.json`,JSON.stringify(report,null,2)+'\n');await writeFile(c.root+`/splice-${stage}.yjs`,bytes);console.log('PASS',stage,'r'+receipt.revision,expected,'original P at',offset)
}finally{initial.destroy();current.destroy()}
