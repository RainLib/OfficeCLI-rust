/** Submit a real link to an already-open normal browser room. UI actions and
 * old-window assertions are performed through the browser testing surface. */
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=resolve(process.argv[2]),out=resolve(process.argv[3]),c=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(c.root,root);assert.equal(c.clean,true);assert.equal(c.linkSource,true);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/);await mkdir(out,{recursive:true})
const native=JSON.parse(execFileSync(resolve('target/debug/officecli'),['hdoc','editor-state',join(root,'region-test.hcd'),'--json'],{encoding:'utf8',timeout:60000})).data,headers={Authorization:'Bearer '+c.alice,'Content-Type':'application/json','X-HCD-Node-Edits-Version':'7','X-HCD-Word-Regions-Version':'2','X-HCD-Word-Layout-Version':'1','X-HCD-Word-Link-Version':'1'}
async function post(action:string,body:unknown){const response=await fetch(`http://127.0.0.1:${c.collabPort}/v1/documents/region-test/collaboration/word-active-link-${action}`,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value}
const selection={sectionId:native.flowLayout.sections[1].id,kind:'header',variant:'even',transactionId:randomUUID().replaceAll('-','')},preview=await post('preview',{epoch:1,selection}),body={epoch:1,pending:preview.pending,reviewHash:preview.reviewHash}
assert.equal(preview.revision,native.revision);const markers={own:'Link own 20261030-Q1',peer:'Link peer 20261030-Q1'}
const nativeText=JSON.stringify(native);for(const marker of Object.values(markers))assert.equal(nativeText.includes(marker),false,'expected uncommitted browser body input')
await writeFile(join(root,'link-session-original.json'),JSON.stringify(body),{mode:0o600})
const installed=await post('submit',body);assert.equal(installed.revision,native.revision+1)
await writeFile(join(out,'service.json'),JSON.stringify({scope:'actual sidecar link submission with three pre-existing ordinary editor windows; subsequent UI/undo/backup assertions recorded separately',initial:native.revision,linkRevision:installed.revision,selection,pending:preview.pending,reviewHash:preview.reviewHash,markers,installed,bodyDraftsNotYetCanonical:true,normalLinkCreationUI:false,physicalDevice:false,realIme:false,production:false},null,2)+'\n')
console.log(JSON.stringify({initial:native.revision,linkRevision:installed.revision,bodyDraftsNotYetCanonical:true}))
