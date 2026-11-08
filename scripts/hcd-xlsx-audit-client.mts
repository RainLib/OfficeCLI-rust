/** Exercise the browser audit client against an owned native fixture. */
import {readFile,writeFile} from 'node:fs/promises'
import {resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import assert from 'node:assert/strict'
import {api,ApiError,type Session} from '../examples/hdoc/editor/src/api.ts'
import {workbookFormulaAudit} from '../examples/hdoc/editor/src/workbookFormulaAudit.ts'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=resolve(process.argv[2]),output=resolve(process.argv[3])
assert.equal(dirname(root),repo+'/target/hcd-preview-runtime');assert.ok(root.split('/').at(-1)!.startsWith('hcd-workbook-'))
const config=JSON.parse(await readFile(root+'/private.json','utf8'))
const session:Session={documentId:'book',format:'xlsx',scope:'write',token:config.tokens.alice,apiUrl:`http://127.0.0.1:${config.ports[0]}/v1/documents`},signal=new AbortController().signal
const initial=await(await api(session,'')).json()
const checked=await workbookFormulaAudit(session,initial.revision,false,signal)
const enabled=await workbookFormulaAudit(session,initial.revision,true,signal)
assert.deepEqual(enabled,checked)
const reader={...session,scope:'read' as const,token:config.tokens.reader}
await assert.rejects(workbookFormulaAudit(reader,initial.revision,true,signal),error=>error instanceof ApiError&&error.status===403)
const final=await(await api(session,'')).json();assert.equal(final.revision,initial.revision);assert.equal(final.rootHash,initial.rootHash)
const result={scope:'isolated native API and synthetic XLSX',revision:final.revision,editableCellsChecked:checked.editableCellsChecked,protectionEnabled:true,readerRejected:true,rootUnchanged:true}
await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
