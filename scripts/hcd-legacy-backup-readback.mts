/** Read only the document-only draft produced by the owned browser scenario. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticInlineContainerNode} from '../examples/hdoc/editor/src/semanticInlineNode.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {createHash} from 'node:crypto'

const path=resolve(process.argv[2]),backup=JSON.parse(await readFile(path,'utf8'))
assert.equal(backup.schemaVersion,'hcd-recovery/1');assert.equal(backup.documentId,'inline-native')
const pending=process.argv[3]==='--pending'
if(pending){assert.equal(backup.nodeResources.length,1);const file=backup.nodeResources[0],bytes=Buffer.from(file.bytes);assert.equal(bytes.toString(),'pending attachment after cancellation');assert.equal(createHash('sha256').update(bytes).digest('hex'),file.resource.hash)}else assert.equal(backup.nodeResources,undefined)
const document=new Y.Doc({gc:false})
try{
 Y.applyUpdate(document,new Uint8Array(Buffer.from(backup.crdt,'base64')))
 const schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity])
 const projected=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true}).project()
 projected.check();assert.match(projected.textContent,/Edited中😀/);assert.match(projected.textContent,/Nested😀/)
 const result={scope:'isolated browser legacy draft',projectedTextVerified:true,attachmentsIncluded:pending,textLength:projected.textContent.length}
 await writeFile(dirname(path)+'/readback.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
}finally{document.destroy()}
