/** Controlled old-tab storage fixture. Each visible button writes one actual
 * archived request in the old sessionStorage key, then opens the normal UI.
 * This is migration acceptance data, not a production old-client claim. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
const [root,out]=process.argv.slice(2).map(value=>resolve(value)),c=JSON.parse(await readFile(root+'/private.json','utf8'))
assert.equal(c.root,root);assert.match(root,/\/target\/hcd-preview-runtime\/word-layout-ui-[^/]+$/)
for(const [number,file] of [[1,'original.hcd-word-page-request'],[2,'cancelled.hcd-word-page-request']] as const){
 const raw=await readFile(out+'/'+file,'utf8'),record=JSON.parse(raw);assert.equal(record.schemaVersion,'hcd-word-page-request/1');assert.equal(record.epoch,1);assert.equal(record.request.actor.userId,'alice');assert.equal(record.request.documentId,c.documentId)
 const session={documentId:c.documentId,apiUrl:'/v1/documents',collabUrl:`ws://127.0.0.1:${c.browserCollabPort}`,collaborationEpoch:1}
 const html=`<!doctype html><meta charset="utf-8"><title>旧标签页请求迁移验证</title><h1>模拟旧标签页 ${number}</h1><p>仅写入本批真实历史原请求，不提交文档修改；随后打开普通编辑器。</p><button id="open" disabled>保留旧请求并打开编辑器</button><script type="module">import {draftNamespace} from '/src/localDrafts.ts';const scope=await draftNamespace(${JSON.stringify(session)},'alice',location.href),button=document.getElementById('open');button.disabled=false;button.onclick=()=>{sessionStorage.setItem('hcd-word-page-request/1:'+scope.name,${JSON.stringify(raw)});location.assign('/layout-alice.html')};</script>`
 assert.equal(html.includes(c.secret),false);await writeFile(root+`/editor/legacy-page-${number}.html`,html)
}
console.log(JSON.stringify({first:`http://127.0.0.1:${c.vitePort}/legacy-page-1.html`,second:`http://127.0.0.1:${c.vitePort}/legacy-page-2.html`,scope:'controlled legacy storage from actual historical requests; not an old production browser'}))
