import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readExportPreflight} from './exportPreflight.ts'
import {readExportOptions,wordNumericFieldsPreserved,currentExportOptions} from './exportOptions.ts'

test('preflight reads bounded JSON and rejects oversized or invalid responses',async()=>{
 assert.deepEqual(await readExportPreflight(async()=>Response.json({revision:3})),{revision:3})
 await assert.rejects(readExportPreflight(async()=>new Response('x'.repeat(65537))),/export-preflight-limit/)
 await assert.rejects(readExportPreflight(async()=>new Response(new Uint8Array([255]))))
})

test('a stalled response header times out even when the transport ignores cancellation',async()=>{
 let complete!:(response:Response)=>void,cancelled=false
 const response=new Promise<Response>(resolve=>{complete=resolve})
 const keepAlive=setTimeout(()=>{},1000)
 try{await assert.rejects(readExportPreflight(()=>response,undefined,30),error=>error instanceof Error&&error.name==='TimeoutError')}finally{clearTimeout(keepAlive)}
 complete(new Response(new ReadableStream({cancel(){cancelled=true}})))
 await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(cancelled,true)
})

test('a stalled body times out and is cancelled',async()=>{
 let cancelled=false
 const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'))},cancel(){cancelled=true}}))
 const keepAlive=setTimeout(()=>{},1000)
 try{await assert.rejects(readExportPreflight(async()=>response,undefined,30),error=>error instanceof Error&&error.name==='TimeoutError')}finally{clearTimeout(keepAlive)}
 assert.equal(cancelled,true)
})

test('changing scope cancels preflight without accepting a late result',async()=>{
 let complete!:(response:Response)=>void,cancelled=false
 const response=new Promise<Response>(resolve=>{complete=resolve}),controller=new AbortController()
 const pending=readExportPreflight(()=>response,controller.signal)
 await Promise.resolve()
 controller.abort(new Error('scope changed'))
 await assert.rejects(pending,/scope changed/)
 complete(new Response(new ReadableStream({cancel(){cancelled=true}})))
 await new Promise(resolve=>setTimeout(resolve,0))
 assert.equal(cancelled,true)
})
test('regional export formats must be an explicit valid capability list',()=>{
 const base={revision:3,sourceAvailable:false,sourceEditsSupported:false}
 assert.equal(readExportOptions(base,3).semanticFormats?.includes('txt'),undefined)
 assert.equal(readExportOptions({...base,semanticFormats:['docx','txt']},3).semanticFormats?.includes('txt'),true)
 for(const value of [null,'txt',[3]])assert.throws(()=>readExportOptions({...base,semanticFormats:value},3))
})

test('Word field export capability remains optional and only the current declared version enables preservation',()=>{
 const base={revision:3,sourceAvailable:true,sourceEditsSupported:false}
 assert.equal(wordNumericFieldsPreserved(readExportOptions(base,3)),false)
 const advertised=readExportOptions({...base,semanticWordFields:'numeric-v1'},3)
 assert.equal(wordNumericFieldsPreserved(advertised),true)
 assert.equal(wordNumericFieldsPreserved(readExportOptions({...base,semanticWordFields:'future-v2'},3)),false)
 assert.equal(wordNumericFieldsPreserved(currentExportOptions({value:advertised,refreshKey:1},4,1)),false)
 assert.equal(wordNumericFieldsPreserved(currentExportOptions({value:advertised,refreshKey:1},3,2)),false)
 for(const value of [true,{},[],4,'', 'numeric v1'])assert.throws(()=>readExportOptions({...base,semanticWordFields:value},3))
})
