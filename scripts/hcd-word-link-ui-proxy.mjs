/** Owned loopback sidecar proxy for normal-editor request acceptance. Only the
 * explicit fixture control file can drop a successful response or block send. */
import assert from 'node:assert/strict'
import {createServer,request} from 'node:http'
import {connect} from 'node:net'
import {readFileSync,writeFileSync,lstatSync,existsSync,unlinkSync} from 'node:fs'
import {resolve,join} from 'node:path'
const root=resolve(process.argv[2]),listen=Number(process.argv[3]),target=Number(process.argv[4]),config=JSON.parse(readFileSync(join(root,'private.json'),'utf8'))
assert.equal(config.root,root);assert.equal(config.linkUiProxy,true);assert.equal(lstatSync(root).isSymbolicLink(),false)
assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
for(const port of [listen,target])assert.ok(Number.isSafeInteger(port)&&port>1024&&port<65536)
const records={link:[],page:[],draft:[],topology:[]},sockets=new Set()
function record(kind,entry){records[kind].push(entry);writeFileSync(join(root,`${kind}-ui-proxy-records.json`),JSON.stringify(records[kind],null,2),{mode:0o600})}
function takeMode(action,kind){const control=join(root,`${kind}-ui-proxy-control`);if(!['submit','apply','save','resume','rebase-stale','cancel'].includes(action)||!existsSync(control))return 'pass';assert.equal(lstatSync(control).isSymbolicLink(),false);const mode=readFileSync(control,'utf8');assert.ok(['drop-success','drop-success-block-retry','block-submit'].includes(mode));if(mode!=='block-submit')unlinkSync(control);return mode}
const server=createServer(async(incoming,response)=>{
 const path=incoming.url??'',page=/^\/v1\/documents\/region-test\/collaboration\/word-active-layout(?:-(status|cancel|check))?$/.exec(path),draft=/^\/v1\/documents\/region-test\/collaboration\/(word-stopped-draft(?:-cancel)?|word-checkpoint-recovery)$/.exec(path),topology=/^\/v1\/documents\/region-test\/collaboration\/(word-stopped-layout|word-stopped-story|word-topology-cancel|word-topology-recovery)$/.exec(path),kind=topology?'topology':draft?'draft':page?'page':'link'
 let action=topology||draft?'inspect':page?(page[1]??'submit'):/^\/v1\/documents\/region-test\/collaboration\/word-active-link-(preview|submit|status|cancel|check)$/.exec(path)?.[1]
 let bytes,body,mode='pass'
 if(action&&incoming.method==='POST'){
  const parts=[];let size=0;for await(const part of incoming){size+=part.length;if(size>512*1024){response.writeHead(413);response.end();return}parts.push(part)}bytes=Buffer.concat(parts);body=JSON.parse(bytes.toString('utf8'));if(draft)action=draft[1]==='word-stopped-draft-cancel'?'cancel':body.operation;if(topology)action=topology[1]==='word-topology-cancel'?'cancel':body.operation;mode=takeMode(action,kind)
  if(mode==='block-submit'){record(kind,{action,body,mode,outcome:'blocked-before-forward'});response.socket?.destroy();return}
 }
 const upstream=request({host:'127.0.0.1',port:target,method:incoming.method,path:incoming.url,headers:incoming.headers},native=>{
  if(action&&body){const parts=[];native.on('data',part=>parts.push(part));native.on('end',()=>{const output=Buffer.concat(parts);let value;try{value=JSON.parse(output.toString('utf8'))}catch{value={invalid:true}}record(kind,{action,body,mode,status:native.statusCode,response:value});if(['drop-success','drop-success-block-retry'].includes(mode)&&native.statusCode===200){if(mode==='drop-success-block-retry')writeFileSync(join(root,`${kind}-ui-proxy-control`),'block-submit');response.socket?.destroy()}else{response.writeHead(native.statusCode??502,native.headers);response.end(output)}})}
  else{response.writeHead(native.statusCode??502,native.headers);native.pipe(response)}
  native.on('error',()=>response.destroy())
 });upstream.on('error',()=>response.destroy());incoming.on('aborted',()=>upstream.destroy());if(bytes)upstream.end(bytes);else incoming.pipe(upstream)
})
server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
server.on('upgrade',(incoming,socket,head)=>{
 const upstream=connect({host:'127.0.0.1',port:target},()=>{upstream.write(`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n`+incoming.rawHeaders.reduce((lines,value,index)=>index%2===0?lines+value+': ':lines+value+'\r\n','')+'\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket)})
 sockets.add(upstream);upstream.on('close',()=>{sockets.delete(upstream);socket.destroy()});upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy())
})
server.listen(listen,'127.0.0.1')
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const socket of sockets)socket.destroy();server.close(()=>process.exit(0))})
