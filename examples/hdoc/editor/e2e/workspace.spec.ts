import { test, expect, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHmac, randomBytes } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'node:net'

const repo = resolve(import.meta.dirname, '../../../..')
const editorRoot = resolve(import.meta.dirname, '..')
const binary = process.env.OFFICECLI_BIN || resolve(repo, 'target/debug/officecli')
const secret = randomBytes(32).toString('hex')
const children: ChildProcess[] = []
let root: string, apiUrl: string, uiUrl: string

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}
function token(id: string, user: string, scope = 'write') {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signed = `${encode({alg:'HS256',typ:'JWT'})}.${encode({doc:id,scope,sub:user,name:user,aud:'hcd-core',iat:now,exp:now+3600})}`
  return `${signed}.${createHmac('sha256',secret).update(signed).digest('base64url')}`
}
function start(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const serviceEnv = {...process.env,...env}
  delete serviceEnv.HCD_DATABASE_URL; delete serviceEnv.HCD_S3_BUCKET; delete serviceEnv.HCD_DEFAULT_THEME
  const child = spawn(command,args,{cwd:editorRoot,env:serviceEnv,stdio:'ignore',detached:process.platform !== 'win32'})
  children.push(child)
  child.on('error', error => console.error(`test service: ${error.message}`))
  return child
}
async function ready(url: string) {
  await expect.poll(async () => { try { return (await fetch(url)).status } catch { return 0 } },{timeout:30_000}).toBe(200)
}
async function open(page: Page, id: string, scope = 'write') {
  page.on('pageerror', error => console.error(`browser: ${error.message}`))
  await page.goto(`${uiUrl}/?locale=zh-CN`)
  await page.getByPlaceholder('doc-…').fill(id)
  await page.getByPlaceholder('粘贴短期令牌',{exact:true}).fill(token(id,'browser-user',scope))
  await page.getByRole('button',{name:'打开文档',exact:true}).click()
  await expect(page.locator('.document-tab-panel:not([hidden]) .workspace')).toBeVisible({timeout:60_000})
}
async function agent(id: string, user: string) {
  const transport = new StdioClientTransport({command:binary,args:['mcp'],env:{...process.env,HCD_API_URL:apiUrl,HCD_MCP_TOKEN:token(id,user)} as Record<string,string>})
  const client = new Client({name:user,version:'1.0.0'})
  await client.connect(transport)
  return client
}
async function call(client: Client, name: string, args: Record<string,unknown>) {
  const result = await client.callTool({name,arguments:args})
  const text = (result.content as Array<{type:string;text?:string}>).find(item => item.type === 'text')?.text || ''
  return {error:result.isError === true, data:result.isError ? text : JSON.parse(text)}
}

test.beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(),'hcd-workspace-e2e-'))
  const service = resolve(root,'service'); mkdirSync(resolve(service,'sources'),{recursive:true})
  const fixtures: Record<string,string> = {
    'tabs-a':'txt', 'tabs-b':'txt', 'human-draft':'txt', 'agents-text':'txt',
    'agents-slides':'examples/ppt/textboxes/textboxes-basic.pptx',
    'complex-word':'assets/showcase/project-proposal.docx',
    'agents-grid':'assets/showcase/gradebook.xlsx',
    'revision-text':'txt', 'revision-errors':'txt', 'ui-text':'txt', 'ui-grid':'assets/showcase/gradebook.xlsx',
    'ui-markdown':'md', 'ui-html':'html', 'ui-pdf':'examples/test.pdf',
  }
  for (const [id,file] of Object.entries(fixtures)) {
    const format = ['txt', 'md', 'html'].includes(file) ? file : file.split('.').at(-1)!
    const source = resolve(service,'sources',`${id}.${format}`)
    if (file === 'md') writeFileSync(source, '# Markdown workspace\n\n**Bold** and [link](https://example.com).\n')
    else if (file === 'html') writeFileSync(source, '<!doctype html><html><body><h1>HTML workspace</h1><p>Preview and edit this document.</p></body></html>')
    else if (file === 'txt') writeFileSync(source,`First paragraph ${id}\n\nSecond paragraph ${id}\n`)
    else copyFileSync(resolve(repo,file),source)
    const result = spawnSync(binary,['hdoc','import',source,'--output',resolve(service,`${id}.hcd`),'--document-id',id],{encoding:'utf8'})
    if (result.status !== 0) throw new Error(`fixture import failed: ${result.stderr}`)
  }
  const apiPort = await freePort(), collabPort = await freePort(), uiPort = await freePort()
  apiUrl = `http://127.0.0.1:${apiPort}`; uiUrl = `http://127.0.0.1:${uiPort}`
  const env = {HCD_TOKEN_SECRET:secret,HCD_API_URL:apiUrl,HCD_API_TARGET:apiUrl,HCD_COLLAB_PORT:String(collabPort),VITE_HCD_COLLAB_URL:`ws://127.0.0.1:${collabPort}`,HCD_VITE_CACHE_DIR:resolve(root,'vite-cache')}
  start(binary,['hdoc','serve','--root',service,'--bind',`127.0.0.1:${apiPort}`],{...env,HCD_DATABASE_URL:'',HCD_S3_BUCKET:''})
  await ready(`${apiUrl}/health`)
  start(resolve(editorRoot,'node_modules/.bin/tsx'),['sidecar.ts'],env)
  start(resolve(editorRoot,'node_modules/.bin/vite'),['--host','127.0.0.1','--port',String(uiPort),'--strictPort'],env)
  await ready(uiUrl)
})
test.afterAll(async () => {
  for (const child of children.reverse()) {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid,'SIGTERM'); else child.kill('SIGTERM') } catch { /* Already exited. */ }
  }
})

test('document tabs retain independent unsaved text and collaboration sessions',async ({page},info) => {
  await open(page,'tabs-a')
  const active = () => page.locator('.document-tab-panel:not([hidden])')
  const body = () => active().locator('.hcd-editor-body')
  await expect(body()).toContainText('First paragraph tabs-a')
  await body().click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' UNSAVED_TAB_A')
  await page.getByRole('button',{name:'打开其他文档',exact:true}).click()
  await page.getByPlaceholder('doc-…').fill('tabs-b')
  await page.getByPlaceholder('粘贴短期令牌',{exact:true}).fill(token('tabs-b','browser-user'))
  await page.getByRole('button',{name:'打开文档',exact:true}).click()
  await expect(body()).toContainText('First paragraph tabs-b')
  await expect(body()).not.toContainText('UNSAVED_TAB_A')
  await page.locator('.document-tab').filter({hasText:'tabs-a'}).locator('button').first().click()
  await expect(body()).toContainText('UNSAVED_TAB_A')
  await expect(page.locator('.hcd-editor-body')).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+f')
  await expect(page.locator('.document-search')).toHaveCount(1)
  await expect(active().locator('.document-search')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.screenshot({path:info.outputPath('multiple-documents.png')})
})

test('two real MCP agents show moving cursors, conflict safely and commit successive edits',async ({page},info) => {
  const id = 'agents-slides'
  await open(page,id,'read')
  await expect(page.locator('iframe').first()).toBeVisible()
  const a = await agent(id,'Agent A'), b = await agent(id,'Agent B')
  try {
    const listed = await a.listTools()
    expect(listed.tools.some(tool => tool.name === 'hcd_activity' && tool.inputSchema.type === 'object')).toBeTruthy()
    const chunk = (await call(a,'hcd_read',{document_id:id,resource:'chunk',number:0})).data
    const nodes = chunk.map.entries.filter((node: {source:{editable:boolean;nodeKind:string}}) => node.source.editable && node.source.nodeKind === 'slide-text')
    expect(nodes.length).toBeGreaterThan(1)
    const focus = (node: string) => ({document_id:id,status:'editing',node_id:node,chunk_sequence:0,expected_revision:0,collaboration_epoch:0})
    expect((await call(a,'hcd_activity',focus(nodes[0].nodeId))).error).toBeFalsy()
    expect((await call(b,'hcd_activity',focus(nodes[1].nodeId))).error).toBeFalsy()
    await expect(page.locator('.agent-cursor')).toHaveCount(2)
    const first = await page.locator('[data-agent-id="Agent A"]').boundingBox()
    await page.screenshot({path:info.outputPath('agents-before-move.png')})
    await call(a,'hcd_activity',focus(nodes[1].nodeId))
    await expect.poll(async () => { const next = await page.locator('[data-agent-id="Agent A"]').boundingBox(); return next ? Math.abs(next.x-first!.x)+Math.abs(next.y-first!.y) : 0 }).toBeGreaterThan(8)
    await expect.poll(async () => { const left = await page.locator('[data-agent-id="Agent A"]').boundingBox(); const right = await page.locator('[data-agent-id="Agent B"]').boundingBox(); return left && right ? Math.abs(left.x-right.x)+Math.abs(left.y-right.y) : Infinity }).toBeLessThan(1)
    await page.screenshot({path:info.outputPath('agents-after-move.png')})
    const patch = (label: string) => ({document_id:id,mode:'node',expected_revision:0,collaboration_epoch:0,patch:{schemaVersion:'hcd-patch/1',documentId:id,patchId:`agent-${label}-first`,baseRevision:0,operations:[{op:'text.splice',nodeId:nodes[0].nodeId,start:0,deleteCount:0,insertText:`[${label}] `,precondition:{nodeHash:nodes[0].nodeHash}}]}})
    const results = await Promise.all([call(a,'hcd_patch',patch('A')),call(b,'hcd_patch',patch('B'))])
    expect(results.filter(result => !result.error)).toHaveLength(1)
    expect(results.find(result => result.error)?.data).toContain('409')
    const activities = (await call(a,'hcd_read',{document_id:id,resource:'agents'})).data.agents
    expect(activities.find((activity: {status:string}) => activity.status === 'applied').nodeId).toBe(nodes[0].nodeId)
    const loser = results[0].error ? a : b
    const node = (await call(loser,'hcd_read',{document_id:id,resource:'node',node_id:nodes[1].nodeId})).data
    const auth = (await call(loser,'hcd_read',{document_id:id,resource:'auth'})).data
    await call(loser,'hcd_activity',{...focus(node.nodeId),expected_revision:1})
    const second = await call(loser,'hcd_patch',{document_id:id,mode:'node',expected_revision:1,collaboration_epoch:auth.collaborationEpoch,patch:{schemaVersion:'hcd-patch/1',documentId:id,patchId:'agent-second-node',baseRevision:1,operations:[{op:'text.splice',nodeId:node.nodeId,start:0,deleteCount:0,insertText:'[Second agent] ',precondition:{nodeHash:node.nodeHash}}]}})
    expect(second.error).toBeFalsy()
    expect(second.data.revision).toBe(2)
    await expect.poll(async () => (await page.locator('.agent-activity-panel').innerText()).includes('r2')).toBeTruthy()
    await expect.poll(async () => { for (const frame of page.frames().slice(1)) if ((await frame.locator('body').innerText().catch(()=>'' )).includes('[Second agent]')) return true; return false }).toBeTruthy()
    await page.screenshot({path:info.outputPath('agents-committed.png')})
    const exported = await call(a,'hcd_export',{document_id:id,format:'html',revision:2,output:resolve(root,'agents.html')})
    expect(exported.error).toBeFalsy()
    expect(readFileSync(resolve(root,'agents.html'),'utf8')).toContain('[Second agent]')
  } finally { await a.close(); await b.close() }
})

test('complex Word tables retain canonical read-only layout in the semantic editor',async ({page},info) => {
  await open(page,'complex-word')
  const preview = page.locator('.hcd-opaque-preview iframe').first()
  await preview.scrollIntoViewIfNeeded()
  await expect(preview).toBeVisible()
  await expect(preview.contentFrame().locator('table')).toBeVisible()
  await expect(preview.contentFrame().locator('td')).toHaveCount(16)
  await expect(preview.contentFrame().locator('body')).toContainText('Version')
  await expect(preview).toHaveAttribute('sandbox','allow-same-origin')
  await page.screenshot({path:info.outputPath('complex-word-preview.png')})
  const client = await agent('complex-word','Word Agent')
  try {
    const projection = (await call(client,'hcd_read',{document_id:'complex-word',resource:'editor'})).data
    const auth = (await call(client,'hcd_read',{document_id:'complex-word',resource:'auth'})).data
    const opaque = projection.blocks.find((block: {readOnly:boolean}) => block.readOnly)
    await call(client,'hcd_activity',{document_id:'complex-word',status:'reading',block_id:opaque.blockId,expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch})
    await expect(page.locator('[data-agent-id="Word Agent"]')).toBeVisible()
    await page.screenshot({path:info.outputPath('word-agent-focus.png')})
  } finally { await client.close() }
})

test('a grid agent highlights its cell without changing the local selection',async ({page},info) => {
  const id = 'agents-grid'
  await open(page,id,'read')
  await expect(page.locator('canvas:visible').first()).toBeVisible()
  const client = await agent(id,'Grid Agent')
  try {
    const index = (await call(client,'hcd_read',{document_id:id,resource:'index',number:0})).data
    const descriptor = index.chunks.find((chunk: {grid?:{kind:string;sheetIndex:number}}) => chunk.grid?.kind === 'cells' && chunk.grid.sheetIndex === 0)
    const chunk = (await call(client,'hcd_read',{document_id:id,resource:'chunk',number:descriptor.sequence})).data
    const nodes = chunk.map.entries.filter((node: {source:{editable:boolean;nodeKind:string}}) => node.source.editable && node.source.nodeKind === 'cell')
    expect(nodes.length).toBeGreaterThan(1)
    const address = page.locator('.xlsx-formula-bar input').first()
    const selected = await address.inputValue()
    const focus = (node: string) => ({document_id:id,status:'reading',node_id:node,chunk_sequence:descriptor.sequence,expected_revision:0,collaboration_epoch:0})
    await call(client,'hcd_activity',focus(nodes[0].nodeId))
    await expect(page.locator('.agent-grid-cursor')).toBeVisible()
    const first = await page.locator('.agent-grid-cursor').boundingBox()
    await call(client,'hcd_activity',focus(nodes[1].nodeId))
    await expect.poll(async () => { const next = await page.locator('.agent-grid-cursor').boundingBox(); return next ? Math.abs(next.x-first!.x)+Math.abs(next.y-first!.y) : 0 }).toBeGreaterThan(8)
    await expect(address).toHaveValue(selected)
    expect((await call(client,'hcd_read',{document_id:id,resource:'manifest'})).data.revision).toBe(0)
    await page.screenshot({path:info.outputPath('grid-agent-focus.png')})
  } finally { await client.close() }
})

test('an MCP agent cannot overwrite a collaborator with pending unsaved text',async ({page}) => {
  const id = 'human-draft'
  await open(page,id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toContainText('First paragraph')
  const client = await agent(id,'Careful Agent')
  try {
    const projection = (await call(client,'hcd_read',{document_id:id,resource:'editor'})).data
    const auth = (await call(client,'hcd_read',{document_id:id,resource:'auth'})).data
    await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' HUMAN_UNSAVED')
    const pending = resolve(root,'service/collaboration',`${id}.${auth.collaborationEpoch}.pending`)
    await expect.poll(() => { try { return JSON.parse(readFileSync(pending,'utf8')).dirty } catch { return false } }).toBeTruthy()
    const block = projection.blocks.find((block: {readOnly:boolean;region:string}) => !block.readOnly && block.region === 'body')
    const result = await call(client,'hcd_patch',{document_id:id,mode:'structure',expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch,patch:{schemaVersion:'hcd-patch/4',documentId:id,patchId:'must-not-overwrite',baseRevision:projection.revision,operations:[{op:'block.replace',blockId:block.blockId,block:{kind:'paragraph',inlines:[{text:'OVERWRITTEN'}]},precondition:{blockHash:block.blockHash}}]}})
    expect(result.error).toBeTruthy(); expect(result.data).toContain('unsaved edits')
    await expect(body).toContainText('HUMAN_UNSAVED'); await expect(body).not.toContainText('OVERWRITTEN')
  } finally { await client.close() }
})

test('semantic MCP commits refresh the browser across collaboration epochs',async ({page},info) => {
  const id = 'agents-text'
  await open(page,id,'read')
  await expect(page.locator('.hcd-editor-body')).toContainText('First paragraph')
  const client = await agent(id,'Writing Agent')
  try {
    for (const label of ['First agent revision','Second agent revision']) {
      const projection = (await call(client,'hcd_read',{document_id:id,resource:'editor'})).data
      const auth = (await call(client,'hcd_read',{document_id:id,resource:'auth'})).data
      const block = projection.blocks.find((block: {readOnly:boolean;region:string}) => !block.readOnly && block.region === 'body')
      const focus = {document_id:id,status:'editing',block_id:block.blockId,expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch}
      expect((await call(client,'hcd_activity',focus)).error).toBeFalsy()
      const result = await call(client,'hcd_patch',{document_id:id,mode:'structure',expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch,patch:{schemaVersion:'hcd-patch/4',documentId:id,patchId:label.replaceAll(' ','-'),baseRevision:projection.revision,operations:[{op:'block.replace',blockId:block.blockId,block:{...block.content,inlines:[{text:label}]},precondition:{blockHash:block.blockHash}}]}})
      expect(result.error).toBeFalsy()
      await expect(page.locator('.hcd-editor-body')).toContainText(label)
    }
    await page.screenshot({path:info.outputPath('semantic-agent-committed.png')})
  } finally { await client.close() }
})

test('workspace drawers, focus mode and preview preserve document state', async ({ page }, info) => {
  await open(page, 'ui-text')
  const active = page.locator('.document-tab-panel:not([hidden])')
  const body = active.locator('.hcd-editor-body')
  await expect(body).toContainText('First paragraph ui-text')
  await active.getByRole('button', { name: '隐藏文档目录', exact: true }).click()
  await active.getByRole('button', { name: '收起协作面板', exact: true }).click()
  await expect(active.locator('.panel-dock')).toHaveCount(2)
  expect((await active.locator('.right-dock').boundingBox())!.height).toBeLessThan(200)
  await active.getByRole('button', { name: '收起工具栏', exact: true }).click()
  await active.getByRole('button', { name: '专注模式', exact: true }).click()
  await expect(active.locator('.content-toolbar')).toHaveCount(0)
  await expect(active.locator('.editor-header')).toBeVisible()
  await page.screenshot({ path: info.outputPath('focus-mode.png') })
  await active.getByRole('button', { name: '退出专注模式', exact: true }).click()
  await expect(active.getByRole('button', { name: '展开工具栏', exact: true })).toBeVisible()
  await active.getByRole('button', { name: '展开文档目录', exact: true }).click()
  await expect(active.locator('.outline-panel')).toBeVisible()
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' PREVIEW_PRESERVED')
  await active.getByRole('button', { name: '预览', exact: true }).click()
  await expect(body).toHaveAttribute('contenteditable', 'false')
  await expect(body).toContainText('PREVIEW_PRESERVED')
  await active.locator('.export-control summary').click()
  await active.getByRole('combobox', { name: '导出格式', exact: true }).selectOption('txt')
  await active.getByRole('button', { name: '准备下载', exact: true }).click()
  const download = active.locator('.download-ready')
  await expect(download).toBeVisible()
  const exported = await page.request.get((await download.getAttribute('href'))!)
  expect(await exported.text()).toContain('PREVIEW_PRESERVED')
  await active.locator('.export-control summary').click()
  await expect(active.locator('.ribbon')).toHaveCount(0)
  await expect(active.getByRole('button', { name: '预览', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await active.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await expect(active.getByRole('button', { name: '展开工具栏', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('restored-workspace.png') })
})

test('workbook preview keeps its canvas and refuses to discard an unapplied formula', async ({ page }) => {
  await open(page, 'ui-grid')
  const active = page.locator('.document-tab-panel:not([hidden])')
  const canvas = active.locator('canvas:visible').first()
  await expect(canvas).toBeVisible()
  await canvas.evaluate(element => { (window as unknown as { originalGrid: Element }).originalGrid = element })
  const address = await active.locator('.xlsx-formula-address').innerText()
  await active.getByRole('button', { name: '预览', exact: true }).click()
  await expect(active.locator('.xlsx-formula-bar input')).toBeDisabled()
  expect(await canvas.evaluate(element => (window as unknown as { originalGrid: Element }).originalGrid === element)).toBe(true)
  await expect(active.locator('.xlsx-formula-address')).toHaveText(address)
  await active.getByRole('button', { name: '编辑', exact: true }).click()
  await active.locator('.xlsx-formula-bar input').fill('UNAPPLIED_FORMULA_DRAFT')
  await active.getByRole('button', { name: '预览', exact: true }).click()
  await expect(active.locator('.xlsx-formula-bar input')).toBeEnabled()
  await expect(active.locator('.xlsx-formula-bar input')).toHaveValue('UNAPPLIED_FORMULA_DRAFT')
  await expect(active.locator('.toast.error')).toContainText('请先应用当前公式并等待保存完成')
})

test('all seven formats use the content shell and enforce read-only preview', async ({ page }, info) => {
  for (const [id, format, content] of [
    ['complex-word', 'docx', '.hcd-editor-body'], ['ui-grid', 'xlsx', 'canvas:visible'],
    ['agents-slides', 'pptx', 'iframe'], ['ui-pdf', 'pdf', 'iframe'],
    ['ui-markdown', 'md', '.hcd-editor-body'], ['ui-html', 'html', '.hcd-editor-body'],
    ['ui-text', 'txt', '.hcd-editor-body'],
  ]) {
    await open(page, id, 'read')
    const active = page.locator('.document-tab-panel:not([hidden])')
    await expect(active.locator(content).first()).toBeVisible()
    await expect(active.getByRole('button', { name: '编辑', exact: true })).toBeDisabled()
    await expect(active.getByRole('button', { name: '预览', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(active.locator('.ribbon')).toHaveCount(0)
    const shell = await active.locator('.content-shell').boundingBox()
    expect(shell!.height).toBeGreaterThan(400)
    expect(shell!.width).toBeGreaterThan(500)
    if (content === '.hcd-editor-body') await expect(active.locator(content)).toHaveAttribute('contenteditable', 'false')
    await page.screenshot({ path: info.outputPath(`${format}-preview.png`) })
  }
})

test('phone workspace provides reachable drawers without page overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, 'ui-html')
  const active = page.locator('.document-tab-panel:not([hidden])')
  await expect(active.locator('.hcd-editor-body')).toContainText('HTML workspace')
  await active.getByRole('button', { name: '查找全文', exact: true }).click()
  await expect(active.locator('.document-search')).toBeVisible()
  await active.getByRole('button', { name: '关闭搜索', exact: true }).click()
  await expect(active.locator('.outline-panel')).toHaveCount(0)
  await expect(active.locator('.agent-activity-panel')).toHaveCount(0)
  await active.getByRole('button', { name: '展开文档目录', exact: true }).click()
  await expect(active.locator('.outline-panel')).toBeVisible()
  await active.getByRole('button', { name: '隐藏文档目录', exact: true }).click()
  await active.getByRole('button', { name: '展开协作面板', exact: true }).click()
  await expect(active.locator('.agent-activity-panel')).toBeVisible()
  await page.screenshot({ path: info.outputPath('phone-collaboration.png') })
  await active.getByRole('button', { name: '收起协作面板', exact: true }).click()
  await active.getByRole('button', { name: '专注模式', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await active.locator('.content-shell').boundingBox())!.height).toBeGreaterThan(400)
  await page.screenshot({ path: info.outputPath('phone-focus.png') })
})

test('history previews and real diffs preserve drafts and enforce read permissions', async ({page}, info) => {
  const id='revision-text', headers={Authorization:`Bearer ${token(id,'history-author')}`}
  const get=async(path:string)=>(await fetch(`${apiUrl}/v1/documents/${id}${path}`,{headers})).json()
  const imported=await get('/editor')
  const project=await fetch(`${apiUrl}/v1/documents/${id}/project`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:imported.revision})})
  expect(project.ok,await project.text()).toBeTruthy()
  const baseline=await get('/editor'), auth=await get('/auth')
  const blocks=baseline.blocks.filter((block:{region:string})=>block.region==='body')
  const response=await fetch(`${apiUrl}/v1/documents/${id}/checkpoints`,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-HCD-Collaboration-Epoch':String(auth.collaborationEpoch)},body:JSON.stringify({expectedRevision:baseline.revision,blocks:[
    {blockId:blocks[0].blockId,content:{...blocks[0].content,inlines:[{text:'First paragraph UPDATED revision-text'}]}},
    {blockId:null,content:{kind:'paragraph',inlines:[{text:'ADDED_PARAGRAPH'}]}},
  ]})})
  expect(response.ok, await response.text()).toBeTruthy()
  await open(page,id)
  const active=page.locator('.document-tab-panel:not([hidden])'),body=active.locator('main.document .hcd-editor-body')
  await expect(body).toContainText('UPDATED')
  await body.click();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText(' DRAFT_KEPT')
  const original=await body.elementHandle()
  const viewport=active.locator('.canvas-viewport')
  const header=await active.locator('.editor-header').boundingBox()
  await viewport.dispatchEvent('wheel',{ctrlKey:true,deltaY:-100,bubbles:true,cancelable:true})
  await expect(viewport).toHaveAttribute('data-canvas-zoom','1.35')
  expect(await active.locator('.editor-header').boundingBox()).toEqual(header)
  await active.getByRole('button',{name:'重置文档缩放',exact:true}).click()
  await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  await active.locator(`.history button[data-revision="${baseline.revision}"]`).click()
  const workspace=active.locator('.revision-workspace')
  await expect(workspace.locator('.revision-paper')).toContainText('Second paragraph revision-text')
  await expect(workspace.locator('.revision-paper')).not.toContainText('UPDATED')
  await expect(active.locator('main.document')).toBeHidden()
  await expect(active.locator(`.history button[data-revision="${baseline.revision}"]`)).toHaveAttribute('aria-pressed','true')
  await active.getByRole('button',{name:'查找全文',exact:true}).click()
  await active.locator('.document-search input').fill('Second paragraph')
  await expect(active.locator('.document-search [role="listitem"]')).toHaveCount(1)
  await active.locator('.document-search [role="listitem"]').click()
  await expect(workspace.locator('.history-search-hit')).toContainText('Second paragraph')
  await active.getByRole('button',{name:'关闭搜索',exact:true}).click()
  await active.locator('.export-control summary').click()
  await active.getByRole('combobox',{name:'导出格式',exact:true}).selectOption('txt')
  await active.getByRole('button',{name:'准备下载',exact:true}).click()
  const download=active.locator('.download-ready')
  await expect(download).toBeVisible()
  const exported=await page.request.get((await download.getAttribute('href'))!)
  const oldText=await exported.text()
  expect(oldText).toContain('Second paragraph');expect(oldText).not.toContain('UPDATED');expect(oldText).not.toContain('DRAFT_KEPT')
  await active.locator('.export-control summary').click()
  await page.screenshot({path:info.outputPath('revision-preview.png')})
  await workspace.getByRole('button',{name:'对比当前',exact:true}).click()
  await expect(workspace.locator('.revision-paper')).toHaveCount(2)
  const compareViewport=workspace.locator('.canvas-viewport')
  await compareViewport.dispatchEvent('wheel',{metaKey:true,deltaY:-60,bubbles:true,cancelable:true})
  await expect.poll(async()=>Number(await compareViewport.getAttribute('data-canvas-zoom'))).toBeGreaterThan(1)
  await active.getByRole('button',{name:'重置文档缩放',exact:true}).click()
  await expect(workspace.locator('.revision-column').last()).toContainText('DRAFT_KEPT')
  await expect(workspace.locator('.diff-removed').filter({hasText:'Second paragraph'})).toBeVisible()
  await expect(workspace.locator('.diff-added')).toContainText('ADDED_PARAGRAPH')
  await expect(workspace.locator('.diff-text-added').first()).toContainText('UPDATED')
  await expect(workspace.locator('.revision-diff-summary')).toContainText(`${blocks.length + 1} 处差异`)
  await workspace.getByRole('button',{name:'下一处差异',exact:true}).click()
  await expect(workspace.locator('.diff-active')).not.toHaveCount(0)
  await page.screenshot({path:info.outputPath('revision-compare.png')})
  await workspace.getByRole('button',{name:'返回当前',exact:true}).click()
  await expect(body).toContainText('DRAFT_KEPT')
  expect(await body.evaluate((node,old)=>node===old,original)).toBe(true)
  await expect(body).toHaveAttribute('contenteditable','true')
  await open(page,id,'read')
  await page.getByRole('button',{name:'修订历史',exact:true}).first().click()
  await page.locator(`.history button[data-revision="${baseline.revision}"]`).click()
  await expect(page.locator('.revision-paper')).toBeVisible()
  await expect(page.getByRole('button',{name:'恢复为此版本',exact:true})).toHaveCount(0)
})

test('failed and superseded history requests cannot replace the current editor', async ({page}) => {
  await open(page,'revision-errors')
  const active=page.locator('.document-tab-panel:not([hidden])')
  await expect(active.locator('.hcd-editor-body')).toContainText('First paragraph')
  await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  const revision=active.locator('.history button[data-revision]').first(), number=await revision.getAttribute('data-revision')
  await page.route(`**/editor?revision=${number}`,route=>route.fulfill({status:500,body:'History temporarily unavailable'}))
  await revision.click()
  await expect(active.locator('.revision-workspace [role="alert"]')).toContainText('History temporarily unavailable')
  await expect(active.locator('.revision-paper')).toHaveCount(0)
  await page.unroute(`**/editor?revision=${number}`)
  await active.getByRole('button',{name:'重试',exact:true}).click()
  await expect(active.locator('.revision-paper')).toContainText('First paragraph')
  await active.locator('.revision-workspace').getByRole('button',{name:'返回当前',exact:true}).click()
  await page.route(`**/editor?revision=${number}`,async route=>{await new Promise(resolve=>setTimeout(resolve,300));await route.continue().catch(()=>{})})
  await revision.click()
  await active.locator('.revision-workspace').getByRole('button',{name:'返回当前',exact:true}).click()
  await page.waitForTimeout(500)
  await expect(active.locator('.revision-workspace')).toHaveCount(0)
  await expect(active.locator('main.document .hcd-editor-body')).toContainText('First paragraph')
})

test('canvas zoom handles all formats and frames without scaling the page', async ({page},info) => {
  for(const [id,format] of [['ui-text','txt'],['ui-markdown','md'],['ui-html','html'],['complex-word','docx'],['agents-slides','pptx'],['ui-pdf','pdf'],['ui-grid','xlsx']]) {
    await open(page,id,'read')
    const active=page.locator('.document-tab-panel:not([hidden])'),viewport=active.locator('.canvas-viewport').first()
    await expect(viewport).toBeVisible()
    if(format==='xlsx')await expect(active.locator('canvas:visible').first()).toBeVisible()
    const header=await active.locator('.editor-header').boundingBox(), scale=await page.evaluate(()=>({width:innerWidth,ratio:devicePixelRatio,visual:visualViewport?.scale}))
    await viewport.hover({position:{x:40,y:80}})
    await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control')
    await expect.poll(async()=>Number(await viewport.getAttribute('data-canvas-zoom'))).toBeGreaterThan(1)
    expect(await active.locator('.editor-header').boundingBox()).toEqual(header)
    expect(await page.evaluate(()=>({width:innerWidth,ratio:devicePixelRatio,visual:visualViewport?.scale}))).toEqual(scale)
    if(format==='pptx'||format==='pdf') {
      const frame=active.locator('.fixed-page iframe').first();await expect(frame).toBeVisible()
      const before=Number(await viewport.getAttribute('data-canvas-zoom'))
      expect(await frame.contentFrame().locator('body').evaluate(body=>!body.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-60,cancelable:true,bubbles:true})))).toBe(true)
      await expect.poll(async()=>Number(await viewport.getAttribute('data-canvas-zoom'))).toBeGreaterThan(before)
    }
    await active.getByRole('button',{name:'重置文档缩放',exact:true}).click()
    await expect(viewport).toHaveAttribute('data-canvas-zoom','1')
    await viewport.dispatchEvent('wheel',{deltaY:-120,bubbles:true,cancelable:true})
    await expect(viewport).toHaveAttribute('data-canvas-zoom','1')
    if(format==='xlsx')await page.screenshot({path:info.outputPath('grid-canvas-zoom.png')})
  }
})

test('historical Word tables keep canonical layout and comparisons fit phones', async ({page},info) => {
  await open(page,'complex-word','read')
  await page.getByRole('button',{name:'修订历史',exact:true}).first().click()
  await page.locator('.history button[data-revision="0"]').click()
  const workspace=page.locator('.revision-workspace'),frame=workspace.locator('.hcd-opaque-preview iframe').first()
  await expect(frame.contentFrame().locator('td')).toHaveCount(16)
  await workspace.getByRole('button',{name:'对比当前',exact:true}).click()
  await expect(workspace.locator('.revision-paper')).toHaveCount(2)
  await expect(workspace.locator('.revision-column').last().locator('iframe').first().contentFrame().locator('td')).toHaveCount(16)
  await page.setViewportSize({width:390,height:844})
  await page.getByRole('button',{name:'隐藏右侧栏',exact:true}).click()
  await page.getByRole('button',{name:'隐藏文档目录',exact:true}).click()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  expect(await workspace.locator('.revision-columns').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(1)
  await page.screenshot({path:info.outputPath('phone-revision-compare.png')})
})
