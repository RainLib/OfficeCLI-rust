/** Own synthetic recovery packet: real canonical HCDZ plus two private files.
 * Does not publish document edits or write browser storage. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import * as Y from '../examples/hdoc/editor/node_modules/yjs/dist/yjs.mjs'
import {getSchema} from '../examples/hdoc/editor/node_modules/@tiptap/core/dist/index.js'
import {schemaExtensions} from '../examples/hdoc/editor/src/schema.ts'
import {SemanticStructureIdentity} from '../examples/hdoc/editor/src/SemanticStructureIdentity.ts'
import {SemanticInlineContainerNode} from '../examples/hdoc/editor/src/semanticInlineNode.ts'
import {SemanticBlockStore} from '../examples/hdoc/editor/src/semanticBlockStore.ts'
import {createSemanticRecoveryArchive} from '../examples/hdoc/editor/src/semanticRecoveryArchive.ts'
import {recoveryHash,httpRecoveryVerifier} from '../examples/hdoc/editor/src/semanticRecoveryTransfer.ts'
import {inlineProtocol} from '../examples/hdoc/editor/src/collaborationProtocol.ts'

const root=resolve(process.argv[2]??''),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(config.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/hcd-inline-editor-[^/]+$/)
const session={documentId:'inline-native',scope:'read' as const,format:'docx',token:config.tokens.reader,apiUrl:`http://127.0.0.1:${config.ports[0]}/v1/documents`,collaborationEpoch:0,collaborationProtocol:inlineProtocol}
const request=async(route:string)=>{const response=await fetch(`${session.apiUrl}/inline-native${route}`,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(response.status,200);return response}
const manifest=await(await request('')).json(),auth=await(await request('/auth')).json();session.collaborationEpoch=auth.collaborationEpoch;session.collaborationProtocol=auth.collaborationProtocol
assert.equal(auth.collaborationProtocol,inlineProtocol)
const canonical=new Uint8Array(await(await request(`/export/hcdz?revision=${manifest.revision}`)).arrayBuffer()),schema=getSchema([...schemaExtensions,SemanticStructureIdentity,SemanticInlineContainerNode]),document=new Y.Doc({gc:false}),store=new SemanticBlockStore(document,schema,undefined,{inlineContainers:true})
store.initialize(schema.node('doc',null,[schema.node('paragraph',null,[schema.text('附件恢复私有样例')])]))
const files=await Promise.all([1,2].map(async n=>{
 const bytes=new Uint8Array(6*1024*1024).fill(n),hash=await recoveryHash(bytes)
 return{version:1 as const,id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,regionId:'body',phase:'chosen' as const,expected:{schemaVersion:'hcd.extension/2' as const,instanceId:'x_'+'a'.repeat(32),type:'example.file',version:1,display:'inline' as const,data:{},fallback:{text:'file'}},resource:{key:'file',hash,byteLength:bytes.length,name:`large-${n}.bin`,mediaType:'application/octet-stream'},bytes}
}))
try{
 const scope={documentId:'inline-native',epoch:auth.collaborationEpoch,model:'structure3-inline1' as const,revision:manifest.revision,rootHash:manifest.rootHash},packet=await createSemanticRecoveryArchive({scope,document,schema,canonical,pendingFiles:files,verifyCanonical:httpRecoveryVerifier(session,new AbortController().signal),readResource:async()=>assert.fail('no committed resource')})
 const output=join(root,'large-files.hcd-recovery');await writeFile(output,packet,{flag:'wx'})
 const evidence={scope:'Owned synthetic canonical archive with two private 6 MiB files; no browser state writes or document commits',revision:manifest.revision,packetBytes:packet.length,packetHash:await recoveryHash(packet),files:files.map(file=>({name:file.resource.name,hash:file.resource.hash,byteLength:file.bytes.length}))}
 await writeFile(join(root,'large-files.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file:output,...evidence}))
}finally{document.destroy()}
