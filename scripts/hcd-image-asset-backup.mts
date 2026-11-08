import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {imageFileHash} from '../examples/hdoc/editor/src/imageFileIntegrity.ts'
import {readImageAssetBackup} from '../examples/hdoc/editor/src/imageAssetBackup.ts'
const root=process.argv[2];if(!root.includes('/hcd-preview-runtime/hcd-mention-preview-'))throw Error('isolated fixture required')
const config=JSON.parse(await readFile(root+'/private.json','utf8')),prior=JSON.parse(await readFile(root+'/semantic-image-service-evidence.json','utf8')),session={documentId:'mentions-docx',token:config.alice,scope:'write' as const,format:'docx',apiUrl:config.origin+'/v1/documents'},base=`${session.apiUrl}/${session.documentId}`
async function revision(){const response=await fetch(base,{headers:{Authorization:`Bearer ${session.token}`}});assert.equal(response.status,200);return(await response.json()).revision}
const before=await revision(),original=new Uint8Array(await readFile(root+'/replacement.png')),saved=await readImageAssetBackup(session,prior.assetHash);assert.equal(saved.extension,'png');assert.deepEqual(saved.bytes,original)
const stagedBytes=new Uint8Array(await readFile(root+'/backup-probe.png')),hash=await imageFileHash(stagedBytes),response=await fetch(base+'/staged-assets?extension=png',{method:'POST',headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/octet-stream'},body:new Blob([stagedBytes])});assert.equal(response.status,200);assert.equal((await response.json()).hash,hash)
const staged=await readImageAssetBackup(session,hash);assert.equal(staged.extension,'png');assert.deepEqual(staged.bytes,stagedBytes);assert.equal(await revision(),before)
const evidence={scope:'Local native API and synthetic image bytes. No browser download or production validation.',revision:before,canonicalExact:true,stagedExact:true,stagedHash:hash};await writeFile(root+'/image-asset-backup-evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence))
