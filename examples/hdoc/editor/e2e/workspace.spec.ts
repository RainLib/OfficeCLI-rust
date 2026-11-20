import { chromium, test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHmac, randomBytes } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, readFileSync, rmSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import * as Y from 'yjs'

const repo = resolve(import.meta.dirname, '../../../..')
const editorRoot = resolve(import.meta.dirname, '..')
const binary = process.env.OFFICECLI_BIN || resolve(repo, 'target/debug/officecli')
const fidelityId = process.env.HCD_FIDELITY_BUNDLE ? JSON.parse(readFileSync(resolve(process.env.HCD_FIDELITY_BUNDLE,'manifest.json'),'utf8')).documentId as string : 'fidelity-word'
const secret = randomBytes(32).toString('hex')
const children: ChildProcess[] = []
const serviceLogs: string[] = []
let root: string, apiUrl: string, uiUrl: string
let apiProcess: ChildProcess, collabProcess: ChildProcess
let serviceEnvironment: NodeJS.ProcessEnv

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}
function token(id: string, user: string, scope = 'write', expiresAt?: number) {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signed = `${encode({alg:'HS256',typ:'JWT'})}.${encode({doc:id,scope,sub:user,name:user,aud:'hcd-core',iat:now,exp:expiresAt ?? now+3600})}`
  return `${signed}.${createHmac('sha256',secret).update(signed).digest('base64url')}`
}
function start(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const serviceEnv = {...process.env,...env}
  delete serviceEnv.HCD_DATABASE_URL; delete serviceEnv.HCD_S3_BUCKET; delete serviceEnv.HCD_DEFAULT_THEME
  const logPath = resolve(root, `service-${serviceLogs.length}.log`)
  const log = createWriteStream(logPath)
  serviceLogs.push(logPath)
  const child = spawn(command,args,{cwd:editorRoot,env:serviceEnv,stdio:['ignore','pipe','pipe'],detached:process.platform !== 'win32'})
  child.stdout?.pipe(log, {end:false}); child.stderr?.pipe(log, {end:false})
  child.on('close', () => log.end())
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
  await expect(page.locator('[data-workspace-restoring="false"]')).toBeVisible({timeout:30_000})
  if (await page.getByRole('button',{name:'文档工作台',exact:true}).isVisible()) await page.getByRole('button',{name:'文档工作台',exact:true}).click()
  await page.getByPlaceholder('doc-…').fill(id)
  await page.getByPlaceholder('粘贴短期令牌',{exact:true}).fill(token(id,'browser-user',scope))
  await page.getByRole('button',{name:'打开文档',exact:true}).click()
  await expect(page.locator('.document-tab-panel:not([hidden]) .workspace')).toBeVisible({timeout:60_000})
}
// Access is granted by credentials; the document UI has no permission switch.
async function reopenWithScope(page: Page, scope: 'read' | 'write') {
  const active = page.locator('.document-tab-panel:not([hidden])')
  const id = (await active.getAttribute('data-document-id'))!
  const save = active.getByRole('button', { name: '保存点', exact: true })
  if (scope === 'read' && await save.isVisible() && await save.isEnabled()) {
    await save.click()
    await expect(active.locator('.editor-statusbar')).toContainText('已保存')
  }
  await page.evaluate(({id, credential}) => {
    const saved = JSON.parse(sessionStorage.getItem('hcd-editor-workspace-v1')!)
    saved.tabs = saved.tabs.map((tab: {documentId: string}) => tab.documentId === id ? {...tab, token: credential} : tab)
    sessionStorage.setItem('hcd-editor-workspace-v1', JSON.stringify(saved))
  }, {id, credential: token(id, 'browser-user', scope)})
  await page.reload()
  await expect(page.locator('[data-workspace-restoring="false"]')).toBeVisible()
  await expect(active.locator('[data-document-scope]')).toHaveAttribute('data-document-scope', scope)
}

// Chromium's HTTP offline switch alone can leave existing WebSockets alive.
// Cut both sides explicitly so these tests cannot recover from a live server
// room and accidentally call that local-journal recovery.
async function collaborationCut(page: Page) {
  let disconnected = false
  const sockets = new Map<WebSocketRoute, WebSocketRoute>()
  await page.routeWebSocket(url => url.port !== new URL(uiUrl).port, socket => {
    if (disconnected) { void socket.close(); return }
    const server = socket.connectToServer()
    sockets.set(socket, server)
    socket.onClose((code, reason) => { sockets.delete(socket); void server.close({ code, reason }) })
    server.onClose((code, reason) => { sockets.delete(socket); void socket.close({ code, reason }) })
  })
  return async (blocked = true) => {
    disconnected = blocked
    if (!blocked) return
    await Promise.all([...sockets].flatMap(([socket, server]) => [socket.close(), server.close()]))
    sockets.clear()
  }
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
    'export-text':'txt', 'export-errors':'txt', 'export-grid':'assets/showcase/gradebook.xlsx', 'calculation-grid':'xlsx-generated', 'calculation-edit':'xlsx-generated',
    'calculation-types':'xlsx-typed', 'rich-grid':'xlsx-rich', 'rich-edit':'xlsx-rich', 'rich-draft':'xlsx-rich', 'rich-paste':'xlsx-rich', 'rich-blank-draft':'xlsx-rich',
    'grid-batch-ready':'xlsx-rich', 'grid-batch-lost':'xlsx-rich', 'grid-batch-stale':'xlsx-rich',
    'grid-batch-storage':'xlsx-rich', 'grid-batch-corrupt':'xlsx-rich',
    'grid-batch-live':'xlsx-rich', 'grid-sync-selection':'xlsx-rich', 'grid-pointer-gesture':'xlsx-rich',
    'export-missing-grid':'assets/showcase/gradebook.xlsx', 'export-pdf':'examples/test.pdf', 'export-font-pdf':'examples/test.pdf',
    'local-edit-text':'txt', 'tabs-a':'txt', 'tabs-b':'txt', 'human-draft':'txt', 'agents-text':'txt', 'crdt-restart':'txt',
    'draft-reopen':'txt', 'draft-stale':'txt', 'draft-storage-error':'txt', 'draft-browser-crash':'txt', 'draft-isolation':'txt',
    'draft-write-error':'txt', 'draft-generation':'txt', 'draft-maintenance':'txt', 'draft-corrupt':'txt',
    'restore-text':'txt', 'restore-read':'txt', 'restore-expired':'txt', 'restore-pdf':'examples/test.pdf',
    'agents-slides':'examples/ppt/textboxes/textboxes-basic.pptx',
    'fixed-history':'examples/ppt/textboxes/textboxes-basic.pptx',
    'fixed-input':'examples/ppt/textboxes/textboxes-basic.pptx',
    'fixed-draft-reopen':'examples/ppt/textboxes/textboxes-basic.pptx',
    'fixed-draft-stale':'examples/ppt/textboxes/textboxes-basic.pptx',
    'fixed-draft-error':'examples/ppt/textboxes/textboxes-basic.pptx',
    'fixed-draft-new-pptx':'examples/ppt/textboxes/textboxes-basic.pptx',
    'fixed-draft-new-pdf':'examples/test.pdf',
    'fixed-draft-crash':'examples/ppt/textboxes/textboxes-basic.pptx',
    'grid-draft-reopen':'xlsx-generated', 'grid-draft-cell':'xlsx-generated', 'grid-draft-stale':'xlsx-generated',
    'ppt-panels':'examples/ppt/textboxes/textboxes-basic.pptx',
    'ppt-ribbon':'examples/ppt/textboxes/textboxes-basic.pptx',
    'ppt-properties':'examples/ppt/textboxes/textboxes-basic.pptx',
    'ppt-panels-read':'examples/ppt/textboxes/textboxes-basic.pptx',
    'fixed-history-errors':'examples/ppt/textboxes/textboxes-basic.pptx',
    'complex-word':'assets/showcase/project-proposal.docx',
    'word-presentation':'assets/showcase/project-proposal.docx',
    'word-pages':'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx',
    'word-margins':'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx',
    'word-grid':'examples/hdoc/editor/e2e/fixtures/word-grid-layout.docx',
    'word-page-agents':'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx',
    'word-local':'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx',
    'word-view':'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx',
    'export-word':'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx',
    'fidelity-word':'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx',
    'table-edit':'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx',
    'table-appearance':'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx',
    'table-conflict':'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx',
    'table-keyboard':'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx',
    'table-md':'md', 'table-html':'html', 'inline-html':'html',
    'table-structure':'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx',
    'table-only':'examples/hdoc/editor/e2e/fixtures/table-only.html',
    'table-long':'docx-long',
    'table-insert':'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx',
    'table-structure-html':'html', 'table-structure-md':'md', 'history-bounded':'html',
    'agents-grid':'assets/showcase/gradebook.xlsx',
    'view-state':'txt', 'history-outline':'md', 'revision-text':'txt', 'revision-errors':'txt', 'ui-text':'txt', 'ui-grid':'assets/showcase/gradebook.xlsx',
    'ui-markdown':'md', 'ui-html':'html', 'ui-pdf':'examples/test.pdf',
  }
  for (const [id,file] of Object.entries(fixtures)) {
    const format = file === 'docx-long' ? 'docx' : file.startsWith('xlsx-') ? 'xlsx' : ['txt', 'md', 'html'].includes(file) ? file : file.split('.').at(-1)!
    const source = resolve(service,'sources',`${id}.${format}`)
    if (file === 'docx-long') {
      if (process.env.HCD_TABLE_REGRESSION_DOCX) copyFileSync(process.env.HCD_TABLE_REGRESSION_DOCX, source)
      else {
        const generated = spawnSync('python3', [resolve(editorRoot, 'e2e/fixtures/word-table-long.py'), source], { encoding: 'utf8' })
        if (generated.status !== 0) throw new Error(`long table fixture failed: ${generated.stderr}`)
      }
    }
    else if (file === 'xlsx-rich') {
      const generated = spawnSync('python3', [resolve(repo, 'docs/acceptance/hcd-xlsx-rich-text/make_fixture.py'), source], { encoding: 'utf8' })
      if (generated.status !== 0) throw new Error(`rich fixture generation failed: ${generated.stderr}`)
    }
    else if (file === 'xlsx-typed') {
      const created = spawnSync(binary, ['create', source], { encoding: 'utf8' })
      if (created.status !== 0) throw new Error(`typed workbook creation failed: ${created.stderr}`)
      const typed = spawnSync('python3', [resolve(editorRoot, 'e2e/fixtures/create_typed_workbook.py'), source], { encoding: 'utf8' })
      if (typed.status !== 0) throw new Error(`typed workbook fixture failed: ${typed.stderr}`)
    }
    else if (file === 'xlsx-generated') {
      const commands = [
        ['create', source],
        ['set', source, '/Sheet1/A1', '--prop', 'formula=LEN("中文")'],
        ['set', source, '/Sheet1/A2', '--prop', 'formula=ROUNDUP(-1.21,1)'],
        ['set', source, '/Sheet1/A3', '--prop', 'formula=ROUNDDOWN(-1.21,1)'],
        ['set', source, '/Sheet1/B1', '--prop', 'value=1'],
        ['set', source, '/Sheet1/B2', '--prop', 'value=2'],
        ['set', source, '/Sheet1/A4', '--prop', 'formula=COUNTBLANK(B1:B3)'],
        ['set', source, '/Sheet1/A5', '--prop', 'formula=COUNTA(B1:B3)'],
        ['set', source, '/Sheet1/A6', '--prop', 'formula=SUM(A1:A5)'],
        ['set', source, '/Sheet1/A7', '--prop', 'formula=IF(1,2,3)'],
        ['set', source, '/Sheet1/A8', '--prop', 'formula="12"'],
        ['set', source, '/Sheet1/A9', '--prop', 'formula=TRUE'],
        ['set', source, '/Sheet1/A10', '--prop', 'formula=SUM(B1:B2)'],
        ['set', source, '/Sheet1/A11', '--prop', 'formula=A10*2'],
        ['add', source, '/', '--type-name', 'sheet', '--prop', 'name=Other'],
        ['set', source, '/Other/A1', '--prop', 'value=9'],
        ['set', source, '/Sheet1/A12', '--prop', 'formula=SUM(Other!A1,B1)'],
      ]
      for (const args of commands) {
        const result = spawnSync(binary, args, { encoding: 'utf8' })
        if (result.status !== 0) throw new Error(`calculation fixture failed: ${result.stderr}`)
      }
      // Deliberately stale source cache. Display must use current expressions;
      // the other formula cells still have no usable imported result.
      const cached = spawnSync('python3', ['-c', `
import sys, zipfile, xml.etree.ElementTree as ET
path=sys.argv[1]
with zipfile.ZipFile(path) as archive:
    entries=[(item, archive.read(item.filename)) for item in archive.infolist()]
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(path,'w') as archive:
    for item,data in entries:
        if item.filename=='xl/worksheets/sheet1.xml':
            root=ET.fromstring(data)
            cell=root.find('.//s:c[@r="A1"]',ns)
            value=cell.find('s:v',ns)
            if value is None: value=ET.SubElement(cell,'{'+ns['s']+'}v')
            value.text='777'
            data=ET.tostring(root,encoding='utf-8',xml_declaration=True)
        archive.writestr(item,data)
`, source], { encoding: 'utf8' })
      if (cached.status !== 0) throw new Error(`stale cache fixture failed: ${cached.stderr}`)
    }
    else if (id === 'table-md') writeFileSync(source, '# Table\n\n| Name | Value |\n| --- | --- |\n| Inline | 42 |\n')
    else if (id === 'table-html') writeFileSync(source, '<!doctype html><html><body><h1>Table</h1><table><tr><th>Name</th><th>Value</th></tr><tr><td>Inline</td><td>42</td></tr></table></body></html>')
    else if (id === 'inline-html') writeFileSync(source, '<!doctype html><html><body><p class="source-only"><b>同名😀</b><span style="font-style:italic"> tail</span><span style="font-weight:normal;font-style:normal"> plain</span><a href="https://example.com/a/b?q=1&amp;x=2" title="原链接"> link</a><a href="#section"> section</a><a href="tel:+86123"> phone</a></p><p><i>同名😀</i> plain</p><table><tr><th>Name</th><th>Value</th></tr><tr><td><b>Table bold</b> <i>table italic</i></td><td>280</td></tr></table></body></html>')
    else if (file === 'md') writeFileSync(source, '# Markdown workspace\n\n**Bold** and [link](https://example.com).\n')
    else if (file === 'html') writeFileSync(source, '<!doctype html><html><body><h1>HTML workspace</h1><p>Preview and edit this document.</p></body></html>')
    else if (file === 'txt') writeFileSync(source,`First paragraph ${id}\n\nSecond paragraph ${id}\n`)
    else copyFileSync(resolve(repo,file),source)
    const result = spawnSync(binary,['hdoc','import',source,'--output',resolve(service,`${id}.hcd`),'--document-id',id],{encoding:'utf8'})
    if (result.status !== 0) throw new Error(`fixture import failed: ${result.stderr}`)
  }
  if (process.env.HCD_FIDELITY_BUNDLE) {
    if (!process.env.HCD_FIDELITY_SOURCE) throw new Error('HCD_FIDELITY_SOURCE is required for native Word fidelity verification')
    cpSync(process.env.HCD_FIDELITY_BUNDLE,resolve(service,`${fidelityId}.hcd`),{recursive:true})
    copyFileSync(process.env.HCD_FIDELITY_SOURCE,resolve(service,'sources',`${fidelityId}.docx`))
  }
  const apiPort = await freePort(), collabPort = await freePort(), uiPort = await freePort()
  apiUrl = `http://127.0.0.1:${apiPort}`; uiUrl = `http://127.0.0.1:${uiPort}`
  const env = {HCD_TOKEN_SECRET:secret,HCD_API_URL:apiUrl,HCD_API_TARGET:apiUrl,HCD_COLLAB_PORT:String(collabPort),VITE_HCD_COLLAB_URL:`ws://127.0.0.1:${collabPort}`,HCD_VITE_CACHE_DIR:resolve(root,'vite-cache')}
  serviceEnvironment = env
  apiProcess = start(binary,['hdoc','serve','--root',service,'--bind',`127.0.0.1:${apiPort}`],{...env,HCD_DATABASE_URL:'',HCD_S3_BUCKET:''})
  await ready(`${apiUrl}/health`)
  collabProcess = start(resolve(editorRoot,'node_modules/.bin/tsx'),['sidecar.ts'],env)
  start(resolve(editorRoot,'node_modules/.bin/vite'),['--host','127.0.0.1','--port',String(uiPort),'--strictPort'],env)
  await ready(uiUrl)
})
test.afterAll(async () => {
  for (const child of children.reverse()) {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid,'SIGTERM'); else child.kill('SIGTERM') } catch { /* Already exited. */ }
  }
})
test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return
  for (const path of serviceLogs) {
    // Test-owned service output is needed to distinguish browser and proxy
    // failures. Avoid attaching the fixture signing secret to test reports.
    const output = readFileSync(path, 'utf8').replaceAll(secret, '[test secret]')
    await info.attach(path.split('/').at(-1)!, {body:output,contentType:'text/plain'})
  }
})

test('calculation contract agrees across native CLI MCP and the selected browser cell', async ({page, context}, info) => {
  const id = 'calculation-grid'
  const client = await agent(id, 'Calculation Inspector')
  try {
    const caps = await call(client, 'hcd_read', { document_id: id, resource: 'capabilities' })
    expect(caps.error).toBe(false)
    expect(caps.data.patchSchemas['hcd-patch/4'].operations).toContain('table.edit')
    const sheet = await call(client, 'hcd_read', { document_id: id, resource: 'sheet', number: 0 })
    expect(sheet.error).toBe(false)
    expect(sheet.data.calculationCapabilities).toEqual(caps.data.calculation)
    for (const [address, expected] of [['A1','2'], ['A2','-1.3'], ['A3','-1.2'], ['A4','1'], ['A5','2'], ['A6','2.5']]) {
      const output = spawnSync(binary, ['get', resolve(root, 'service/sources/calculation-grid.xlsx'), `/Sheet1/${address}`, '--json'], { encoding: 'utf8' })
      expect(output.status).toBe(0)
      const native = JSON.parse(output.stdout).data.results[0]
      const served = sheet.data.cells.find((cell: { address: string }) => cell.address === address)
      expect(native.text).toBe(expected)
      expect(native.format.calculation).toEqual(served.calculation)
      expect(native.format.calculationContract).toBe(caps.data.calculation.contractVersion)
    }
    const unverified = spawnSync(binary, ['get', resolve(root, 'service/sources/calculation-grid.xlsx'), '/Sheet1/A7'], { encoding: 'utf8' })
    expect(unverified.status).toBe(0)
    expect(unverified.stdout).toContain('Calculation: unavailable (unsupported_function; text is a compatibility preview)')
    expect(sheet.data.cells.find((cell: { address: string }) => cell.address === 'A7').calculation.status).toBe('unavailable')
    await open(page, id)
    await expect(page.getByLabel('计算校验', { exact: true })).toHaveText('已核验 · 2')
    const options = await page.getByLabel('插入常用函数', { exact: true }).locator('option').allTextContents()
    expect(options).toContain('COUNTBLANK')
    expect(options).toContain('ROUNDUP')
    expect(options).not.toContain('IF')
    // Calculation metadata can arrive before Univer paints its workbook. A
    // visible wrapper alone would allow a blank grid to pass this regression.
    const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
    await expect(canvas).toBeVisible()
    await expect.poll(async () => canvas.evaluate(element => {
      const surface = element as HTMLCanvasElement
      if (surface.width < 400 || surface.height < 120) return false
      const pixels = surface.getContext('2d')?.getImageData(0, 0, Math.min(surface.width, 800), Math.min(surface.height, 400)).data
      if (!pixels) return false
      let ink = 0
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 200 && Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < 160 && ++ink > 100) return true
      }
      return false
    }), { message: 'workbook headers and cell contents must paint before acceptance' }).toBe(true)
    // Copy through the real grid, rather than reading the separate formula
    // status: the visible cell's cache must contain the verified result too.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await canvas.click({ position: { x: 80, y: 30 } })
    await expect(page.getByLabel('选中单元格', { exact: true })).toHaveText('A1')
    await expect.poll(async () => {
      await page.keyboard.press('ControlOrMeta+c')
      return page.evaluate(() => navigator.clipboard.readText())
    }).toBe('2')
    await page.screenshot({ path: info.outputPath('calculation-contract.png') })
  } finally { await client.close() }
})

test('XLSX rich strings retain painted runs through human and MCP collaboration and native export', async ({page, context, request}, info) => {
  const id = 'rich-grid'
  const headers = { Authorization: `Bearer ${token(id, 'rich-reader')}` }
  await context.addInitScript(() => {
    const paints: Array<{text: string; font: string; color: string}> = []
    ;(window as unknown as {richPaints: typeof paints}).richPaints = paints
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof original>) {
      if (/[中文斜体a-z]/i.test(args[0])) {
        paints.push({text: args[0], font: this.font, color: String(this.fillStyle)})
        if (paints.length > 2000) paints.splice(0, 1000)
      }
      return original.apply(this, args)
    }
  })
  const paints = (target: Page) => target.evaluate(() => (window as unknown as {richPaints: Array<{text: string; font: string; color: string}>}).richPaints)
  const verifyPaint = async (target: Page, middle: string) => {
    await expect.poll(async () => (await paints(target)).some(p => p.text.includes('中') && p.color.toLowerCase() === '#cc2244' && /bold|700/.test(p.font))).toBe(true)
    await expect.poll(async () => (await paints(target)).filter(p => p.color.toLowerCase() === '#2255aa' && !/italic|bold|700/.test(p.font)).map(p => p.text).join('').includes(middle)).toBe(true)
    await expect.poll(async () => (await paints(target)).some(p => p.text.includes('斜') && /italic/.test(p.font))).toBe(true)
  }
  await open(page, id)
  const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await verifyPaint(page, 'normal')
  await canvas.evaluate(element => { (window as unknown as {richCanvas: Element}).richCanvas = element })
  const peer = await context.newPage()
  await open(peer, id)
  await verifyPaint(peer, 'normal')
  await canvas.click({position: {x: 100, y: 35}})
  const field = page.getByLabel('单元格内容或公式', {exact: true})
  await expect(field).toHaveValue('中文😀 normal 斜体')
  await field.fill('中文😀 edited 斜体')
  await page.getByRole('button', {name: '应用内容', exact: true}).click()
  await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`, {headers})).json()).revision).toBe(1)
  await expect(peer.getByLabel('单元格内容或公式', {exact: true})).toHaveValue('中文😀 edited 斜体')
  await verifyPaint(page, 'edited')
  await verifyPaint(peer, 'edited')
  const sheet = await (await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`, {headers})).json()
  const a1 = sheet.cells.find((cell: {address: string}) => cell.address === 'A1')
  const client = await agent(id, 'Rich Agent')
  try {
    const node = (await call(client, 'hcd_read', {document_id: id, resource: 'node', node_id: a1.nodeId})).data
    const auth = (await call(client, 'hcd_read', {document_id: id, resource: 'auth'})).data
    const result = await call(client, 'hcd_patch', {document_id: id, mode: 'node', expected_revision: node.revision, collaboration_epoch: auth.collaborationEpoch,
      patch: {schemaVersion: 'hcd-patch/1', documentId: id, patchId: 'rich-agent-edit', baseRevision: node.revision,
        operations: [{op: 'text.splice', nodeId: node.nodeId, start: [...node.text].length, deleteCount: 0, insertText: ' Agent', precondition: {nodeHash: node.nodeHash}}]}})
    expect(result.error, String(result.data)).toBeFalsy()
    await expect(field).toHaveValue('中文😀 edited 斜体 Agent')
    await expect(peer.getByLabel('单元格内容或公式', {exact: true})).toHaveValue('中文😀 edited 斜体 Agent')
    await expect(page.getByRole('button', {name: '↶ 撤销', exact: true})).toBeDisabled()
    await verifyPaint(page, 'edited')
    expect(await canvas.evaluate(element => (window as unknown as {richCanvas: Element}).richCanvas === element)).toBe(true)
    await page.screenshot({path: info.outputPath('xlsx-rich-collaboration.png')})
    const active = page.locator('.document-tab-panel:not([hidden])')
    await active.locator('.export-control summary').first().click()
    await expect(active.getByRole('combobox', {name: '导出方式', exact: true})).toHaveValue('source')
    await active.getByRole('button', {name: '准备下载', exact: true}).click()
    const download = active.locator('.download-ready')
    await expect(download).toBeVisible()
    const native = await page.request.get((await download.getAttribute('href'))!)
    expect(native.ok()).toBe(true)
    const file = info.outputPath('xlsx-rich-edited.xlsx'); writeFileSync(file, await native.body())
    const check = spawnSync('python3', ['-c', `import sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(sys.argv[1]);ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
r=E.fromstring(z.read('xl/worksheets/sheet1.xml'));c=r.find('.//s:c[@r="A1"]',ns);runs=c.findall('s:is/s:r',ns)
assert ''.join(c.itertext())=='中文😀 edited 斜体 Agent'
assert len(runs)==3
assert runs[0].find('s:rPr/s:b',ns) is not None
assert runs[0].find('s:rPr/s:sz',ns).get('val')=='18'
assert runs[1].find('s:rPr/s:b',ns).get('val')=='0'
assert runs[1].find('s:rPr/s:color',ns).get('rgb')=='FF2255AA'
assert runs[2].find('s:rPr/s:i',ns) is not None
assert runs[2].find('s:rPr/s:scheme',ns).get('val')=='minor'
print('Native rich runs, explicit normal, fonts, colour and Agent suffix verified.')`, file], {encoding: 'utf8'})
    expect(check.status, check.stderr).toBe(0)
    const mixedPaints = {local: await paints(page), peer: await paints(peer)}
    await active.locator('.export-control summary').first().click()
    await page.getByLabel('文字颜色', {exact: true}).fill('#228844')
    await page.getByRole('button', {name: '应用颜色', exact: true}).click()
    await expect.poll(async () => (await paints(page)).some(p => p.text === '中' && p.color === '#228844')).toBe(true)
    await expect.poll(async () => (await paints(peer)).some(p => p.text === '中' && p.color === '#228844')).toBe(true)
    await page.evaluate(() => { (window as unknown as {richPaints: unknown[]}).richPaints.length = 0 })
    await peer.evaluate(() => { (window as unknown as {richPaints: unknown[]}).richPaints.length = 0 })
    const undo = page.getByRole('button', {name: '↶ 撤销', exact: true})
    await expect(undo).toBeEnabled()
    await undo.click()
    await verifyPaint(page, 'edited')
    await verifyPaint(peer, 'edited')
    await expect(field).toHaveValue('中文😀 edited 斜体 Agent')
    await page.evaluate(() => { (window as unknown as {richPaints: unknown[]}).richPaints.length = 0 })
    await page.getByRole('button', {name: '↷ 重做', exact: true}).click()
    await expect.poll(async () => (await paints(page)).some(p => p.text === '中' && p.color === '#228844')).toBe(true)
    expect(await canvas.evaluate(element => (window as unknown as {richCanvas: Element}).richCanvas === element)).toBe(true)
    writeFileSync(info.outputPath('xlsx-rich-paints.json'), JSON.stringify({mixedPaints, finalLocal: await paints(page), native: check.stdout, wholeCellColorAndUndoRedo: true}, null, 2))
  } finally { await client.close(); await peer.close() }
})

test('XLSX native text selections save format-only edits and synchronize undo without replacing canvas', async ({page, context, request}, info) => {
  const id = 'rich-edit'
  const headers = {Authorization: `Bearer ${token(id, 'rich-editor')}`}
  const writes: unknown[] = []
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/node-patch')) writes.push(req.postDataJSON()) })
  await context.addInitScript(() => {
    const paints: Array<{text: string; font: string; color: string}> = []
    ;(window as unknown as {selectionPaints: typeof paints}).selectionPaints = paints
    const original = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function (...args: Parameters<typeof original>) {
      if (/[a-z]/i.test(args[0])) { paints.push({text: args[0], font: this.font, color: String(this.fillStyle)}); if (paints.length > 2000) paints.splice(0,1000) }
      return original.apply(this,args)
    }
  })
  await open(page,id)
  const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await canvas.evaluate(element => { (window as unknown as {selectionCanvas: Element}).selectionCanvas = element })
  const peer = await context.newPage(); await open(peer,id)
  await page.bringToFront()
  await canvas.dblclick({position: {x:180,y:35}})
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('ArrowLeft')
  for (let i=0;i<4;i++) await page.keyboard.press('ArrowRight')
  for (let i=0;i<6;i++) await page.keyboard.press('Shift+ArrowRight')
  await page.getByRole('button',{name:'加粗',exact:true}).click()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(1)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({schemaVersion:'hcd-patch/49',operations:[{op:'xlsx.richText.set'}]})
  const boldMiddle = async (target: Page) => target.evaluate(() => (window as unknown as {selectionPaints: Array<{text:string;font:string;color:string}>}).selectionPaints
    .filter(p => p.color.toLowerCase()==='#2255aa' && /bold|700/.test(p.font)).map(p => p.text).join('').includes('normal'))
  await expect.poll(() => boldMiddle(page)).toBe(true)
  await expect.poll(() => boldMiddle(peer)).toBe(true)
  // Native rich cells may store text only in `p`, leaving `v` null. Ending
  // another edit without changes must not retain an empty-baseline draft.
  await canvas.dblclick({position: {x:180,y:35}})
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('未应用输入位置',{exact:true})).toHaveCount(0)
  expect(writes).toHaveLength(1)
  await page.screenshot({path:info.outputPath('xlsx-selection-format.png')})
  await expect(page.getByRole('button',{name:'↶ 撤销',exact:true})).toBeEnabled()
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(2)
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click()
  await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(3)
  expect(await canvas.evaluate(element => (window as unknown as {selectionCanvas:Element}).selectionCanvas===element)).toBe(true)
  const client = await agent(id, 'Rich Format Agent')
  try {
    const sheet = await (await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`, {headers})).json()
    const a1 = sheet.cells.find((cell:{address:string}) => cell.address==='A1')
    const node = (await call(client, 'hcd_read', {document_id:id, resource:'node', node_id:a1.nodeId})).data
    expect(node.text).toBe('中文😀 normal 斜体')
    const middle = node.xlsxRuns.find((run:{text:string}) => run.text==='normal')
    expect(middle.properties.b.val).toBe('1')
    middle.properties.color = {rgb:'FFBB6611'}
    const auth = (await call(client,'hcd_read',{document_id:id,resource:'auth'})).data
    const patched = await call(client,'hcd_patch',{document_id:id,mode:'node',expected_revision:node.revision,collaboration_epoch:auth.collaborationEpoch,
      patch:{schemaVersion:'hcd-patch/49',documentId:id,patchId:'agent-rich-color',baseRevision:node.revision,
        operations:[{op:'xlsx.richText.set',nodeId:node.nodeId,runs:node.xlsxRuns,precondition:{nodeHash:node.nodeHash}}]}})
    expect(patched.error,String(patched.data)).toBeFalsy()
    for (const target of [page,peer]) await expect.poll(() => target.evaluate(() => (window as unknown as {selectionPaints:Array<{text:string;font:string;color:string}>}).selectionPaints
      .filter(p=>p.color.toLowerCase()==='#bb6611' && /bold|700/.test(p.font)).map(p=>p.text).join('').includes('normal'))).toBe(true)
    expect((await (await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(4)
    const active = page.locator('.document-tab-panel:not([hidden])')
    await active.locator('.export-control summary').first().click()
    await active.getByRole('button',{name:'准备下载',exact:true}).click()
    const download = active.locator('.download-ready'); await expect(download).toBeVisible()
    const output = await page.request.get((await download.getAttribute('href'))!)
    const path = info.outputPath('xlsx-selection-edited.xlsx'); writeFileSync(path,await output.body())
    const check=spawnSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as z:
 c=E.fromstring(z.read('xl/worksheets/sheet1.xml')).find('.//s:c[@r="A1"]',ns)
 assert ''.join(c.itertext())=='中文😀 normal 斜体'
 r=next(r for r in c.findall('s:is/s:r',ns) if r.find('s:t',ns).text=='normal')
 assert r.find('s:rPr/s:b',ns).get('val')=='1'
 assert r.find('s:rPr/s:color',ns).get('rgb')=='FFBB6611'
 assert c.findall('s:is/s:r',ns)[-1].find('s:rPr/s:scheme',ns).get('val')=='minor'
print('UI format-only edit, Agent color and untouched native scheme verified.')`,path],{encoding:'utf8'})
    expect(check.status,check.stderr).toBe(0)
    writeFileSync(info.outputPath('xlsx-selection-results.json'),JSON.stringify({formatOnlyEdit:true,peerSync:true,undoRedo:true,mcpReadRuns:true,mcpWriteRuns:true,canvasIdentityPreserved:true,native:check.stdout.trim(),revision:4},null,2))
    await active.locator('.export-control summary').first().click()
    await page.screenshot({path:info.outputPath('xlsx-selection-agent.png')})
  } finally {await client.close(); await peer.close() }
})

test('XLSX rich clipboard saves existing and blank cells with numbers and formulas as one undoable revision', async ({page,context,request},info) => {
  const id='rich-paste',headers={Authorization:`Bearer ${token(id,'paste-reader')}`}
  const writes: Array<{schemaVersion:string;operations:Array<{op:string}>}>=[]
  page.on('request',req=>{if(req.method()==='POST'&&req.url().endsWith('/node-patch'))writes.push(req.postDataJSON())})
  await context.grantPermissions(['clipboard-read','clipboard-write'])
  await open(page,id)
  const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await canvas.evaluate(element=>{(window as unknown as {pasteCanvas:Element}).pasteCanvas=element})
  const peer=await context.newPage();await open(peer,id);await page.bringToFront()
  try {
    await page.evaluate(async()=>{
      const html='<table><tr><td><b style="color:#cc2244">新😀</b><span style="font-weight:400;color:#2255aa"> normal</span></td><td>7</td><td>=SUM(B1,2)</td></tr><tr><td>other</td><td><b style="color:#228844">新增</b><span style="font-weight:400"> normal</span></td><td>=B1*2</td></tr></table>'
      const text='新😀 normal\t7\t=SUM(B1,2)\nother\t新增 normal\t=B1*2'
      await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([text],{type:'text/plain'})})])
    })
    await canvas.click({position:{x:180,y:35}})
    await page.keyboard.press('ControlOrMeta+v')
    await expect.poll(async()=>(await(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(1)
    expect(writes).toHaveLength(1);expect(writes[0].schemaVersion).toBe('hcd-patch/50')
    for(const op of ['xlsx.richText.set','xlsx.richText.create','xlsx.number.set','xlsx.formula.set','xlsx.formula.create'])
      expect(writes[0].operations.map(o=>o.op)).toContain(op)
    const sheet=async()=>await(await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`,{headers})).json()
    const getCell=async(address:string)=>(await sheet()).cells.find((c:{address:string})=>c.address===address)
    const b2=await getCell('B2')
    const read=await(await request.get(`${apiUrl}/v1/documents/${id}/nodes/${b2.nodeId}`,{headers})).json()
    expect(read.text).toBe('新增 normal')
    expect(read.xlsxRuns.some((r:{text:string;properties:{b?:{val:string}}})=>r.text.includes('新增')&&r.properties.b?.val==='1')).toBe(true)
    await expect.poll(()=>peer.getByLabel('单元格内容或公式',{exact:true}).inputValue()).toBe('新😀 normal')
    await expect(page.getByRole('button',{name:'↶ 撤销',exact:true})).toBeEnabled()
    await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
    await expect.poll(async()=>(await(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(2)
    expect((await getCell('A1')).text).toBe('中文😀 normal 斜体')
    await page.getByRole('button',{name:'↷ 重做',exact:true}).click()
    await expect.poll(async()=>(await(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(3)
    expect(await canvas.evaluate(element=>(window as unknown as {pasteCanvas:Element}).pasteCanvas===element)).toBe(true)
    const active=page.locator('.document-tab-panel:not([hidden])')
    await active.locator('.export-control summary').first().click()
    await active.getByRole('button',{name:'准备下载',exact:true}).click()
    const download=active.locator('.download-ready');await expect(download).toBeVisible()
    const path=info.outputPath('rich-paste.xlsx')
    writeFileSync(path,await(await page.request.get((await download.getAttribute('href'))!)).body())
    const native=spawnSync('python3',['-c',`import sys,zipfile,xml.etree.ElementTree as E
ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as z:
 sheet=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
 def cell(a):return sheet.find('.//s:c[@r="'+a+'"]',ns)
 for a,text in [('A1','新😀 normal'),('B2','新增 normal')]:
  c=cell(a);assert ''.join(c.find('s:is',ns).itertext())==text
  assert any(r.find('s:rPr/s:b',ns) is not None for r in c.findall('s:is/s:r',ns))
 assert cell('B1').find('s:v',ns).text=='7' and cell('B1').get('t')!='inlineStr'
 assert cell('C1').find('s:f',ns).text=='SUM(B1,2)'
 assert cell('C2').find('s:f',ns).text=='B1*2'
print('Native rich runs, numeric literal and formula expressions verified.')`,path],{encoding:'utf8'})
    expect(native.status,native.stderr).toBe(0)
    await active.locator('.export-control summary').first().click()
    await page.screenshot({path:info.outputPath('xlsx-rich-paste.png')})
    writeFileSync(info.outputPath('xlsx-rich-paste-results.json'),JSON.stringify({oneRevision:true,mixedOperations:writes[0].operations.map(o=>o.op),blankRichText:true,peerSync:true,undoRedo:true,canvasIdentityPreserved:true,native:native.stdout.trim()},null,2))
  }finally{await peer.close()}
})

async function pasteDurableGridBatch(page: Page) {
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.evaluate(async () => {
    const html = '<table><tr><td><b style="color:#cc2244">新😀</b><span style="font-weight:400"> normal</span></td><td>7</td><td>=SUM(B1,2)</td></tr><tr><td>other</td><td><b>新增</b><span style="font-weight:400"> normal</span></td><td>=B1*2</td></tr></table>'
    const text = '新😀 normal\t7\t=SUM(B1,2)\nother\t新增 normal\t=B1*2'
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], {type:'text/html'}), 'text/plain': new Blob([text], {type:'text/plain'}) })])
  })
  const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await canvas.click({position:{x:180,y:35}})
  await page.keyboard.press('ControlOrMeta+v')
  const pending = page.getByLabel('待保存的单元格修改', {exact:true})
  await expect(pending).toBeVisible()
  await expect(pending).toContainText('6 个单元格')
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await expect(page.getByLabel('单元格内容或公式', {exact:true})).toBeDisabled()
  return pending
}

for (const outcome of ['ready', 'lost', 'stale'] as const) test(`XLSX batch input journal ${outcome} preserves exact writes and reconciles without automatic replay`, async ({page,context,request}, info) => {
  const id = `grid-batch-${outcome}`, headers = { Authorization: `Bearer ${token(id,'batch-inspector')}` }
  const manifest = async () => (await request.get(`${apiUrl}/v1/documents/${id}`, {headers})).json()
  let originalPatch: any, submitted = 0
  await context.grantPermissions(['clipboard-read','clipboard-write'])
  await page.route('**/node-patch', async route => {
    originalPatch = route.request().postDataJSON(); submitted++
    if (outcome === 'lost') {
      const saved = await route.fetch()
      expect(saved.ok(), await saved.text()).toBe(true)
    }
    await route.abort('failed')
  })
  await open(page,id)
  const pending = await pasteDurableGridBatch(page)
  expect(submitted).toBe(1)
  expect((await manifest()).revision).toBe(outcome === 'lost' ? 1 : 0)
  const download = page.waitForEvent('download')
  await pending.getByRole('button',{name:'下载本地草稿',exact:true}).click()
  const local = JSON.parse(readFileSync((await (await download).path())!, 'utf8'))
  expect(local.patch).toEqual(originalPatch)
  expect(local.changes).toHaveLength(6)
  if (outcome === 'ready') await context.setOffline(true)
  await page.close({runBeforeUnload:false})
  if (outcome === 'ready') await context.setOffline(false)
  if (outcome !== 'ready') {
    // A later collaborator revision must not turn a lost receipt into a replay.
    const sheet = await (await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`,{headers})).json()
    const b1 = sheet.cells.find((c:{address:string}) => c.address === 'B1')
    const peer = await request.post(`${apiUrl}/v1/documents/${id}/node-patch`, {headers, data: {
      schemaVersion:'hcd-patch/29',documentId:id,patchId:`peer-after-${outcome}`,baseRevision:(await manifest()).revision,
      operations:[{op:'xlsx.number.set',nodeId:b1.nodeId,sheetId:sheet.sheetId,value:'9',precondition:{nodeHash:b1.nodeHash}}],
    }})
    expect(peer.ok(),await peer.text()).toBe(true)
  }
  if (outcome !== 'stale') {
    // Restart only the temporary test API, retaining its root and service identity.
    const exited = new Promise<void>(resolve => apiProcess.once('exit', () => resolve()))
    if (process.platform !== 'win32') process.kill(-apiProcess.pid!, 'SIGKILL'); else apiProcess.kill('SIGKILL')
    await exited
    apiProcess = start(binary,['hdoc','serve','--root',resolve(root,'service'),'--bind',`127.0.0.1:${new URL(apiUrl).port}`],serviceEnvironment)
    await ready(`${apiUrl}/health`)
  }
  const reopened = await context.newPage()
  const replayed: any[] = []
  reopened.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/node-patch')) replayed.push(req.postDataJSON()) })
  await open(reopened,id)
  const canvas = reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await canvas.evaluate(element => { (window as any).batchCanvas = element })
  const retained = reopened.getByLabel('保留的未提交输入',{exact:true})
  await expect(retained).toHaveCount(1)
  await retained.locator('summary').click()
  await expect(retained.getByRole('textbox')).toHaveValue(local.text)
  await retained.getByRole('button',{name:'恢复输入',exact:true}).click()
  if (outcome === 'ready') {
    const restored = reopened.getByLabel('待保存的单元格修改',{exact:true})
    await expect(restored).toBeVisible()
    expect(replayed).toHaveLength(0)
    expect((await manifest()).revision).toBe(0)
    await restored.getByRole('button',{name:'核对并提交',exact:true}).click()
    await expect(restored).toHaveCount(0)
    expect(replayed).toEqual([originalPatch])
    expect((await manifest()).revision).toBe(1)
    await expect(reopened.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('新😀 normal')
    // Numeric and formula cells must reconcile too; optimistic values were lost with the old page.
    await canvas.click({position:{x:180,y:35}}); await reopened.keyboard.press('ArrowRight')
    await expect(reopened.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('7')
    await reopened.keyboard.press('ArrowRight')
    await expect(reopened.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('=SUM(B1,2)')
  } else if (outcome === 'lost') {
    await expect(retained).toHaveCount(0)
    await expect(reopened.getByLabel('待保存的单元格修改',{exact:true})).toHaveCount(0)
    expect(replayed).toHaveLength(0)
    expect((await manifest()).revision).toBe(2)
  } else {
    await expect(reopened.locator('.toast.error')).toContainText('文档版本或提交回执不一致')
    await expect(retained).toHaveCount(1)
    expect(replayed).toHaveLength(0)
    expect((await manifest()).revision).toBe(1)
    await expect(retained.getByRole('button',{name:'下载本地草稿',exact:true})).toBeEnabled()
  }
  expect(await canvas.evaluate(element => (window as any).batchCanvas === element)).toBe(true)
  await reopened.screenshot({path:info.outputPath(`xlsx-batch-${outcome}.png`)})
  writeFileSync(info.outputPath(`xlsx-batch-${outcome}.json`),JSON.stringify({outcome,exactPatch:originalPatch,local,originalPosts:submitted,replayedPosts:replayed.length,revision:(await manifest()).revision,canvasPreserved:true},null,2))
})

test('XLSX batch input journal live retry keeps identity and new edits follow the epoch after undo', async ({page,context,request},info) => {
  const id='grid-batch-live',headers={Authorization:`Bearer ${token(id,'batch-inspector')}`}
  const manifest=async()=>(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()
  const writes:Array<{patch:any;epoch:string|null}>=[]
  page.on('request',req=>{if(req.method()==='POST'&&req.url().endsWith('/node-patch'))writes.push({patch:req.postDataJSON(),epoch:req.headers()['x-hcd-collaboration-epoch']??null})})
  await context.grantPermissions(['clipboard-read','clipboard-write'])
  await page.route('**/node-patch',route=>route.abort('failed'))
  await open(page,id)
  const pending=await pasteDurableGridBatch(page)
  const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await canvas.evaluate(element=>{(window as any).retryCanvas=element})
  await page.unroute('**/node-patch')
  await pending.getByRole('button',{name:'核对并提交',exact:true}).click()
  await expect(pending).toHaveCount(0)
  await expect.poll(async()=>(await manifest()).revision).toBe(1)
  expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0])
  await expect(page.getByRole('button',{name:'↶ 撤销',exact:true})).toBeEnabled()
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await expect.poll(async()=>(await manifest()).revision).toBe(2)
  await expect(page.getByRole('button',{name:'↷ 重做',exact:true})).toBeEnabled()
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  await canvas.click({position:{x:180,y:35}})
  const nativeEditor=page.locator('.hcd-univer-host [id="__editor___INTERNAL_EDITOR__DOCS_NORMAL"]')
  await expect(nativeEditor).toBeFocused()
  // Check navigation after the focused native canvas has painted a frame.
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
  await nativeEditor.press('ArrowRight')
  await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('B1')
  await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('2')
  await page.getByLabel('单元格内容或公式',{exact:true}).fill('11')
  await page.getByRole('button',{name:'应用内容',exact:true}).click()
  await expect.poll(async()=>(await manifest()).revision).toBe(3)
  expect(writes).toHaveLength(3);expect(writes[2].epoch).toBe('1')
  expect(writes[2].patch.baseRevision).toBe(2)
  await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('11')
  expect(await canvas.evaluate(element=>(window as any).retryCanvas===element)).toBe(true)
  await page.screenshot({path:info.outputPath('xlsx-batch-live-retry.png')})
  writeFileSync(info.outputPath('xlsx-batch-live-retry.json'),JSON.stringify({exactRetry:true,writes,revision:3,canvasPreserved:true},null,2))
})

test('XLSX canvas mouse navigation survives intervening toolbar clicks and native double click still edits', async ({page,request},info) => {
  const id='grid-pointer-gesture'
  await open(page,id)
  const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  // Dispatch the two real mouse clicks inside Univer's 500 ms counter, with
  // a DOM toolbar click in between. Browser click counts correctly reset.
  const clicks:number[]=[]
  await canvas.evaluate(element => {
    ;(window as any).gridGestureTimes=[]
    element.addEventListener('pointerup',()=>(window as any).gridGestureTimes.push(performance.now()))
    ;(window as any).gridGestureCanvas=element
  })
  await canvas.click({position:{x:180,y:35}})
  await page.getByRole('button',{name:'开始',exact:true}).click()
  await canvas.click({position:{x:180,y:35}})
  clicks.push(...await page.evaluate(()=>(window as any).gridGestureTimes))
  expect(clicks[1]-clicks[0], 'exercise the real 500 ms double-click boundary').toBeLessThan(500)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('B1')
  // Keeping navigation usable must also preserve true mouse double-click
  // editing and cancellation without a document write or canvas remount.
  await canvas.dblclick({position:{x:180,y:35}})
  await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('A1')
  await page.keyboard.press('ControlOrMeta+a');await page.keyboard.insertText('NATIVE_DOUBLE_CLICK')
  await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('NATIVE_DOUBLE_CLICK')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('B1')
  expect(await canvas.evaluate(element=>(window as any).gridGestureCanvas===element)).toBe(true)
  const manifest=await (await request.get(`${apiUrl}/v1/documents/${id}`,{headers:{Authorization:`Bearer ${token(id,'gesture-inspector')}`}})).json()
  expect(manifest.revision).toBe(0)
  await page.screenshot({path:info.outputPath('xlsx-mouse-navigation.png')})
  writeFileSync(info.outputPath('xlsx-mouse-navigation.json'),JSON.stringify({mouseIntervalMs:clicks[1]-clicks[0],navigation:'B1',nativeDoubleClickEdits:true,canvasPreserved:true,revision:0},null,2))
})

test('XLSX batch input journal remote refresh keeps a newer canvas selection while the index is in flight', async ({page,context},info) => {
  const id='grid-sync-selection'
  await open(page,id)
  const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await canvas.evaluate(element=>{(window as any).syncSelectionCanvas=element})
  const peer=await context.newPage()
  await open(peer,id)
  const peerCanvas=peer.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(peerCanvas).toBeVisible()
  await expect(peer.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  let held=false,released=false
  let release!:()=>void
  const heldResponse=new Promise<void>(resolve=>{release=resolve})
  await page.route(`**/v1/documents/${id}`,async route=>{
    if(!released) {held=true;await heldResponse}
    await route.continue()
  })
  try {
    await peerCanvas.click({position:{x:180,y:35}});await peer.keyboard.press('ArrowRight')
    await expect(peer.getByLabel('选中单元格',{exact:true})).toHaveText('B1')
    await peer.getByLabel('单元格内容或公式',{exact:true}).fill('9')
    await peer.getByRole('button',{name:'应用内容',exact:true}).click()
    await expect.poll(()=>held).toBe(true)
    await page.bringToFront()
    await canvas.click({position:{x:180,y:35}});await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight')
    await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('C1')
    const synced=page.waitForResponse(response=>response.url().endsWith(`/v1/documents/${id}/auth`))
    released=true;release()
    await synced
    await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('C1')
    await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('=LEN(A1)')
    expect(await canvas.evaluate(element=>(window as any).syncSelectionCanvas===element)).toBe(true)
    await page.screenshot({path:info.outputPath('xlsx-batch-inflight-selection.png')})
    writeFileSync(info.outputPath('xlsx-batch-inflight-selection.json'),JSON.stringify({delayedRemoteIndex:true,newerSelection:'C1',canvasPreserved:true,revision:1},null,2))
  } finally {released=true;release();await peer.close()}
})

test('XLSX batch input journal storage failure blocks submission and allows full live download and discard', async ({page,context,request},info) => {
  const id = 'grid-batch-storage', writes: string[] = []
  await context.grantPermissions(['clipboard-read','clipboard-write'])
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'drafts' && this.transaction.db.name === 'hcd-input-drafts-v1') throw new DOMException('Batch storage failure','QuotaExceededError')
      return put.apply(this,args)
    }
  })
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/node-patch')) writes.push(req.url()) })
  await open(page,id)
  // Unlike the helper's successful durability check, this write must report failed protection.
  await page.evaluate(async () => { await navigator.clipboard.writeText('STORAGE_BATCH\t7\t=SUM(B1,2)\nother\tnew\t=B1*2') })
  const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  await canvas.click({position:{x:180,y:35}}); await page.keyboard.press('ControlOrMeta+v')
  const pending = page.getByLabel('待保存的单元格修改',{exact:true})
  await expect(pending).toBeVisible()
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','failed')
  expect(writes).toHaveLength(0)
  expect(await page.evaluate(() => { const e = new Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
  const downloaded = page.waitForEvent('download')
  await pending.getByRole('button',{name:'下载本地草稿',exact:true}).click()
  const local = JSON.parse(readFileSync((await (await downloaded).path())!,'utf8'))
  expect(local.changes).toHaveLength(6)
  expect(local.text).toContain('A1: STORAGE_BATCH')
  expect(local.patch.operations.some((op:{op:string}) => op.op === 'xlsx.formula.create')).toBe(true)
  // A rejected formula paste restores its checked display cache as well as its expression.
  await canvas.click({position:{x:180,y:35}})
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
  await expect.poll(async () => {
    await page.keyboard.press('ControlOrMeta+c')
    return page.evaluate(() => navigator.clipboard.readText())
  }).toBe('13')
  await page.screenshot({path:info.outputPath('xlsx-batch-storage.png')})
  await pending.getByRole('button',{name:'舍弃本地修改',exact:true}).click()
  await expect(pending).toHaveCount(0)
  const response = await request.get(`${apiUrl}/v1/documents/${id}`,{headers:{Authorization:`Bearer ${token(id,'inspector')}`}})
  expect((await response.json()).revision).toBe(0)
  expect(writes).toHaveLength(0)
})

test('XLSX batch input journal keeps a corrupt intent downloadable and never sends it to review or apply', async ({page,context},info) => {
  const id = 'grid-batch-corrupt'
  await context.grantPermissions(['clipboard-read','clipboard-write'])
  await page.route('**/node-patch',route => route.abort('failed'))
  await open(page,id); await pasteDurableGridBatch(page)
  await page.close({runBeforeUnload:false})
  const reopened = await context.newPage()
  await reopened.goto(`${uiUrl}/?locale=zh-CN`)
  await reopened.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve,reject) => { const r = indexedDB.open('hcd-input-drafts-v1'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error) })
    await new Promise<void>((resolve,reject) => {
      const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),r=store.getAll()
      r.onsuccess=()=>{ for(const record of r.result) if(record.documentId===id) { const content=JSON.parse(record.content);content.changes[0].column=-1;store.put({...record,content:JSON.stringify(content)}) } }
      tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error)
    });db.close()
  },id)
  const writes: string[] = []
  reopened.on('request',req=>{if(req.method()==='POST'&&/\/node-patch(?:-review)?$/.test(req.url()))writes.push(req.url())})
  await open(reopened,id)
  const retained=reopened.getByLabel('保留的未提交输入',{exact:true})
  await expect(retained).toHaveCount(1);await retained.locator('summary').click()
  await retained.getByRole('button',{name:'恢复输入',exact:true}).click()
  await expect(reopened.locator('.toast.error')).toContainText('无法安全恢复')
  await expect(retained.getByRole('button',{name:'下载本地草稿',exact:true})).toBeEnabled()
  expect(writes).toHaveLength(0)
  await reopened.screenshot({path:info.outputPath('xlsx-batch-corrupt.png')})
})

test('XLSX rich input journal recovers uncommitted selection formatting after offline page closure', async ({page,context,request}, info) => {
  const id='rich-draft', headers={Authorization:`Bearer ${token(id,'draft-reader')}`}
  await open(page,id)
  const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  await context.setOffline(true)
  await canvas.dblclick({position:{x:180,y:35}})
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('ArrowLeft')
  for(let i=0;i<4;i++) await page.keyboard.press('ArrowRight')
  for(let i=0;i<6;i++) await page.keyboard.press('Shift+ArrowRight')
  await page.getByRole('button',{name:'加粗',exact:true}).click()
  await expect(page.getByLabel('未应用输入位置',{exact:true})).toContainText('A1')
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  await page.close({runBeforeUnload:false}); await context.setOffline(false)
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(0)
  const reopened=await context.newPage(); await open(reopened,id)
  const retained=reopened.getByLabel('保留的未提交输入',{exact:true})
  await expect(retained).toHaveCount(1)
  await retained.locator('summary').click()
  await expect(retained.getByRole('textbox')).toHaveValue('中文😀 normal 斜体')
  await expect(retained).toContainText('包含文字格式')
  const pendingDownload=reopened.waitForEvent('download')
  await retained.getByRole('button',{name:'下载本地草稿',exact:true}).click()
  const local=JSON.parse(readFileSync((await(await pendingDownload).path())!,'utf8'))
  const recoveredInput=JSON.parse(local.content)
  expect(recoveredInput.richRuns.find((run:{text:string})=>run.text==='normal').properties.b.val).toBe('1')
  await retained.getByRole('button',{name:'恢复输入',exact:true}).click()
  await expect(reopened.getByLabel('未应用输入位置',{exact:true})).toContainText('A1')
  await reopened.getByRole('button',{name:'应用内容',exact:true}).click()
  await expect.poll(async()=>(await(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(1)
  await expect(reopened.getByLabel('未应用输入位置',{exact:true})).toHaveCount(0)
  await reopened.reload()
  await expect(reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()).toBeVisible()
  await expect(reopened.getByLabel('保留的未提交输入',{exact:true})).toHaveCount(0)
  const sheet=await(await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`,{headers})).json()
  const a1=sheet.cells.find((cell:{address:string})=>cell.address==='A1')
  const saved=await(await request.get(`${apiUrl}/v1/documents/${id}/nodes/${a1.nodeId}`,{headers})).json()
  expect(saved.text).toBe('中文😀 normal 斜体')
  expect(saved.xlsxRuns.find((run:{text:string})=>run.text==='normal').properties.b.val).toBe('1')
  await reopened.screenshot({path:info.outputPath('xlsx-rich-draft-recovered.png')})
})

test('XLSX rich blank-cell input journal restores new formatted text without creating a cell before application', async ({page,context,request},info) => {
  const id='rich-blank-draft',headers={Authorization:`Bearer ${token(id,'blank-draft-reader')}`}
  await open(page,id)
  const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  await context.setOffline(true)
  await canvas.click({position:{x:180,y:35}})
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('B2')
  await page.keyboard.press('F2')
  await page.keyboard.insertText('新增 normal')
  await page.keyboard.press('ControlOrMeta+A');await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Shift+ArrowRight')
  await page.getByRole('button',{name:'加粗',exact:true}).click()
  await expect(page.getByLabel('未应用输入位置',{exact:true})).toContainText('B2')
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  await page.close({runBeforeUnload:false});await context.setOffline(false)
  expect((await(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(0)
  const reopened=await context.newPage();await open(reopened,id)
  const retained=reopened.getByLabel('保留的未提交输入',{exact:true})
  await expect(retained).toHaveCount(1);await retained.locator('summary').click()
  await expect(retained).toContainText('包含文字格式')
  await retained.getByRole('button',{name:'恢复输入',exact:true}).click()
  await expect(reopened.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('新增 normal')
  expect((await(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(0)
  await reopened.getByRole('button',{name:'应用内容',exact:true}).click()
  await expect.poll(async()=>(await(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(1)
  const sheet=await(await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`,{headers})).json()
  const b2=sheet.cells.find((c:{address:string})=>c.address==='B2')
  const saved=await(await request.get(`${apiUrl}/v1/documents/${id}/nodes/${b2.nodeId}`,{headers})).json()
  expect(saved.text).toBe('新增 normal')
  expect(saved.xlsxRuns.some((r:{text:string;properties:{b?:{val:string}}})=>r.text==='新增'&&r.properties.b?.val==='1')).toBe(true)
  await reopened.reload()
  await expect(reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()).toBeVisible()
  await expect(reopened.getByLabel('保留的未提交输入',{exact:true})).toHaveCount(0)
  await reopened.screenshot({path:info.outputPath('xlsx-rich-blank-draft.png')})
})

test('verified grid caches follow local and remote dependencies without extra writes or canvas replacement', async ({page, context, request}, info) => {
  const id = 'calculation-edit'
  const headers = { Authorization: `Bearer ${token(id, 'calculation-reader')}` }
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  let writes = 0
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/node-patch')) writes++ })
  await open(page, id)
  const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(page.getByLabel('计算校验', { exact: true })).toHaveText('已核验 · 2')
  await canvas.evaluate(element => { (window as unknown as { formulaCanvas: Element }).formulaCanvas = element })
  const copy = async (row: number, column: number, expected: string) => {
    await canvas.click({ position: { x: 80 + column * 64, y: 30 + row * 20 } })
    await expect.poll(async () => {
      await page.keyboard.press('ControlOrMeta+c')
      return page.evaluate(() => navigator.clipboard.readText())
    }).toBe(expected)
  }
  await copy(0, 0, '2') // stale 777 is never accepted as verified.
  await copy(1, 0, '-1.3') // missing source cache.
  await copy(7, 0, '12')
  await copy(8, 0, '1') // Univer copies the raw boolean; canvas displays TRUE.
  await copy(9, 0, '3')
  await copy(10, 0, '6')
  await copy(11, 0, '10')
  expect(writes).toBe(0)
  await canvas.click({ position: { x: 144, y: 30 } })
  await expect(page.getByLabel('选中单元格', { exact: true })).toHaveText('B1')
  await page.getByLabel('单元格内容或公式', { exact: true }).fill('5')
  await page.getByRole('button', { name: '应用内容', exact: true }).click()
  await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(1)
  await copy(9, 0, '7')
  await copy(10, 0, '14')
  await copy(11, 0, '14')
  expect(writes).toBe(1)
  const sheet = await (await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`, { headers })).json()
  const b2 = sheet.cells.find((cell: { address: string }) => cell.address === 'B2')
  const remote = await request.post(`${apiUrl}/v1/documents/${id}/node-patch`, { headers, data: {
    schemaVersion: 'hcd-patch/29', documentId: id, patchId: 'remote-numeric-dependency', baseRevision: 1,
    operations: [{ op: 'xlsx.number.set', nodeId: b2.nodeId, sheetId: sheet.sheetId, value: '3', precondition: { nodeHash: b2.nodeHash } }],
  } })
  expect(remote.ok(), await remote.text()).toBe(true)
  await copy(9, 0, '8')
  await copy(10, 0, '16')
  await expect(page.locator('.mode-switch')).toHaveCount(0)
  await copy(9, 0, '8')
  expect(await canvas.evaluate(element => (window as unknown as { formulaCanvas: Element }).formulaCanvas === element)).toBe(true)
  expect(writes).toBe(1)
  await page.screenshot({ path: info.outputPath('calculation-live-cache.png') })
  const exported = await request.get(`${apiUrl}/v1/documents/${id}/export/xlsx?mode=source`, { headers })
  expect(exported.ok(), exported.statusText()).toBe(true)
  const path = info.outputPath('calculation-edited.xlsx')
  writeFileSync(path, await exported.body())
  for (const [cell, expected] of [['A10', '8'], ['A11', '16'], ['A12', '14']]) {
    const output = spawnSync(binary, ['get', path, `/Sheet1/${cell}`, '--json'], { encoding: 'utf8' })
    expect(output.status).toBe(0)
    expect(JSON.parse(output.stdout).data.results[0].format.calculation.value).toBe(expected)
  }
  await page.reload()
  await expect(page.getByLabel('计算校验', { exact: true })).toHaveText('已核验 · 2')
  await copy(9, 0, '8')
  const head = await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()
  expect(head.revision).toBe(2)
})

test('native literal types agree across the grid MCP CLI and exported workbook after editing', async ({page, context, request}, info) => {
  const id = 'calculation-types'
  const client = await agent(id, 'Literal Type Inspector')
  const headers = { Authorization: `Bearer ${token(id, 'literal-reader')}` }
  const expected: Record<string, string | null> = {
    B1: '0', B2: '1', B3: '8', B4: '3', B5: null, B6: 'TRUE', B7: 'TRUE',
    B8: '4', B9: '3', B10: '3', B11: null, B12: '1', B13: '0', B14: '0', B15: '0', B16: 'TRUE', B17: 'TRUE',
  }
  type ReadCell = { address: string; nodeId: string; nodeHash: string; valueType: string;
    calculation: { status: string; value: string | null; valueType?: string; error: string | null } }
  const read = async () => {
    const response = await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`, { headers })
    expect(response.ok(), await response.text()).toBe(true)
    return await response.json() as { sheetId: string; revision: number; cells: ReadCell[] }
  }
  const native = (path: string, address: string) => {
    const output = spawnSync(binary, ['get', path, `/Sheet1/${address}`, '--json'], { encoding: 'utf8' })
    expect(output.status, output.stderr).toBe(0)
    return JSON.parse(output.stdout).data.results[0].format.calculation
  }
  try {
    const initial = await read()
    const mcp = await call(client, 'hcd_read', { document_id: id, resource: 'sheet', number: 0 })
    expect(mcp.error).toBe(false)
    expect(mcp.data.cells).toEqual(initial.cells)
    for (const [address, value] of Object.entries(expected)) {
      const cell = initial.cells.find(cell => cell.address === address)!
      expect(cell.calculation.value, address).toBe(value)
      expect(native(resolve(root, `service/sources/${id}.xlsx`), address), address).toEqual(cell.calculation)
    }
    expect(initial.cells.find(cell => cell.address === 'A1')?.calculation).toMatchObject({ value: 'TRUE', valueType: 'boolean' })
    expect(initial.cells.find(cell => cell.address === 'A2')?.calculation).toMatchObject({ value: 'FALSE', valueType: 'boolean' })
    expect(initial.cells.find(cell => cell.address === 'A3')?.calculation).toMatchObject({ value: '', valueType: 'string' })
    expect(initial.cells.find(cell => cell.address === 'A4')?.calculation).toMatchObject({ value: '', valueType: 'string' })
    expect(initial.cells.find(cell => cell.address === 'A6')?.calculation).toMatchObject({ status: 'calculated', value: '#N/A', valueType: 'string' })
    expect(initial.cells.find(cell => cell.address === 'A7')?.calculation).toMatchObject({ status: 'unavailable', error: '#N/A' })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    let writes = 0
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/node-patch')) writes++ })
    await open(page, id)
    const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
    await expect(canvas).toBeVisible()
    await canvas.evaluate(element => { (window as unknown as { typeCanvas: Element }).typeCanvas = element })
    const copy = async (address: string, value: string) => {
      const column = address.charCodeAt(0) - 65
      const row = Number(address.slice(1)) - 1
      await canvas.click({ position: { x: 80 + column * 64, y: 30 + row * 20 } })
      await expect(page.getByLabel('选中单元格', { exact: true })).toHaveText(address)
      await expect.poll(async () => {
        await page.keyboard.press('ControlOrMeta+c')
        return page.evaluate(() => navigator.clipboard.readText())
      }, { message: `actual grid scalar ${address}` }).toBe(value)
    }
    for (const [address, value] of Object.entries(expected)) {
      if (value !== null) await copy(address, value === 'TRUE' ? '1' : value)
    }
    await copy('A1', '1')
    await copy('A2', '0')
    await copy('A7', '#N/A')
    await copy('B5', '#N/A')
    await copy('B11', '#DIV/0!')
    expect(writes).toBe(0)
    const patchRoute = `**/v1/documents/${id}/node-patch`
    await page.route(patchRoute, route => route.fulfill({ status: 409, json: { message: 'Typed edit deliberately rejected' } }))
    await copy('A1', '1')
    await page.getByLabel('单元格内容或公式', { exact: true }).fill('Rejected edit')
    await page.getByRole('button', { name: '应用内容', exact: true }).click()
    await expect(page.locator('.toast.error')).toContainText('Typed edit deliberately rejected')
    await copy('A1', '1') // rejection restores BOOLEAN, not a numeric/string 1.
    await copy('B6', '1')
    expect((await read()).revision).toBe(0)
    await page.unroute(patchRoute)
    await page.getByLabel('待保存的单元格修改',{exact:true}).getByRole('button',{name:'舍弃本地修改',exact:true}).click()
    await expect(page.getByLabel('待保存的单元格修改',{exact:true})).toHaveCount(0)
    // A textual edit must replace the old boolean/error type too. This is a
    // real node splice followed by dependent recalculation, not a display fix.
    await copy('A1', '1')
    await page.getByLabel('单元格内容或公式', { exact: true }).fill('Changed')
    await page.getByRole('button', { name: '应用内容', exact: true }).click()
    await expect.poll(async () => (await read()).revision).toBe(1)
    const textChanged = await read()
    expect(textChanged.cells.find(cell => cell.address === 'A1')).toMatchObject({ valueType: 'string', numberEditable: false, numberValue: null, calculation: { value: 'Changed', valueType: 'string' } })
    await copy('B6', '0')
    expect(writes).toBe(2)
    await copy('B5', '#N/A')
    await expect(page.getByText('值不可用', { exact: true })).toBeVisible()
    const errorCell = textChanged.cells.find(cell => cell.address === 'A7')!
    const numeric = await request.post(`${apiUrl}/v1/documents/${id}/node-patch`, { headers, data: {
      schemaVersion: 'hcd-patch/29', documentId: id, patchId: 'error-to-number', baseRevision: 1,
      operations: [{ op: 'xlsx.number.set', nodeId: errorCell.nodeId, sheetId: textChanged.sheetId,
        value: '9', precondition: { nodeHash: errorCell.nodeHash } }],
    } })
    expect(numeric.ok(), await numeric.text()).toBe(true)
    // Keep the pointer still while the remote commit fixes the dependency.
    // The old error popup must disappear without a pointerleave/re-hover.
    await expect(page.getByText('值不可用', { exact: true })).toBeHidden()
    await copy('B5', '12')
    const changed = await read()
    expect(changed.cells.find(cell => cell.address === 'A7')).toMatchObject({ valueType: 'number', calculation: { value: '9', valueType: 'number' } })
    expect(await canvas.evaluate(element => (window as unknown as { typeCanvas: Element }).typeCanvas === element)).toBe(true)
    await page.screenshot({ path: info.outputPath('calculation-native-types.png') })
    const exported = await request.get(`${apiUrl}/v1/documents/${id}/export/xlsx?mode=source`, { headers })
    expect(exported.ok(), await exported.text()).toBe(true)
    const path = info.outputPath('typed-edited.xlsx')
    writeFileSync(path, await exported.body())
    for (const cell of changed.cells.filter(cell => cell.address.startsWith('B'))) {
      expect(native(path, cell.address), cell.address).toEqual(cell.calculation)
    }
    // Reimport the source export into a new identity and inspect through MCP.
    const reimportedId = 'calculation-types-reopened'
    const imported = spawnSync(binary, ['hdoc', 'import', path, '--output', resolve(root, `service/${reimportedId}.hcd`), '--document-id', reimportedId], { encoding: 'utf8' })
    expect(imported.status, imported.stderr).toBe(0)
    const reopenedClient = await agent(reimportedId, 'Reopen Inspector')
    try {
      const reopened = await call(reopenedClient, 'hcd_read', { document_id: reimportedId, resource: 'sheet', number: 0 })
      expect(reopened.error).toBe(false)
      for (const cell of changed.cells.filter(cell => cell.address.startsWith('B'))) {
        expect(reopened.data.cells.find((next: ReadCell) => next.address === cell.address)?.calculation, cell.address).toEqual(cell.calculation)
      }
    } finally { await reopenedClient.close() }
    await page.reload()
    await copy('B6', '0')
    expect((await read()).revision).toBe(2)
  } finally { await client.close() }
})

test('protocol preflight rejects an old operation table without submitting a patch', async ({page}) => {
  let writes = 0
  await page.route('**/v1/documents/calculation-grid/capabilities', async route => {
    const response = await route.fetch()
    const capabilities = await response.json()
    for (const schema of Object.values(capabilities.patchSchemas) as Array<{ operations: string[] }>) {
      schema.operations = schema.operations.filter(op => op !== 'xlsx.formula.set')
    }
    await route.fulfill({ response, json: capabilities })
  })
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/node-patch')) writes++ })
  await open(page, 'calculation-grid')
  await expect(page.getByLabel('计算校验', { exact: true })).toHaveText('已核验 · 2')
  await page.getByLabel('单元格内容或公式', { exact: true }).fill('=LEN("中文测试")')
  await page.getByRole('button', { name: '应用内容', exact: true }).click()
  await expect(page.locator('.toast.error')).toContainText('尚未支持此操作')
  expect(writes).toBe(0)
  const response = await fetch(`${apiUrl}/v1/documents/calculation-grid`, { headers: { Authorization: `Bearer ${token('calculation-grid', 'inspector')}` } })
  expect((await response.json()).revision).toBe(0)
})

test('protocol fingerprint changes reject before JSON deserialization and leave the document unchanged', async ({request}) => {
  const headers = { Authorization: `Bearer ${token('calculation-grid', 'inspector')}`, 'x-hcd-protocol-fingerprint': '0'.repeat(64), 'Content-Type': 'application/json' }
  const response = await request.post(`${apiUrl}/v1/documents/calculation-grid/node-patch`, { headers, data: '{invalid' })
  expect(response.status()).toBe(409)
  expect((await response.json()).code).toBe('service_version_changed')
  const manifest = await request.get(`${apiUrl}/v1/documents/calculation-grid`, { headers })
  expect((await manifest.json()).revision).toBe(0)
})

test('collaboration room identities survive API and sidecar crashes while offline edits merge once', async ({page, context}, info) => {
  const id = 'crdt-restart'
  const headers = { Authorization: `Bearer ${token(id, 'restart-inspector')}`, 'X-HCD-Collaboration-Epoch': '0' }
  const persisted = async () => {
    const response = await fetch(`${apiUrl}/v1/documents/${id}/collaboration/state`, { headers })
    expect(response.status).toBe(200)
    const doc = new Y.Doc(); Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()))
    return doc
  }
  await open(page, id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toContainText(`First paragraph ${id}`)
  await body.evaluate(element => { (window as unknown as { restartEditor: Element }).restartEditor = element })
  const baseline = await persisted()
  const generation = baseline.getMap('hcd-room').get('generation')
  expect(typeof generation).toBe('string')
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' SAVED_BEFORE_CRASH')
  await page.getByRole('button', { name: '保存点', exact: true }).click()
  await expect.poll(async () => JSON.stringify((await persisted()).getXmlFragment('default').toJSON())).toContain('SAVED_BEFORE_CRASH')
  await context.setOffline(true)
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' OFFLINE_AFTER_CRASH')
  for (const child of [collabProcess, apiProcess]) {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL'); else child.kill('SIGKILL')
    await exited
  }
  apiProcess = start(binary, ['hdoc', 'serve', '--root', resolve(root, 'service'), '--bind', `127.0.0.1:${new URL(apiUrl).port}`], serviceEnvironment)
  await ready(`${apiUrl}/health`)
  collabProcess = start(resolve(editorRoot, 'node_modules/.bin/tsx'), ['sidecar.ts'], serviceEnvironment)
  await context.setOffline(false)
  await expect.poll(async () => {
    const doc = await persisted()
    expect(doc.getMap('hcd-room').get('generation')).toBe(generation)
    return JSON.stringify(doc.getXmlFragment('default').toJSON())
  }, { timeout: 30_000 }).toContain('OFFLINE_AFTER_CRASH')
  expect(await body.evaluate(element => (window as unknown as { restartEditor: Element }).restartEditor === element)).toBe(true)
  await page.reload()
  await expect(body).toContainText('OFFLINE_AFTER_CRASH')
  const text = await body.innerText()
  expect(text.split('SAVED_BEFORE_CRASH')).toHaveLength(2)
  expect(text.split('OFFLINE_AFTER_CRASH')).toHaveLength(2)
  await page.screenshot({ path: info.outputPath('crdt-crash-recovery.png') })
})

test('offline content journal survives closing the browser page and restores the original CRDT edits once', async ({page, context, request}, info) => {
  const id = 'draft-reopen', marker = ' OFFLINE_CLOSED_PAGE_INPUT'
  const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}`, 'X-HCD-Collaboration-Epoch': '0' }
  const disconnect = await collaborationCut(page)
  await open(page, id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await disconnect(); await context.setOffline(true)
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(marker)
  await expect(body).toContainText(marker.trim())
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await expect.poll(async () => page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('hcd-editor-drafts-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const records = await new Promise<Array<{ documentId: string; dirty: boolean; lastUpdateKey?: number }>>(resolve => {
      const request = db.transaction('streams').objectStore('streams').getAll(); request.onsuccess = () => resolve(request.result)
    })
    db.close()
    return records.some(record => record.documentId === id && record.dirty && (record.lastUpdateKey ?? 0) > 0)
  }, id)).toBe(true)
  const remoteBefore = await request.get(`${apiUrl}/v1/documents/${id}/collaboration/state`, { headers })
  const persistedBefore = new Y.Doc(); Y.applyUpdate(persistedBefore, new Uint8Array(await remoteBefore.body()))
  expect(persistedBefore.getXmlFragment('default').toString()).not.toContain(marker.trim())
  await page.close({ runBeforeUnload: false })
  await context.setOffline(false)
  const reopened = await context.newPage()
  await open(reopened, id)
  const restored = reopened.locator('.hcd-editor-body')
  await expect(restored).toHaveAttribute('contenteditable', 'true')
  await expect(restored).toContainText(marker.trim())
  expect((await restored.innerText()).split(marker.trim())).toHaveLength(2)
  await reopened.getByRole('button', { name: '保存点', exact: true }).click()
  await expect.poll(async () => {
    const response = await request.get(`${apiUrl}/v1/documents/${id}/collaboration/state`, { headers })
    const doc = new Y.Doc(); Y.applyUpdate(doc, new Uint8Array(await response.body()))
    return doc.getXmlFragment('default').toString()
  }).toContain(marker.trim())
  await reopened.reload()
  await expect(restored).toContainText(marker.trim())
  expect((await restored.innerText()).split(marker.trim())).toHaveLength(2)
  await reopened.screenshot({ path: info.outputPath('offline-closed-page-recovery.png') })
})

test('a killed browser process recovers its committed offline journal from the same profile', async ({request}, info) => {
  const id = 'draft-browser-crash', marker = ' BROWSER_PROCESS_CRASH_DRAFT'
  const profile = resolve(root, 'crashed-browser-profile')
  const launch = async () => {
    const port = await freePort()
    const child = start(process.env.HCD_BROWSER_PATH || chromium.executablePath(), [
      '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
    ], {})
    await ready(`http://127.0.0.1:${port}/json/version`)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    return { child, browser, context: browser.contexts()[0] }
  }
  const first = await launch()
  const page = await first.context.newPage()
  const disconnect = await collaborationCut(page)
  await open(page, id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await disconnect(); await first.context.setOffline(true)
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  const headers = { Authorization: `Bearer ${token(id, 'crash-inspector')}`, 'X-HCD-Collaboration-Epoch': '0' }
  const before = await request.get(`${apiUrl}/v1/documents/${id}/collaboration/state`, { headers })
  const doc = new Y.Doc(); Y.applyUpdate(doc, new Uint8Array(await before.body()))
  expect(doc.getXmlFragment('default').toString()).not.toContain(marker.trim())
  const exited = new Promise<void>(resolve => first.child.once('exit', () => resolve()))
  if (process.platform !== 'win32') process.kill(-first.child.pid!, 'SIGKILL'); else first.child.kill('SIGKILL')
  await exited
  const second = await launch()
  try {
    const reopened = await second.context.newPage()
    await open(reopened, id)
    const restored = reopened.locator('.hcd-editor-body')
    await expect(restored).toContainText(marker.trim())
    await expect(restored).toHaveAttribute('contenteditable', 'true')
    expect((await restored.innerText()).split(marker.trim())).toHaveLength(2)
    await reopened.getByRole('button', { name: '保存点', exact: true }).click()
    await reopened.screenshot({ path: info.outputPath('browser-process-crash-recovery.png') })
  } finally { await second.browser.close() }
})

test('a restored revision quarantines an older offline journal instead of writing it into the new room', async ({page, context, request}, info) => {
  const id = 'draft-stale', marker = ' STALE_CLOSED_PAGE_INPUT'
  const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  const disconnect = await collaborationCut(page)
  await open(page, id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await disconnect(); await context.setOffline(true)
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.close({ runBeforeUnload: false })
  const head = await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()
  const restored = await request.post(`${apiUrl}/v1/documents/${id}/restore/0`, { headers, data: { expectedRevision: head.revision } })
  expect(restored.ok(), await restored.text()).toBe(true)
  await context.setOffline(false)
  const reopened = await context.newPage()
  await open(reopened, id)
  await expect(reopened.locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
  await expect(reopened.locator('.hcd-editor-body')).not.toContainText(marker.trim())
  const conflict = reopened.getByLabel('保留的本地草稿', { exact: true })
  await expect(conflict).toBeVisible()
  await conflict.locator('summary').click()
  await expect(conflict.getByLabel('保留的本地草稿内容', { exact: true })).toHaveValue(new RegExp(marker.trim()))
  await expect(conflict.getByLabel('当前文档内容', { exact: true })).not.toHaveValue(new RegExp(marker.trim()))
  const download = reopened.waitForEvent('download')
  await conflict.getByRole('button', { name: '下载本地草稿', exact: true }).click()
  const content = readFileSync((await (await download).path())!, 'utf8')
  expect(content).toContain(marker.trim())
  expect(content).not.toContain('Bearer ')
  const exported = JSON.parse(content)
  const decoded = new Y.Doc(); Y.applyUpdate(decoded, new Uint8Array(Buffer.from(exported.yjsUpdate, 'base64')))
  expect(decoded.getXmlFragment('default').toString()).toContain(marker.trim())
  expect(exported.collaborationEpoch).toBe(0)
  await reopened.screenshot({ path: info.outputPath('quarantined-draft-recovery.png') })
  const access = await (await request.get(`${apiUrl}/v1/documents/${id}/auth`, { headers })).json()
  expect(access.collaborationEpoch).toBeGreaterThan(0)
  const response = await request.get(`${apiUrl}/v1/documents/${id}/collaboration/state`, { headers: { ...headers, 'X-HCD-Collaboration-Epoch': String(access.collaborationEpoch) } })
  const doc = new Y.Doc(); Y.applyUpdate(doc, new Uint8Array(await response.body()))
  expect(doc.getXmlFragment('default').toString()).not.toContain(marker.trim())
})

test('browser storage failures are visible without claiming offline draft protection', async ({page}) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Storage unavailable') } }) })
  await open(page, 'draft-storage-error')
  await expect(page.getByRole('alert', { name: '本地草稿保护不可用' })).toBeVisible()
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'failed')
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' ONLINE_EDIT_WITHOUT_LOCAL_STORAGE')
  await expect(body).toContainText('ONLINE_EDIT_WITHOUT_LOCAL_STORAGE')
})

test('a failed journal write warns on close until current content is confirmed saved by the server', async ({page, context}) => {
  const disconnect = await collaborationCut(page)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await open(page, 'draft-write-error')
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await disconnect(); await context.setOffline(true)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'updates') throw new DOMException('Simulated quota failure', 'QuotaExceededError')
      return original.apply(this, args)
    }
  })
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' UNPROTECTED_QUOTA_INPUT')
  await expect(page.getByRole('alert', { name: '本地草稿保护不可用' })).toBeVisible()
  const warnsOnClose = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented
  })
  expect(await warnsOnClose()).toBe(true)
  await disconnect(false); await context.setOffline(false)
  await page.getByRole('button', { name: '保存点', exact: true }).click()
  await expect.poll(warnsOnClose).toBe(false)
  await expect(body).toContainText('UNPROTECTED_QUOTA_INPUT')
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'failed')
  expect(pageErrors).toEqual([])
})

test('a rebuilt collaboration room quarantines an offline journal even when its epoch is unchanged', async ({page, context, request}) => {
  const id = 'draft-generation', marker = ' OLD_ROOM_GENERATION_INPUT'
  const disconnect = await collaborationCut(page)
  await open(page, id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable', 'true')
  const headers = { Authorization: `Bearer ${token(id, 'generation-inspector')}`, 'X-HCD-Collaboration-Epoch': '0' }
  const response = await request.get(`${apiUrl}/v1/documents/${id}/collaboration/state`, { headers })
  const initial = new Y.Doc(); Y.applyUpdate(initial, new Uint8Array(await response.body()))
  await disconnect(); await context.setOffline(true)
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.close({ runBeforeUnload: false })
  const exited = new Promise<void>(resolve => collabProcess.once('exit', () => resolve()))
  if (process.platform !== 'win32') process.kill(-collabProcess.pid!, 'SIGKILL'); else collabProcess.kill('SIGKILL')
  await exited
  rmSync(resolve(root, 'service', 'collaboration', `${id}.bin`))
  collabProcess = start(resolve(editorRoot, 'node_modules/.bin/tsx'), ['sidecar.ts'], serviceEnvironment)
  await context.setOffline(false)
  const reopened = await context.newPage()
  await open(reopened, id)
  await expect(reopened.locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
  await expect(reopened.locator('.hcd-editor-body')).not.toContainText(marker.trim())
  const conflict = reopened.getByLabel('保留的本地草稿', { exact: true })
  await expect(conflict).toBeVisible(); await conflict.locator('summary').click()
  await expect(conflict.getByLabel('保留的本地草稿内容', { exact: true })).toHaveValue(new RegExp(marker.trim()))
  const current = await request.get(`${apiUrl}/v1/documents/${id}/collaboration/state`, { headers })
  const document = new Y.Doc(); Y.applyUpdate(document, new Uint8Array(await current.body()))
  expect(document.getMap('hcd-room').get('generation')).not.toBe(initial.getMap('hcd-room').get('generation'))
  const access = await (await request.get(`${apiUrl}/v1/documents/${id}/auth`, { headers })).json()
  expect(access.collaborationEpoch).toBe(0)
})

test('journal maintenance prunes abandoned clean streams without deleting a live writer baseline', async ({page}) => {
  await open(page, 'draft-maintenance')
  await expect(page.locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/draftJournal.ts'
    const { readDrafts } = await import(/* @vite-ignore */ moduleUrl)
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('hcd-editor-drafts-v1'); request.onsuccess = () => resolve(request.result) })
    const streams = await new Promise<Array<{ id: string; namespace: string }>>(resolve => { const request = db.transaction('streams').objectStore('streams').getAll(); request.onsuccess = () => resolve(request.result) })
    const active = streams[0]
    const tx = db.transaction('streams', 'readwrite')
    for (let index = 0; index < 140; index++) tx.objectStore('streams').put({ ...active, id: `abandoned-clean-${index}` })
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve() })
    await readDrafts(active.namespace)
    const remaining = await new Promise<Array<{ id: string }>>(resolve => { const request = db.transaction('streams').objectStore('streams').getAll(); request.onsuccess = () => resolve(request.result) })
    db.close()
    return { remaining: remaining.map(stream => stream.id), active: active.id }
  })
  expect(result.remaining).toEqual([result.active])
  const body = page.locator('.hcd-editor-body')
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' ACTIVE_STREAM_KEPT')
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
})

test('an unreadable local journal stays downloadable without crashing the editor or merging it', async ({page, context}) => {
  const id = 'draft-corrupt'
  await open(page, id)
  await expect(page.locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('hcd-editor-drafts-v1'); request.onsuccess = () => resolve(request.result) })
    const tx = db.transaction('streams', 'readwrite'), store = tx.objectStore('streams'), request = store.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) store.put({ ...cursor.value, id: 'unreadable-retained-draft', dirty: true, baseline: new Uint8Array([255, 255, 255]).buffer })
    }
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve() }); db.close()
  })
  await page.close({ runBeforeUnload: false })
  const reopened = await context.newPage()
  await open(reopened, id)
  await expect(reopened.locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
  const conflict = reopened.getByLabel('保留的本地草稿', { exact: true })
  await expect(conflict).toBeVisible(); await conflict.locator('summary').click()
  await expect(conflict.getByRole('alert')).toContainText('无法合并')
  const download = reopened.waitForEvent('download')
  await conflict.getByRole('button', { name: '下载本地草稿', exact: true }).click()
  const value = JSON.parse(readFileSync((await (await download).path())!, 'utf8'))
  expect(Buffer.from(value.updateLog[0], 'base64')).toEqual(Buffer.from([255, 255, 255]))
})

test('offline journals stay isolated between authenticated users and service identities', async ({page, context, request}) => {
  const id = 'draft-isolation', marker = ' PRIVATE_OFFLINE_USER_DRAFT'
  const disconnect = await collaborationCut(page)
  await open(page, id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await disconnect(); await context.setOffline(true)
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  const headers = { Authorization: `Bearer ${token(id, 'isolation-inspector')}`, 'X-HCD-Collaboration-Epoch': '0' }
  const response = await request.get(`${apiUrl}/v1/documents/${id}/collaboration/state`, { headers })
  const persisted = new Y.Doc(); Y.applyUpdate(persisted, new Uint8Array(await response.body()))
  expect(persisted.getXmlFragment('default').toString()).not.toContain(marker.trim())
  await page.close({ runBeforeUnload: false })
  await context.setOffline(false)
  const other = await context.newPage()
  await other.goto(`${uiUrl}/?locale=zh-CN`)
  await expect(other.locator('[data-workspace-restoring="false"]')).toBeVisible()
  await other.getByPlaceholder('doc-…').fill(id)
  await other.getByPlaceholder('粘贴短期令牌', { exact: true }).fill(token(id, 'another-browser-user'))
  await other.getByRole('button', { name: '打开文档', exact: true }).click()
  await expect(other.locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
  await expect(other.locator('.hcd-editor-body')).not.toContainText(marker.trim())
  await expect(other.getByLabel('保留的本地草稿', { exact: true })).toHaveCount(0)
  await other.close()
  const replaced = await context.newPage()
  await replaced.route(`**/v1/documents/${id}/auth`, async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), serviceId: 'different-authorized-service-root' } })
  })
  await open(replaced, id)
  await expect(replaced.locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
  await expect(replaced.locator('.hcd-editor-body')).not.toContainText(marker.trim())
  await expect(replaced.getByLabel('保留的本地草稿', { exact: true })).toHaveCount(0)
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

test('workspace reload restores multiple tabs, active document, preview and independent canvas zoom', async ({page}, info) => {
  await open(page,'restore-text')
  await expect(page.locator('.hcd-editor-body')).toContainText('restore-text')
  await page.getByRole('button',{name:'放大文档',exact:true}).click()
  await expect(page.locator('.canvas-zoom-value')).toHaveText('110%')
  await reopenWithScope(page, 'read')
  await page.getByRole('button',{name:'打开其他文档',exact:true}).click()
  await page.getByPlaceholder('doc-…').fill('restore-pdf')
  await page.getByPlaceholder('粘贴短期令牌',{exact:true}).fill(token('restore-pdf','browser-user'))
  await page.getByRole('button',{name:'打开文档',exact:true}).click()
  const active = page.locator('.document-tab-panel:not([hidden])')
  await expect(active.locator('iframe').first()).toBeVisible()
  await active.getByRole('button',{name:'缩小文档',exact:true}).click()
  const pdfZoom = await active.locator('.canvas-zoom-value').innerText()
  await page.reload()
  await expect(page.locator('[data-workspace-restoring="false"]')).toBeVisible()
  await expect(page.locator('.document-tab')).toHaveCount(2)
  await expect(active).toHaveAttribute('data-document-id','restore-pdf')
  await expect(active.locator('.canvas-zoom-value')).toHaveText(pdfZoom)
  await page.locator('.document-tab').filter({hasText:'restore-text'}).locator('button').first().click()
  await expect(active.locator('.canvas-zoom-value')).toHaveText('110%')
  await expect(active.locator('.mode-switch')).toHaveCount(0)
  await expect(active.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','false')
  await page.getByRole('button',{name:'关闭 restore-pdf',exact:true}).click()
  await expect(page.locator('.document-tab')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('.document-tab')).toHaveCount(1)
  await expect(page.locator('.document-tab')).toContainText('restore-text')
  await page.screenshot({path:info.outputPath('workspace-restored-tabs.png')})
})

test('workspace restoration reauthenticates every tab and isolates expired access', async ({page}, info) => {
  await page.goto(`${uiUrl}/?locale=zh-CN`)
  const valid = token('restore-read','browser-user','read'), expired = token('restore-expired','browser-user','write',Math.floor(Date.now()/1000)-3600)
  await page.evaluate(({valid,expired}) => sessionStorage.setItem('hcd-editor-workspace-v1',JSON.stringify({version:1,activeDocument:'restore-read',tabs:[
    {documentId:'restore-read',token:valid,scope:'write',format:'xlsx',collaborationEpoch:999},
    {documentId:'restore-expired',token:expired},
  ]})),{valid,expired})
  await page.reload()
  await expect(page.locator('[data-workspace-restoring="false"]')).toBeVisible()
  await expect(page.locator('.document-tab')).toHaveCount(1)
  const active = page.locator('.document-tab-panel:not([hidden])')
  await expect(active.locator('.workspace')).toHaveAttribute('data-format','txt')
  await expect(active.locator('[data-document-scope]')).toHaveAttribute('data-document-scope', 'read')
  await expect(active.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','false')
  await page.getByRole('button',{name:'文档工作台',exact:true}).click()
  const unavailable = page.getByRole('region',{name:'待恢复的文档'})
  await expect(unavailable).toContainText('restore-expired')
  await expect(unavailable).toContainText('访问已过期或无权限')
  await unavailable.getByRole('button',{name:'重新连接',exact:true}).click()
  await expect(page.getByPlaceholder('doc-…')).toHaveValue('restore-expired')
  await page.getByPlaceholder('粘贴短期令牌',{exact:true}).fill(token('restore-expired','browser-user'))
  await page.getByRole('button',{name:'打开文档',exact:true}).click()
  await expect(page.locator('.document-tab')).toHaveCount(2)
  await expect(active.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','true')
  await page.getByRole('button',{name:'文档工作台',exact:true}).click()
  await expect(unavailable).toHaveCount(0)
  await page.screenshot({path:info.outputPath('workspace-reauthenticated-tabs.png')})
})

for (const storageMode of ['blocked', 'quota'] as const) test(`workspace connections remain usable with ${storageMode} browser storage`, async ({page}) => {
  await page.addInitScript(mode => {
    if (mode === 'blocked') {
      // Browsers deny the storage getter; lib0 detects this during module load.
      // Making getItem throw while the getter works models a different runtime
      // failure in lib0's environment module, outside session restoration.
      for (const property of ['sessionStorage', 'localStorage']) Object.defineProperty(window, property, { configurable:true, get() { throw new DOMException('Storage is disabled','SecurityError') } })
    } else Storage.prototype.setItem = () => { throw new DOMException('Storage is full','QuotaExceededError') }
  }, storageMode)
  await open(page,'restore-text')
  await expect(page.locator('.hcd-editor-body')).toContainText('restore-text')
  await expect(page.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','true')
  await page.getByRole('button',{name:'放大文档',exact:true}).click()
  await expect(page.locator('.canvas-zoom-value')).toHaveText('110%')
  page.once('dialog',dialog => dialog.accept())
  await page.getByRole('button',{name:'关闭 restore-text',exact:true}).click()
  await expect(page.locator('.document-tab')).toHaveCount(0)
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
  const wrapper = page.locator('.hcd-opaque-preview').first()
  await expect(wrapper.locator(':scope > small')).toHaveCount(0)
  expect(await wrapper.evaluate(element => {
    const style = getComputedStyle(element)
    return { padding:style.padding, margin:style.margin, border:style.borderWidth, background:style.backgroundColor }
  })).toEqual({padding:'0px',margin:'0px',border:'0px',background:'rgba(0, 0, 0, 0)'})
  expect(await preview.contentFrame().locator('body').evaluate(element=>getComputedStyle(element).padding)).toBe('0px')
  const frameHeight = await preview.evaluate(element=>element.getBoundingClientRect().height)
  await expect(wrapper.locator('button')).toHaveCount(0)
  await expect(preview.contentFrame().locator('[data-hcd-inline-table-text]').first()).toHaveAttribute('contenteditable','plaintext-only')
  expect(await preview.evaluate(element=>element.getBoundingClientRect().height)).toBe(frameHeight)
  expect(await wrapper.evaluate(element=>element.getBoundingClientRect().height)).toBe(frameHeight)
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

test('Word table text editing checkpoints shared drafts and preserves source runs and merged cells', async ({page, context}, info) => {
  const id = 'table-edit'
  await open(page, id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toContainText('COVER TITLE')
  await body.locator('p').filter({hasText:'COVER TITLE'}).first().click()
  await page.keyboard.press('End'); await page.keyboard.insertText(' HUMAN_DRAFT')
  const coverText = await body.locator('p').filter({hasText:'HUMAN_DRAFT'}).first().innerText()
  const peer = await context.newPage()
  await open(peer, id)
  await expect(peer.locator('.hcd-editor-body')).toContainText('HUMAN_DRAFT')
  const frame = page.locator('.hcd-opaque-preview iframe').first().contentFrame()
  await expect(frame.locator('table')).toBeVisible()
  await frame.locator('td').first().click()
  const text = frame.locator('td').first().locator('[data-hcd-inline-table-text]')
  await expect(text).toHaveText('ROW 00')
  await expect(text).toHaveAttribute('contenteditable','plaintext-only')
  await frame.locator('table').evaluate(element => { (window as unknown as {originalTable:Element}).originalTable = element })
  await text.fill('ROW 中文🙂00')
  await expect(frame.locator('td').first()).toHaveText('ROW 中文🙂00')
  await expect(frame.locator('td').first().locator('[data-hcd-node-hash]').last()).toHaveText('00')
  await page.screenshot({path:info.outputPath('word-table-text-editor.png')})
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', {name:'保存点', exact:true}).click()
  expect(await frame.locator('table').evaluate(element => (window as unknown as {originalTable:Element}).originalTable === element)).toBe(true)
  const table = page.locator('.hcd-opaque-preview iframe').first().contentFrame()
  await expect(table.locator('td').first()).toHaveText('ROW 中文🙂00')
  await expect(peer.locator('.hcd-opaque-preview iframe').first().contentFrame().locator('td').first()).toHaveText('ROW 中文🙂00')
  await expect(peer.locator('.hcd-editor-body')).toContainText('HUMAN_DRAFT')
  await reopenWithScope(page, 'read')
  await expect(page.locator('.word-page-preview iframe').contentFrame().locator('body')).toContainText('ROW 中文🙂00')
  const auth = {Authorization:`Bearer ${token(id,'browser-user')}`}
  const response = await fetch(`${apiUrl}/v1/documents/${id}/export/docx?source=true`, {headers:auth})
  expect(response.status).toBe(200)
  const exported = resolve(root,'table-edited.docx'); writeFileSync(exported,Buffer.from(await response.arrayBuffer()))
  const checked = spawnSync('python3',['-c',
    'import sys,zipfile\na=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2])\nassert set(a.namelist())==set(b.namelist())\nfor p in a.namelist():\n x,y=a.read(p),b.read(p)\n if p=="word/document.xml":\n  assert y==x.replace(b"COVER TITLE",sys.argv[3].encode(),1).replace(b"ROW ","ROW 中文🙂".encode(),1)\n else: assert x==y,p',
    resolve(root,'service/sources',`${id}.docx`),exported,coverText],{encoding:'utf8'})
  expect(checked.stderr).toBe(''); expect(checked.status).toBe(0)
  await page.reload()
  await expect(page.locator('[data-workspace-restoring="false"]')).toBeVisible()
  await expect(page.locator('.hcd-editor-body')).toContainText('HUMAN_DRAFT')
  await expect(page.locator('.hcd-opaque-preview iframe').first().contentFrame().locator('td').first()).toHaveText('ROW 中文🙂00')
  await page.screenshot({path:info.outputPath('word-table-text-saved.png')})
  await peer.close()
})

test('Word table edits share character updates, undo, and serialize safely with an MCP agent', async ({page, context}, info) => {
  const id = 'table-conflict'
  await open(page,id)
  const frame = page.locator('.hcd-opaque-preview iframe').first().contentFrame()
  const field = frame.locator('td').first().locator('[data-hcd-inline-table-text]')
  await expect(field).toHaveText('ROW 00')
  await expect(field).toHaveAttribute('contenteditable','plaintext-only')
  const peer = await context.newPage(); await open(peer,id)
  const peerFrame = peer.locator('.hcd-opaque-preview iframe').first().contentFrame()
  const peerField = peerFrame.locator('td').first().locator('[data-hcd-inline-table-text]')
  await expect(peerField).toHaveText('ROW 00')
  // Native typing keeps the table, paragraph and formatting spans alive.
  await field.evaluate(element => { (window as unknown as {originalParagraph:Element}).originalParagraph = element })
  await field.click(); await page.keyboard.press('End'); await page.keyboard.type(' HUMAN')
  await expect(peerField).toHaveText('ROW 00 HUMAN')
  expect(await field.evaluate(element => (window as unknown as {originalParagraph:Element}).originalParagraph === element)).toBe(true)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(field).toHaveText('ROW 00')
  await expect(peerField).toHaveText('ROW 00')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(peerField).toHaveText('ROW 00 HUMAN')
  // A second person edits another cell without either table being remounted.
  const second = peerFrame.locator('td').nth(1).locator('[data-hcd-inline-table-text]').first()
  await second.fill('PEER 中文🙂')
  await expect(frame.locator('td').nth(1)).toHaveText('PEER 中文🙂')
  await page.getByRole('button',{name:'保存点',exact:true}).click()
  const client = await agent(id,'Table Agent')
  try {
    const projection = (await call(client,'hcd_read',{document_id:id,resource:'editor'})).data
    const table = projection.blocks.find((block:{readOnlyHtml?:string}) => block.readOnlyHtml?.includes('<table'))
    const node = (await call(client,'hcd_read',{document_id:id,resource:'node',node_id:table.content.inlines[0].nodeId})).data
    const auth = (await call(client,'hcd_read',{document_id:id,resource:'auth'})).data
    // The sidecar may finish the peer's checkpoint between the editor and
    // node reads. The fresh node's hash and revision form one precondition.
    const result = await call(client,'hcd_patch',{document_id:id,mode:'node',expected_revision:node.revision,collaboration_epoch:auth.collaborationEpoch,
      patch:{schemaVersion:'hcd-patch/1',documentId:id,patchId:'table-agent-edit',baseRevision:node.revision,operations:[{op:'text.splice',nodeId:node.nodeId,start:0,deleteCount:0,insertText:'AGENT ',precondition:{nodeHash:node.nodeHash}}]}})
    expect(result.error, String(result.data)).toBeFalsy()
    await expect(field).toHaveText('AGENT ROW 00 HUMAN')
    await expect(peerField).toHaveText('AGENT ROW 00 HUMAN')
    await expect(frame.locator('td').nth(1)).toHaveText('PEER 中文🙂')
    expect(await field.evaluate(element => (window as unknown as {originalParagraph:Element}).originalParagraph === element)).toBe(true)
    // A stale checkpoint cannot overwrite the agent's committed source text.
    const stale = await page.request.post(`${apiUrl}/v1/documents/${id}/checkpoints`, {headers:{Authorization:`Bearer ${token(id,'browser-user')}`,'X-HCD-Collaboration-Epoch':String(auth.collaborationEpoch)},data:{expectedRevision:projection.revision,blocks:projection.blocks.filter((block:{region:string})=>block.region==='body').map((block:{blockId:string;content:unknown})=>({blockId:block.blockId,content:block.content}))}})
    expect(stale.status()).toBe(409)
    await page.screenshot({path:info.outputPath('word-table-inline-collaboration.png')})
  } finally { await client.close(); await peer.close() }
})

test('inline Word table keyboard, composition and remote updates retain the canvas viewport', async ({page, context},info)=>{
  const id='table-keyboard'
  await page.setViewportSize({width:1440,height:720})
  await open(page,id)
  const active=page.locator('.document-tab-panel:not([hidden])')
  const frame=active.locator('.hcd-opaque-preview iframe').first().contentFrame()
  const field=frame.locator('[data-hcd-inline-table-text]').filter({hasText:'ROW 25'}).first()
  await expect(field).toHaveAttribute('contenteditable','plaintext-only')
  await field.click()
  await field.evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);range.collapse(false);const selected=document.getSelection()!;selected.removeAllRanges();selected.addRange(range)})
  const scroll=active.locator('.canvas-viewport').first()
  const before=await scroll.evaluate(element=>element.scrollTop)
  expect(before).toBeGreaterThan(100)
  await field.evaluate(element=>{(window as unknown as {originalTextNode:Node|null}).originalTextNode=element.querySelector('[data-hcd-node-hash]')?.firstChild || null})
  await page.keyboard.type(' EDIT'); await page.keyboard.insertText('🙂')
  await expect(field).toHaveText('ROW 25 EDIT🙂')
  await page.keyboard.press('Backspace')
  await expect(field).toHaveText('ROW 25 EDIT')
  expect(await field.evaluate(element=>(window as unknown as {originalTextNode:Node}).originalTextNode===element.querySelector('[data-hcd-node-hash]')?.firstChild)).toBe(true)
  expect(Math.abs(await scroll.evaluate(element=>element.scrollTop)-before)).toBeLessThan(2)
  // Simulate native IME events while a second browser changes the same run.
  const peer=await context.newPage(); await open(peer,id)
  const other=peer.locator('.hcd-opaque-preview iframe').first().contentFrame().locator('[data-hcd-inline-table-text]').filter({hasText:'ROW 25 EDIT'}).first()
  await expect(other).toHaveText('ROW 25 EDIT')
  await field.evaluate(element=>{
    element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))
    const text=element.querySelector('[data-hcd-node-hash]')!.firstChild!
    text.textContent+='中文'
    const range=document.createRange();range.selectNodeContents(element);range.collapse(false)
    const selection=document.getSelection()!;selection.removeAllRanges();selection.addRange(range)
    element.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'中文'}))
  })
  await other.click()
  await other.evaluate(element=>{const range=document.createRange();range.selectNodeContents(element);range.collapse(true);const selected=document.getSelection()!;selected.removeAllRanges();selected.addRange(range)})
  await peer.keyboard.type('PEER ')
  await expect(other).toHaveText('PEER ROW 25 EDIT')
  // Let the shared transaction arrive; it must not interrupt the active IME DOM.
  await expect(active.locator('.editor-statusbar')).toContainText('编辑中')
  await page.waitForTimeout(300)
  await expect(field).toHaveText('ROW 25 EDIT中文')
  await field.evaluate(element=>element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'})))
  await expect(field).toHaveText('PEER ROW 25 EDIT中文')
  await expect(other).toHaveText('PEER ROW 25 EDIT中文')
  expect(Math.abs(await scroll.evaluate(element=>element.scrollTop)-before)).toBeLessThan(2)
  // Keyboard navigation remains within the source table.
  await field.click(); await page.keyboard.press('Tab'); await page.keyboard.insertText('NEXT CELL')
  await expect(frame.locator('[data-hcd-inline-table-text]').filter({hasText:'NEXT CELL'})).toHaveCount(1)
  await page.screenshot({path:info.outputPath('word-table-inline-at-scroll.png')})
  await peer.close()
})

test('HTML inline fidelity survives human undo, peer sync, MCP edits and canonical export', async ({page, context}, info) => {
  const id = 'inline-html'
  await open(page, id)
  const active = page.locator('.document-tab-panel:not([hidden])')
  const paragraph = active.locator('.hcd-editor-body p[data-hcd-block-id]').first()
  await expect(paragraph.locator('strong')).toHaveText('同名😀')
  await expect(paragraph.locator('em')).toHaveText(' tail')
  await expect(paragraph.locator('a[href="#section"]')).toHaveText(' section')
  await expect(paragraph.locator('a[href="tel:+86123"]')).toHaveText(' phone')
  const headers = { Authorization: `Bearer ${token(id, 'browser-user')}` }
  const initial = await (await page.request.get(`${apiUrl}/v1/documents/${id}/editor`, {headers})).json()
  const first = initial.blocks.find((block: {content: {inlines: Array<{text: string}>}}) => block.content.inlines[0]?.text === '同名😀')
  const originalNodeId = first.content.inlines[0].nodeId
  await paragraph.evaluate(element => { (window as unknown as {inlineParagraph: Element}).inlineParagraph = element })
  const peer = await context.newPage()
  await open(peer, id)
  const peerParagraph = peer.locator(`.hcd-editor-body [data-hcd-block-id="${first.blockId}"]`)
  await expect(peerParagraph.locator('strong')).toHaveText('同名😀')
  const bold = paragraph.locator('strong')
  await bold.click()
  await bold.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(false)
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
  await page.keyboard.insertText(' EDIT🙂')
  await expect(peerParagraph.locator('strong')).toHaveText('同名😀 EDIT🙂')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(peerParagraph.locator('strong')).toHaveText('同名😀')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(peerParagraph.locator('strong')).toHaveText('同名😀 EDIT🙂')
  await active.getByRole('button', {name: '保存点', exact: true}).click()
  await expect(active.locator('.editor-header .status')).toHaveText('已保存')
  const client = await agent(id, 'HTML Agent')
  try {
    const nodeRead = await call(client, 'hcd_read', {document_id: id, resource: 'node', node_id: originalNodeId})
    expect(nodeRead.error, String(nodeRead.data)).toBeFalsy()
    const node = nodeRead.data
    expect(node.text).toBe('同名😀 EDIT🙂')
    const auth = (await call(client, 'hcd_read', {document_id: id, resource: 'auth'})).data
    const result = await call(client, 'hcd_patch', {
      document_id: id, mode: 'node', expected_revision: node.revision, collaboration_epoch: auth.collaborationEpoch,
      patch: {schemaVersion: 'hcd-patch/1', documentId: id, patchId: 'html-inline-agent', baseRevision: node.revision,
        operations: [{op: 'text.splice', nodeId: originalNodeId, start: 0, deleteCount: 0,
          insertText: 'AGENT ', precondition: {nodeHash: node.nodeHash}}]},
    })
    expect(result.error, String(result.data)).toBeFalsy()
    await expect(paragraph.locator('strong')).toHaveText('AGENT 同名😀 EDIT🙂')
    await expect(peerParagraph.locator('strong')).toHaveText('AGENT 同名😀 EDIT🙂')
    await expect(paragraph.locator('em')).toHaveText(' tail')
    expect(await paragraph.evaluate(element => (window as unknown as {inlineParagraph: Element}).inlineParagraph === element)).toBe(true)
    const table = active.locator('.hcd-opaque-preview iframe').first().contentFrame()
    await expect(table.locator('td strong')).toHaveText('Table bold')
    await expect(table.locator('td em')).toHaveText('table italic')
    const exported = await page.request.get(`${apiUrl}/v1/documents/${id}/export/html`, {headers})
    expect(exported.ok()).toBeTruthy()
    const markup = await exported.text()
    const observed = await page.evaluate(markup => {
      const doc = new DOMParser().parseFromString(markup, 'text/html')
      return {bold: doc.querySelector('p strong')?.textContent, italic: doc.querySelector('p em')?.textContent,
        href: doc.querySelector('a')?.getAttribute('href'), title: doc.querySelector('a')?.getAttribute('title')}
    }, markup)
    expect(observed).toEqual({bold: 'AGENT 同名😀 EDIT🙂', italic: ' tail', href: 'https://example.com/a/b?q=1&x=2', title: '原链接'})
    await page.screenshot({path: info.outputPath('html-inline-human-peer-agent.png')})
    for (const [oldHref, newHref] of [['#section', '#updated-section'], ['tel:+86123', 'tel:+86456']]) {
      await paragraph.locator(`a[href="${oldHref}"]`).click()
      await active.getByRole('button', {name: '链接', exact: true}).click()
      const dialog = page.getByRole('dialog', {name: '设置链接', exact: true})
      await dialog.getByLabel('链接地址', {exact: true}).fill(newHref)
      await dialog.getByRole('button', {name: '应用链接', exact: true}).click()
      await expect(dialog).toHaveCount(0)
      await expect(peerParagraph.locator(`a[href="${newHref}"]`)).toBeVisible()
      await active.getByRole('button', {name: '保存点', exact: true}).click()
      await expect(active.locator('.editor-header .status')).toHaveText('已保存')
    }
  } finally { await client.close(); await peer.close() }
})

test('HTML and Markdown source tables edit inline and preserve their source format',async({page})=>{
  for(const [id,format] of [['table-md','md'],['table-html','html']]){
    await open(page,id)
    const active=page.locator('.document-tab-panel:not([hidden])')
    const frame=active.locator('.hcd-opaque-preview iframe').first().contentFrame()
    const field=frame.locator('[data-hcd-inline-table-text]').filter({hasText:'Inline'}).first()
    await expect(field).toHaveAttribute('contenteditable','plaintext-only')
    await field.fill('直接编辑中文🙂')
    await active.getByRole('button',{name:'保存点',exact:true}).click()
    await expect(active.locator('.editor-header .status')).toHaveText('已保存')
    const response=await page.request.get(`${apiUrl}/v1/documents/${id}/export/${format}`,{headers:{Authorization:`Bearer ${token(id,'browser-user')}`}})
    const source=await response.text()
    expect(response.ok(),source.slice(0,500)).toBe(true)
    expect(source).toContain('直接编辑中文🙂')
    expect(source).toContain(format==='md'?'| --- | --- |':'<table ')
    await page.reload()
    await expect(page.locator('.document-tab-panel:not([hidden]) .hcd-opaque-preview iframe').first().contentFrame().locator('table')).toContainText('直接编辑中文🙂')
  }
})

test('Word typography survives text checkpoints, reload and historical comparisons', async ({page}, info) => {
  const id = 'word-presentation'
  await open(page, id)
  const active = page.locator('.document-tab-panel:not([hidden])')
  const title = active.locator('main.document .hcd-editor-body > p').first()
  await expect(title).toHaveAttribute('data-word-presentation', 'true')
  await expect(title).toHaveCSS('text-align', 'center')
  await expect(title.locator('span').last()).toHaveCSS('font-size', '32px')
  await expect(title.locator('span').last()).toHaveCSS('color', 'rgb(40, 87, 164)')
  await expect(active.locator('main.document')).toHaveAttribute('data-word-page', 'true')
  await expect(active.locator('main.document')).toHaveCSS('width', '816px')
  await expect(active.locator('main.document')).toHaveCSS('padding-top', '96px')
  await title.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' EDITED')
  await active.getByRole('button', {name: '保存点', exact: true}).click()
  const headers = {Authorization: `Bearer ${token(id, 'word-layout-check')}`}
  await expect.poll(async () => {
    const projection = await (await fetch(`${apiUrl}/v1/documents/${id}/editor`, {headers})).json()
    return projection.blocks[0].content.inlines.map((inline: {text:string}) => inline.text).join('')
  }).toContain('EDITED')
  await expect(title).toHaveCSS('text-align', 'center')
  await expect(title.locator('span').last()).toHaveCSS('font-size', '32px')
  await active.locator('.export-control summary').click()
  await expect(active.getByRole('combobox', {name:'导出方式', exact:true})).toHaveValue('source')
  await active.getByRole('button', {name:'准备下载', exact:true}).click()
  await expect(active.locator('.download-ready')).toBeVisible()
  const download = await page.request.get((await active.locator('.download-ready').getAttribute('href'))!)
  expect(download.ok()).toBe(true)
  expect((await download.body()).subarray(0, 2).toString()).toBe('PK')
  await active.locator('.export-control summary').click()
  await open(page, id)
  await expect(title).toContainText('EDITED')
  await expect(title).toHaveCSS('text-align', 'center')
  await expect(title.locator('span').last()).toHaveCSS('color', 'rgb(40, 87, 164)')
  await active.getByRole('button', {name:'修订历史', exact:true}).first().click()
  await active.locator('.history button[data-revision="0"]').click()
  const historical = active.locator('.revision-paper .hcd-editor-body > p').first()
  await expect(historical).not.toContainText('EDITED')
  await expect(historical).toHaveAttribute('data-word-presentation', 'true')
  await expect(historical).toHaveCSS('text-align', 'center')
  await expect(historical.locator('span').last()).toHaveCSS('font-size', '32px')
  await active.getByRole('button', {name:'对比当前', exact:true}).click()
  await expect(active.locator('.revision-paper')).toHaveCount(2)
  await expect(active.locator('.diff-text-added')).toContainText('EDITED')
  await page.screenshot({path:info.outputPath('word-presentation-comparison.png')})
})

test('Word read access paginates saved Unicode content, sections, running regions and table rows', async ({page}, info) => {
  const id = 'word-pages', headers = {Authorization:`Bearer ${token('word-pages','pages-reader')}`}
  const get = async (path = '') => (await fetch(`${apiUrl}/v1/documents/${id}${path}`, {headers})).json()
  await open(page, id)
  const active = page.locator('.document-tab-panel:not([hidden])')
  const title = active.locator('main.document .hcd-editor-body > p').first()
  await expect(title).toHaveAttribute('data-word-presentation','true')
  // Capture a baseline after the collaboration projection is established.
  const before = await get()
  await title.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' DRAFT 🙂 <script>window.injected=true</script>')
  await reopenWithScope(page, 'read')
  const iframe = active.locator('.word-page-preview iframe'), body = iframe.contentFrame().locator('body')
  await expect(body).toHaveAttribute('data-hcd-page-count', /^\d+$/)
  const pages = body.locator('.hcd-virtual-page')
  expect(await pages.count()).toBeGreaterThan(4)
  await expect(pages.first()).toContainText('COVER END')
  await expect(pages.first()).not.toContainText('SECOND PAGE START')
  await expect(pages.nth(1)).toContainText('SECOND PAGE START')
  await expect(pages.first().locator('.hcd-page-header')).toHaveText('FIRST HEADER')
  await expect(pages.nth(1).locator('.hcd-page-header')).toHaveText('EVEN HEADER')
  await expect(pages.nth(2).locator('.hcd-page-header')).toHaveText('DEFAULT HEADER')
  const metrics = await body.evaluate(element => {
    const pages = [...element.querySelectorAll<HTMLElement>('.hcd-virtual-page')]
    const rows = [...element.querySelectorAll('.hcd-virtual-page-content tr')].filter(row=>!row.closest('[data-hcd-repeat]'))
    return { dimensions:pages.map(page=>[page.dataset.hcdSection,page.getBoundingClientRect().width,page.getBoundingClientRect().height]),
      cells: rows.reduce((sum,row)=>sum+row.querySelectorAll('td').length,0),
      longText:[...element.querySelectorAll('.hcd-virtual-page-content p')].filter(p=>p.textContent?.includes('Unicode')||p.hasAttribute('data-hcd-continuation')).map(p=>p.textContent).join(''),
      rowLabels:rows.map(row=>row.textContent),
      overflow:pages.filter(page=>page.dataset.hcdPageOverflow).length,
      fields:[...element.querySelectorAll('[data-hcd-field]')].map(field=>({kind:field.getAttribute('data-hcd-field'),value:field.textContent,page:field.closest('[data-hcd-page-number]')?.getAttribute('data-hcd-page-number')})),
      merged:[...element.querySelectorAll<HTMLTableCellElement>('td[rowspan]')].filter(cell=>cell.rowSpan===2).map(cell=>cell.closest('tr')?.nextElementSibling?.textContent),
      injected:!!(window as unknown as {injected?:boolean}).injected, error:element.dataset.hcdPaginationError }
  })
  expect(metrics.dimensions[0][1]).toBeCloseTo(400,0)
  expect(metrics.dimensions[0][2]).toBeCloseTo(533.33,0)
  const landscape = metrics.dimensions.find(([section])=>section==='1')!
  expect(landscape[1]).toBeCloseTo(533.33,0); expect(landscape[2]).toBeCloseTo(400,0)
  expect(metrics.cells).toBe(62)
  expect(await body.locator('[data-hcd-repeat="table-header"]').count()).toBeGreaterThan(0)
  expect(metrics.rowLabels).toHaveLength(31)
  for(let index=0;index<31;index++) expect(metrics.rowLabels[index]).toContain(`Value ${String(index).padStart(2,'0')}`)
  expect(metrics.longText).toBe(('Unicode 🙂 paragraph keeps every character. '.repeat(120)).trim())
  expect(metrics.merged).toEqual(['Value 03'])
  expect(metrics.overflow).toBe(0); expect(metrics.error).toBeUndefined(); expect(metrics.injected).toBe(false)
  expect(metrics.fields.length).toBe((await pages.count())*2)
  for(const field of metrics.fields) expect(field.value).toBe(field.kind==='NUMPAGES'?String(await pages.count()):field.page)
  await expect(body).toContainText('DRAFT 🙂 <script>window.injected=true</script>')
  expect((await get()).revision).toBeGreaterThan(before.revision)
  await page.screenshot({path:info.outputPath('word-paginated-cover.png')})
  await reopenWithScope(page, 'write')
  await expect(title).toContainText('DRAFT 🙂')
  await active.getByRole('button',{name:'保存点',exact:true}).click()
  await expect.poll(async()=> (await get('/editor')).blocks[0].content.inlines.map((run:{text:string})=>run.text).join('')).toContain('DRAFT 🙂')
  await open(page,id)
  await expect(title).toContainText('DRAFT 🙂')
  await reopenWithScope(page, 'read')
  await expect(body).toHaveAttribute('data-hcd-page-count', /^\d+$/)
  await expect(body.locator('.hcd-page-header').first()).toHaveText('FIRST HEADER')
  const download = await page.request.get(`${apiUrl}/v1/documents/${id}/export/docx?source=true`,{headers})
  expect(download.ok()).toBe(true)
})

test('Word source grids preserve font metrics, opt-outs, fixed lines and header anchors', async ({page}, info) => {
  await open(page,'word-grid')
  const active = page.locator('.document-tab-panel:not([hidden])')
  const editing = active.locator('main.document .hcd-editor-body > p').filter({hasText:'GRID SINGLE'})
  await expect(editing).toHaveAttribute('data-word-presentation','true')
  await expect(editing).toHaveCSS('line-height','27.2px')
  const running = active.locator('.word-running-header iframe').contentFrame()
  const runningImage = running.locator('img[data-hcd-running-drawing="header"]')
  await expect(runningImage).toHaveAttribute('data-hcd-anchor-constrained','true')
  await expect.poll(()=>runningImage.evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBe(64)
  const ink = await runningImage.evaluate(image=>{const page=image.closest('.word-running-page')!.getBoundingClientRect(),rect=image.getBoundingClientRect();return{top:rect.top-page.top+16,bottom:rect.top-page.top+48,left:rect.left-page.left}})
  expect(ink.left).toBe(0); expect(ink.top).toBeGreaterThanOrEqual(0); expect(ink.bottom).toBeLessThan(60)
  await reopenWithScope(page, 'read')
  const body = active.locator('.word-page-preview iframe').contentFrame().locator('body')
  await expect(body).toHaveAttribute('data-hcd-page-count','3')
  const paragraph = (text:string) => body.locator('.hcd-virtual-page-content p').filter({hasText:new RegExp(`^${text}$`)})
  for(const text of ['GRID SINGLE','GRID MINIMUM','GRID INHERITED AUTO','CELL GRID']) await expect(paragraph(text)).toHaveCSS('line-height','27.2px')
  await expect(paragraph('GRID EXACT')).toHaveCSS('line-height','8px')
  for(const text of ['GRID OFF','GRID INHERITED OFF','CELL NATURAL','GRID DISABLED']) await expect(paragraph(text)).not.toHaveAttribute('data-hcd-grid-line',/.+/)
  await expect(paragraph('GRID LARGE')).toHaveCSS('line-height','54.4px')
  await expect(paragraph('GRID SECOND')).toHaveCSS('line-height','24px')
  const first = body.locator('.hcd-virtual-page').first(), drawing = first.locator('[data-hcd-running-drawing="header"]')
  await expect(drawing).toHaveAttribute('data-hcd-anchor-constrained','true')
  await expect(first.locator('.hcd-page-header p')).not.toHaveClass(/hcd-empty-paragraph/)
  await expect(first.locator('.hcd-page-header p')).toHaveCSS('font-size','12px')
  const bounds = await drawing.evaluate(image=>{const paper=image.closest('.hcd-virtual-page')!.getBoundingClientRect(),r=image.getBoundingClientRect();return{top:r.top-paper.top,inkTop:r.top-paper.top+16,inkBottom:r.top-paper.top+48}})
  expect(bounds.top).toBeGreaterThan(-40); expect(bounds.inkTop).toBeGreaterThanOrEqual(0); expect(bounds.inkBottom).toBeLessThan(60)
  await page.screenshot({path:info.outputPath('word-grid-layout.png')})
})

test('Word agents locate visible paginated content across sections and keep moving cursors', async ({page}, info) => {
  const id = 'word-page-agents'
  await open(page,id,'read')
  const active = page.locator('.document-tab-panel:not([hidden])')
  const body = active.locator('.word-page-preview iframe').contentFrame().locator('body')
  await expect(body).toHaveAttribute('data-hcd-page-count', /^\d+$/)
  const a = await agent(id,'Pages Agent A'), b = await agent(id,'Pages Agent B')
  try {
    const projection = (await call(a,'hcd_read',{document_id:id,resource:'editor'})).data
    const auth = (await call(a,'hcd_read',{document_id:id,resource:'auth'})).data
    const blocks = projection.blocks.filter((block:{region:string;readOnly:boolean})=>block.region==='body'&&!block.readOnly)
    const focus = (blockId:string)=>({document_id:id,status:'reading',block_id:blockId,expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch})
    expect((await call(a,'hcd_activity',focus(blocks[0].blockId))).error).toBe(false)
    await expect(active.locator('[data-agent-id="Pages Agent A"]')).toBeVisible()
    const target = blocks.find((block:{content:{inlines:Array<{text:string}>}})=>block.content.inlines.some(run=>run.text==='LANDSCAPE START'))
    expect((await call(b,'hcd_activity',focus(target.blockId))).error).toBe(false)
    await active.locator('.agent-collaborators > summary').click()
    const card = active.locator('.agent-activity').filter({hasText:'Pages Agent B'})
    await card.getByRole('button',{name:'定位到内容',exact:true}).click()
    await expect(active.locator('[data-agent-id="Pages Agent B"]')).toBeVisible()
    const focused = body.locator(`[data-hcd-block-id="${target.blockId}"]`)
    const frameBox = (await active.locator('.word-page-preview iframe').boundingBox())!, targetBox = (await focused.boundingBox())!
    expect(targetBox.y).toBeGreaterThan(frameBox.y+400)
    await expect.poll(async()=>Math.abs((await active.locator('[data-agent-id="Pages Agent B"]').boundingBox())!.y-(await focused.boundingBox())!.y)).toBeLessThan(2)
    expect((await call(a,'hcd_activity',focus(target.blockId))).error).toBe(false)
    await expect(active.locator('.agent-cursor')).toHaveCount(2)
    await active.getByRole('button',{name:'放大文档',exact:true}).click()
    await card.getByRole('button',{name:'定位到内容',exact:true}).click()
    await expect(active.locator('[data-agent-id="Pages Agent A"]')).toBeVisible()
    // Use DOM coordinates across the frame: CDP boundingBox divides parent
    // offsets by the iframe's effective DPR when an ancestor has CSS zoom.
    await expect.poll(async()=>{
      const targetY = await focused.evaluate(element=>{const f=window.frameElement as HTMLIFrameElement;return f.getBoundingClientRect().top+element.getBoundingClientRect().top*f.getBoundingClientRect().height/f.offsetHeight})
      return Math.abs((await active.locator('[data-agent-id="Pages Agent A"]').boundingBox())!.y-targetY)
    }).toBeLessThan(2)
    const header = projection.blocks.find((block:{region:string;content:{inlines:Array<{text:string;nodeId:string}>}})=>block.region==='header'&&block.content.inlines.some(run=>run.text==='DEFAULT HEADER'))
    const headerNode = header.content.inlines.find((run:{text:string})=>run.text==='DEFAULT HEADER')
    expect((await call(b,'hcd_activity',{document_id:id,status:'reading',node_id:headerNode.nodeId,expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch})).error).toBe(false)
    const runningHeader = body.locator(`.hcd-virtual-page[data-hcd-section="1"] [data-hcd-origin-id="${headerNode.nodeId}"]`)
    await expect.poll(async()=>{
      const y = await runningHeader.evaluate(element=>{const f=window.frameElement as HTMLIFrameElement;return f.getBoundingClientRect().top+element.getBoundingClientRect().top*f.getBoundingClientRect().height/f.offsetHeight})
      return Math.abs((await active.locator('[data-agent-id="Pages Agent B"]').boundingBox())!.y-y)
    }).toBeLessThan(2)
    await page.screenshot({path:info.outputPath('word-paginated-agents.png')})
  } finally { await a.close(); await b.close() }
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
  await page.locator('.hcd-editor-body').evaluate(element => { (window as any).__stableSemantic = {editor:element, second:element.lastElementChild} })
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
      expect(await page.locator('.hcd-editor-body').evaluate(element => element === (window as any).__stableSemantic.editor && element.lastElementChild === (window as any).__stableSemantic.second)).toBe(true)
    }
    await page.screenshot({path:info.outputPath('semantic-agent-committed.png')})
  } finally { await client.close() }
})

test('a clean semantic epoch keeps the editor writable and undo local to the new room', async ({page}) => {
  const id='local-edit-text'
  await open(page,id)
  const body=page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable','true')
  await body.evaluate(element=>{(window as any).__editableRoot=element})
  const client=await agent(id,'Incremental text agent')
  try {
    const projection=(await call(client,'hcd_read',{document_id:id,resource:'editor'})).data
    const auth=(await call(client,'hcd_read',{document_id:id,resource:'auth'})).data
    const block=projection.blocks.find((block:any)=>block.region==='body'&&!block.readOnly)
    const result=await call(client,'hcd_patch',{document_id:id,mode:'structure',expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch,patch:{schemaVersion:'hcd-patch/4',documentId:id,patchId:'clean-room-edit',baseRevision:projection.revision,operations:[{op:'block.replace',blockId:block.blockId,block:{...block.content,inlines:[{text:'REMOTE_CANONICAL'}]},precondition:{blockHash:block.blockHash}}]}})
    expect(result.error).toBe(false)
    await expect(body).toContainText('REMOTE_CANONICAL')
    await expect(body).toHaveAttribute('contenteditable','true')
    expect(await body.evaluate(element=>element===(window as any).__editableRoot)).toBe(true)
    await body.locator('p').last().click(); await page.keyboard.press('End'); await page.keyboard.insertText(' LOCAL_AFTER_EPOCH')
    await expect(body).toContainText('LOCAL_AFTER_EPOCH')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(body).not.toContainText('LOCAL_AFTER_EPOCH')
    await expect(body).toContainText('REMOTE_CANONICAL')
    await page.keyboard.insertText(' SAVED_AFTER_EPOCH')
    await page.getByRole('button',{name:'保存点',exact:true}).click()
    await expect.poll(async()=>JSON.stringify((await call(client,'hcd_read',{document_id:id,resource:'editor'})).data)).toContain('SAVED_AFTER_EPOCH')
  } finally {await client.close()}
})

test('Word remote edits patch paginated nodes without navigating or resetting scroll', async ({page},info) => {
  const id='word-local'
  await open(page,id,'read')
  const iframe=page.locator('.word-page-preview iframe'), body=iframe.contentFrame().locator('body'), viewport=page.locator('.canvas-viewport')
  await expect(body).toHaveAttribute('data-hcd-page-count',/^\d+$/)
  await viewport.evaluate(element=>{element.scrollTop=750})
  const top=await viewport.evaluate(element=>element.scrollTop)
  expect(top).toBeGreaterThan(500)
  await iframe.evaluate((element:HTMLIFrameElement)=>{
    const doc=element.contentDocument!
    ;(window as any).__wordRetained={frame:element,doc,nodes:[...doc.querySelectorAll('[data-hcd-id],img,.hcd-virtual-page')],loads:0}
    element.addEventListener('load',()=>{(window as any).__wordRetained.loads++})
  })
  const client=await agent(id,'Word local patch agent')
  try {
    for(const marker of [' WORD_LOCAL_ONE',' WORD_LOCAL_TWO']) {
      const projection=(await call(client,'hcd_read',{document_id:id,resource:'editor'})).data
      const auth=(await call(client,'hcd_read',{document_id:id,resource:'auth'})).data
      const block=projection.blocks.find((block:any)=>block.region==='body'&&!block.readOnly&&block.content.inlines.some((run:any)=>run.nodeId&&run.text))
      const run=block.content.inlines.find((run:any)=>run.nodeId&&run.text)
      const node=(await call(client,'hcd_read',{document_id:id,resource:'node',node_id:run.nodeId})).data
      const result=await call(client,'hcd_patch',{document_id:id,mode:'node',expected_revision:node.revision,collaboration_epoch:auth.collaborationEpoch,patch:{schemaVersion:'hcd-patch/1',documentId:id,patchId:marker.trim(),baseRevision:node.revision,operations:[{op:'text.splice',nodeId:node.nodeId,start:[...node.text].length,deleteCount:0,insertText:marker,precondition:{nodeHash:node.nodeHash}}]}})
      expect(result.error).toBe(false)
      await expect(body).toContainText(marker)
      expect(Math.abs(await viewport.evaluate(element=>element.scrollTop)-top)).toBeLessThan(2)
      expect(await iframe.evaluate((element:HTMLIFrameElement)=>{
        const saved=(window as any).__wordRetained
        return {frame:saved.frame===element,doc:saved.doc===element.contentDocument,nodes:saved.nodes.every((node:Node)=>node.isConnected),loads:saved.loads}
      })).toEqual({frame:true,doc:true,nodes:true,loads:0})
    }
    await page.screenshot({path:info.outputPath('word-local-update-scrolled.png')})
  } finally {await client.close()}
})

test('workspace drawers, focus mode and export preserve document state', async ({ page }, info) => {
  await open(page, 'ui-text')
  const active = page.locator('.document-tab-panel:not([hidden])')
  const body = active.locator('.hcd-editor-body')
  await expect(body).toContainText('First paragraph ui-text')
  await active.getByRole('button', { name: '收起左侧面板', exact: true }).click()
  await active.getByRole('button', { name: '收起协作面板', exact: true }).click()
  await expect(active.locator('.panel-dock')).toHaveCount(0)
  const collapsedShell = await active.locator('.content-shell').boundingBox(), layout = await active.locator('.editor-layout').boundingBox()
  const rails = await active.locator('.workspace-panel-controls:visible').evaluateAll(items => items.reduce((width, element) => width + element.getBoundingClientRect().width, 0))
  expect(Math.abs(collapsedShell!.width + rails + 2 * 10 - layout!.width)).toBeLessThan(3)
  await active.getByRole('button', { name: '收起工具栏', exact: true }).click()
  await active.getByRole('button', { name: '专注模式', exact: true }).click()
  await expect(active.locator('.content-toolbar')).toHaveCount(0)
  await expect(active.locator('.editor-header')).toBeVisible()
  await page.screenshot({ path: info.outputPath('focus-mode.png') })
  await active.getByRole('button', { name: '退出专注模式', exact: true }).click()
  await expect(active.getByRole('button', { name: '展开工具栏', exact: true })).toBeVisible()
  await active.getByRole('button', { name: '展开左侧栏', exact: true }).click()
  await expect(active.locator('.outline-panel')).toBeVisible()
  await body.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' PREVIEW_PRESERVED')
  await expect(active.locator('.mode-switch')).toHaveCount(0)
  await expect(body).toHaveAttribute('contenteditable', 'true')
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
  await expect(active.locator('.mode-switch')).toHaveCount(0)
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await expect(active.getByRole('button', { name: '展开工具栏', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('restored-workspace.png') })
})

test('workbook permissions are explicit and panel actions preserve an unapplied formula', async ({ page }) => {
  await open(page, 'ui-grid')
  const active = page.locator('.document-tab-panel:not([hidden])')
  const canvas = active.locator('canvas:visible').first()
  await expect(canvas).toBeVisible()
  await canvas.evaluate(element => { (window as unknown as { originalGrid: Element }).originalGrid = element })
  await expect(active.locator('[data-document-scope]')).toHaveAttribute('data-document-scope', 'write')
  await expect(active.locator('.mode-switch')).toHaveCount(0)
  await active.locator('.xlsx-formula-bar input').fill('UNAPPLIED_FORMULA_DRAFT')
  await active.getByRole('button',{name:'界面设置',exact:true}).click()
  await expect(active.locator('.xlsx-formula-bar input')).toBeEnabled()
  await expect(active.locator('.xlsx-formula-bar input')).toHaveValue('UNAPPLIED_FORMULA_DRAFT')
  expect(await canvas.evaluate(element => (window as unknown as { originalGrid: Element }).originalGrid === element)).toBe(true)
})

test('all seven formats use the content shell and enforce read-only preview', async ({ page }, info) => {
  for (const [id, format, content] of [
    ['complex-word', 'docx', '.word-page-preview iframe'], ['ui-grid', 'xlsx', 'canvas:visible'],
    ['agents-slides', 'pptx', 'iframe'], ['ui-pdf', 'pdf', 'iframe'],
    ['ui-markdown', 'md', '.hcd-editor-body'], ['ui-html', 'html', '.hcd-editor-body'],
    ['ui-text', 'txt', '.hcd-editor-body'],
  ]) {
    await open(page, id, 'read')
    const active = page.locator('.document-tab-panel:not([hidden])')
    await expect(active.locator(content).first()).toBeVisible()
    await expect(active.locator('[data-document-scope]')).toHaveAttribute('data-document-scope', 'read')
    await expect(active.locator('.mode-switch')).toHaveCount(0)
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
  await expect(active.locator('.outline-panel')).toBeHidden()
  await expect(active.locator('.agent-activity-panel')).toBeHidden()
  await active.getByRole('button', { name: '展开左侧栏', exact: true }).click()
  await expect(active.locator('.outline-panel')).toBeVisible()
  await active.getByRole('button', { name: '收起左侧面板', exact: true }).click()
  await active.getByRole('button', { name: '展开右侧栏', exact: true }).click()
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
    if(format==='pptx'||format==='pdf'||format==='docx') {
      const frame=active.locator(format==='docx'?'.word-page-preview iframe':'.fixed-page iframe').first();await expect(frame).toBeVisible()
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
  const hideOutline=page.getByRole('button',{name:'收起左侧面板',exact:true})
  if (await hideOutline.isVisible()) await hideOutline.click()
  await expect(page.locator('.outline-panel')).toBeHidden()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  expect(await workspace.locator('.revision-columns').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(1)
  await page.screenshot({path:info.outputPath('phone-revision-compare.png')})
})

test('agent commits preserve preview, focus, zoom and the selected historical comparison', async ({page},info) => {
  const id='view-state'
  await open(page,id)
  const active=page.locator('.document-tab-panel:not([hidden])')
  await expect(active.locator('.hcd-editor-body')).toContainText('First paragraph')
  const client=await agent(id,'View State Agent')
  try {
    const initial=(await call(client,'hcd_read',{document_id:id,resource:'editor'})).data
    await reopenWithScope(page, 'read')
    await active.getByRole('button',{name:'放大文档',exact:true}).click({clickCount:3})
    await expect(active.locator('.canvas-viewport')).toHaveAttribute('data-canvas-zoom','1.3')
    await active.getByRole('button',{name:'专注模式',exact:true}).click()
    const apply=async(label:string)=>{
      const projection=(await call(client,'hcd_read',{document_id:id,resource:'editor'})).data
      const auth=(await call(client,'hcd_read',{document_id:id,resource:'auth'})).data
      const block=projection.blocks.find((block:{region:string;readOnly:boolean})=>block.region==='body'&&!block.readOnly)
      const result=await call(client,'hcd_patch',{document_id:id,mode:'structure',expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch,patch:{schemaVersion:'hcd-patch/4',documentId:id,patchId:label.replaceAll(' ','-'),baseRevision:projection.revision,operations:[{op:'block.replace',blockId:block.blockId,block:{...block.content,inlines:[{text:label}]},precondition:{blockHash:block.blockHash}}]}})
      expect(result.error).toBe(false)
    }
    await apply('First remote view update')
    await expect(active.locator('.hcd-editor-body')).toContainText('First remote view update')
    await expect(active.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','false')
    await expect(active.locator('.workspace')).toHaveClass(/focus-mode/)
    await expect(active.locator('.canvas-viewport')).toHaveAttribute('data-canvas-zoom','1.3')
    await expect(active.locator('.mode-switch')).toHaveCount(0)
    await active.getByRole('button',{name:'退出专注模式',exact:true}).click()
    await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
    await active.locator(`.history button[data-revision="${initial.revision}"]`).click()
    await active.locator('.revision-workspace').getByRole('button',{name:'对比当前',exact:true}).click()
    await expect(active.locator('.revision-column').last()).toContainText('First remote view update')
    await apply('Second remote view update')
    await expect(active.locator('.revision-column').last()).toContainText('Second remote view update')
    await expect(active.locator('.revision-column').first()).toContainText('First paragraph')
    await expect(active.locator('.revision-scroll')).toHaveAttribute('data-canvas-zoom','1.3')
    await expect(active.locator(`.history button[data-revision="${initial.revision}"]`)).toHaveAttribute('aria-pressed','true')
    await page.screenshot({path:info.outputPath('comparison-after-agent-commit.png')})
    await active.locator('.revision-workspace').getByRole('button',{name:'返回当前',exact:true}).click()
    await expect(active.locator('main.document .hcd-editor-body')).toHaveAttribute('contenteditable','false')
    await expect(active.locator('main.document .hcd-editor-body')).toContainText('Second remote view update')
    await expect(active.locator('.canvas-viewport')).toHaveAttribute('data-canvas-zoom','1.3')
  } finally {await client.close()}
})

test('history uses the selected outline and closes the mobile drawer after selection', async ({page},info) => {
  const id='history-outline',headers={Authorization:`Bearer ${token(id,'outline-author')}`}
  const get=async(path:string)=>(await fetch(`${apiUrl}/v1/documents/${id}${path}`,{headers})).json()
  const imported=await get('/editor')
  const projected=await fetch(`${apiUrl}/v1/documents/${id}/project`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:imported.revision})})
  expect(projected.ok,await projected.text()).toBe(true)
  const baseline=await get('/editor'),auth=await get('/auth')
  const blocks=baseline.blocks.filter((block:{region:string})=>block.region==='body').map((block:{blockId:string;content:{kind:string}})=>({blockId:block.blockId,content:block.content.kind==='heading'?{...block.content,inlines:[{text:'Updated current heading'}]}:block.content}))
  const saved=await fetch(`${apiUrl}/v1/documents/${id}/checkpoints`,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-HCD-Collaboration-Epoch':String(auth.collaborationEpoch)},body:JSON.stringify({expectedRevision:baseline.revision,blocks})})
  expect(saved.ok,await saved.text()).toBe(true)
  await open(page,id,'read')
  const active=page.locator('.document-tab-panel:not([hidden])')
  await expect(active.locator('.outline-panel nav')).toContainText('Updated current heading')
  await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  await active.locator(`.history button[data-revision="${baseline.revision}"]`).click()
  await expect(active.locator('.outline-panel nav')).toContainText('Markdown workspace')
  await expect(active.locator('.outline-panel nav')).not.toContainText('Updated current heading')
  await active.locator('.outline-panel nav').getByRole('button',{name:'Markdown workspace',exact:true}).click()
  await expect(active.locator('.revision-paper .history-search-hit')).toContainText('Markdown workspace')
  await expect(active.locator('.revision-preview-title')).toContainText('outline-author')
  await active.locator('.revision-workspace').getByRole('button',{name:'返回当前',exact:true}).click()
  await expect(active.locator('.outline-panel nav')).toContainText('Updated current heading')
  await active.getByRole('button',{name:'收起左侧面板',exact:true}).click()
  await page.setViewportSize({width:390,height:844})
  await active.locator(`.history button[data-revision="${baseline.revision}"]`).click()
  await expect(active.locator('.workspace-sidebar:visible')).toHaveCount(0)
  await expect(active.locator('.revision-paper')).toContainText('Markdown workspace')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.screenshot({path:info.outputPath('phone-history-selection.png')})
})


test('grid input journal keeps unapplied text bound to its cell across selections and page closure', async ({page, context, request}, info) => {
  const id = 'grid-draft-reopen', expression = '=SUM(B1:B2)*2'
  const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  await open(page, id)
  const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  const field = page.getByLabel('单元格内容或公式', { exact: true })
  await expect(field).toHaveValue('=LEN("中文")')
  await context.setOffline(true)
  await field.fill(expression)
  await canvas.click({ position: { x: 144, y: 30 } })
  await expect(field).toHaveValue(expression)
  await expect(page.getByLabel('未应用输入位置', { exact: true })).toHaveText('Sheet1!A1')
  expect((await field.boundingBox())!.width).toBeGreaterThan(150)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.close({ runBeforeUnload: false }); await context.setOffline(false)
  const reopened = await context.newPage()
  await open(reopened, id)
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  await retained.locator('summary').click()
  const restoredCanvas = reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(restoredCanvas).toBeVisible()
  await restoredCanvas.evaluate(element => { (window as any).__restoredGridCanvas = element })
  await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  const restored = reopened.getByLabel('单元格内容或公式', { exact: true })
  await expect(restored).toHaveValue(expression)
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
  await reopened.screenshot({ path: info.outputPath('grid-unapplied-recovered.png') })
  await reopened.getByRole('button', { name: '应用内容', exact: true }).click()
  await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(1)
  await expect(reopened.getByLabel('未应用输入位置', { exact: true })).toHaveCount(0)
  expect(await restoredCanvas.evaluate(element => (window as any).__restoredGridCanvas === element)).toBe(true)
  await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await reopened.reload()
  await expect(reopened.getByLabel('单元格内容或公式', { exact: true })).toHaveValue(expression)
  await expect(reopened.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0)
})

test('grid input journal protects native cell typing before confirmation and restores it into the formula field', async ({page, context, request}) => {
  const id = 'grid-draft-cell', marker = 'NATIVE_UNCONFIRMED_INPUT'
  await open(page, id)
  const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible()
  await canvas.dblclick({ position: { x: 144, y: 30 } })
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(marker)
  await expect(page.getByLabel('单元格内容或公式', { exact: true })).toHaveValue(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.close({ runBeforeUnload: false })
  const reopened = await context.newPage()
  await open(reopened, id)
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  await retained.locator('summary').click()
  await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  await expect(reopened.getByLabel('单元格内容或公式', { exact: true })).toHaveValue(marker)
  await expect(reopened.getByLabel('未应用输入位置', { exact: true })).toContainText('!B1')
  const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
  await reopened.getByRole('button', { name: '取消输入', exact: true }).click()
  await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await reopened.reload()
  const refreshedCanvas = reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(refreshedCanvas).toBeVisible()
  await expect(reopened.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0)
  await refreshedCanvas.dblclick({ position: { x: 144, y: 30 } })
  await reopened.keyboard.press('ControlOrMeta+A'); await reopened.keyboard.insertText('7')
  await reopened.keyboard.press('Enter')
  await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(1)
  await expect(reopened.getByLabel('未应用输入位置', { exact: true })).toHaveCount(0)
  await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await reopened.reload()
  await expect(reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()).toBeVisible()
  await expect(reopened.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0)
})

test('grid input journal leaves changed workbooks untouched and retains the original expression', async ({page, context, request}) => {
  const id = 'grid-draft-stale', marker = '=SUM(B1:B2)*2'
  const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  await open(page, id)
  await expect(page.getByLabel('单元格内容或公式', { exact: true })).toHaveValue('=LEN("中文")')
  await page.getByLabel('单元格内容或公式', { exact: true }).fill(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.close({ runBeforeUnload: false })
  const sheet = await (await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`, { headers })).json()
  const node = sheet.cells.find((cell: { address: string }) => cell.address === 'B1')
  const saved = await request.post(`${apiUrl}/v1/documents/${id}/node-patch`, { headers, data: {
    schemaVersion: 'hcd-patch/29', documentId: id, patchId: 'remote-before-draft-recovery', baseRevision: 0,
    operations: [{ op: 'xlsx.number.set', nodeId: node.nodeId, sheetId: sheet.sheetId, value: '9', precondition: { nodeHash: node.nodeHash } }],
  } })
  expect(saved.ok(), await saved.text()).toBe(true)
  const reopened = await context.newPage()
  await open(reopened, id)
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  await retained.locator('summary').click()
  await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  await expect(reopened.locator('.toast.error')).toContainText('文档版本已变化')
  await expect(retained.getByRole('textbox')).toContainText(marker)
  await expect(reopened.getByLabel('单元格内容或公式', { exact: true })).toHaveValue('=LEN("中文")')
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(1)
})

test('fixed input journal restores closed offline text once without submitting it or rebuilding its canvas', async ({page, context, request}, info) => {
  const id = 'fixed-draft-reopen', marker = 'CLOSED_FIXED_INPUT_🙂'
  await open(page, id)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.locator('.fixed-page-hitbox').first().click()
  const text = page.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })
  await context.setOffline(true)
  await text.fill(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.close({ runBeforeUnload: false }); await context.setOffline(false)
  const reopened = await context.newPage()
  await open(reopened, id)
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  await expect(retained).toHaveCount(1)
  await retained.locator('summary').click()
  await expect(retained.getByRole('textbox')).toContainText(marker)
  const frame = reopened.locator('.fixed-pages iframe').first()
  await expect(frame).toBeVisible()
  await frame.evaluate(element => { (window as any).__fixedDraftFrame = element })
  let patches = 0
  reopened.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/node-patch')) patches++ })
  await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  const restored = frame.contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })
  await expect(restored).toHaveText(marker)
  expect(patches).toBe(0)
  expect(await frame.evaluate(element => (window as any).__fixedDraftFrame === element)).toBe(true)
  const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
  await reopened.screenshot({ path: info.outputPath('fixed-text-recovered-input.png') })
  await restored.press('ControlOrMeta+Enter')
  await expect(restored).toHaveCount(0)
  await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  expect(patches).toBe(1)
  await reopened.reload()
  await expect(reopened.locator('.fixed-pages iframe').first().contentFrame().locator('body')).toContainText(marker)
  await expect(reopened.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0)
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(1)
})

test('fixed input journal quarantines a changed collaboration epoch and keeps the old input downloadable', async ({page, context, request}) => {
  const id = 'fixed-draft-stale', marker = 'STALE_FIXED_INPUT'
  await open(page, id)
  await page.locator('.fixed-page-hitbox').first().click()
  const initial = page.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })
  await initial.fill('COMMITTED_BASELINE'); await initial.press('ControlOrMeta+Enter')
  await expect(initial).toHaveCount(0)
  await page.locator('.fixed-page-hitbox').first().click()
  await page.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true }).fill(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.close({ runBeforeUnload: false })
  const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}`, 'Content-Type': 'application/json' }
  const restored = await request.post(`${apiUrl}/v1/documents/${id}/restore/0`, { headers, data: { expectedRevision: 1 } })
  expect(restored.ok(), await restored.text()).toBe(true)
  const reopened = await context.newPage()
  await open(reopened, id)
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  await retained.locator('summary').click()
  await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  await expect(reopened.locator('.toast.error')).toContainText('版本已变化')
  await expect(retained).toBeVisible()
  await expect(reopened.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })).toHaveCount(0)
  const download = reopened.waitForEvent('download')
  await retained.getByRole('button', { name: '下载本地草稿', exact: true }).click()
  expect((await download).suggestedFilename()).toBe(`${id}-input-draft.json`)
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(2)
})

for (const format of ['pdf', 'pptx']) test(`fixed input journal restores a new ${format} text box with its original placement`, async ({page, context, request}, info) => {
  const id = `fixed-draft-new-${format}`, marker = `UNCOMMITTED_NEW_${format.toUpperCase()}`
  await open(page, id)
  await page.getByRole('button', { name: '插入', exact: true }).first().click()
  await page.getByRole('button', { name: '新增文字框', exact: true }).click()
  await page.locator('.fixed-placement-layer').first().click({ position: { x: 80, y: 100 } })
  const text = page.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })
  await text.fill(marker)
  const before = await text.boundingBox()
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await page.close({ runBeforeUnload: false })
  const reopened = await context.newPage()
  await open(reopened, id)
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  await retained.locator('summary').click()
  await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  const restored = reopened.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })
  await expect(restored).toHaveText(marker)
  const after = await restored.boundingBox()
  expect(after?.width).toBeCloseTo(before!.width, 0)
  expect(after?.height).toBeCloseTo(before!.height, 0)
  const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
  await reopened.screenshot({ path: info.outputPath(`${format}-placement-recovered.png`) })
  // Explicit cancellation retires the local stream without creating an object.
  await restored.press('Escape')
  await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  await reopened.reload()
  await expect(reopened.locator('.fixed-pages iframe').first()).toBeVisible()
  await expect(reopened.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0)
  expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
})

test('fixed input journal failures warn before close and keep entered text editable', async ({page}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'drafts' && this.transaction.db.name === 'hcd-input-drafts-v1') throw new DOMException('Simulated draft quota', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await open(page, 'fixed-draft-error')
  await page.locator('.fixed-page-hitbox').first().click()
  const text = page.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })
  await text.fill('STORAGE_FAILED_INPUT')
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'failed')
  await expect(page.getByRole('alert', { name: '本地草稿保护不可用' })).toBeVisible()
  await expect(text).toHaveText('STORAGE_FAILED_INPUT')
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(true)
  await text.press('ControlOrMeta+Enter')
  await expect(text).toHaveCount(0)
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(false)
})

test('fixed input journal survives browser SIGKILL and requires explicit saving after recovery', async ({request}, info) => {
  const id = 'fixed-draft-crash', marker = 'KILLED_FIXED_BROWSER_🙂', profile = resolve(root, 'fixed-input-crash-profile')
  const launch = async () => {
    const port = await freePort()
    const child = start(process.env.HCD_BROWSER_PATH || chromium.executablePath(), [
      '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
    ], {})
    await ready(`http://127.0.0.1:${port}/json/version`)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    return { child, browser, context: browser.contexts()[0] }
  }
  const first = await launch(), page = await first.context.newPage()
  await open(page, id)
  await page.locator('.fixed-page-hitbox').first().click()
  await first.context.setOffline(true)
  await page.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true }).fill(marker)
  await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  const exited = new Promise<void>(resolve => first.child.once('exit', () => resolve()))
  if (process.platform !== 'win32') process.kill(-first.child.pid!, 'SIGKILL'); else first.child.kill('SIGKILL')
  await exited
  const second = await launch()
  try {
    const reopened = await second.context.newPage()
    await open(reopened, id)
    const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
    await retained.locator('summary').click()
    await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
    await expect(reopened.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })).toHaveText(marker)
    const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
    expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
    await reopened.screenshot({ path: info.outputPath('fixed-browser-crash-recovered.png') })
  } finally { await second.browser.close() }
})

test('input journal streams isolate live writers and refuse to delete a newer recovered snapshot', async ({page}) => {
  await page.goto(`${uiUrl}/?locale=zh-CN`)
  const result = await page.evaluate(async () => {
    const url = '/src/inputDraftJournal.ts'
    const { InputDraftJournal, readInputDrafts, discardInputDraft } = await import(url)
    const events: unknown[] = []
    const namespace = crypto.randomUUID()
    const writer = await InputDraftJournal.create(namespace, 'isolated', 0, (error?: unknown) => { if (error) events.push(String(error)) })
    writer.replace(JSON.stringify({ text: 'v1' })); await writer.flush()
    const live = await readInputDrafts(namespace)
    writer.dispose()
    // dispose releases its writer lock after the final transaction settles.
    let records = await readInputDrafts(namespace)
    if (!records.length) records = await readInputDrafts(namespace)
    const stale = records[0]
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('hcd-input-drafts-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite')
      tx.objectStore('drafts').put({ ...stale, version: stale.version + 1, content: JSON.stringify({ text: 'newer input' }) })
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
    let refused = false
    try { await discardInputDraft(stale) } catch { refused = true }
    const newer = await readInputDrafts(namespace)
    const other = await readInputDrafts(`${namespace}-other-user-or-service`)
    await discardInputDraft(newer[0]); db.close()
    return { live: live.length, refused, text: JSON.parse(newer[0].content).text, other: other.length, errors: events.length }
  })
  expect(result).toEqual({ live: 0, refused: true, text: 'newer input', other: 0, errors: 0 })
})

test('fixed text box initial focus preserves immediate full-text replacements', async ({page}) => {
  await open(page,'fixed-input')
  const active = page.locator('.document-tab-panel:not([hidden])')
  for (let index = 0; index < 8; index++) {
    await active.locator('.fixed-page-hitbox').first().click()
    const text = active.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox',{name:'编辑文字',exact:true})
    await text.fill(`REPLACE_🙂_${index}`)
    await expect(text).toHaveText(`REPLACE_🙂_${index}`)
    await text.press('Escape')
    await expect(text).toHaveCount(0)
  }
})

test('fixed history saves drafts, pins even the latest revision read-only and restores the live deck', async ({page},info) => {
  const id='fixed-history'
  await open(page,id)
  const active=page.locator('.document-tab-panel:not([hidden])')
  await active.locator('.fixed-page-hitbox').first().click()
  const text=active.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox',{name:'编辑文字',exact:true})
  await text.fill('PRESERVED_FIXED_DRAFT')
  await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  const patchRoute=`**/v1/documents/${id}/node-patch`
  await page.route(patchRoute, route=>route.fulfill({status:409,body:'Test conflict: draft must stay'}))
  await active.locator('.history button[data-revision="0"]').click()
  await expect(text).toHaveText('PRESERVED_FIXED_DRAFT')
  await expect(active.locator('.revision-preview-bar')).toHaveCount(0)
  await expect(active.locator('.toast.error')).toContainText('Test conflict')
  await page.unroute(patchRoute)
  await active.locator('.history button[data-revision="0"]').click()
  await expect(active.locator('.workspace')).toHaveAttribute('data-hcd-history','true')
  await expect(active.locator('.fixed-page-hitbox')).toHaveCount(0)
  await expect(active.locator('.fixed-pages iframe').first().contentFrame().locator('body')).not.toContainText('PRESERVED_FIXED_DRAFT')
  await active.locator('.revision-preview-bar').getByRole('button',{name:'返回当前',exact:true}).click()
  await expect(active.locator('.fixed-pages iframe').first().contentFrame().locator('body')).toContainText('PRESERVED_FIXED_DRAFT')
  await active.locator('.history button[data-revision="1"]').click()
  await expect(active.locator('.history button[data-revision="1"]')).toHaveAttribute('aria-pressed','true')
  await expect(active.locator('.fixed-page-hitbox')).toHaveCount(0)
  await expect(active.locator('.ribbon')).toHaveCount(0)
  await expect(active.locator('.revision-preview-title')).toContainText('browser-user')
  await active.locator('.revision-preview-bar').getByRole('button',{name:'返回当前',exact:true}).click()
  await expect(active.locator('.revision-preview-bar')).toHaveCount(0)
  await active.getByRole('button',{name:'插入',exact:true}).click()
  const before=await active.locator('.slide-card').count()
  await active.getByRole('button',{name:'新增幻灯片',exact:true}).click()
  await expect(active.locator('.slide-card')).toHaveCount(before+1)
  await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  await active.locator('.history button[data-revision="0"]').click()
  await expect(active.locator('.slide-card')).toHaveCount(before)
  await expect(active.locator('.slide-number')).toHaveCount(before)
  await page.screenshot({path:info.outputPath('pptx-history-preview.png')})
  await page.setViewportSize({width:390,height:844})
  await active.locator('.history button[data-revision="1"]').click()
  await expect(active.locator('.workspace-sidebar:visible')).toHaveCount(0)
  await expect(active.locator('.revision-preview-title')).toContainText('r1')
  await active.locator('.revision-preview-bar').getByRole('button',{name:'返回当前',exact:true}).click()
  await expect(active.locator('.outline-panel')).toBeHidden()
  await active.getByRole('button',{name:'展开左侧栏',exact:true}).click()
  await expect(active.locator('.slide-card')).toHaveCount(before+1)
  await active.getByRole('button',{name:'收起左侧面板',exact:true}).click()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('fixed snapshot failures can retry and delayed requests cannot replace the selected revision', async ({page},info) => {
  const id='fixed-history-errors'
  await open(page,id)
  const active=page.locator('.document-tab-panel:not([hidden])')
  await expect(active.locator('.fixed-pages iframe').first()).toBeVisible()
  await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  const snapshotRoute=`**/v1/documents/${id}?revision=0`
  await page.route(snapshotRoute,route=>route.fulfill({status:503,body:'Snapshot temporarily unavailable'}))
  await active.locator('.history button[data-revision="0"]').click()
  await expect(active.locator('.content-shell [role="alert"]')).toContainText('Snapshot temporarily unavailable')
  await expect(active.locator('.canvas-viewport')).toBeHidden()
  await page.unroute(snapshotRoute)
  await active.getByRole('button',{name:'重试',exact:true}).click()
  await expect(active.locator('.fixed-pages iframe').first()).toBeVisible()
  await active.locator('.revision-preview-bar').getByRole('button',{name:'返回当前',exact:true}).click()
  let release!:()=>void, started!:()=>void
  const requestStarted=new Promise<void>(resolve=>{started=resolve})
  const gate=new Promise<void>(resolve=>{release=resolve})
  await page.route(snapshotRoute,async route=>{started(); await gate; await route.continue().catch(()=>{})})
  await active.locator('.history button[data-revision="0"]').click()
  await requestStarted
  await expect(active.getByText('正在加载历史版本…',{exact:true})).toBeVisible()
  await active.locator('.revision-preview-bar').getByRole('button',{name:'返回当前',exact:true}).click()
  release()
  await expect(active.locator('.revision-preview-bar')).toHaveCount(0)
  await expect(active.locator('.fixed-page-hitbox').first()).toBeVisible()
  await page.screenshot({path:info.outputPath('fixed-history-return-current.png')})
  await page.unroute(snapshotRoute)
  await open(page,'ui-pdf','read')
  const pdf=page.locator('.document-tab-panel:not([hidden])')
  await pdf.getByRole('button',{name:'修订历史',exact:true}).first().click()
  await pdf.locator('.history button[data-revision="0"]').click()
  await expect(pdf.locator('.workspace')).toHaveAttribute('data-hcd-history','true')
  await expect(pdf.locator('.fixed-pages iframe').first()).toBeVisible()
  await expect(pdf.locator('.fixed-page-hitbox')).toHaveCount(0)
  await expect(pdf.locator('[data-document-scope]')).toHaveAttribute('data-document-scope', 'read')
  await page.screenshot({path:info.outputPath('pdf-history-preview.png')})
})


test('export menus use source-aware methods and prepare real TXT, XLSX and PDF artifacts', async ({page},info) => {
  for (const [id,format,mode] of [['export-text','txt','semantic'],['export-grid','xlsx','source'],['export-pdf','pdf','visual']]) {
    await open(page,id,'read')
    const active=page.locator('.document-tab-panel:not([hidden])')
    await active.locator('.export-control summary').first().click()
    const select=active.getByRole('combobox',{name:'导出格式',exact:true})
    await expect(select).toBeEnabled()
    await expect(select).toHaveValue(format)
    await expect(active.getByRole('combobox',{name:'导出方式',exact:true})).toHaveValue(mode)
    await expect(select.locator('option[value="csv"]')).toHaveCount(0)
    await active.getByRole('button',{name:'准备下载',exact:true}).click()
    const download=active.locator('.download-ready')
    await expect(download).toBeVisible()
    const response=await page.request.get((await download.getAttribute('href'))!)
    expect(response.ok(),await response.text().then(text=>text.slice(0,160))).toBe(true)
    const body=await response.body()
    if (format==='txt') expect(body.toString()).toContain('First paragraph export-text')
    else if (format==='xlsx') expect(body.subarray(0,2).toString()).toBe('PK')
    else {
      expect(body.subarray(0,4).toString()).toBe('%PDF')
      const href=(await download.getAttribute('href'))!
      const preview=await page.request.get(`${href}/preview`)
      expect(preview.headers()['content-disposition']).toMatch(/^inline;/)
      expect((await preview.body()).equals(body)).toBe(true)
      await expect(active.locator('.export-guidance')).toContainText('页面图像')
      await page.screenshot({path:info.outputPath('pdf-export-capabilities.png')})
    }
  }
})

test('Word export downloads use the document title and selected extension and contain readable DOCX files', async ({page},info) => {
  const id = 'export-word', title = '合同附件 #1.docx'
  await page.goto(`${uiUrl}/?locale=zh-CN`)
  await page.evaluate(({id,title,credential}) => sessionStorage.setItem('hcd-editor-workspace-v1', JSON.stringify({
    version:1,tabs:[{documentId:id,title,token:credential}],activeDocument:id,
  })), {id,title,credential:token(id,'browser-user')})
  await page.reload()
  await expect(page.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','true')
  await expect(page.locator('.document-title strong')).toHaveText(title)
  await page.locator('.export-control summary').click()
  await expect(page.getByLabel('导出格式',{exact:true})).toHaveValue('docx')
  for (const mode of ['source','semantic']) {
    await page.getByLabel('导出方式',{exact:true}).selectOption(mode)
    await page.getByRole('button',{name:'准备下载',exact:true}).click()
    const link = page.locator('.download-ready')
    await expect(link).toHaveAttribute('download',title)
    await expect(page.locator('.export-filename')).toHaveText(title)
    const response = await page.request.get((await link.getAttribute('href'))!)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(response.headers()['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent(title).replace(/'/g,'%27')}`)
    const event = page.waitForEvent('download'); await link.click(); const download = await event
    expect(download.suggestedFilename()).toBe(title)
    const output = info.outputPath(`${mode}.docx`); await download.saveAs(output)
    const checked = spawnSync('python3',['-c','import sys,zipfile,xml.etree.ElementTree as E\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nassert {"[Content_Types].xml","word/document.xml"} <= set(z.namelist())\nfor p in z.namelist():\n if p.endswith((".xml",".rels")): E.fromstring(z.read(p))',output],{encoding:'utf8'})
    expect(checked.status,checked.stderr).toBe(0)
    const read = spawnSync(binary,['view',output,'text'],{encoding:'utf8'})
    expect(read.status,read.stderr).toBe(0); expect(read.stdout).toContain('COVER TITLE')
    await page.screenshot({path:info.outputPath(`word-export-${mode}.png`)})
  }
})

test('Word high fidelity downloads preserve native parts and match every preview page and paper size', async ({page,context},info) => {
  test.setTimeout(240_000)
  const copied = !!process.env.HCD_FIDELITY_BUNDLE
  await open(page,fidelityId,copied ? 'read' : 'write')
  if (!copied) {
    const frame = page.locator('.hcd-opaque-preview iframe').first().contentFrame(), tools = page.locator('[data-hcd-table-controls]').first()
    await expect(frame.locator('[data-hcd-inline-table-text]').first()).toHaveAttribute('contenteditable','plaintext-only')
    await frame.locator('tr').nth(5).locator('td').first().hover()
    await tools.getByRole('button',{name:'在下方插入行',exact:true}).click(); await expect(frame.locator('tr')).toHaveCount(32)
    await frame.locator('tr').nth(6).locator('[data-hcd-inline-table-text]').first().fill('FIDELITY TABLE 中文')
    await frame.locator('tr').nth(6).locator('td').first().hover()
    await tools.getByRole('button',{name:'在右侧插入列',exact:true}).click()
    await expect(frame.locator('tr').nth(6).locator('td')).toHaveCount(3)
    await reopenWithScope(page, 'read')
  }
  const word = page.locator('.word-page-preview iframe').contentFrame()
  await expect(word.locator('body')).toHaveAttribute('data-hcd-page-count',/^[1-9]\d*$/)
  const papers = await word.locator('.hcd-virtual-page').evaluateAll(pages=>pages.map(page=>({
    width:(page as HTMLElement).style.width,height:(page as HTMLElement).style.height,
    text:(page as HTMLElement).innerText,
    paragraphs:[...page.querySelectorAll<HTMLElement>('.hcd-paragraph')].map(p=>p.innerText).filter(Boolean),
    images:[...page.querySelectorAll<HTMLImageElement>('img')].map(image=>({width:image.naturalWidth,height:image.naturalHeight})),
    bodyBottom:page.querySelector('.hcd-virtual-page-content')?.lastElementChild?.getBoundingClientRect().bottom,
    footerTop:page.querySelector('.hcd-page-footer')?.getBoundingClientRect().top,
  })))
  expect(papers.length).toBeGreaterThan(1)
  expect(papers.every(page=>page.images.every(image=>image.width>0&&image.height>0))).toBe(true)
  for(const paper of papers) if(paper.bodyBottom!==undefined&&paper.footerTop!==undefined) expect(paper.bodyBottom).toBeLessThanOrEqual(paper.footerTop+1)
  writeFileSync(info.outputPath('preview-pages.json'),JSON.stringify(papers,null,2))
  await page.locator('.export-control summary').click()
  await expect(page.getByLabel('导出方式',{exact:true})).toHaveValue('source')
  await page.getByRole('button',{name:'准备下载',exact:true}).click()
  await expect(page.locator('.download-ready')).toBeVisible()
  const docxResponse=await page.request.get((await page.locator('.download-ready').getAttribute('href'))!)
  expect(docxResponse.status()).toBe(200)
  const docx=info.outputPath('native.docx');writeFileSync(docx,await docxResponse.body())
  const source=resolve(root,'service','sources',`${fidelityId}.docx`)
  const checked=spawnSync('python3',['-c','import sys,zipfile,xml.etree.ElementTree as E\na=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2])\nassert set(a.namelist())==set(b.namelist())\nfor p in a.namelist():\n if p!="word/document.xml": assert a.read(p)==b.read(p),p\nfor p in b.namelist():\n if p.endswith((".xml",".rels")): E.fromstring(b.read(p))',source,docx],{encoding:'utf8'})
  expect(checked.status,checked.stderr).toBe(0)
  if (!copied) {
    const nativeText=spawnSync(binary,['view',docx,'text'],{encoding:'utf8'})
    expect(nativeText.status,nativeText.stderr).toBe(0);expect(nativeText.stdout).toContain('FIDELITY TABLE 中文')
  }
  await page.getByLabel('导出格式',{exact:true}).selectOption('pdf')
  await expect(page.locator('.export-guidance')).toContainText('分页预览')
  await page.getByRole('button',{name:'准备下载',exact:true}).click()
  await expect(page.locator('.download-ready').or(page.locator('.export-popover .export-error'))).toBeVisible({timeout:60_000})
  expect(await page.locator('.export-popover .export-error').allTextContents()).toEqual([])
  await expect(page.locator('.download-ready')).toBeVisible()
  const pdfResponse=await page.request.get((await page.locator('.download-ready').getAttribute('href'))!)
  expect(pdfResponse.status()).toBe(200)
  const pdf=info.outputPath('preview.pdf');writeFileSync(pdf,await pdfResponse.body())
  const stats=spawnSync(binary,['view',pdf,'stats','--json'],{encoding:'utf8'});expect(stats.status,stats.stderr).toBe(0);expect(JSON.parse(stats.stdout).data.pageCount).toBe(papers.length)
  const extracted=spawnSync(binary,['view',pdf,'text'],{encoding:'utf8'});expect(extracted.status,extracted.stderr).toBe(0)
  const normalize=(text:string)=>text.replace(/[\s\u00ad]/g,'')
  const text=normalize(extracted.stdout)
  for (const paper of papers) for (const paragraph of paper.paragraphs) expect(text.includes(normalize(paragraph)),`PDF dropped preview text: ${paragraph.slice(0,60)}`).toBe(true)
  const previewUrl=new URL((await page.locator('.export-preview').getAttribute('href'))!)
  // Business workspaces retain this parameter on their export-preview links.
  // A PDF ticket must take precedence over opening another editing session.
  previewUrl.searchParams.set('workspaceFile','00000000-0000-4000-8000-000000000001')
  const preview=await context.newPage();await preview.goto(previewUrl.href)
  for(let index=0;index<papers.length;index++){
    const sheet=preview.locator('.pdf-export-preview-page');await expect(sheet).toHaveAttribute('data-pdf-rendered-page',String(index+1),{timeout:30_000});await expect(sheet).toHaveAttribute('aria-busy','false')
    const size=await sheet.locator('canvas').boundingBox();const expected=parseFloat(papers[index].width)/parseFloat(papers[index].height)
    expect(size!.width/size!.height).toBeCloseTo(expected,2)
    await preview.screenshot({path:info.outputPath(`pdf-page-${String(index+1).padStart(2,'0')}.png`)})
    if(index+1<papers.length) await preview.getByRole('button',{name:'下一页',exact:true}).click()
  }
  await preview.close()
})

test('missing workbook sources fall back explicitly to content conversion', async ({page},info) => {
  const id='export-missing-grid'
  rmSync(resolve(root,'service','sources',`${id}.xlsx`))
  await open(page,id,'read')
  const active=page.locator('.document-tab-panel:not([hidden])')
  await active.locator('.export-control summary').first().click()
  const method=active.getByRole('combobox',{name:'导出方式',exact:true})
  await expect(method).toHaveValue('semantic')
  await expect(method.locator('option[value="source"]')).toBeDisabled()
  await expect(active.locator('.export-guidance')).toContainText('复杂排版可能变化')
  await active.getByRole('button',{name:'准备下载',exact:true}).click()
  await expect(active.locator('.download-ready')).toBeVisible()
  const response=await page.request.get((await active.locator('.download-ready').getAttribute('href'))!)
  expect(response.status()).toBe(200)
  expect((await response.body()).subarray(0,2).toString()).toBe('PK')
  await active.getByRole('combobox',{name:'导出格式',exact:true}).selectOption('docx')
  await expect(active.locator('.export-guidance')).toContainText('公式、图表和工作簿结构')
  await expect(active.locator('.download-ready')).toHaveCount(0)
  await page.screenshot({path:info.outputPath('workbook-export-fallback.png')})
})

test('export capabilities follow the selected PDF revision and block historical HCD archives', async ({page},info) => {
  const id='export-font-pdf',headers={Authorization:`Bearer ${token(id,'font-author')}`}
  const resource=async(path:string)=>(await fetch(`${apiUrl}/v1/documents/${id}${path}`,{headers})).json()
  const chunk=await resource('/chunks/0'),node=chunk.map.entries.find((node:{source:{editable:boolean}})=>node.source.editable)
  const edited=await fetch(`${apiUrl}/v1/documents/${id}/node-patch`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:'hcd-patch/37',documentId:id,patchId:'export-font-constraint',baseRevision:0,operations:[{op:'text.font',nodeId:node.nodeId,font:{latin:'Arial'},precondition:{nodeHash:node.nodeHash}}]})})
  expect(edited.ok,await edited.text()).toBe(true)
  await open(page,id,'read')
  const active=page.locator('.document-tab-panel:not([hidden])')
  await active.locator('.export-control summary').first().click()
  const method=active.getByRole('combobox',{name:'导出方式',exact:true})
  await expect(method).toHaveValue('visual')
  await expect(method.locator('option[value="source"]')).toBeDisabled()
  await active.locator('.export-control summary').first().click()
  await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  await active.locator('.history button[data-revision="0"]').click()
  await active.locator('.export-control summary').first().click()
  await expect(method).toBeEnabled()
  await expect(method.locator('option[value="source"]')).toBeEnabled()
  await expect(active.getByRole('combobox',{name:'导出格式',exact:true}).locator('option[value="hcd"]')).toBeDisabled()
  await method.selectOption('source')
  await expect(active.locator('div.export-guidance')).toContainText('优先保留源文档结构')
  await page.screenshot({path:info.outputPath('historical-export-options.png')})
  await active.getByRole('button',{name:'准备下载',exact:true}).click()
  await expect(active.locator('.download-ready')).toBeVisible()
  const historicalUrl=(await active.locator('.download-ready').getAttribute('href'))!
  const original=await page.request.get(historicalUrl)
  expect(original.ok()).toBe(true)
  const oldBytes=await original.body()
  await active.locator('.export-control summary').first().click()
  await active.locator('.revision-preview-bar').getByRole('button',{name:'返回当前',exact:true}).click()
  await active.locator('.export-control summary').first().click()
  await expect(method).toBeEnabled()
  await expect(active.locator('.download-ready')).toHaveCount(0)
  await expect(method).toHaveValue('source')
  await expect(active.getByRole('button',{name:'准备下载',exact:true})).toBeDisabled()
  await expect(active.locator('div.export-guidance [role="alert"]')).toContainText('当前版本的修改无法')
  await method.selectOption('visual')
  await active.getByRole('button',{name:'准备下载',exact:true}).click()
  await expect(active.locator('.download-ready')).toBeVisible()
  expect((await (await page.request.get(historicalUrl)).body()).equals(oldBytes)).toBe(true)
})

test('export option failures retry and conversion failures never expose a download link', async ({page},info) => {
  const id='export-errors',capRoute=`**/v1/documents/${id}/export-capabilities?revision=*`
  await open(page,id,'read')
  const active=page.locator('.document-tab-panel:not([hidden])')
  await page.route(capRoute,route=>route.fulfill({status:503,body:'Capabilities temporarily unavailable'}))
  await active.locator('.export-control summary').first().click()
  await expect(active.locator('.export-popover [role="alert"]')).toContainText('无法获取导出选项')
  await expect(active.getByRole('button',{name:'准备下载',exact:true})).toBeDisabled()
  await page.unroute(capRoute)
  await page.route(capRoute,async route=>{
    const response=await route.fetch(),plan=await response.json()
    plan.formats=plan.formats.filter((item:{format:string})=>item.format==='txt')
    await route.fulfill({response,json:plan})
  })
  await active.getByRole('button',{name:'重试',exact:true}).click()
  const format=active.getByRole('combobox',{name:'导出格式',exact:true})
  await expect(format).toBeEnabled()
  await expect(format.locator('option')).toHaveCount(1)
  const headers={Authorization:`Bearer ${token(id,'export-validator')}`}
  const manifest=await (await fetch(`${apiUrl}/v1/documents/${id}`,{headers})).json()
  const stylePath=resolve(root,'service',`${id}.hcd`,manifest.stylesHref),styles=readFileSync(stylePath)
  rmSync(stylePath)
  await active.getByRole('button',{name:'准备下载',exact:true}).click()
  await expect(active.locator('.export-popover>.export-error')).toBeVisible()
  await expect(active.locator('.download-ready')).toHaveCount(0)
  writeFileSync(stylePath,styles)
  await active.getByRole('button',{name:'准备下载',exact:true}).click()
  await expect(active.locator('.download-ready')).toBeVisible()
  await page.screenshot({path:info.outputPath('txt-export-ready.png')})
})

test('appearance follows the system, persists overrides and preserves the live editor', async ({page}, info) => {
  await page.emulateMedia({colorScheme:'light'})
  await open(page,'ui-text')
  const surface=page.locator('.multi-document-workspace'),active=page.locator('.document-tab-panel:not([hidden])')
  const body=active.locator('.hcd-editor-body'),picker=page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true})
  await expect(body).toBeVisible()
  await body.evaluate(element=>{(window as any).__appearanceEditor=element})
  await expect(surface).toHaveAttribute('data-theme','light')
  await page.emulateMedia({colorScheme:'dark'})
  await expect(surface).toHaveAttribute('data-theme','dark')
  expect(await body.evaluate(element=>getComputedStyle(element).color)).toBe(await surface.evaluate(element=>getComputedStyle(element).color))
  expect(await active.locator('.document').evaluate(element=>getComputedStyle(element).backgroundColor)).not.toBe('rgb(255, 255, 255)')
  await picker.selectOption('light')
  await expect(surface).toHaveAttribute('data-theme','light')
  await page.screenshot({animations:'disabled',path:info.outputPath('workspace-pen-light.png')})
  await picker.selectOption('dark')
  await expect(surface).toHaveAttribute('data-theme','dark')
  await active.getByRole('button',{name:'收起协作面板',exact:true}).click()
  await expect(active.locator('.agent-activity-panel')).toBeHidden()
  await active.getByRole('button',{name:'展开右侧栏',exact:true}).click()
  expect(await body.evaluate(element=>(window as any).__appearanceEditor===element)).toBe(true)
  await page.screenshot({animations:'disabled',path:info.outputPath('workspace-pen-dark.png')})
  await page.reload()
  await expect(surface).toHaveAttribute('data-theme','dark')
  await expect(picker).toHaveValue('dark')
  await page.emulateMedia({colorScheme:'light'})
  await expect(surface).toHaveAttribute('data-theme','dark')
  await picker.selectOption('system')
  await expect(surface).toHaveAttribute('data-theme','light')
  await picker.selectOption('dark')
  await page.getByRole('button',{name:'文档工作台',exact:true}).click()
  await page.getByPlaceholder('粘贴短期令牌',{exact:true}).fill('')
  await page.screenshot({animations:'disabled',path:info.outputPath('library-dark.png')})
})

test('dark workspace keeps all seven document surfaces and native canvas instances', async ({page}, info) => {
  for(const [id,format,selector] of [
    ['ui-grid','xlsx','.hcd-univer-host canvas:visible'], ['agents-slides','pptx','.fixed-pages iframe'],
    ['ui-pdf','pdf','.fixed-pages iframe'], ['complex-word','docx','.word-page-preview iframe'],
    ['ui-markdown','md','.hcd-editor-body'],['ui-html','html','.hcd-editor-body'],['ui-text','txt','.hcd-editor-body'],
  ]) {
    await open(page,id,'read')
    const active=page.locator('.document-tab-panel:not([hidden])')
    const content=active.locator(selector).first()
    await expect(content).toBeVisible()
    await content.evaluate(element=>{(window as any).__themeSurface=element})
    const theme=page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true})
    await theme.selectOption('light');await theme.selectOption('dark')
    await expect(page.locator('.multi-document-workspace')).toHaveAttribute('data-theme','dark')
    expect(await content.evaluate(element=>(window as any).__themeSurface===element)).toBe(true)
    await expect(active.locator('.agent-activity-panel')).toBeVisible()
    if(format==='xlsx') {
      expect(await content.evaluate(element=>getComputedStyle(element.parentElement!).backgroundColor)).toBe('rgb(255, 255, 255)')
      await expect(page.locator('html')).not.toHaveClass(/univer-dark/)
    }
    await page.screenshot({animations:'disabled',path:info.outputPath(`dark-${format}.png`)})
  }
})

test('context menu uses a themed viewport portal with keyboard navigation and focus return', async ({page}, info) => {
  await open(page,'ui-markdown')
  const active=page.locator('.document-tab-panel:not([hidden])'),body=active.locator('.hcd-editor-body')
  await expect(body).toBeVisible()
  await page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
  await body.click();await page.keyboard.press('ControlOrMeta+Home')
  await active.locator('.document').evaluate(element=>element.dispatchEvent(new MouseEvent('contextmenu',{clientX:1430,clientY:1035,bubbles:true})))
  const menu=page.getByRole('menu',{name:'文档选区',exact:true})
  await expect(menu).toBeVisible()
  await expect(page.locator('.hcd-floating-layer')).toHaveAttribute('data-theme','dark')
  const bounds=await menu.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(8);expect(bounds!.y).toBeGreaterThanOrEqual(8)
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(1433);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(1043)
  await expect(menu.locator('.context-menu-footer')).toBeInViewport()
  await page.keyboard.press('End')
  await expect(menu.locator('button:not(:disabled)').last()).toBeFocused()
  await page.keyboard.press('Home')
  await expect(menu.getByRole('menuitem',{name:'用 Agent 修改…',exact:true})).toBeFocused()
  await page.screenshot({animations:'disabled',path:info.outputPath('context-menu-dark.png')})
  await expect(menu.getByRole('menuitem',{name:'设置链接',exact:true})).toHaveCount(0)
  await menu.getByRole('menuitem',{name:'更多编辑操作',exact:true}).click()
  await expect(menu.getByRole('menuitem',{name:'设置链接',exact:true})).toBeVisible()
  await page.keyboard.press('Escape');await expect(menu).toHaveCount(0);await expect(body).toBeFocused()
  await active.locator('.document').evaluate(element=>element.dispatchEvent(new MouseEvent('contextmenu',{clientX:400,clientY:400,bubbles:true})))
  await expect(menu).toBeVisible();await active.locator('.document-title').click();await expect(menu).toHaveCount(0)
})

test('mobile docked panels replace the content column without a scrim and retain the composer draft', async ({page}, info) => {
  await page.setViewportSize({width:390,height:844})
  await open(page,'ui-html')
  const active=page.locator('.document-tab-panel:not([hidden])')
  await page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
  await active.getByRole('button',{name:'展开左侧栏',exact:true}).click()
  await expect(active.locator('.outline-panel')).toBeVisible()
  await expect(active.getByRole('button',{name:'收起左侧面板',exact:true})).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(active.locator('.outline-panel')).toBeHidden()
  await expect(active.getByRole('button',{name:'展开左侧栏',exact:true})).toBeFocused()
  await active.getByRole('button',{name:'展开右侧栏',exact:true}).click()
  const input=active.getByRole('textbox',{name:'Agent 任务',exact:true})
  await input.fill('保留这份待发送草稿')
  await active.getByRole('button',{name:'任务设置',exact:true}).click()
  await active.getByRole('combobox',{name:'协同人数',exact:true}).selectOption('3')
  await page.screenshot({animations:'disabled',path:info.outputPath('mobile-drawer-dark.png')})
  await expect(active.locator('.workspace-drawer-scrim')).toHaveCount(0)
  await expect(active.locator('.content-shell')).toBeHidden()
  await active.getByRole('button',{name:'收起协作面板',exact:true}).click()
  await expect(active.locator('.content-shell')).toBeVisible()
  await expect(active.locator('.agent-activity-panel')).toBeHidden()
  await active.getByRole('button',{name:'展开右侧栏',exact:true}).click()
  await expect(input).toHaveValue('保留这份待发送草稿')
  await expect(active.getByRole('combobox',{name:'协同人数',exact:true})).toHaveValue('3')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('inline tables keep canonical appearance in dark mode and reject structural checkpoint changes',async({page},info)=>{
  const id='table-appearance'
  await open(page,id)
  const active=page.locator('.document-tab-panel:not([hidden])')
  await page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
  const table=active.locator('.hcd-opaque-preview iframe').first().contentFrame()
  await expect(table.locator('table')).toBeVisible()
  const field=table.locator('[data-hcd-inline-table-text]').first()
  await expect(field).toHaveAttribute('contenteditable','plaintext-only')
  await field.click()
  await expect(active.getByRole('button',{name:'𝐁 加粗',exact:true})).toBeDisabled()
  await active.locator('.hcd-editor-body > p').first().click({position:{x:10,y:8}})
  await expect(active.getByRole('button',{name:'𝐁 加粗',exact:true})).toBeEnabled()
  await field.click()
  await expect(field).toHaveCSS('outline-style','none')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const headers={Authorization:`Bearer ${token(id,'browser-user')}`}
  const projection=await (await page.request.get(`${apiUrl}/v1/documents/${id}/editor`,{headers})).json()
  const access=await (await page.request.get(`${apiUrl}/v1/documents/${id}/auth`,{headers})).json()
  const blocks=projection.blocks.filter((block:{region:string})=>block.region==='body').map((block:{blockId:string;content:unknown})=>({blockId:block.blockId,content:structuredClone(block.content)}))
  // An invalid table style edit must also reject an otherwise valid paragraph edit.
  blocks[0].content.inlines[0].text='MUST NOT COMMIT'
  const opaque=blocks.find((block:{content:{kind:string}})=>block.content.kind==='opaque')
  opaque.content.inlines[0].bold=!opaque.content.inlines[0].bold
  const rejected=await page.request.post(`${apiUrl}/v1/documents/${id}/checkpoints`,{headers:{...headers,'X-HCD-Collaboration-Epoch':String(access.collaborationEpoch)},data:{expectedRevision:projection.revision,blocks}})
  expect(rejected.ok()).toBe(false)
  const unchanged=await (await page.request.get(`${apiUrl}/v1/documents/${id}/editor`,{headers})).json()
  expect(unchanged).toEqual(projection)
  await field.evaluate(element=>{(window as unknown as {originalInline:Element}).originalInline=element})
  await expect(active.locator('.mode-switch')).toHaveCount(0)
  const readPage = await page.context().newPage()
  await open(readPage, id, 'read')
  await expect(readPage.locator('.hcd-opaque-preview iframe').first().contentFrame().locator('[contenteditable="plaintext-only"]')).toHaveCount(0)
  await readPage.close()
  await expect(field).toHaveAttribute('contenteditable','plaintext-only')
  expect(await field.evaluate(element=>(window as unknown as {originalInline:Element}).originalInline===element)).toBe(true)
  await page.screenshot({animations:'disabled',path:info.outputPath('table-inline-dark.png')})
})

test('docked panels never cover the document and restore space without replacing editors',async({page},info)=>{
  await page.setViewportSize({width:1600,height:1040})
  for(const [id,format,selector] of [
    ['ui-markdown','md','.hcd-editor-body'],['ui-grid','xlsx','.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]'],['agents-slides','pptx','.fixed-pages iframe'],
  ]) {
    await open(page,id)
    const active=page.locator('.document-tab-panel:not([hidden])'),header=active.locator('.editor-header')
    const surface=active.locator(selector).first(),shell=active.locator('.content-shell'),layout=active.locator('.editor-layout')
    const left=active.locator('.workspace-left-panel'),right=active.locator('.pen-agent-panel')
    await expect(surface).toBeVisible()
    if(format==='xlsx') await expect(header.getByRole('status')).toHaveText('已保存')
    await surface.evaluate(element=>{(window as any).__dockedEditor=element})
    const verifyDock=async()=>{
      const content=await shell.boundingBox(),host=await layout.boundingBox()
      for(const panel of [left,right]) if(await panel.isVisible()) {
        const box=await panel.boundingBox()
        expect(box!.y).toBeGreaterThanOrEqual(host!.y-1)
        expect(box!.y+box!.height).toBeLessThanOrEqual(host!.y+host!.height+1)
        expect(await panel.evaluate(element=>getComputedStyle(element).position)).toBe('static')
        expect(await panel.evaluate(element=>getComputedStyle(element).boxShadow)).toBe('none')
        if(panel===left) expect(box!.x+box!.width).toBeLessThanOrEqual(content!.x+1)
        else expect(box!.x).toBeGreaterThanOrEqual(content!.x+content!.width-1)
      }
      await expect(header.locator('.sidebar-toggle,.settings-trigger,.history-trigger,.properties-trigger')).toHaveCount(0)
      await expect(header).not.toContainText(/可编辑|可查看/)
    }
    await expect(left).toBeVisible();await expect(right).toBeVisible();await verifyDock()
    const leftClose=await left.getByRole('button',{name:'收起左侧面板',exact:true}).boundingBox()
    const rightClose=await right.getByRole('button',{name:'收起协作面板',exact:true}).boundingBox()
    expect(leftClose!.x).toBeGreaterThan((await left.boundingBox())!.x+150)
    expect(rightClose!.x).toBeLessThan((await right.boundingBox())!.x+44)
    await expect(active.locator('.left-sidebar-toggle')).toBeHidden();await expect(active.locator('.right-sidebar-toggle')).toBeHidden()
    await page.screenshot({animations:'disabled',path:info.outputPath(`${format}-docked-open-light.png`)})
    const initial=(await shell.boundingBox())!.width
    await left.getByRole('button',{name:'收起左侧面板',exact:true}).click()
    await expect(left).toBeHidden();await expect(active.getByRole('button',{name:'展开左侧栏',exact:true})).toBeVisible()
    expect((await shell.boundingBox())!.width).toBeGreaterThan(initial+150)
    await right.getByRole('button',{name:'收起协作面板',exact:true}).click()
    await expect(right).toBeHidden()
    const expanded=(await shell.boundingBox())!.width
    expect(expanded).toBeGreaterThan(initial+450)
    await page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
    await page.screenshot({animations:'disabled',path:info.outputPath(`${format}-docked-closed-dark.png`)})
    await active.getByRole('button',{name:'展开左侧栏',exact:true}).click()
    await active.getByRole('button',{name:'展开右侧栏',exact:true}).click()
    await verifyDock()
    expect(Math.abs((await shell.boundingBox())!.width-initial)).toBeLessThan(1)
    expect(await surface.evaluate(element=>(window as any).__dockedEditor===element)).toBe(true)
    await active.getByRole('button',{name:'界面设置',exact:true}).click()
    const settings=active.getByRole('complementary',{name:'界面设置',exact:true})
    await expect(settings).toBeVisible()
    const close=await settings.getByRole('button',{name:'隐藏右侧栏',exact:true}).boundingBox()
    expect(close!.x).toBeLessThan((await settings.boundingBox())!.x+52)
    await settings.getByRole('button',{name:'隐藏右侧栏',exact:true}).click()
    await active.getByRole('button',{name:'展开右侧栏',exact:true}).click()
    await expect(settings).toBeVisible()
    await settings.getByRole('button',{name:'隐藏右侧栏',exact:true}).click()
    await left.getByRole('button',{name:'收起左侧面板',exact:true}).click()
    await page.reload()
    await expect(active.getByRole('button',{name:'展开左侧栏',exact:true})).toBeVisible()
    await expect(active.getByRole('button',{name:'展开右侧栏',exact:true})).toBeVisible()
    if(format==='md') for(const width of [1024,820,390]) {
      await page.setViewportSize({width,height:844})
      await expect(shell).toBeVisible()
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
      if(width<=900) {
        await active.getByRole('button',{name:'展开右侧栏',exact:true}).click()
        await expect(settings).toBeVisible();await expect(shell).toBeHidden()
        await expect(active.locator('.workspace-drawer-scrim')).toHaveCount(0)
        await page.screenshot({animations:'disabled',path:info.outputPath(`docked-panel-${width}.png`)})
        await settings.getByRole('button',{name:'隐藏右侧栏',exact:true}).click()
        await expect(shell).toBeVisible()
      }
    }
    await page.setViewportSize({width:1600,height:1040})
  }
})

test('PPT thumbnail drag saves the complete order in one revision with hover actions and undo',async({page},info)=>{
  await open(page,'ppt-panels')
  const active=page.locator('.document-tab-panel:not([hidden])'),cards=active.locator('.slide-card')
  const headers={Authorization:`Bearer ${token('ppt-panels','browser-user')}`}
  const read=async()=>{
    const manifest=await (await fetch(`${apiUrl}/v1/documents/ppt-panels`,{headers})).json()
    const index=await (await fetch(`${apiUrl}/v1/documents/ppt-panels/index/0`,{headers})).json()
    return {revision:manifest.revision,ids:index.chunks.map((chunk:any)=>chunk.chunkId)}
  }
  await expect(cards).toHaveCount(4)
  await expect(active.locator('.page-thumbnail iframe')).toHaveCount(4)
  await expect(active.getByRole('button',{name:'↑ 上移',exact:true})).toHaveCount(0)
  await page.mouse.move(0,0)
  await expect(cards.first().locator('.slide-actions')).toHaveCSS('opacity','0')
  await cards.first().hover()
  await expect(cards.first().locator('.slide-actions')).toHaveCSS('opacity','1')
  await active.getByRole('button',{name:'形状属性',exact:true}).click()
  await page.screenshot({animations:'disabled',path:info.outputPath('ppt-panels-light.png')})
  await expect(cards.first()).toHaveAttribute('draggable','true')
  const before=await read(),last=await cards.last().boundingBox()
  const response=page.waitForResponse(response=>response.url().endsWith('/node-patch')&&response.request().method()==='POST',{timeout:15000})
  await cards.first().dragTo(cards.last(),{sourcePosition:{x:30,y:20},targetPosition:{x:50,y:last!.height-4}})
  const moved=await response
  expect(moved.ok(),await moved.text()).toBe(true)
  const sent=moved.request().postDataJSON()
  expect(sent.schemaVersion).toBe('hcd-patch/48');expect(sent.operations[0].targetIndex).toBe(3)
  await expect.poll(async()=>await cards.evaluateAll(items=>items.map(item=>(item as HTMLElement).dataset.slideId))).toEqual([...before.ids.slice(1),before.ids[0]])
  const after=await read();expect(after.revision).toBe(before.revision+1)
  expect(after.ids).toEqual([...before.ids.slice(1),before.ids[0]])
  await active.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await expect.poll(async()=>(await read()).ids).toEqual(before.ids)
  await active.getByRole('button',{name:'↷ 重做',exact:true}).click()
  await expect.poll(async()=>(await read()).ids).toEqual(after.ids)
  await cards.first().hover();await active.getByRole('button',{name:'复制幻灯片 1',exact:true}).click()
  await expect(cards).toHaveCount(5)
  await cards.nth(1).hover();await active.getByRole('button',{name:'删除幻灯片 2',exact:true}).click()
  await expect(cards).toHaveCount(4)
  await expect.poll(async()=>(await read()).ids).toEqual(after.ids)
  await page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
  await cards.first().hover()
  await page.screenshot({animations:'disabled',path:info.outputPath('ppt-panels-dark-hover.png')})
  await page.reload();await expect(cards).toHaveCount(4)
  await expect.poll(async()=>await cards.evaluateAll(items=>items.map(item=>(item as HTMLElement).dataset.slideId))).toEqual(after.ids)
  // A refused drop must not leave the navigator in an optimistic order.
  await page.route('**/node-patch',route=>route.fulfill({status:409,body:'A collaborator updated this presentation. Read the latest revision.'}))
  const rejected=page.waitForResponse(response=>response.url().endsWith('/node-patch'))
  await cards.first().dragTo(cards.last(),{sourcePosition:{x:30,y:20},targetPosition:{x:50,y:last!.height-4}})
  expect((await rejected).status()).toBe(409)
  await expect(active.locator('.toast.error')).toContainText('排序失败')
  expect(await cards.evaluateAll(items=>items.map(item=>(item as HTMLElement).dataset.slideId))).toEqual(after.ids)
  await page.unroute('**/node-patch')
  await open(page,'ppt-panels-read','read')
  const readOnly=page.locator('.document-tab-panel:not([hidden])')
  await expect(readOnly.locator('.slide-card')).toHaveCount(4)
  await expect(readOnly.locator('.slide-card[draggable=true]')).toHaveCount(0)
  await expect(readOnly.locator('.slide-actions,.add-slide')).toHaveCount(0)
})

test('PPT grip swaps adjacent slides and the ribbon inserts editable layouts on the active page', async ({page}, info) => {
  const id = 'ppt-ribbon'
  await open(page, id)
  const pane = page.locator('.document-tab-panel:not([hidden])')
  const cards = pane.locator('.slide-card')
  const ids = () => cards.evaluateAll(items => items.map(item => (item as HTMLElement).dataset.slideId))
  const patch = () => page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/node-patch'))
  await expect(cards).toHaveCount(4)
  const initial = await ids()
  await cards.first().hover()
  const swapped = patch()
  await cards.first().getByRole('button', {name:'拖动幻灯片 1 排序'}).dragTo(cards.nth(1))
  expect((await swapped).ok()).toBe(true)
  await expect.poll(ids).toEqual([initial[1], initial[0], ...initial.slice(2)])
  await cards.nth(1).getByRole('button',{name:'幻灯片 2',exact:true}).click()
  await pane.getByRole('button',{name:'插入',exact:true}).click()
  const headers = {Authorization:'Bearer ' + token(id,'browser-user')}
  const chunk = async () => {
    const res = await page.request.get(apiUrl + '/v1/documents/' + id + '/chunks/1', {headers})
    expect(res.ok()).toBe(true)
    return (await res.json()).html as string
  }
  for (const layout of [{name:'标题与正文', texts:['标题','正文']},{name:'双栏内容', texts:['标题','左栏内容','右栏内容']}]) {
    const saved = patch()
    await pane.getByRole('button', {name:layout.name,exact:true}).click()
    const response = await saved
    expect(response.ok(),await response.text()).toBe(true)
    const {baseRevision, operations} = response.request().postDataJSON()
    expect((await response.json()).revision).toBe(baseRevision + 1)
    expect(operations.map((op:{text:string})=>op.text)).toEqual(layout.texts)
    expect(operations.every((op:{chunkId:string})=>op.chunkId === initial[0])).toBe(true)
    const html = await chunk()
    for (const value of layout.texts) expect(html).toContain(value)
  }
  await page.reload()
  await expect.poll(ids).toEqual([initial[1], initial[0], ...initial.slice(2)])
  await cards.nth(1).getByRole('button',{name:'幻灯片 2',exact:true}).click()
  await pane.getByRole('button',{name:'从当前页放映'}).click()
  const show = page.getByRole('dialog',{name:'幻灯片放映'})
  await expect(show.locator('output')).toHaveText('2 / 4')
  await expect(show.locator('iframe').contentFrame().locator('body')).toContainText('右栏内容')
  await page.keyboard.press('ArrowRight')
  await expect(show.locator('output')).toHaveText('3 / 4')
  await page.keyboard.press('Escape')
  await expect(show).toHaveCount(0)
  await pane.getByRole('button',{name:'插入',exact:true}).click()
  await page.screenshot({animations:'disabled',path:info.outputPath('ppt-slide-layouts.png')})
})

test('PPT shape properties follow the design and commit real typography and geometry',async({page},info)=>{
  await open(page,'ppt-properties')
  const active=page.locator('.document-tab-panel:not([hidden])'),properties=active.getByRole('complementary',{name:'形状属性',exact:true})
  const first=active.locator('.fixed-page-hitbox').first()
  await expect(first).toBeVisible()
  const name=(await first.getAttribute('aria-label'))!
  const select=async()=>{await active.getByRole('button',{name,exact:true}).first().click();await expect(properties).toBeVisible()}
  await select()
  await expect(properties.getByRole('button',{name:'文本',exact:true})).toHaveAttribute('aria-pressed','true')
  await expect(properties.getByRole('spinbutton',{name:'属性字号',exact:true})).toBeEnabled()
  await expect(properties.getByRole('spinbutton',{name:'形状宽度',exact:true})).toBeEnabled()
  await page.screenshot({animations:'disabled',path:info.outputPath('ppt-shape-properties-light.png')})
  const commit=async(action:()=>Promise<unknown>,schema:string)=>{
    const response=page.waitForResponse(response=>response.url().endsWith('/node-patch')&&response.request().method()==='POST')
    await action();const saved=await response
    expect(saved.ok(),await saved.text()).toBe(true);expect(saved.request().postDataJSON().schemaVersion).toBe(schema)
    await expect(properties.getByRole('spinbutton',{name:'形状宽度',exact:true})).toBeEnabled()
  }
  await commit(async()=>{await properties.getByRole('spinbutton',{name:'属性字号',exact:true}).fill('32');await properties.getByRole('spinbutton',{name:'属性字号',exact:true}).press('Enter')},'hcd-patch/30')
  await expect(properties.getByRole('spinbutton',{name:'属性字号',exact:true})).toHaveValue('32')
  await commit(()=>properties.getByRole('button',{name:'属性居中',exact:true}).click(),'hcd-patch/46')
  await expect(properties.getByRole('button',{name:'属性居中',exact:true})).toHaveAttribute('aria-pressed','true')
  await properties.getByRole('button',{name:'布局',exact:true}).click()
  await properties.getByRole('spinbutton',{name:'形状 X',exact:true}).fill('90')
  await commit(()=>properties.getByRole('button',{name:'应用布局',exact:true}).click(),'hcd-patch/17')
  await expect(properties.getByRole('spinbutton',{name:'形状 X',exact:true})).toHaveValue('90')
  await page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
  await page.screenshot({animations:'disabled',path:info.outputPath('ppt-shape-properties-dark.png')})
  await properties.getByRole('button',{name:'协作',exact:true}).click()
  const drawer=active.locator('.agent-activity-panel')
  await expect(drawer).toBeVisible()
  await drawer.getByRole('textbox',{name:'Agent 任务',exact:true}).fill('保留这份协作草稿')
  await active.getByRole('button',{name:'形状属性',exact:true}).click()
  await expect(properties).toBeVisible()
  await expect(properties.getByRole('button',{name:'布局',exact:true})).toHaveAttribute('aria-pressed','true')
  await properties.getByRole('button',{name:'协作',exact:true}).click()
  await expect(drawer.getByRole('textbox',{name:'Agent 任务',exact:true})).toHaveValue('保留这份协作草稿')
  await page.screenshot({animations:'disabled',path:info.outputPath('ppt-collaboration-dark.png')})
  await active.getByRole('button',{name:'形状属性',exact:true}).click()
  await page.setViewportSize({width:390,height:844})
  await expect(properties).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await expect(active.locator('.right-sidebar-toggle')).toBeHidden()
  await expect(active.locator('.content-shell')).toBeHidden()
  const close=await properties.locator('.panel-close').boundingBox(),bounds=await properties.boundingBox()
  expect(close!.x).toBeLessThan(bounds!.x+52)
  await page.screenshot({animations:'disabled',path:info.outputPath('ppt-properties-mobile-dark.png')})
  await page.keyboard.press('Escape')
  await expect(properties).toBeHidden()
  await expect(active.locator('.right-sidebar-toggle')).toBeFocused()
})

test('shared side panels match the latest Pen components across document formats',async({page},info)=>{
  let sharedMetrics: unknown = null
  await page.setViewportSize({width:1600,height:1040})
  await page.route('**/agent-runs',route=>route.fulfill({json:{available:true,model:'gpt-6.1-sol',runs:[{runId:'panel-design-example',agentId:'panel-agent',name:'Office Agent',task:'检查内容结构，并保留已有格式。',status:'completed',model:'gpt-6.1-sol',result:'已完成内容检查。\n\n- 保留现有文字与格式\n- 调整前可随时定位和核对内容',committedRevisions:[],events:[]}]}}))
  for(const [id,format] of [['ui-markdown','md'],['complex-word','docx'],['ui-grid','xlsx'],['ppt-panels-read','pptx'],['ui-pdf','pdf'],['ui-html','html'],['ui-text','txt']]) {
    await open(page,id)
    const active=page.locator('.document-tab-panel:not([hidden])'),left=active.locator('.workspace-left-panel'),right=active.locator('.pen-agent-panel')
    await page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true}).selectOption('light')
    await expect(left).toBeVisible();await expect(right).toBeVisible()
    const metrics=await active.evaluate(element=>{
      const left=element.querySelector('.workspace-left-panel')!,right=element.querySelector('.pen-agent-panel')!
      const size=(root:Element,selector:string)=>root.querySelector(selector)!.getBoundingClientRect()
      return {
        leftWidth:left.getBoundingClientRect().width,rightWidth:right.getBoundingClientRect().width,
        leftNavigation:size(left,'.left-panel-navigation').height,leftFooter:size(left,'.left-panel-footer').height,
        rightNavigation:size(right,'.agent-panel-navigation').height,input:size(right,'.agent-compose-area>form').height,
        leftGap:getComputedStyle(left).gap,rightGap:getComputedStyle(right).gap,
        leftRadius:getComputedStyle(left.querySelector('.left-panel-main')!).borderRadius,
        rightRadius:getComputedStyle(right.querySelector('.agent-panel-main')!).borderRadius,
      }
    })
    expect(metrics.leftRadius).toBe('16px');expect(metrics.rightRadius).toBe('16px')
    if(sharedMetrics===null)sharedMetrics=metrics
    else for(const [key,value] of Object.entries(metrics)) {
      const expected=(sharedMetrics as Record<string, unknown>)[key]
      if(typeof value==='number') expect(value).toBeCloseTo(expected as number,2)
      else expect(value).toBe(expected)
    }
    for(const panel of [left,right]) await expect.poll(async()=>{
      const canvasBounds=await active.locator('.editor-layout').boundingBox(),bounds=await panel.boundingBox()
      return !!canvasBounds && !!bounds && bounds.y >= canvasBounds.y - 1 && bounds.y+bounds.height <= canvasBounds.y+canvasBounds.height+1
    }).toBe(true)
    const input=right.getByRole('textbox',{name:'Agent 任务',exact:true}),feed=right.locator('.agent-task-feed')
    await input.fill(`保留 ${format} 文档的草稿`)
    await feed.evaluate(element=>{(window as any).__sharedChatFeed=element})
    await right.getByRole('button',{name:'图片与资源',exact:true}).click()
    await expect(right.locator('.image-studio')).toBeVisible();await expect(input).toBeVisible()
    expect(await feed.evaluate(element=>(window as any).__sharedChatFeed===element)).toBe(true)
    await right.getByRole('button',{name:'对话',exact:true}).click()
    await expect(input).toHaveValue(`保留 ${format} 文档的草稿`)
    const firstStructure=left.locator('.left-panel-content')
    await expect(firstStructure).toBeVisible()
    await firstStructure.evaluate(element=>{(window as any).__sharedOutline=element})
    await left.getByRole('button',{name:'文件与项目',exact:true}).click()
    await expect(left.locator('.left-panel-file-tools')).toBeVisible()
    await left.getByRole('button',{name:'文档结构',exact:true}).click()
    expect(await firstStructure.evaluate(element=>(window as any).__sharedOutline===element)).toBe(true)
    await left.getByRole('button',{name:'搜索文档',exact:true}).click()
    await expect(active.locator('.document-search')).toBeVisible()
    await active.getByRole('button',{name:'关闭搜索',exact:true}).click()
    const canvas=format==='docx'?'.hcd-editor-body:visible, .word-page-preview iframe:visible':format==='xlsx'?'.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]':['pptx','pdf'].includes(format)?'.fixed-pages iframe':'.hcd-editor-body'
    await expect(active.locator(canvas).first()).toBeVisible()
    await page.screenshot({animations:'disabled',path:info.outputPath(`${format}-shared-panels-light.png`)})
    await page.locator('.document-tabs').getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
    const colors=await active.evaluate(element=>[
      getComputedStyle(element.querySelector('.left-panel-main')!).backgroundColor,
      getComputedStyle(element.querySelector('.agent-panel-main')!).backgroundColor,
    ])
    expect(colors[0]).toBe(colors[1]);expect(colors[0]).not.toBe('rgb(255, 255, 255)')
    await page.screenshot({animations:'disabled',path:info.outputPath(`${format}-shared-panels-dark.png`)})
    if(format==='pptx') {
      await right.getByRole('button',{name:'展开聊天区域',exact:true}).click()
      await expect(right.getByRole('button',{name:'展开聊天区域',exact:true})).toHaveAttribute('aria-pressed','true')
      expect((await right.boundingBox())!.width).toBe(480)
      await expect(input).toHaveValue(`保留 ${format} 文档的草稿`)
      await right.getByRole('button',{name:'展开聊天区域',exact:true}).click()
      await page.setViewportSize({width:390,height:844})
      await expect(right).toBeVisible();await expect(input).toBeInViewport()
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
      await page.screenshot({animations:'disabled',path:info.outputPath('pptx-shared-panels-mobile-dark.png')})
      await page.setViewportSize({width:1600,height:1040})
    }
  }
})

test('long Word table insertion preserves typography and viewport throughout an epoch change', async ({page}, info) => {
  await open(page, 'table-long')
  const frames = page.locator('.hcd-opaque-preview iframe')
  await expect(frames).toHaveCount(process.env.HCD_TABLE_REGRESSION_DOCX ? 5 : 4)
  const target = frames.nth(3), frame = target.contentFrame()
  await expect(frame.locator('[data-hcd-inline-table-text]').first()).toHaveAttribute('contenteditable','plaintext-only')
  await expect(page.locator('[data-word-presentation]').first()).toBeVisible()
  if (process.env.HCD_TABLE_REGRESSION_DOCX) for (const kind of ['header','footer']) {
    const image = page.locator(`.word-running-${kind} iframe`).contentFrame().locator(`img[data-hcd-running-drawing="${kind}"]`)
    await expect(image).toHaveCount(1)
    await expect.poll(()=>image.evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    const bounds = await image.evaluate(image=>{const page=image.closest('.word-running-page')!.getBoundingClientRect(),rect=image.getBoundingClientRect();return{top:rect.top-page.top,bottom:rect.bottom-page.top,height:page.height}})
    expect(bounds.top).toBeLessThan(bounds.height); expect(bounds.bottom).toBeGreaterThan(0)
  }
  const host = page.locator('.hcd-opaque-preview').nth(3), tools = host.locator('[data-hcd-table-controls]')
  for (const action of ['在下方插入行', '在右侧插入列']) {
    const cell = frame.locator('tr').first().locator('td,th').first()
    await cell.scrollIntoViewIfNeeded(); await cell.click()
    await expect(tools.getByRole('button',{name:action,exact:true})).toBeVisible()
    const beforeRows = await frame.locator('tr').count(), beforeColumns = await frame.locator('tr').first().locator('td,th').count()
    await page.evaluate(() => {
      const viewport = document.querySelector('.canvas-viewport')!, body = document.querySelector('.hcd-editor-body')!
      const frames = [...body.querySelectorAll<HTMLIFrameElement>('.hcd-opaque-preview iframe')]
      const anchor = frames[3]
      const paragraphs = () => [...body.querySelectorAll<HTMLElement>(':scope > p')].map(element=>({id:element.dataset.hcdBlockId,height:element.getBoundingClientRect().height,style:element.getAttribute('style'),line:getComputedStyle(element).lineHeight}))
      const reference = { top: viewport.scrollTop, anchorTop: anchor.getBoundingClientRect().top, count: body.querySelectorAll('[data-word-presentation]').length, spans:body.querySelectorAll('span').length, paragraphs:paragraphs() }
      const samples: Array<{ top: number; anchorTop: number; count: number; heights: number[] }> = []
      const probe = { reference, samples, frames, paragraphs, stopped: false }
      ;(window as any).__tableLayoutProbe = probe
      const sample = () => {
        samples.push({ top: viewport.scrollTop, anchorTop: anchor.getBoundingClientRect().top, count: body.querySelectorAll('[data-word-presentation]').length, heights: frames.map(frame=>frame.getBoundingClientRect().height) })
        if (!probe.stopped) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    const started = Date.now()
    await tools.getByRole('button',{name:action,exact:true}).click()
    await expect(frame.locator('tr')).toHaveCount(beforeRows + (action === '在下方插入行' ? 1 : 0))
    await expect(frame.locator('tr').first().locator('td,th')).toHaveCount(beforeColumns + (action === '在右侧插入列' ? 1 : 0))
    await expect(frame.locator('[data-hcd-inline-table-text]').first()).toHaveAttribute('contenteditable','plaintext-only')
    const duration = Date.now()-started
    await page.screenshot({path:info.outputPath(action === '在下方插入行' ? 'long-table-row.png' : 'long-table-column.png')})
    const result = await page.evaluate(() => {
      const probe = (window as any).__tableLayoutProbe
      probe.stopped = true
      return { reference: probe.reference, samples: probe.samples, paragraphs:probe.paragraphs(), spans:document.querySelectorAll('.hcd-editor-body span').length, framesPreserved: probe.frames.every((frame: HTMLIFrameElement)=>frame.isConnected) }
    })
    const requests = await page.evaluate(()=>performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/v1/')).slice(-30).map(entry=>({path:new URL(entry.name).pathname,duration:entry.duration})))
    writeFileSync(info.outputPath(action === '在下方插入行' ? 'row-layout.json' : 'column-layout.json'), JSON.stringify({...result,duration,requests},null,2))
    expect(duration, `${action} must finish within the table interaction budget`).toBeLessThan(Number(process.env.HCD_TABLE_MAX_LATENCY_MS || 3000))
    expect(result.framesPreserved).toBe(true)
    expect(result.spans).toBeLessThan(result.reference.spans+20)
    expect(result.reference.top).toBeGreaterThan(5000)
    expect(Math.max(...result.samples.map((sample:any)=>Math.abs(sample.top-result.reference.top)))).toBeLessThan(4)
    expect(Math.max(...result.samples.map((sample:any)=>Math.abs(sample.anchorTop-result.reference.anchorTop)))).toBeLessThan(4)
    expect(Math.min(...result.samples.map((sample:any)=>sample.count))).toBe(result.reference.count)
    for (let index=0; index<3; index++) expect(Math.max(...result.samples.map((sample:any)=>sample.heights[index])) - Math.min(...result.samples.map((sample:any)=>sample.heights[index]))).toBeLessThan(2)
  }
})

test('long Word local undo and redo remain local and keep the selected cell visible', async ({page, context}, info) => {
  await open(page, 'table-long')
  const target = page.locator('.hcd-opaque-preview iframe').nth(3), frame = target.contentFrame()
  const field = frame.locator('[data-hcd-inline-table-text]').nth(20)
  await expect(field).toHaveAttribute('contenteditable','plaintext-only')
  await expect(page.locator('[data-word-presentation]').first()).toBeVisible()
  await field.scrollIntoViewIfNeeded(); await field.click()
  const before = await field.innerText()
  const spanCount = await page.locator('.hcd-editor-body span').count()
  const profiler = await context.newCDPSession(page)
  await profiler.send('Profiler.enable'); await profiler.send('Profiler.start')
  const recording = new Promise<void>(resolve=>setTimeout(async()=>{
    const {profile} = await profiler.send('Profiler.stop')
    writeFileSync(info.outputPath('undo-profile.json'), JSON.stringify(profile))
    resolve()
  },6000))
  const writes: string[] = []
  page.on('request', request=>{ if (request.method()==='POST' && request.url().includes('/patch')) writes.push(request.url()) })
  await field.press('End'); await field.pressSequentially(' UNDO PROBE')
  await expect(field).toContainText('UNDO PROBE')
  const viewport = page.locator('.canvas-viewport'), top = await viewport.evaluate(element=>element.scrollTop)
  const timings: number[] = []
  for (let index=0;index<3;index++) {
    const started = Date.now()
    await field.press('ControlOrMeta+z')
    await expect(field).toHaveText(before)
    timings.push(Date.now()-started)
    await field.press('ControlOrMeta+Shift+z')
    await expect(field).toContainText('UNDO PROBE')
  }
  await recording
  writeFileSync(info.outputPath('undo-timings.json'), JSON.stringify({timings,writes,scrollDelta:await viewport.evaluate(element=>element.scrollTop)-top}))
  expect(writes).toEqual([])
  expect(Math.max(...timings)).toBeLessThan(1000)
  expect(await page.locator('.hcd-editor-body span').count()).toBeLessThan(spanCount + 20)
  expect(Math.abs(await viewport.evaluate(element=>element.scrollTop)-top)).toBeLessThan(4)
  await page.screenshot({path:info.outputPath('long-table-undo.png')})
})

test('Word continuous editing displays protected running margins without adding them to checkpoints', async ({page}, info) => {
  await open(page, 'word-margins')
  const header = page.locator('.word-running-header iframe').contentFrame(), footer = page.locator('.word-running-footer iframe').contentFrame()
  await expect(header.locator('body')).toContainText('FIRST HEADER')
  await expect(header.locator('body')).not.toContainText('EVEN HEADER')
  await expect(footer.locator('body')).toContainText('Page')
  await expect(footer.locator('body')).not.toContainText('999')
  await expect(header.locator('[contenteditable="true"],[contenteditable="plaintext-only"]')).toHaveCount(0)
  const paragraph = page.locator('.hcd-editor-body > p').filter({hasText:'COVER TITLE'}).first()
  await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' BODY EDIT')
  const pending = page.waitForRequest(request=>request.method()==='POST' && request.url().endsWith('/checkpoints'))
  await page.getByRole('button',{name:'保存点',exact:true}).click()
  const blocks = (await pending).postDataJSON().blocks
  expect(JSON.stringify(blocks)).not.toContain('FIRST HEADER')
  expect(JSON.stringify(blocks)).not.toContain('DEFAULT HEADER')
  await expect(header.locator('body')).toContainText('FIRST HEADER')
  await header.locator('.word-running-content').scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('continuous-word-header.png')})
  await footer.locator('.word-running-content').scrollIntoViewIfNeeded()
  await page.screenshot({path:info.outputPath('continuous-word-footer.png')})
})

test('table hover controls edit rows and columns with merges and retain canvas nodes and scroll', async ({page, context}, info) => {
  const id = 'table-structure'
  await open(page, id)
  const iframe = page.locator('.hcd-opaque-preview iframe').first(), frame = iframe.contentFrame()
  const tools = page.locator('.hcd-opaque-preview').first().locator('[data-hcd-table-controls]')
  await expect(frame.locator('[data-hcd-inline-table-text]').first()).toHaveAttribute('contenteditable','plaintext-only')
  // Chromium's cross-frame boundingBox/hover conversion ignores ancestor CSS
  // zoom. Map frame-local rectangles into real screen coordinates for this check.
  const screenRect = async (element: ReturnType<typeof frame.locator>) => {
    const outer = await iframe.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, scale: rect.width / parseFloat(getComputedStyle(element).width) }
    })
    const rect = await element.evaluate(element => element.getBoundingClientRect().toJSON())
    return { x: outer.x + rect.x * outer.scale, y: outer.y + rect.y * outer.scale, width: rect.width * outer.scale, height: rect.height * outer.scale }
  }
  const edges = async () => {
    await expect(tools).toBeVisible()
    const table = await screenRect(frame.locator('table'))
    const row = (await tools.locator('[data-hcd-table-axis="row"]').boundingBox())!
    const column = (await tools.locator('[data-hcd-table-axis="column"]').boundingBox())!
    const trigger = (await tools.getByRole('button',{name:'表格操作',exact:true}).boundingBox())!
    expect(row.x + row.width).toBeLessThan(table.x)
    expect(column.y + column.height).toBeLessThan(table.y)
    expect(trigger.x + trigger.width).toBeLessThan(table.x)
    expect(trigger.y + trigger.height).toBeLessThan(table.y)
    return {row, column}
  }
  for (const zoom of ['缩小文档','放大文档','放大文档','重置文档缩放']) {
    await page.getByRole('button',{name:zoom,exact:true}).click()
    const firstCell = await screenRect(frame.locator('tr').first().locator('td').first())
    await page.mouse.move(firstCell.x + firstCell.width / 2, firstCell.y + firstCell.height / 2)
    const first = await edges()
    const nextCell = await screenRect(frame.locator('tr').first().locator('td').nth(1))
    await page.mouse.move(nextCell.x + nextCell.width / 2, nextCell.y + nextCell.height / 2)
    const next = await edges()
    expect(Math.abs(first.row.x - next.row.x)).toBeLessThan(1)
    expect(Math.abs(first.column.y - next.column.y)).toBeLessThan(1)
    expect(next.column.x).toBeGreaterThan(first.column.x)
    await expect(tools.locator(':scope > button')).toHaveCount(5)
    await expect(frame.locator('td button,th button')).toHaveCount(0)
  }
  // A user can pause in the empty gutter while moving from the table to a
  // control. Keep it reachable even beyond the ordinary dismissal delay.
  for (const axis of ['row', 'column']) {
    await frame.locator('tr').first().locator('td').nth(1).hover()
    const table = await screenRect(frame.locator('table'))
    const button = tools.locator(`[data-hcd-table-axis="${axis}"]`)
    const rect = (await button.boundingBox())!
    const gap = axis === 'row'
      ? { x: (rect.x + rect.width + table.x) / 2, y: rect.y + rect.height / 2 }
      : { x: rect.x + rect.width / 2, y: (rect.y + rect.height + table.y) / 2 }
    await page.mouse.move(gap.x, gap.y, {steps:8})
    await page.waitForTimeout(1100)
    await expect(button).toBeVisible()
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2, {steps:8})
    await page.waitForTimeout(1100)
    await expect(button).toBeVisible()
  }
  await tools.getByRole('button',{name:'表格操作',exact:true}).click()
  const menu = tools.locator('[data-hcd-table-menu]')
  await expect(menu).toBeVisible()
  await frame.locator('tr').nth(1).locator('td').nth(1).hover()
  await page.waitForTimeout(1100)
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await page.mouse.click(20,20)
  await expect(tools).toBeHidden({timeout:3000})
  await frame.locator('tr').first().locator('td').nth(1).hover()
  await page.screenshot({path:info.outputPath('table-header-left-controls.png')})
  const peer = await context.newPage(); await open(peer, id)
  const peerFrame = peer.locator('.hcd-opaque-preview iframe').first().contentFrame()
  await expect(peerFrame.locator('tr')).toHaveCount(31)
  await iframe.evaluate(element => { (window as any).__tableFrame = element })
  await frame.locator('table').evaluate(element => { (window as any).__tableNodes = { table: element, paragraph: element.querySelector('p'), span: element.querySelector('span') } })
  const lateCell = frame.locator('tr').nth(25).locator('td').first()
  await lateCell.scrollIntoViewIfNeeded(); await lateCell.hover()
  await expect(tools.getByRole('button',{name:'在下方插入行',exact:true})).toBeVisible()
  const top = await page.locator('.canvas-viewport').evaluate(element => element.scrollTop)
  await page.screenshot({path:info.outputPath('table-hover-actions.png')})
  await tools.getByRole('button',{name:'在下方插入行',exact:true}).click()
  await expect(frame.locator('tr')).toHaveCount(32)
  await expect(peerFrame.locator('tr')).toHaveCount(32,{timeout:30_000})
  expect(await iframe.evaluate(element => element === (window as any).__tableFrame)).toBe(true)
  expect(await frame.locator('table').evaluate(element => { const saved = (window as any).__tableNodes; return saved.table === element && saved.paragraph === element.querySelector('p') && saved.span === element.querySelector('span') })).toBe(true)
  expect(Math.abs(await page.locator('.canvas-viewport').evaluate(element => element.scrollTop) - top)).toBeLessThan(4)
  const blank = frame.locator('tr').nth(26).locator('[data-hcd-inline-table-text]').first()
  await expect(blank).toHaveAttribute('contenteditable','plaintext-only')
  await blank.fill('新增行中文🙂')
  await expect(peerFrame.locator('tr').nth(26)).toContainText('新增行中文🙂')
  await frame.locator('tr').nth(26).locator('td').first().hover()
  await tools.getByRole('button',{name:'在右侧插入列',exact:true}).click()
  await expect(frame.locator('tr').nth(26).locator('td')).toHaveCount(3)
  await expect(peerFrame.locator('tr').nth(26).locator('td')).toHaveCount(3,{timeout:30_000})
  expect(await frame.locator('td[rowspan]').evaluateAll(cells => cells.filter(cell => (cell as HTMLTableCellElement).rowSpan === 2).length)).toBe(1)
  await expect(frame.locator('tr').nth(26)).toContainText('新增行中文🙂')
  await frame.locator('tr').nth(26).locator('td').nth(1).hover()
  await tools.getByRole('button',{name:'列操作',exact:true}).click()
  await expect(tools.getByRole('menuitem')).toHaveCount(3)
  await tools.getByRole('menuitem',{name:'删除当前列',exact:true}).click()
  await expect(frame.locator('tr').nth(26).locator('td')).toHaveCount(2)
  await expect(frame.locator('tr').nth(26)).toContainText('新增行中文🙂')
  await frame.locator('tr').nth(26).locator('td').first().hover()
  const beforeMenuScroll = await page.locator('.canvas-viewport').evaluate(element => element.scrollTop)
  await tools.getByRole('button',{name:'行操作',exact:true}).click()
  await expect(tools.getByRole('menuitem')).toHaveCount(3)
  expect(Math.abs(await page.locator('.canvas-viewport').evaluate(element => element.scrollTop) - beforeMenuScroll)).toBeLessThan(4)
  await page.screenshot({path:info.outputPath('table-row-delete-menu.png')})
  await tools.getByRole('menuitem',{name:'删除当前行',exact:true}).click()
  await expect(frame.locator('tr')).toHaveCount(31)
  await expect(frame.locator('table')).not.toContainText('新增行中文🙂')
  await expect(peerFrame.locator('tr')).toHaveCount(31,{timeout:30_000})
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await expect(frame.locator('tr')).toHaveCount(32)
  await expect(frame.locator('table')).toContainText('新增行中文🙂')
  await expect(peerFrame.locator('table')).toContainText('新增行中文🙂',{timeout:30_000})
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click()
  await expect(frame.locator('tr')).toHaveCount(31)
  await expect(frame.locator('table')).not.toContainText('新增行中文🙂')
  await page.reload()
  await expect(page.locator('.hcd-opaque-preview iframe').first().contentFrame().locator('tr')).toHaveCount(31)
  const headers = {Authorization:`Bearer ${token(id,'browser-user')}`}
  const beforeDelete = await (await fetch(`${apiUrl}/v1/documents/${id}/editor`,{headers})).json()
  const original = beforeDelete.blocks.find((block:any) => block.readOnlyHtml?.includes('<table'))
  await frame.locator('tr').nth(25).locator('td').first().hover()
  const deleteTop = await page.locator('.canvas-viewport').evaluate(element => element.scrollTop)
  await tools.getByRole('button',{name:'表格操作',exact:true}).click()
  expect(Math.abs(await page.locator('.canvas-viewport').evaluate(element => element.scrollTop) - deleteTop)).toBeLessThan(4)
  await tools.getByRole('menuitem',{name:'删除表格',exact:true}).click()
  await expect(page.locator('.hcd-opaque-preview iframe')).toHaveCount(0)
  await expect(peer.locator('.hcd-opaque-preview iframe')).toHaveCount(0,{timeout:30_000})
  await expect(page.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','true')
  await expect(page.locator('.hcd-editor-body')).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(frame.locator('tr')).toHaveCount(31)
  await expect(peerFrame.locator('tr')).toHaveCount(31,{timeout:30_000})
  const restored = await (await fetch(`${apiUrl}/v1/documents/${id}/editor`,{headers})).json()
  expect(restored.blocks.find((block:any) => block.blockId === original.blockId)?.blockHash).toBe(original.blockHash)
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click()
  await expect(page.locator('.hcd-opaque-preview iframe')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','true')
  await expect(page.locator('.hcd-opaque-preview iframe')).toHaveCount(0)
  await peer.close()
})

test('single cell table menus preserve the last row and column and whole-table deletion stays editable and undoable', async ({page}) => {
  await open(page,'table-only')
  const body = page.locator('.hcd-editor-body'), frame = body.locator('iframe').contentFrame()
  const tools = body.locator('[data-hcd-table-controls]')
  await expect(frame.locator('td')).toHaveCount(1)
  await frame.locator('td').hover()
  await tools.getByRole('button',{name:'行操作',exact:true}).click()
  await expect(tools.getByRole('menuitem',{name:'删除当前行',exact:true})).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(tools.getByRole('button',{name:'行操作',exact:true})).toBeFocused()
  await tools.getByRole('button',{name:'列操作',exact:true}).click()
  await expect(tools.getByRole('menuitem',{name:'删除当前列',exact:true})).toBeDisabled()
  await page.keyboard.press('Escape')
  await tools.getByRole('button',{name:'表格操作',exact:true}).click()
  await page.keyboard.press('End')
  await expect(tools.getByRole('menuitem',{name:'删除表格',exact:true})).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(body.locator('iframe')).toHaveCount(0)
  await expect(body).toHaveAttribute('contenteditable','true')
  await expect(body.locator(':scope > p')).toHaveCount(1)
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await expect(frame.locator('td')).toHaveText('仅有的单元格')
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click()
  await expect(body.locator('iframe')).toHaveCount(0)
  await body.locator('p').click(); await page.keyboard.insertText('删除后继续编辑')
  await expect(body).toContainText('删除后继续编辑')
})

test('Word opens directly with granted permissions and read credentials show saved pages', async ({page}, info) => {
  await open(page,'word-view')
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable','true')
  await expect(page.locator('.mode-switch')).toHaveCount(0)
  const paragraph = body.locator(':scope > p').filter({hasText:'COVER TITLE'}).first()
  await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' · 已授权直接编辑')
  await page.getByRole('button',{name:'视图',exact:true}).click()
  await expect(page.getByLabel('文档视图',{exact:true})).toHaveCount(0)
  await page.screenshot({path:info.outputPath('word-access-controls.png')})
  await page.getByRole('button',{name:'开始',exact:true}).click()
  await reopenWithScope(page, 'read')
  await expect(page.locator('.word-page-preview iframe').contentFrame().locator('body')).toContainText('已授权直接编辑')
  await expect(body).toHaveAttribute('contenteditable','false')
  await expect(page.locator('.mode-switch')).toHaveCount(0)
})

test('insert ribbon creates blank paragraphs and editable tables that survive collaboration and DOCX export', async ({page, context}, info) => {
  const id = 'table-insert'; await open(page, id)
  const body = page.locator('.hcd-editor-body')
  await expect(body).toHaveAttribute('contenteditable','true')
  const cover = body.locator('p').filter({hasText:'COVER TITLE'}).first(); await cover.click()
  await page.getByRole('button',{name:'插入',exact:true}).click()
  const before = await body.locator(':scope > p').count()
  await page.getByRole('button',{name:'＋ 新增段落',exact:true}).click()
  await expect(body.locator(':scope > p')).toHaveCount(before + 1)
  await expect(body).not.toContainText('新段落')
  await page.keyboard.insertText('空白段落直接输入')
  await expect(body).toContainText('空白段落直接输入')
  await page.getByRole('button',{name:'插入表格',exact:true}).click()
  const picker = page.getByRole('dialog',{name:'插入表格',exact:true})
  await expect(picker).toBeVisible()
  await picker.getByLabel('行数',{exact:true}).fill('3'); await picker.getByLabel('列数',{exact:true}).fill('4')
  await page.screenshot({path:info.outputPath('insert-table-picker.png')})
  await picker.getByRole('button',{name:'插入',exact:true}).click()
  await expect(page.locator('.hcd-opaque-preview iframe')).toHaveCount(2)
  const frame = page.locator('.hcd-opaque-preview iframe').first().contentFrame()
  await expect(frame.locator('table')).toHaveClass(/hcd-editor-table/)
  await expect(frame.locator('tr')).toHaveCount(3); await expect(frame.locator('td')).toHaveCount(12)
  await expect(frame.locator('table')).toHaveText('')
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await expect(page.locator('.hcd-opaque-preview iframe')).toHaveCount(1)
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click()
  await expect(page.locator('.hcd-opaque-preview iframe')).toHaveCount(2)
  const field = frame.locator('[data-hcd-inline-table-text]').first()
  await expect(field).toHaveAttribute('contenteditable','plaintext-only'); await field.fill('新建表格内容')
  const peer = await context.newPage(); await open(peer,id)
  await expect(peer.locator('.hcd-opaque-preview iframe').first().contentFrame().locator('table')).toContainText('新建表格内容')
  const savedResponse = page.waitForResponse(response => response.url().endsWith('/checkpoints') && response.request().method() === 'POST')
  await page.getByRole('button',{name:'保存点',exact:true}).click(); expect((await savedResponse).status()).toBe(200)
  const headers = {Authorization:`Bearer ${token(id,'browser-user')}`}
  const exported = await fetch(`${apiUrl}/v1/documents/${id}/export/docx`,{headers})
  expect(exported.status).toBe(200)
  const output = resolve(root,'inserted-table.docx'); writeFileSync(output, Buffer.from(await exported.arrayBuffer()))
  const checked = spawnSync('python3',['-c','import sys,zipfile,xml.etree.ElementTree as E\nr=E.fromstring(zipfile.ZipFile(sys.argv[1]).read("word/document.xml"))\nns={"w":"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}\nt=r.findall(".//w:tbl",ns)\nassert len(t)==2\nassert len(t[0].findall("w:tr",ns))==3\nassert len(t[0].findall("w:tr",ns)[0].findall("w:tc",ns))==4\nassert "新建表格内容" in "".join(r.itertext())\nassert "新段落" not in "".join(r.itertext())',output],{encoding:'utf8'})
  expect(checked.stderr).toBe(''); expect(checked.status).toBe(0)
  await page.reload()
  const reloaded = page.locator('.hcd-opaque-preview iframe').first().contentFrame()
  await expect(reloaded.locator('td')).toHaveCount(12); await expect(reloaded.locator('table')).toContainText('新建表格内容')
  await expect(page.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','true')
  await page.screenshot({animations:'disabled',path:info.outputPath('inserted-table-edit.png')})
  await reopenWithScope(page, 'read')
  await expect(page.locator('.word-page-preview iframe').contentFrame().locator('body')).toContainText('新建表格内容')
  await peer.close()
})

test('HTML and Markdown tables insert through guarded structure patches and hide controls in read-only mode', async ({page}) => {
  for (const id of ['table-structure-html','table-structure-md']) {
    await open(page,id)
    const active = page.locator('.document-tab-panel:not([hidden])'), headers = {Authorization:`Bearer ${token(id,'browser-user')}`}
    await expect(active.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','true')
    await active.locator('.hcd-editor-body').locator('p').last().click()
    await active.getByRole('button',{name:'插入',exact:true}).click()
    await active.getByRole('button',{name:'插入表格',exact:true}).click()
    await page.getByRole('button',{name:'2 行 × 2 列',exact:true}).click()
    const frame = active.locator('.hcd-opaque-preview iframe').contentFrame()
    await expect(frame.locator('td')).toHaveCount(4)
    const field = frame.locator('[data-hcd-inline-table-text]').first()
    await expect(field).toHaveAttribute('contenteditable','plaintext-only'); await field.fill('共享表格')
    const savedResponse = page.waitForResponse(response => response.url().endsWith('/checkpoints') && response.request().method() === 'POST')
    await active.getByRole('button',{name:'保存点',exact:true}).click(); expect((await savedResponse).status()).toBe(200)
    const projection = await (await fetch(`${apiUrl}/v1/documents/${id}/editor`,{headers})).json()
    const auth = await (await fetch(`${apiUrl}/v1/documents/${id}/auth`,{headers})).json()
    const table = projection.blocks.find((block:any) => block.readOnlyHtml?.includes('<table'))
    const patch = {schemaVersion:'hcd-patch/4',documentId:id,patchId:crypto.randomUUID(),baseRevision:projection.revision,operations:[{op:'table.edit',blockId:table.blockId,tableIndex:0,action:'insertRow',index:1,precondition:{blockHash:table.blockHash}}]}
    const requestHeaders = {...headers,'Content-Type':'application/json','X-HCD-Collaboration-Epoch':String(auth.collaborationEpoch)}
    const response = await fetch(`${apiUrl}/v1/documents/${id}/patch`,{method:'POST',headers:requestHeaders,body:JSON.stringify(patch)})
    expect(response.status, await response.text()).toBe(200)
    await expect(frame.locator('tr')).toHaveCount(3,{timeout:30_000})
    const stale = await fetch(`${apiUrl}/v1/documents/${id}/patch`,{method:'POST',headers:requestHeaders,body:JSON.stringify({...patch,patchId:crypto.randomUUID()})})
    expect(stale.status).toBe(409)
    await expect(frame.locator('tr')).toHaveCount(3)
    const tools = active.locator('[data-hcd-table-controls]')
    await field.hover(); await expect(tools.getByRole('button',{name:'表格操作',exact:true})).toBeVisible()
    await reopenWithScope(page, 'read')
    await expect(tools).toBeHidden()
    await expect(field).toHaveAttribute('contenteditable','false')
  }
})

test('editor deletion supports undo redo and retains only twenty local history steps', async ({page}) => {
  await open(page,'history-bounded')
  const body = page.locator('.hcd-editor-body')
  await expect(body).toContainText('Preview and edit this document.')
  await body.locator('p').last().click()
  await page.getByRole('button',{name:'插入',exact:true}).click()
  await page.getByRole('button',{name:'删除段落',exact:true}).click()
  await expect(body).not.toContainText('Preview and edit this document.')
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await expect(body).toContainText('Preview and edit this document.')
  await body.locator('p').last().click(); await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(body).not.toContainText('Preview and edit this document.')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body).toContainText('Preview and edit this document.')
  const depth = await body.evaluate(element => {
    const view = (element as any).editor.view
    const history = view.state.plugins.map((plugin:any) => plugin.getState(view.state)).find((value:any) => value?.undoManager)?.undoManager
    history.clear()
    for (let i=0;i<25;i++) { history.stopCapturing(); view.dispatch(view.state.tr.insertText(` ${i}`, view.state.doc.content.size-1)) }
    return history.undoStack.length
  })
  expect(depth).toBe(20)
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await expect(body).not.toContainText(' 24')
  await page.getByRole('button',{name:'↷ 重做',exact:true}).click()
  await expect(body).toContainText(' 24')
  await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  await body.locator('p').last().click(); await page.keyboard.insertText(' BRANCH')
  await expect(page.getByRole('button',{name:'↷ 重做',exact:true})).toBeDisabled()
})
