/** Isolated browser fixture. IndexedDB and the file client are real; the
 * failure is injected immediately after the device transaction commits. */
import {WordDeviceDraft} from '../src/wordDeviceDraft.ts'
import {WordNodeResourceClient} from '../src/wordNodeResources.ts'
import type {ExtensionNodePayload} from '../src/extensionTypes.ts'

const name=`hcd-local-draft-v1-${'d'.repeat(64)}-1-wordregions1-device2`
const node:ExtensionNodePayload={schemaVersion:'hcd.extension/1',instanceId:`x_${'2'.repeat(32)}`,type:'test.card',version:1,display:'block',data:{title:'Test'},fallback:{text:'Test'}}
const cache=await WordDeviceDraft.open(name),channel=new BroadcastChannel(`${name}:fixture`)
const put=cache.putNodeResource.bind(cache)
cache.putNodeResource=async value=>{await put(value);throw new Error('injected post-commit failure')}
let uploads=0,notice=''
const client=new WordNodeResourceClient({cache,ready:()=>true,notify:()=>channel.postMessage('changed'),registry:{archiveResource:async()=>{uploads++;throw new Error('unexpected upload')}}})
const status=document.querySelector<HTMLElement>('#status')!,gate=document.querySelector<HTMLButtonElement>('#save')!,start=document.querySelector<HTMLButtonElement>('#start')!,read=document.querySelector<HTMLButtonElement>('#read')!
function render(){const state=client.state();status.textContent=`任务 ${state.jobs.length} · ${state.jobs[0]?.phase??'无'} · 上传 ${uploads} · ${notice}`;gate.disabled=state.pending;start.disabled=state.pending;read.disabled=!state.jobs[0]?.draft}
client.subscribe(render);channel.onmessage=()=>void client.refresh();await client.initialize();render()
start.onclick=()=>void client.start(new File(['retained browser attachment'],'fixture.txt',{type:'text/plain'}),node,`n_${'1'.repeat(32)}`).then(()=>{notice='意外成功';render()},()=>{notice='写入结果不明';render()})
read.onclick=()=>{const id=client.state().jobs[0]?.id;if(id)void client.readPendingFile(id).then(async value=>{notice=`文件内容：${await value.blob.text()}`;render()})}
window.addEventListener('pagehide',()=>{client.dispose();channel.close();void cache.close()},{once:true})
