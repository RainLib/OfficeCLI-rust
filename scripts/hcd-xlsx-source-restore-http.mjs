// Exercise only a preview fixture created by hcd-workbook-recovery-preview.py.
// Tokens are read from the private fixture and are never printed or saved.
import assert from 'node:assert/strict'
import {readFile,rename,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'

const root=resolve(process.argv[2]??'')
if(!root.includes('/target/hcd-preview-runtime/hcd-workbook-'))throw Error('owned workbook fixture required')
const config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
if(config.root!==root)throw Error('fixture identity mismatch')
const base=`http://127.0.0.1:${config.ports[0]}/v1/documents/book`
const auth=(user)=>({Authorization:`Bearer ${config.tokens[user]}`})
const source=join(root,'sources/book.xlsx'),held=join(root,'sources/book.xlsx.held')
const original=await readFile(source)
await rename(source,held)
try{
 const missing=await fetch(`${base}/xlsx/formula-audit`,{headers:auth('alice')});assert.equal(missing.status,404)
 const denied=await fetch(`${base}/xlsx/source`,{method:'POST',headers:auth('reader'),body:original});assert.equal(denied.status,403)
 const wrong=await fetch(`${base}/xlsx/source`,{method:'POST',headers:auth('alice'),body:Buffer.from('wrong workbook')});assert.equal(wrong.status,422)
 const ok=await fetch(`${base}/xlsx/source`,{method:'POST',headers:auth('alice'),body:original});assert.equal(ok.status,200);assert.equal((await ok.json()).alreadyPresent,false)
 const again=await fetch(`${base}/xlsx/source`,{method:'POST',headers:auth('alice'),body:original});assert.equal(again.status,200);assert.equal((await again.json()).alreadyPresent,true)
 const restored=await readFile(source),digest=x=>createHash('sha256').update(x).digest('hex');assert.equal(digest(restored),digest(original))
 const audit=await fetch(`${base}/xlsx/formula-audit`,{headers:auth('alice')});assert.equal(audit.status,200);assert.equal((await audit.json()).revision,0)
 const proof=await fetch(`${base}/xlsx/formula-audit`,{method:'POST',headers:{...auth('alice'),'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:0})});assert.equal(proof.status,200);assert.equal((await proof.json()).sourceFreeEditsAuthorized,true)
 const result={readOnlyDenied:true,wrongSourceRejected:true,restored:true,repeatIdempotent:true,sourceSha256:digest(restored),auditedRevision:0,proofEnabled:true}
 if(process.argv[3])await writeFile(resolve(process.argv[3]),JSON.stringify(result,null,2)+'\n')
 console.log(JSON.stringify(result))
}finally{
 // Keep the fixture usable even if the test failed before restoring the source.
 try{await readFile(source)}catch{await rename(held,source)}
}
