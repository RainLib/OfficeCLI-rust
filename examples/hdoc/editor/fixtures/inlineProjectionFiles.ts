/** CLI/file bridge audit only; no browser or active room capability is enabled. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import * as Y from 'yjs'
import {getSchema} from '@tiptap/core'
import {Fragment,type Node as PmNode} from '@tiptap/pm/model'
import {schemaExtensions,projectionToJson,jsonToSnapshot,type Projection} from '../src/schema.ts'
import {SemanticInlineContainerNode} from '../src/semanticInlineNode.ts'
import {SemanticInlineContainers,inlineContainerNodeName} from '../src/semanticInlineContainers.ts'
import {SemanticTextFlow} from '../src/semanticTextFlow.ts'
import {captureSourceLeaf,sourceLeafActions,type SourceBindingStore,type SourceLeafBinding} from '../src/semanticSourceBindings.ts'
import {checkpointContents} from '../src/checkpointSnapshot.ts'
const [stage,input,output]=process.argv.slice(2);assert.ok(['prepare','receipt'].includes(stage)&&input&&output)
const projection:Projection=JSON.parse(await readFile(input,'utf8')),models={inlineContainers:true},schema=getSchema([...schemaExtensions,SemanticInlineContainerNode]),origin={kind:'file-bridge-user'},receiptOrigin={kind:'file-bridge-receipt'}
await mkdir(output,{recursive:true})
function normal(value:unknown):unknown{
 if(Array.isArray(value))return value.map(normal)
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key,item])=>item!==null&&item!==undefined&&!(item===false&&['bold','italic','underline','strike','code','hardBreak','fontSizeExplicit'].includes(key))&&!(Array.isArray(item)&&!item.length&&['children','customMarks'].includes(key))).map(([key,item])=>[key,normal(item)]))
 return value
}
type Root={key:string;attrs:Record<string,unknown>;type:string}
const roots:Root[]=stage==='prepare'?[]:JSON.parse(await readFile(join(output,'roots.json'),'utf8'))
function replica(){
 const document=new Y.Doc({gc:false}),contents=document.getMap<Y.XmlFragment>('carriers'),containers=new SemanticInlineContainers(document,schema,origin),flow=new SemanticTextFlow(document,contents,schema,origin,containers)
 const content=(key:string)=>{const root=roots.find(root=>root.key===key)!;return schema.nodes[root.type].createChecked(root.attrs,flow.read(key).content)}
 const store:SourceBindingStore={flow,contents,content}
 const snapshot=()=>jsonToSnapshot(schema.nodes.doc.createChecked(null,roots.map(root=>content(root.key))).toJSON(),models)
 return{document,contents,containers,flow,store,snapshot}
}
const save=(name:string,value:unknown)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n')
const base=projection.blocks.map(block=>({blockId:block.blockId,content:block.content}))
if(stage==='prepare'){
 assert.throws(()=>projectionToJson(projection),/unsupportedInlineContainerModel/)
 const pm=schema.nodeFromJSON(projectionToJson(projection,models));pm.check();assert.equal(pm.childCount,projection.blocks.length)
 const r=replica()
 pm.forEach((node,index)=>{
  assert.ok(node.isTextblock);const key=`root-${index}`,fragment=new Y.XmlFragment();roots.push({key,attrs:node.attrs,type:node.type.name});r.contents.set(key,fragment);fragment.insert(0,[new Y.XmlText()]);r.containers.write(fragment.get(0) as Y.XmlText,Fragment.empty,node)
 })
 r.flow.initialize(roots.map(root=>root.key));assert.deepEqual(normal(r.snapshot()),normal(base))
 await writeFile(join(output,'initial.yjs'),Y.encodeStateAsUpdate(r.document));await save('roots.json',roots);r.document.destroy()
 const loaded=replica();Y.applyUpdate(loaded.document,new Uint8Array(await readFile(join(output,'initial.yjs'))));assert.deepEqual(normal(loaded.snapshot()),normal(base))
 let chosen:string|undefined
 for(const root of roots)loaded.store.content(root.key).descendants(node=>{if(!chosen&&node.type.name===inlineContainerNodeName)chosen=node.attrs.extension.instanceId})
 assert.ok(chosen);const body=loaded.containers.bodies.get(chosen)!
 const emptyCandidates=[...loaded.containers.bodies.keys()].filter(id=>loaded.containers.readBody(id).textContent==='新内容');assert.equal(emptyCandidates.length,1)
 const emptied=loaded.containers.bodies.get(emptyCandidates[0])!
 loaded.document.transact(()=>{body.insert(body.length,' 已回读',{});emptied.delete(0,emptied.length)},origin)
 const snapshot=loaded.snapshot(),captures=roots.map(root=>captureSourceLeaf(loaded.store,root.key,loaded.store.content(root.key)))
 await save('snapshot.json',snapshot);await save('captures.json',captures);await writeFile(join(output,'prepared.yjs'),Y.encodeStateAsUpdate(loaded.document))
 await save('patch.json',{schemaVersion:'hcd-patch/4',documentId:projection.documentId,patchId:'inline-projection-file-bridge',baseRevision:projection.revision,actor:{name:'Owned file bridge'},operations:snapshot.map((block,index)=>({op:'block.replace',blockId:block.blockId,block:block.content,precondition:{blockHash:projection.blocks[index].blockHash}}))})
 await save('prepare-evidence.json',{inputRevision:projection.revision,roots:roots.length,bodies:loaded.containers.bodies.size,oldReaderRejected:true,nativeDtoPmYjsFileNewDocExact:true,edit:'append 已回读 to first real body and deliberately clear 新内容 field',emptyBody:emptyCandidates[0],captures:captures.length,scope:'Internal codec/kernel plus actual native file application; not a signed coordinator/browser checkpoint'})
 loaded.document.destroy()
}else{
 const loaded=replica();Y.applyUpdate(loaded.document,new Uint8Array(await readFile(join(output,'prepared.yjs'))))
 const captures:SourceLeafBinding[]=JSON.parse(await readFile(join(output,'captures.json'),'utf8')),pm=schema.nodeFromJSON(projectionToJson(projection,models)),before=checkpointContents(loaded.snapshot()),actions:Array<()=>void>=[]
 roots.forEach((root,index)=>actions.push(...sourceLeafActions(loaded.store,root.key,pm.child(index),captures[index])))
 loaded.document.transact(transaction=>{transaction.meta.set('addToHistory',false);actions.forEach(action=>action())},receiptOrigin)
 assert.deepEqual(normal(loaded.snapshot()),normal(base));assert.equal(checkpointContents(loaded.snapshot()),before)
 const emptyBodies=[...loaded.containers.bodies.keys()].filter(id=>loaded.containers.readBody(id).content.size===0);assert.equal(emptyBodies.length,1);assert.match(loaded.containers.readBody(emptyBodies[0]).attrs.hcdSourceId,/^n_[a-f0-9]{32}$/)
 await save('postreceipt.json',loaded.snapshot());await writeFile(join(output,'receipted.yjs'),Y.encodeStateAsUpdate(loaded.document));loaded.document.destroy()
 const reopened=replica();Y.applyUpdate(reopened.document,new Uint8Array(await readFile(join(output,'receipted.yjs'))));assert.deepEqual(normal(reopened.snapshot()),normal(base));await save('receipt-evidence.json',{canonicalRevision:projection.revision,fullCanonicalSnapshotIncludingSourceIdsExact:true,receiptChangesSemanticDigest:false,newYDocFromActualFileExact:true,sourceActions:actions.length,emptyBodySourceRetained:true,bodies:reopened.containers.bodies.size});reopened.document.destroy()
}
console.log(`PASS ${stage}: native DTO, permanent bodies, file reload and source receipt`)
