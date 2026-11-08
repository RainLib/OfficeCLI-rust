import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {schemaExtensions,jsonToSnapshot,sourceIdentityPlugin} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {extensionNodes,extensionPreservationPlugin} from '../examples/hdoc/editor/src/extensionNode.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {nodePortableFixture} from '../examples/hdoc/editor/fixtures/nodePortable.ts'
import {deletionReviews} from '../examples/hdoc/editor/src/deletionReview.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8'));assert.equal(meta.nodeEdits,5)
const path=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`,bytes=new Uint8Array(await readFile(path)),doc=new Y.Doc();Y.applyUpdate(doc,bytes);const store=new SemanticBlockStore(doc,schema);assert.equal(deletionReviews(store).length,0);assert.equal(extensionNodes(store.project()).size,6)
for(const label of ['Bob 删除后离线输入','Bob 第二次离线输入','Bob 迟到复核输入','Bob 确认后再到输入'])assert.match(store.project().textContent,new RegExp(label))
const records=[...doc.getMap('hcd-semantic-deletions/1')];assert.equal(records.length,1);assert.equal(store.visibility.get(records[0][0]),true)
const blocked=[];for(const mode of ['prepare','second','late','late-again']){const data=new Uint8Array(await readFile(c.root+'/deletion-blocked-'+mode+'.bin')),snapshot=new Y.Doc();Y.applyUpdate(snapshot,data);const retained=deletionReviews(new SemanticBlockStore(snapshot,schema));assert.equal(retained.length,1);assert.match(retained[0].node.textContent,/Bob/);blocked.push({mode,scope:'Independent client Yjs capture at the failed save, not a historical copy of the native persisted file',reviewCount:1,retainedText:retained[0].node.textContent});snapshot.destroy()}
const evidence={scope:'Fresh Y.Doc read directly from current native persisted file at r10; blocked captures are independently labeled client snapshots, not service restart acceptance',requiredModel:meta.nodeEdits,epoch:meta.epoch,persistedBytes:bytes.length,allFourLateInputsRetained:true,reviewReceiptCount:records.length,restoredVisibility:true,reviewCount:0,blocked};await writeFile('docs/assets/hcd-deletion-review-2026-10-25/persistence-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log('PASS native persisted r10 reloaded, review receipt and all late edits retained; four separate blocked client captures reload with review.');doc.destroy()
