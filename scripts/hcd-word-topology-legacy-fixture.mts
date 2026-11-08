/** Visible old-tab storage fixture using IDs from actual browser downloads.
 * It supplies no missing request parameters or server authority. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
const [root,out]=process.argv.slice(2).map(value=>resolve(value)),c=JSON.parse(await readFile(root+'/private.json','utf8'))
assert.equal(c.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
const urls:Record<string,string>={}
for(const [name,file] of [['first','story-request.json'],['second','cancel-request.json'],['duplicate','story-request.json']]){
 const record=JSON.parse(await readFile(out+'/'+file,'utf8'));assert.equal(record.schemaVersion,'hcd-word-stopped-topology/2');assert.equal(record.epoch,1);assert.equal(record.actor.userId,'alice');assert.match(record.transactionId,/^[a-f0-9]{32}$/)
 const session={documentId:c.documentId,userId:'alice',apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${c.browserCollabPort}`,collaborationEpoch:1}
 const html=`<!doctype html><meta charset="utf-8"><title>旧结构编号迁移验证</title><h1>模拟旧标签页 ${name}</h1><p>只写入本批实际请求的旧版编号，再打开普通编辑器；不补造缺失参数，不提交文档修改。</p><button id="open" disabled>保留旧编号并打开编辑器</button><script type="module">import {legacyLayoutAttemptKey} from '/src/wordLayoutAttempt.ts';const session=${JSON.stringify(session)},button=document.getElementById('open');button.disabled=false;button.onclick=()=>{sessionStorage.setItem(legacyLayoutAttemptKey(session),${JSON.stringify(record.transactionId)});location.assign('/layout-alice.html')};</script>`
 assert.equal(html.includes(c.secret),false);await writeFile(root+`/editor/legacy-topology-${name}.html`,html);urls[name]=`http://127.0.0.1:${c.vitePort}/legacy-topology-${name}.html`
}
console.log(JSON.stringify({...urls,scope:'controlled legacy storage using actual request IDs; not old production-client acceptance'}))
