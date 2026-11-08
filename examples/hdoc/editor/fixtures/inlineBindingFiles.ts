/** Actual native file bridge using the precise PM inline-body binding.
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
import {EditorState,type Transaction,type PluginView} from '@tiptap/pm/state'
import type {EditorView} from '@tiptap/pm/view'
import {semanticStructureBinding} from '../src/semanticStructureBinding.ts'
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
 const roots=loaded.store.blocks(),history=loaded.store.undoManager(false),errors:unknown[]=[],plugin=semanticStructureBinding(loaded.store,{canWrite:()=>true,onError:cause=>errors.push(cause)})
 let state=EditorState.create({schema,doc:loaded.store.project(),plugins:[plugin]}),binding:PluginView
 const view={get state(){return state},dispatch(tr:Transaction){const before=state;state=state.applyTransaction(tr).state;binding?.update?.(view as unknown as EditorView,before)}};binding=plugin.spec.view!(view as unknown as EditorView);await Promise.resolve()
 const bodyStart=(doc:PmNode,id:string)=>{let found:number|undefined;doc.descendants((node,at)=>{if(node.type.name===inlineContainerNodeName&&node.attrs.extension.instanceId===id)found=at+1});assert.ok(found!==undefined);return found}
 const visible=(raw:Y.XmlText)=>{const ids:string[]=[];for(let item=raw._start;item;item=item.right)if(!item.deleted&&item.countable)for(let i=0;i<item.length;i++)ids.push(`${item.id.client}:${item.id.clock+i}`);return ids}
 const raw=containers.bodies.get(chosen)!,original=visible(raw),start=bodyStart(state.doc,chosen)
 let tr=state.tr.insertText('n',start).insertText('ni',start,start+1).insertText('精确绑定😀 ',start,start+2)
 const clearing=emptyCandidates[0],from=bodyStart(tr.doc,clearing),length=containers.readBody(clearing).content.size;tr.delete(from,from+length)
 view.dispatch(tr);assert.deepEqual(errors,[]);assert.deepEqual(visible(raw).slice('精确绑定😀 '.length),original);assert.ok(state.doc.eq(loaded.store.project()))
 history.stopCapturing();const expected=loaded.snapshot();assert.equal(history.undoStack.length,1);assert.ok(history.undo());assert.deepEqual(loaded.snapshot(),base);assert.ok(history.redo());assert.deepEqual(loaded.snapshot(),expected);history.destroy();binding.destroy?.()

 const captures=structureSourceTargets(loaded.store);assert.equal(captures.length,projection.blocks.length)
 await save('snapshot.json',loaded.snapshot());await save('captures.json',captures);await writeFile(join(output,'prepared.yjs'),Y.encodeStateAsUpdate(loaded.document))
 await save('patch.json',{schemaVersion:'hcd-patch/4',documentId:projection.documentId,patchId:'inline-binding-file-bridge',baseRevision:projection.revision,actor:{name:'Owned structure file bridge'},operations:loaded.snapshot().map((block,index)=>({op:'block.replace',blockId:block.blockId,block:block.content,precondition:{blockHash:projection.blocks[index].blockHash}}))})
 await save('roots.json',roots.map(root=>({key:root.key})));await save('prepare-evidence.json',{inputRevision:projection.revision,roots:roots.length,bodies:containers.bodies.size,oldStoreRejected:true,structuralInitializeAndReloadExact:true,personalUndoRedoExact:true,exactPmTransactionBinding:true,originalBodyCharactersRetained:true,edit:'Composition-style 精确绑定😀 prefix and clear 新内容 via real PM transactions',emptyBody:emptyCandidates[0],captures:captures.length,scope:'Body-aware structural store and actual native file application; no active room or signed coordinator'})
 loaded.document.destroy()
}else{
 const loaded=replica();Y.applyUpdate(loaded.document,new Uint8Array(await readFile(join(output,'prepared.yjs'))));const captures:SemanticSourceTarget[]=JSON.parse(await readFile(join(output,'captures.json'),'utf8')),before=checkpointContents(loaded.snapshot()),history=loaded.store.undoManager(false)
 reconcileStructureSources(loaded.store,captures,projection.blocks,receiptOrigin);assert.deepEqual(loaded.snapshot(),base);assert.equal(checkpointContents(loaded.snapshot()),before);assert.equal(history.undoStack.length,0)
 const containers=loaded.store.flow.containers!,emptyBodies=[...containers.bodies.keys()].filter(id=>containers.readBody(id).content.size===0);assert.equal(emptyBodies.length,1);assert.match(containers.readBody(emptyBodies[0]).attrs.hcdSourceId,/^n_[a-f0-9]{32}$/)
 await save('postreceipt.json',loaded.snapshot());await writeFile(join(output,'receipted.yjs'),Y.encodeStateAsUpdate(loaded.document));history.destroy();loaded.document.destroy()
 const reopened=replica();Y.applyUpdate(reopened.document,new Uint8Array(await readFile(join(output,'receipted.yjs'))));assert.deepEqual(reopened.snapshot(),base);await save('receipt-evidence.json',{canonicalRevision:projection.revision,fullCodecCanonicalSnapshotIncludingSourceIdsExact:true,businessNullFalseAndEmptyValuesPreserved:true,receiptChangesSemanticDigest:false,newYDocFromActualFileExact:true,receiptCreatesPersonalHistory:false,emptyBodySourceRetained:true,bodies:reopened.store.flow.containers!.bodies.size});reopened.document.destroy()
}
console.log(`PASS ${stage}: precise PM binding, personal history, file reload and recursive receipt`)
