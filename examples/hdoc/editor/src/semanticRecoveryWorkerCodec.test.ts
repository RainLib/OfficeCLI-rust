import test from 'node:test'
import assert from 'node:assert/strict'

test('worker transfers strictly decoded binary envelopes and rejects malformed data',async()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'self'),replies:Array<{value:any;transfer:Transferable[]}>=[]
 const scope:{onmessage:((event:{data:ArrayBuffer|{file:Blob}})=>void)|null;postMessage:(value:unknown,transfer:Transferable[])=>void}={onmessage:null,postMessage:(value,transfer)=>replies.push({value,transfer})}
 Object.defineProperty(globalThis,'self',{value:scope,configurable:true})
 try{
  await import('./semanticRecoveryParseWorker.ts')
  const binary=(s:string)=>({byteLength:s.length,sha256:'a'.repeat(64),base64:btoa(s)})
  const source={schemaVersion:'hcd-semantic-recovery/1',scope:{},canonical:binary('a'),state:binary('ab'),resources:[binary('abc')],pendingFiles:[]}
  const send=(value:unknown)=>scope.onmessage!({data:new TextEncoder().encode(JSON.stringify(value)).buffer})
  send(source);const result=replies.pop()!;assert.equal(result.value.ok,true);assert.deepEqual([...result.value.value.canonical.bytes],[97]);assert.deepEqual([...result.value.value.state.bytes],[97,98]);assert.deepEqual([...result.value.value.resources[0].bytes],[97,98,99]);assert.equal(result.transfer.length,3)
  send({...source,canonical:{...source.canonical,base64:'YR=='}});assert.equal(replies.pop()!.value.ok,false)
  send({...source,resources:[{...source.resources[0],byteLength:17*1024*1024}]});assert.equal(replies.pop()!.value.ok,false)
  send({...source,state:{...source.state,unexpected:true}});assert.equal(replies.pop()!.value.ok,false)
  const packet=new TextEncoder().encode(JSON.stringify(source)),expected=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',packet)),byte=>byte.toString(16).padStart(2,'0')).join('')
  const fileResult=await new Promise<{value:any;transfer:Transferable[]}>(resolve=>{scope.postMessage=(value,transfer)=>resolve({value,transfer});scope.onmessage!({data:{file:new Blob([packet])}})})
  assert.equal(fileResult.value.ok,true);assert.equal(fileResult.value.packetHash,expected);assert.deepEqual([...fileResult.value.value.resources[0].bytes],[97,98,99]);assert.equal(fileResult.transfer.length,3)
  const empty=await new Promise<any>(resolve=>{scope.postMessage=value=>resolve(value);scope.onmessage!({data:{file:new Blob([])}})});assert.equal(empty.ok,false)
 }finally{if(previous)Object.defineProperty(globalThis,'self',previous);else delete (globalThis as {self?:unknown}).self}
})
