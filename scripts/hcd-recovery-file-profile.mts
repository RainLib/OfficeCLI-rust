/** Install visible diagnostics only in a verified owned preview copy. */
import assert from 'node:assert/strict'
import {readFile,writeFile,copyFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
const root=resolve(process.argv[2]??''),config=JSON.parse(await readFile(join(root,'private.json'),'utf8'))
assert.equal(config.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/hcd-inline-editor-[^/]+$/)
for(const name of ['semanticRecoveryArchive.ts','semanticRecoveryParseWorker.ts','semanticRecoveryTransfer.ts','RecoveryArchivePanel.tsx'])await copyFile(resolve('examples/hdoc/editor/src',name),join(root,'editor/src',name))
const page=join(root,'editor/inline-writer.html'),html=await readFile(page,'utf8');assert.equal(html.includes('recovery-file-profile.js'),false)
await writeFile(page,html.replace('<script type="module">','<script type="module" src="/recovery-file-profile.js"></script><script type="module">'))
await writeFile(join(root,'editor/recovery-file-profile.js'),`
const tasks=[];let metrics=null,ended=false;
new PerformanceObserver(list=>{for(const entry of list.getEntries())tasks.push({start:entry.startTime,duration:entry.duration})}).observe({type:'longtask',buffered:true});
const originalRead=Blob.prototype.arrayBuffer;Blob.prototype.arrayBuffer=function(){if(metrics&&!ended&&this.size>1024*1024)metrics.mainLargeReads++;return originalRead.call(this)};
const OriginalWorker=Worker;window.Worker=new Proxy(OriginalWorker,{construct(target,args){const worker=Reflect.construct(target,args);if(String(args[0]).includes('semanticRecoveryParseWorker')){const post=worker.postMessage;worker.postMessage=function(data,...rest){if(metrics&&!ended){if(data?.file instanceof Blob)metrics.workerBlobInputs++;else metrics.workerByteInputs++}return post.call(worker,data,...rest)}}return worker}});
document.addEventListener('change',event=>{const file=event.target.files?.[0];if(!file||!file.name.endsWith('.hcd-recovery'))return;metrics={started:performance.now(),fileBytes:file.size,workerBlobInputs:0,workerByteInputs:0,mainLargeReads:0};ended=false},true);
const button=document.createElement('button'),output=document.createElement('output'),box=document.createElement('aside');button.textContent='附件恢复性能';box.style='position:fixed;bottom:35px;left:8px;z-index:99999;background:#fff;border:1px solid #aaa;padding:4px;max-width:600px;font:12px monospace';box.append(button,output);document.body.append(box);
new MutationObserver(()=>{if(!metrics||ended)return;const text=document.querySelector('.recovery-archive-panel')?.textContent??'';if(text.includes('保存基线 r')&&text.includes('large-1.bin')){metrics.finished=performance.now();ended=true}}).observe(document.body,{childList:true,subtree:true});
button.onclick=()=>{if(!metrics){output.textContent='尚未比较';return}output.textContent=JSON.stringify({...metrics,elapsedMs:metrics.finished?metrics.finished-metrics.started:null,longTasks:tasks.filter(task=>task.start>=metrics.started&&task.start<=(metrics.finished??performance.now()))})};
`)
console.log(JSON.stringify({scope:'Owned preview UI diagnostics; does not inject document or storage state',writer:config.pages.writer}))
