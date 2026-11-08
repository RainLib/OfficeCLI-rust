/** Owned loopback-only fixture proxy. Drop one successful native link response
 * after its entire body was received; all other requests stream unchanged. */
import {createServer,request} from 'node:http'
import {writeFileSync,readFileSync,lstatSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,join} from 'node:path'
import assert from 'node:assert/strict'
const root=resolve(process.argv[2]),listen=Number(process.argv[3]),target=Number(process.argv[4]),config=JSON.parse(readFileSync(join(root,'private.json'),'utf8'))
assert.equal(config.root,root);assert.ok(config.dropNativeLinkResponse===true||config.nativeTopologyProxy===true);assert.equal(lstatSync(root).isDirectory(),true);assert.equal(lstatSync(root).isSymbolicLink(),false)
assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
for(const port of [listen,target])assert.ok(Number.isSafeInteger(port)&&port>1024&&port<65536)
let dropped=false,submits=0
const records=[],sealed=new Set(),control=join(root,'native-topology-control')
function record(value){records.push(value);writeFileSync(join(root,'native-topology-records.json'),JSON.stringify(records,null,2),{mode:0o600})}
function modeFor(kind){if(!config.nativeTopologyProxy||!existsSync(control))return 'pass';assert.equal(lstatSync(control).isSymbolicLink(),false);const v=JSON.parse(readFileSync(control,'utf8'));assert.ok(['layout','story'].includes(v.kind)&&['block-submit','drop-success-block-recovery'].includes(v.mode));return v.kind===kind?v.mode:'pass'}
const server=createServer(async(incoming,response)=>{
 const link=incoming.method==='POST'&&incoming.url==='/v1/documents/region-test/word/link-transactions'
 if(link)submits++
 const match=config.nativeTopologyProxy&&incoming.method==='POST'?/^\/v1\/documents\/region-test\/word\/(layout|story)-(transactions|receipt)$/.exec(incoming.url??''):null
 const kind=match?.[1],action=match?.[2],mode=kind?modeFor(kind):'pass'
 let bytes,entry
 if(match){
  const parts=[];let size=0;for await(const part of incoming){size+=part.length;if(size>1024*1024){response.writeHead(413);response.end();return}parts.push(part)}bytes=Buffer.concat(parts);const value=JSON.parse(bytes.toString('utf8')),request=value.transaction??value.request
  assert.match(request.transactionId,/^[a-f0-9]{32}$/);entry={kind,action,transactionId:request.transactionId,...(request.expectedRevision===undefined?{}:{expectedRevision:request.expectedRevision}),bodySha256:createHash('sha256').update(bytes).digest('hex'),mode}
  if(mode==='block-submit'&&action==='transactions'||mode==='drop-success-block-recovery'&&sealed.has(kind)){record({...entry,outcome:'blocked-before-forward'});response.socket?.destroy();return}
 }
 const upstream=request({host:'127.0.0.1',port:target,method:incoming.method,path:incoming.url,headers:incoming.headers},native=>{
  if(match){
   const parts=[];native.on('data',part=>parts.push(part));native.on('end',()=>{const output=Buffer.concat(parts);record({...entry,status:native.statusCode});if(mode==='drop-success-block-recovery'&&action==='transactions'&&native.statusCode===200){sealed.add(kind);response.socket?.destroy()}else{response.writeHead(native.statusCode??502,native.headers);response.end(output)}})
  }else if(config.dropNativeLinkResponse&&link&&native.statusCode===200&&!dropped){
   dropped=true;native.resume();native.on('end',()=>{writeFileSync(join(root,'native-link-dropped.json'),JSON.stringify({droppedSuccessfulResponse:true,linkTransactionRequests:submits}),{mode:0o600});response.socket?.destroy()})
  }else{response.writeHead(native.statusCode??502,native.headers);native.pipe(response)}
  native.on('error',()=>response.destroy())
 })
 upstream.on('error',()=>response.destroy());incoming.on('aborted',()=>upstream.destroy());if(bytes)upstream.end(bytes);else incoming.pipe(upstream)
})
server.listen(listen,'127.0.0.1')
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0))})
