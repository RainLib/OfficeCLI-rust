import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {schemaExtensions,jsonToSnapshot} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {deletionReviews} from '../examples/hdoc/editor/src/deletionReview.ts'
import {structureSourceTargets} from '../examples/hdoc/editor/src/semanticStructureSources.ts'
const c=JSON.parse(await readFile(process.argv[2],'utf8')),revision=Number(process.argv[3]),identity=JSON.parse(await readFile(c.root+'/list-identities.json','utf8')),meta=JSON.parse(await readFile(c.root+'/collaboration/mentions-docx.epoch','utf8')),path=c.root+`/collaboration/mentions-docx.epoch-${meta.epoch}${meta.migration?.id?'.'+meta.migration.id:''}.bin`,bytes=new Uint8Array(await readFile(path)),document=new Y.Doc();assert.equal(meta.nodeEdits,5);Y.applyUpdate(document,bytes)
try{
 const store=new SemanticBlockStore(document,getSchema([...schemaExtensions,SemanticStructureIdentity])),projection=store.project(),reviews=deletionReviews(store),snapshot=jsonToSnapshot(projection.toJSON()),targets=structureSourceTargets(store);assert.equal(JSON.parse(await readFile(c.root+'/mentions-docx.hcd/manifest.json','utf8')).revision,revision);assert.equal(reviews.length,revision===3?1:0);assert.equal(targets.length,snapshot.length);assert.equal(projection.textContent.match(/Original/g)?.length,1)
 if(revision===3)assert.match(reviews[0].node.textContent,/列表迟到新项/)
 if(revision>=4){assert.match(projection.textContent,/列表迟到新项/);const wrapper=store.content(identity.wrapper);assert.equal(wrapper.childCount,revision===4?1:2);assert.equal(store.childKeys(identity.wrapper).length,2);if(revision===4){assert.equal(store.canonicalIds.get(store.owners.get(identity.oldItem)!),null);assert.ok(targets.every(target=>!('key'in target)||target.key!==identity.oldItem))}else{assert.match(projection.textContent,/旧列表项迟到的新段/);assert.ok(targets.some(target=>'key'in target&&target.key===identity.oldItem))}}
 const evidence={scope:'Actual native persisted Yjs file read into a fresh Y.Doc without browser history. Not a service restart.',revision,requiredModel:meta.nodeEdits,byteLength:bytes.length,reviewCount:reviews.length,projectedTargets:targets.length,snapshotBlocks:snapshot.length,rawItemCount:store.childKeys(identity.wrapper).length,oldItemVisibility:store.visibility.get(identity.oldItem),oldItemCanonicalId:store.canonicalIds.get(store.owners.get(identity.oldItem)!),visibleText:projection.textContent,uniqueSourcesFollowProjection:true};await writeFile(`docs/assets/hcd-list-recovery-2026-10-25/persisted-r${revision}.json`,JSON.stringify(evidence,null,2)+'\n');console.log('PASS native persisted r'+revision+' projects '+targets.length+' targets, '+reviews.length+' reviews; permanent old list slot retained')
}finally{document.destroy()}
