/** Owned offline edits of an actual browser-downloaded recovery file. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {getSchema} from '@tiptap/core'
import {schemaExtensions} from '../src/schema.ts'
import {SemanticStructureIdentity} from '../src/semanticStructureIdentity.ts'
import {NodeExtensionRegistry} from '../src/extensionRegistry.ts'
import {createSemanticRecoveryArchive,openSemanticRecoveryArchive,semanticRecoveryArchiveScope} from '../src/semanticRecoveryArchive.ts'
import {nodePortableFixture} from './nodePortable.ts'
import {nativeRecoveryVerifier} from './semanticRecoveryFileVerifier.ts'
import {createHash} from 'node:crypto'
const [input,rootPath]=process.argv.slice(2),root=resolve(rootPath),binary=resolve('../../..','target/debug/officecli'),schema=getSchema([...schemaExtensions,SemanticStructureIdentity]),verifyCanonical=nativeRecoveryVerifier({root,binary}),original=new Uint8Array(await readFile(input)),scope=semanticRecoveryArchiveScope(original)
await mkdir(root,{recursive:true});const candidate=await openSemanticRecoveryArchive(original,{scope,schema,verifyCanonical}),hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
try{
 const attached=new TextEncoder().encode('恢复包附件原始字节 😀'),resource={key:'attached',hash:hash(attached),byteLength:attached.length,name:'恢复附件.txt',mediaType:'text/plain'},registry=new NodeExtensionRegistry(nodePortableFixture),value=registry.create('example.resource_badge',{title:'恢复附件'},[resource]),node=schema.nodes.hcdExtensionInline.createChecked({extension:value})
 candidate.store.insert([schema.nodes.paragraph.createChecked(null,schema.text('文件中新增的段落😀')),schema.nodes.paragraph.createChecked(null,[node])],null)
 const pendingBytes=new TextEncoder().encode('未完成文件待确认原始字节 😀'),pendingResource={key:'pending',hash:hash(pendingBytes),byteLength:pendingBytes.length,name:'待确认附件.txt',mediaType:'text/plain'},pending={version:1 as const,id:crypto.randomUUID(),regionId:'body',expected:value,resource:pendingResource,bytes:pendingBytes,phase:'chosen' as const}
 const packet=async(files:typeof pending[])=>createSemanticRecoveryArchive({scope,document:candidate.document,schema,canonical:candidate.canonical,verifyCanonical,pendingFiles:files,readResource:async metadata=>metadata.hash===resource.hash?attached:assert.fail('unexpected resource')})
 await writeFile(join(root,'edited.hcd-recovery'),await packet([]));await writeFile(join(root,'pending.hcd-recovery'),await packet([pending]));await writeFile(join(root,'file-fixture-evidence.json'),JSON.stringify({source:'Actual browser download; isolated Y.Doc edits with no network mutation',scope,resource,pendingResource,pendingSelectionId:pending.id,createdNode:value.instanceId,sourceSha256:hash(original),body:candidate.store.project().textContent},null,2)+'\n');console.log('PASS: downloaded scope + offline text/node/resource edits and pending bytes')
}finally{candidate.dispose()}
