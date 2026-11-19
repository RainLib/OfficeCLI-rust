// Run against the local OFFICECLI_DEMO_SPEC_BOARD=1 fixture. No model key required.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect } from '../editor/node_modules/@playwright/test/index.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = process.env.OFFICECLI_SPEC_DEMO || 'http://fold.localhost:4417/examples/spec'
const out = process.env.OFFICECLI_DESK_ARTIFACTS
const browser = await chromium.launch({executablePath:process.env.HCD_BROWSER_PATH,args:['--no-proxy-server']})
const clients = []
async function openEditor() {
  const page = await browser.newPage({viewport:{width:1440,height:940}})
  await page.goto(url)
  await page.getByRole('button',{name:'编辑文档',exact:true}).click()
  const form = page.getByRole('form',{name:'编辑 Spec 文档'})
  const line = form.getByRole('textbox',{name:'文档正文'}).locator('p').filter({hasText:'我们计划'})
  return {page,form,line}
}
async function select(line, text, extent='range') {
  await line.evaluate((p,{text, extent})=>{
    const offset = p.textContent.indexOf(text)
    if(offset<0) throw Error('找不到选句')
    const at=(i)=>{
      const nodes=document.createTreeWalker(p,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('[contenteditable=false]')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT})
      let n
      while((n=nodes.nextNode())){if(i<=n.length)return [n,i];i-=n.length}
      throw Error('位置超出段落')
    }
    p.closest('[contenteditable]').focus()
    const r=document.createRange()
    r.setStart(...at(extent==='inside'?offset+1:offset))
    r.setEnd(...at(extent==='inside'?offset+1:offset+text.length))
    const sel=getSelection();sel.removeAllRanges();sel.addRange(r)
    document.dispatchEvent(new Event('selectionchange'))
  },{text,extent})
}
try {
  const first = await openEditor(), other = await openEditor()
  const chosen='春季发布', insert='秋季上线', concurrent='（同编）'
  const initial=await first.line.textContent()
  assert.ok(initial.includes(chosen))
  const grantResponse=first.page.waitForResponse(r=>r.url().endsWith('/api/embed/selection') && r.request().method()==='PUT' && r.request().postDataJSON()?.selection?.target?.kind==='spec')
  await select(first.line,chosen)
  await first.form.getByRole('button',{name:'让全局 AI 改写选句'}).click()
  const response=await grantResponse
  assert.equal(response.ok(),true)
  const scope=response.request().postDataJSON().selection.target
  const grant=await response.json()
  assert.equal(scope.id,'spec-release-body')
  assert.equal(scope.expected,chosen)
  // Two independent MCP sessions, with different declared names on the same grant.
  for (const title of ['尺规','折页']) {
    const c=new Client({name:'sample-'+clients.length,title,version:'1.0.0'})
    clients.push(c)
    await c.connect(new StreamableHTTPClientTransport(new URL(grant.endpoint),{requestInit:{headers:{Authorization:'Bearer '+grant.token}}}))
    const result=await c.callTool({name:'read_selection',arguments:{}})
    assert.equal(result.structuredContent.spans[0].text,chosen)
    for(const line of [first.line,other.line]){
      const caret=line.locator('[data-agent="true"][data-spec-peer="'+title+'"]')
      await expect(caret).toBeVisible()
      await expect(caret).toHaveCSS('animation-name','agent-idle-glide')
      assert.ok(await caret.evaluate(node=>getComputedStyle(node,'::after').translate === getComputedStyle(node.querySelector('.agent-nib')).translate))
    }
  }
  if(out){mkdirSync(out,{recursive:true});await other.page.screenshot({path:join(out,'spec-two-mcp-agents.png')})}
  const chat=first.page.getByRole('complementary',{name:'全局 AI'})
  await expect(chat.getByText('Spec 选句 · '+chosen,{exact:true})).toBeVisible()
  // Another editor changes the original paragraph between clicking rewrite and sending.
  await select(other.line,chosen,'inside')
  await other.page.keyboard.insertText(concurrent)
  await expect(first.line).toContainText(concurrent)
  await expect(chat.getByText('Spec 选句 · '+chosen,{exact:true})).toBeVisible()
  await chat.getByRole('textbox',{name:'全局 AI 指令'}).fill('改写为：'+insert)
  await chat.getByRole('button',{name:'发送全局指令'}).click()
  const undo=chat.getByRole('button',{name:/撤销 r\d+ 的选句改写/})
  await expect(undo).toBeVisible()
  await expect(first.line).toContainText(insert)
  const changed=await first.line.textContent()
  assert.equal(changed.replace(concurrent,''),initial.replace(chosen,insert))
  if(out)await first.page.screenshot({path:join(out,'spec-workbench-mcp.png')})
  await undo.click();await expect(undo).toHaveText('已撤销')
  for (const line of [first.line,other.line]) await expect.poll(async()=>(await line.textContent()).replace(concurrent,'')).toBe(initial)
  const restored=await other.line.textContent()
  assert.ok(restored.includes(concurrent))
  const proof={scope:{kind:scope.kind,block:scope.block,start:scope.start,end:scope.end},names:['尺规','折页'],selected:chosen,changed,restored}
  if(out)writeFileSync(join(out,'workbench-proof.json'),JSON.stringify(proof,null,2))
  console.log(JSON.stringify(proof,null,2))
  // Leave the interactive demo at its starting text.
  await select(other.line,concurrent)
  await other.page.keyboard.press('Backspace')
  await expect(first.line).toHaveText(initial)
} finally {
  await Promise.allSettled(clients.map(c=>c.close()))
  await browser.close()
}
