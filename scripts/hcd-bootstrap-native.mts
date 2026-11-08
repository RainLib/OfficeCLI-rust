// Read-only native API proof. Credentials remain inside the owned loopback fixture.
import * as fs from 'node:fs/promises'
import {resolve,basename} from 'node:path'
import assert from 'node:assert/strict'
import {readServerDraft,DraftBootstrapError} from '../examples/hdoc/editor/src/draftBootstrap.ts'
import {legacyProtocol,structuralProtocol} from '../examples/hdoc/editor/src/collaborationProtocol.ts'
import {localDraftPreview} from '../examples/hdoc/editor/src/localDrafts.ts'
const root=resolve(process.argv[2]??'')
assert.match(basename(root),/^hcd-mention-preview-/)
const fixture=JSON.parse(await fs.readFile(resolve(root,'private.json'),'utf8'))
assert.equal(new URL(fixture.origin).hostname,'127.0.0.1')
const manifest=resolve(root,'mentions-docx.hcd/manifest.json'),before=await fs.readFile(manifest,'utf8')
const original=globalThis.fetch,requests:Array<{route:string;status:number}>=[]
globalThis.fetch=async(input,init)=>{const response=await original(input,init);requests.push({route:new URL(String(input)).pathname.split('/').pop()!,status:response.status});return response}
try{
 if(process.argv[3]){
  const access=await(await original(fixture.origin+'/v1/documents/mentions-docx/auth',{headers:{Authorization:'Bearer '+fixture.bob}})).json()
  const doc=await readServerDraft({documentId:'mentions-docx',scope:'write',format:'docx',token:fixture.bob,apiUrl:fixture.origin+'/v1/documents',...access},AbortSignal.timeout(10000))
  assert.ok(doc);const present=localDraftPreview(doc).includes(process.argv[3]);doc.destroy();assert.equal(present,false)
  assert.equal(await fs.readFile(manifest,'utf8'),before)
  const evidence={boundary:'actual native collaboration snapshot before local recovery',marker:process.argv[3],markerPresent:present,nativeRevision:JSON.parse(before).revision,nativeManifestUnchanged:true}
  await fs.writeFile(resolve('docs/assets/hcd-workbench-2026-10-24/bootstrap-server-before-recovery.json'),JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify(evidence)+'\n')
 }else{
 await assert.rejects(readServerDraft({documentId:'mentions-docx',scope:'write',format:'docx',token:fixture.bob,apiUrl:fixture.origin+'/v1/documents',collaborationEpoch:0,collaborationProtocol:legacyProtocol},AbortSignal.timeout(10000)),
  error=>error instanceof DraftBootstrapError&&error.key==='localDraftAuthorityChanged'&&error.authority?.collaborationProtocol===structuralProtocol&&error.authority.collaborationEpoch>0)
 assert.deepEqual(requests.map(value=>value.status),[409,200])
 assert.equal(await fs.readFile(manifest,'utf8'),before)
 const evidence={boundary:'actual loopback native HTTP read-only stale-epoch request via the frontend bootstrap helper; not proof of the exact earlier browser failure',requests,decision:'refresh changed authority once, retain disk copies; no storage-failure fallback',nativeManifestUnchanged:true}
 await fs.writeFile(resolve('docs/assets/hcd-workbench-2026-10-24/bootstrap-native-evidence.json'),JSON.stringify(evidence,null,2)+'\n')
 process.stdout.write(JSON.stringify(evidence)+'\n')
 }
}finally{globalThis.fetch=original}
