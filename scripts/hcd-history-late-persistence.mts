import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {EditorState} from '../examples/hdoc/editor/node_modules/@tiptap/pm/state/index.ts'
import {Fragment} from '../examples/hdoc/editor/node_modules/@tiptap/pm/model/index.ts'
import {HocuspocusProvider} from '../examples/hdoc/editor/node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {schemaExtensions,jsonToSnapshot,sourceIdentityPlugin} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {NodeExtensionRegistry} from '../examples/hdoc/editor/src/extensionRegistry.ts'
import {prepareExtensionHistoryGuard} from '../examples/hdoc/editor/src/extensionHistory.ts'
import {CollaborativeImageDraftStore,imageDraftDigest} from '../examples/hdoc/editor/src/collaborativeImages.ts'
import {SemanticHistory} from '../examples/hdoc/editor/src/semanticHistory.ts'
import {extensionNodes,extensionPreservationPlugin} from '../examples/hdoc/editor/src/extensionNode.ts'
import {rootBlocks,blockTarget,transformBlocks} from '../examples/hdoc/editor/src/commands/blocks.ts'
import {nodeEditCollaborationUrl} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {checkpointDigest} from '../examples/hdoc/editor/src/checkpointSnapshot.ts'
import {requestCoordinatedSave} from '../examples/hdoc/editor/src/semanticSaveClient.ts'
import {nodePortableFixture} from '../examples/hdoc/editor/fixtures/nodePortable.ts'
import {deletionReviews} from '../examples/hdoc/editor/src/deletionReview.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),expected=Number(process.argv[3]??8),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8'));assert.equal(meta.nodeEdits,5);const path=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`,bytes=new Uint8Array(await readFile(path)),document=new Y.Doc();Y.applyUpdate(document,bytes);const store=new SemanticBlockStore(document,schema),reviews=deletionReviews(store),manifest=JSON.parse(await readFile(c.root+'/mentions-docx.hcd/manifest.json','utf8'));assert.equal(manifest.revision,expected);assert.equal(reviews.length,expected===12?0:1);assert.equal(extensionNodes(store.project()).size,expected===8?6:9)
if(expected===8)assert.match(reviews[0].node.textContent,/复制撤销后的离线输入/)
if(expected===11)assert.equal(reviews[0].node.textContent,'包装撤销后的离线新段')
if(expected===12){assert.match(store.project().textContent,/复制撤销后的离线输入/);assert.match(store.project().textContent,/包装撤销后的离线新段/)}
const ownerSlots=store.blocks().flatMap(block=>['bulletList','orderedList'].includes(block.node.type.name)?store.childKeys(block.key):[block.key]),owners=ownerSlots.map(key=>store.owners.get(key));assert.equal(new Set(owners).size,owners.length);const evidence={scope:'Actual native persisted Yjs file loaded directly into a fresh Y.Doc without local operation history; not a service restart or production acceptance',revision:expected,requiredModel:meta.nodeEdits,byteLength:bytes.length,reviewCount:reviews.length,reviews:reviews.map(group=>({key:group.key,receiptId:group.receipt?.id,text:group.node.textContent})),visibleBusinessNodes:extensionNodes(store.project()).size,uniqueCanonicalOwners:true};await writeFile(c.root+`/history-native-${expected}.bin`,bytes,{mode:0o600});await writeFile(`docs/assets/hcd-history-late-2026-10-25/persisted-r${expected}.json`,JSON.stringify(evidence,null,2)+'\n');console.log('PASS persisted native file r'+expected+' independently reloads with '+reviews.length+' reviews and unique visible owners');document.destroy()
