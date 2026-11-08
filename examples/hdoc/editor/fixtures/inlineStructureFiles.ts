/** Actual native file bridge for the internal body-aware structural store.
 * No browser automation, public capability advertisement, or unsigned socket. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions,projectionToJson,jsonToSnapshot,type Projection} from '../src/schema.ts'
import {SemanticInlineContainerNode} from '../src/semanticInlineNode.ts'
import {inlineContainerNodeName} from '../src/semanticInlineContainers.ts'
import {SemanticStructureIdentity} from '../src/semanticStructureIdentity.ts'
import {SemanticBlockStore} from '../src/semanticBlockStore.ts'
import {structureSourceTargets,reconcileStructureSources,type SemanticSourceTarget} from '../src/semanticStructureSources.ts'
import {checkpointContents} from '../src/checkpointSnapshot.ts'
const [stage,input,output]=process.argv.slice(2);assert.ok(['prepare','receipt'].includes(stage)&&input&&output)
const projection:Projection=JSON.parse(await readFile(input,'utf8')),models={inlineContainers:true} as const,schema=getSchema([...schemaExtensions,SemanticInlineContainerNode,SemanticStructureIdentity]),origin={kind:'structure-file-user'},receiptOrigin={kind:'structure-file-receipt'}
await mkdir(output,{recursive:true})
function replica(){const document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,origin,models);return{document,store,snapshot:()=>jsonToSnapshot(store.project().toJSON(),models)}}
const save=(name:string,value:unknown)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n'),base=jsonToSnapshot(schema.nodeFromJSON(projectionToJson(projection,models)).toJSON(),models)
if(stage==='prepare'){
 const pm=schema.nodeFromJSON(projectionToJson(projection,models));pm.check();const initial=replica();initial.store.initialize(pm);assert.deepEqual(initial.snapshot(),base);await writeFile(join(output,'initial.yjs'),Y.encodeStateAsUpdate(initial.document));initial.document.destroy()
 const loaded=replica();Y.applyUpdate(loaded.document,new Uint8Array(await readFile(join(output,'initial.yjs'))));assert.deepEqual(loaded.snapshot(),base);assert.throws(()=>new SemanticBlockStore(loaded.document,schema,origin).project(),/unsupportedInlineContainerModel/)
 const containers=loaded.store.flow.containers!,emptyCandidates=[...containers.bodies.keys()].filter(id=>containers.readBody(id).textContent==='新内容');assert.equal(emptyCandidates.length,1)
 let chosen:string|undefined;loaded.store.project().descendants(node=>{if(!chosen&&node.type.name===inlineContainerNodeName)chosen=node.attrs.extension.instanceId});assert.ok(chosen)
 const roots=loaded.store.blocks(),history=loaded.store.undoManager(false)
 const change=(node:PmNode):PmNode=>{if(node.isText)return node;let content=Fragment.fromArray(node.content.content.map(change));if(node.type.name===inlineContainerNodeName){if(node.attrs.extension.instanceId===chosen)content=content.append(Fragment.from(schema.text(' 已接入结构')));if(node.attrs.extension.instanceId===emptyCandidates[0])content=Fragment.empty}return node.copy(content)}
 loaded.store.reconcile(roots,roots.map(root=>({key:root.key,node:change(root.node)})));history.stopCapturing();const expected=loaded.snapshot();assert.equal(history.undoStack.length,1);assert.ok(history.undo());assert.deepEqual(loaded.snapshot(),base);assert.ok(history.redo());assert.deepEqual(loaded.snapshot(),expected);history.destroy()
 const captures=structureSourceTargets(loaded.store);assert.equal(captures.length,projection.blocks.length)
 await save('snapshot.json',loaded.snapshot());await save('captures.json',captures);await writeFile(join(output,'prepared.yjs'),Y.encodeStateAsUpdate(loaded.document))
 await save('patch.json',{schemaVersion:'hcd-patch/4',documentId:projection.documentId,patchId:'inline-structure-file-bridge',baseRevision:projection.revision,actor:{name:'Owned structure file bridge'},operations:loaded.snapshot().map((block,index)=>({op:'block.replace',blockId:block.blockId,block:block.content,precondition:{blockHash:projection.blocks[index].blockHash}}))})
 await save('roots.json',roots.map(root=>({key:root.key})));await save('prepare-evidence.json',{inputRevision:projection.revision,roots:roots.length,bodies:containers.bodies.size,oldStoreRejected:true,structuralInitializeAndReloadExact:true,personalUndoRedoExact:true,edit:'Append 已接入结构 to first body and deliberately clear 新内容 using structural reconciliation',emptyBody:emptyCandidates[0],captures:captures.length,scope:'Body-aware structural store and actual native file application; no active room or signed coordinator'})
 loaded.document.destroy()
}else{
 const loaded=replica();Y.applyUpdate(loaded.document,new Uint8Array(await readFile(join(output,'prepared.yjs'))));const captures:SemanticSourceTarget[]=JSON.parse(await readFile(join(output,'captures.json'),'utf8')),before=checkpointContents(loaded.snapshot()),history=loaded.store.undoManager(false)
 reconcileStructureSources(loaded.store,captures,projection.blocks,receiptOrigin);assert.deepEqual(loaded.snapshot(),base);assert.equal(checkpointContents(loaded.snapshot()),before);assert.equal(history.undoStack.length,0)
 const containers=loaded.store.flow.containers!,emptyBodies=[...containers.bodies.keys()].filter(id=>containers.readBody(id).content.size===0);assert.equal(emptyBodies.length,1);assert.match(containers.readBody(emptyBodies[0]).attrs.hcdSourceId,/^n_[a-f0-9]{32}$/)
 await save('postreceipt.json',loaded.snapshot());await writeFile(join(output,'receipted.yjs'),Y.encodeStateAsUpdate(loaded.document));history.destroy();loaded.document.destroy()
 const reopened=replica();Y.applyUpdate(reopened.document,new Uint8Array(await readFile(join(output,'receipted.yjs'))));assert.deepEqual(reopened.snapshot(),base);await save('receipt-evidence.json',{canonicalRevision:projection.revision,fullCodecCanonicalSnapshotIncludingSourceIdsExact:true,businessNullFalseAndEmptyValuesPreserved:true,receiptChangesSemanticDigest:false,newYDocFromActualFileExact:true,receiptCreatesPersonalHistory:false,emptyBodySourceRetained:true,bodies:reopened.store.flow.containers!.bodies.size});reopened.document.destroy()
}
console.log(`PASS ${stage}: structural prepare/reconcile, personal history, file reload and recursive receipt`)
