import {test} from 'node:test'
import assert from 'node:assert/strict'
import {writeRecoveryJson} from './recoveryJsonWriter.ts'

test('chunked JSON output keeps unicode and UTF-16 boundary pairs intact',async()=>{
 const json=JSON.stringify({name:'a'.repeat(256*1024-10)+'😀é中',data:'A'.repeat(600000)}),signal=new AbortController().signal
 assert.equal(json.charCodeAt(256*1024-1),0xd83d)
 const result=await writeRecoveryJson([json],2_000_000,signal)
 assert.deepEqual(result,new TextEncoder().encode(json));assert.deepEqual(JSON.parse(new TextDecoder().decode(result)),JSON.parse(json))
 await assert.rejects(writeRecoveryJson([json],100,signal),/semantic-recovery-limit/)
})
test('cancel while serializing prevents publishing the assembled bytes',async()=>{
 const controller=new AbortController(),work=writeRecoveryJson(['A'.repeat(1024*1024)],2_000_000,controller.signal)
 controller.abort(Error('cancelled'));await assert.rejects(work,/cancelled/)
})
