/** Visible storage fault controls; content must come from ordinary grid input. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
const root=resolve(process.argv[2]),config=JSON.parse(await readFile(root+'/private.json','utf8'))
assert.equal(config.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/hcd-workbook-[^/]+$/)
let html=await readFile(root+'/editor/alice.html','utf8')
assert.match(html,/EmbeddedHcdEditor/)
const controls=`<aside id="storage-faults"><strong>设备日志故障验证</strong><button id="arm-storage">模拟一次写入和两次读取失败</button><button id="download-storage">下载存储重试记录</button><output id="storage-state">未注入故障</output></aside>`
const script=`
import {WorkbookBlankBatchJournal} from '/src/workbookBlankBatchJournal.ts';
import {WorkbookBlankBatchClient} from '/src/workbookBlankBatchClient.ts';
const storageRecords=[],owners=new WeakMap();let nextOwner=0,failWrite=false,failReads=0;
const owner=value=>{if(!owners.has(value))owners.set(value,++nextOwner);return owners.get(value)};
const record=(event,client,extra={})=>{const row={event,...(client?{owner:owner(client),transient:client.transient,entries:client.entries,problem:client.problem,loading:client.loading,working:client.working}:{}),...extra};storageRecords.push(structuredClone(row));document.getElementById('storage-state').textContent=event};
const stage=WorkbookBlankBatchJournal.prototype.stage,list=WorkbookBlankBatchJournal.prototype.list;
WorkbookBlankBatchJournal.prototype.stage=async function(input){if(failWrite){failWrite=false;failReads=2;record('device-write-refused',null,{input});throw Error('owned synthetic write failure')}return stage.call(this,input)};
WorkbookBlankBatchJournal.prototype.list=async function(){if(failReads){failReads--;record('device-read-refused',null,{remaining:failReads});throw Error('owned synthetic read failure')}return list.call(this)};
const capture=WorkbookBlankBatchClient.prototype.capture;
WorkbookBlankBatchClient.prototype.capture=function(...args){const accepted=capture.apply(this,args);record('grid-captured',this,{accepted});return accepted};
for(const name of ['retryStorage','persistTransient']){const original=WorkbookBlankBatchClient.prototype[name];WorkbookBlankBatchClient.prototype[name]=async function(...args){record(name+'-start',this);try{const result=await original.apply(this,args);record(name+'-done',this,{result});return result}catch(error){record(name+'-failed',this);throw error}}}
document.getElementById('arm-storage').onclick=()=>{failWrite=true;record('fault-armed',null)};
document.getElementById('download-storage').onclick=()=>{const link=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:'hcd-workbook-storage-retry-observations/1',records:storageRecords},null,2)],{type:'application/json'}));link.href=url;link.download='storage-retry-observations.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
`
html=html.replace('#root{height:calc(100% - 36px)}','#root{height:calc(100% - 72px)}').replace('<div id="root">',controls+'<div id="root">').replace("createRoot(document.getElementById('root'))",script+"\ncreateRoot(document.getElementById('root'))")
await writeFile(root+'/editor/storage-retry.html',html,{mode:0o600})
console.log(JSON.stringify({url:`http://127.0.0.1:${config.ports[2]}/storage-retry.html`,scope:'synthetic journal faults only; no content injection'}))
