import { test, expect, type Page } from '@playwright/test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '../../../..'), editor = resolve(import.meta.dirname, '..')
const binary = process.env.OFFICECLI_BIN || resolve(repo, 'target/debug/officecli')
const secret = randomBytes(32).toString('hex'), children: ChildProcess[] = []
let root: string, apiUrl: string, uiUrl: string, model: Server
const transferInputs: { name: string; selection: { id: string; text?: string }[] }[] = []
function token(id: string, user = 'resource-user', scope = 'write') {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url'), now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ doc: id, sub: user, name: user, scope, aud: 'hcd-core', iat: now, exp: now + 3600 })}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
async function freePort() { const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const port = (server.address() as { port: number }).port; await new Promise<void>(done => server.close(() => done())); return port }
function cli(args: string[]) { const result = spawnSync(binary, args, { encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr || result.stdout) }
function start(command: string, args: string[], extra: NodeJS.ProcessEnv) {
  const env = { ...process.env, ...extra }; delete env.HCD_DATABASE_URL; delete env.HCD_S3_BUCKET; delete env.HCD_DEFAULT_THEME
  const child = spawn(command, args, { cwd: editor, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
  const log = createWriteStream(resolve(root, `process-${child.pid}.log`)); child.stdout?.pipe(log); child.stderr?.pipe(log)
}
async function read(id: string, route: string) { const response = await fetch(`${apiUrl}/v1/documents/${id}${route}`, { headers: { Authorization: `Bearer ${token(id)}` } }); expect(response.ok).toBeTruthy(); return response.json() }
async function open(page: Page, id: string, user = 'resource-user', scope = 'write') {
  if (!page.url().startsWith(uiUrl)) await page.goto(`${uiUrl}/?locale=zh-CN`)
  if (await page.getByRole('button', { name: '文档工作台', exact: true }).isVisible()) await page.getByRole('button', { name: '文档工作台', exact: true }).click()
  await page.getByPlaceholder('doc-…').fill(id)
  await page.getByPlaceholder('粘贴短期令牌', { exact: true }).fill(token(id, user, scope))
  await page.getByRole('button', { name: '打开文档', exact: true }).click()
  await expect(page.locator('.document-tab-panel:not([hidden]) .workspace')).toBeVisible({ timeout: 60_000 })
}
const active = (page: Page) => page.locator('.document-tab-panel:not([hidden])')
async function tab(page: Page, id: string) { await page.locator(`.document-tabs button[title="${id}"]`).click(); await expect(active(page)).toHaveAttribute('data-document-id', id) }
async function closeTab(page: Page, id: string) {
  await page.getByRole('button', { name: `关闭 ${id}`, exact: true }).click()
  await expect(page.locator(`.document-tab-panel[data-document-id="${id}"]`)).toHaveCount(0)
}
async function reopenTab(page: Page, id: string) {
  await page.getByRole('button', { name: '管理标签页', exact: true }).click()
  await page.getByRole('dialog', { name: '管理标签页' }).getByRole('button', { name: `重新打开 ${id}`, exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', id)
}
async function boxCanvas(page: Page) {
  await active(page).getByRole('button', { name: '框选区域', exact: true }).click()
  const surface = (await active(page).locator('.canvas-surface').boundingBox())!
  await page.mouse.move(surface.x + 230, surface.y + 245)
  await page.mouse.down()
  await page.mouse.move(surface.x + 570, surface.y + 475, { steps: 8 })
  await page.mouse.up()
}
async function insert(page: Page, id: string, range?: string, blockId?: string) {
  await active(page).getByRole('button', { name: '插入资源', exact: true }).click()
  await page.getByLabel('引用源文件', { exact: true }).selectOption(id)
  if (range) { await expect(page.getByLabel('引用工作表', { exact: true }).locator('option')).not.toHaveCount(0); await page.getByLabel('引用表格区域', { exact: true }).fill(range) }
  else { await expect(page.getByLabel('引用段落', { exact: true }).locator('option')).not.toHaveCount(1); await page.getByLabel('引用段落', { exact: true }).selectOption(blockId || (await page.getByLabel('引用段落', { exact: true }).locator('option').filter({ hasText: '白板引用保持关联' }).getAttribute('value'))!) }
  await page.getByRole('button', { name: '插入白板', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '插入资源引用' })).toBeHidden()
  const card = active(page).locator(`.resource-card[data-resource-document="${id}"]`).last()
  await expect(card).toBeVisible()
  const bounds = (await card.boundingBox())!; await page.mouse.click(bounds.x + 20, bounds.y + 20)
  await expect(active(page).getByRole('button', { name: 'AI 编辑源内容', exact: true })).toBeVisible()
}

test.beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), 'officecli-resources-'))
  const service = resolve(root, 'service'), board = resolve(root, '资源白板.excalidraw'), document = resolve(root, '方案文档.txt'), sheet = resolve(root, '预算表.xlsx')
  writeFileSync(board, JSON.stringify({ type: 'excalidraw', version: 2, elements: [], files: {}, appState: { viewBackgroundColor: '#faf9f6' } }))
  writeFileSync(document, '产品工作空间\n\n以文档和表格为源，白板引用保持关联。\n\n共享上下文，同时保留精确的编辑目标。')
  const reading = resolve(root, '长文档.txt')
  const nativeBoard = resolve(root, '对象白板.excalidraw')
  writeFileSync(nativeBoard, JSON.stringify({ type: 'excalidraw', version: 2, files: {}, appState: {}, elements: [
    { id: 'selected-shape', type: 'rectangle', x: 0, y: 0, width: 300, height: 200, strokeColor: '#995443', backgroundColor: '#e2a47b', fillStyle: 'solid' },
  ] }))
  const ideas = resolve(root, '头脑风暴.excalidraw'), lesson = resolve(root, '讲解来源.md')
  writeFileSync(ideas, JSON.stringify({ type: 'excalidraw', version: 2, files: {}, appState: {}, elements: [
    { id: 'idea', type: 'text', x: 0, y: 0, width: 300, height: 36, text: '上线前补做三轮可用性测试', fontSize: 24, fontFamily: 2, lineHeight: 1.25 },
  ] }))
  writeFileSync(lesson, '# 发布方案\n\n前缀🚀先灰度，再放量。\n\n观察错误率，后缀。\n\n尚未选择的保密附录。')
  writeFileSync(reading, Array.from({ length: 72 }, (_, index) => `第 ${index + 1} 段。每个标签页应保留滚动位置与选区，方便继续整理手账、文档和表格。`).join('\n\n'))
  cli(['create', sheet])
  for (const [cell, value] of [['A1', '项目'], ['B1', '预算'], ['A2', '设计'], ['B2', '1200'], ['A3', '研发'], ['B3', '3600']]) cli(['set', sheet, `/Sheet1/${cell}`, '--prop', `value=${value}`])
  for (const [id, source] of [['resource-board', board], ['resource-doc', document], ['resource-sheet', sheet], ['resource-word', resolve(repo, 'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx')]]) cli(['hdoc', 'import', source, '--output', resolve(service, `${id}.hcd`), '--document-id', id])
  for (const [id, source] of [['tab-board', board], ['tab-stale-board', board], ['tab-native-board', nativeBoard], ['tab-reading', reading]]) cli(['hdoc', 'import', source, '--output', resolve(service, `${id}.hcd`), '--document-id', id])
  for (const [id, source] of [['transfer-ideas', ideas], ['transfer-lesson', lesson], ['transfer-destination', nativeBoard],
    ['transfer-word', resolve(repo, 'examples/hdoc/editor/e2e/fixtures/word-page-layout.docx')]]) {
    cli(['hdoc', 'import', source, '--output', resolve(service, `${id}.hcd`), '--document-id', id])
  }
  const apiPort = await freePort(), collabPort = await freePort(), uiPort = await freePort()
  apiUrl = `http://127.0.0.1:${apiPort}`; uiUrl = `http://127.0.0.1:${uiPort}`
  const flowchart = {
    title: '灰度发布流程', layout: 'flowchart', items: [],
    diagram: { groups: [], nodes: [
      { id: 'canary', title: '启动灰度', body: '先小范围发布。', kind: 'terminal', group: null },
      { id: 'observe', title: '观察错误率', body: '灰度阶段关注错误率。', kind: 'process', group: null },
      { id: 'release', title: '放量', body: '按方案扩大发布范围。', kind: 'terminal', group: null },
    ], edges: [
      { from: 'canary', to: 'observe', label: '灰度期间', kind: 'arrow' },
      { from: 'observe', to: 'release', label: '随后', kind: 'arrow' },
    ] },
  }
  model = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const name = body.tool_choice?.name
      let output: unknown[] = [{ type: 'message', content: [{ type: 'output_text', text: '已收到指定源文件和选区。本次为路由验收，不修改内容。' }] }]
      if (name === 'hcd_draft_document_from_canvas' || name === 'hcd_draft_canvas_from_document') {
        const { selection, request } = JSON.parse(body.input[0].content)
        transferInputs.push({ name, selection })
        const sources = selection.map((item: { id: string }) => item.id)
        const visual = { style: 'studio', palette: 'ocean', paper: 'plain', brush: 'ink', stickers: [] }
        const draft = name === 'hcd_draft_document_from_canvas'
          ? { title: '上线讨论纪要', sections: [{ heading: '待办事项', paragraphs: ['上线前补做三轮可用性测试。'], bullets: ['负责人待确认'], sources }] }
          : { title: '发布方案讲解', sections: [
            { composition: { title: '发布总览', layout: 'grid', diagram: null, visual, items: [{ title: '稳妥发布', body: '先灰度，再放量。', kind: 'card' }] }, sources: [sources[0]] },
            { composition: { ...flowchart, visual }, sources },
          ] }
        output = [{ type: 'function_call', name, arguments: JSON.stringify(draft), call_id: randomUUID() }]
        if (request === '请整理上线前的待办') await new Promise(done => setTimeout(done, 1500))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'completed', output }))
    } catch { res.writeHead(400).end() }
  })
  await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
  const env = { HCD_TOKEN_SECRET: secret, HCD_API_URL: apiUrl, HCD_API_TARGET: apiUrl, HCD_COLLAB_PORT: String(collabPort), VITE_HCD_COLLAB_URL: `ws://127.0.0.1:${collabPort}`, HCD_VITE_CACHE_DIR: resolve(root, 'vite-cache'), HCD_AI_ENABLED: 'true', OPENAI_API_KEY: 'resource-test-only', HCD_OPENAI_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, HCD_OPENAI_MODEL: 'resource-test' }
  start(binary, ['hdoc', 'serve', '--root', service, '--bind', `127.0.0.1:${apiPort}`], env)
  await expect.poll(async () => { try { return (await fetch(`${apiUrl}/health`)).status } catch { return 0 } }).toBe(200)
  start(resolve(editor, 'node_modules/.bin/tsx'), ['sidecar.ts'], env)
  start(resolve(editor, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], env)
  await expect.poll(async () => { try { return (await fetch(uiUrl)).status } catch { return 0 } }, { timeout: 30_000 }).toBe(200)
})
test.afterAll(() => { for (const child of children) child.kill('SIGTERM'); model?.close(); console.log(`Resource acceptance artifacts: ${root}`) })

test('document references persist, locate a paragraph and retain AI ownership across tabs', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await open(page, 'resource-doc'); await expect(active(page).locator('.tiptap')).toContainText('白板引用保持关联')
  await open(page, 'resource-board'); await insert(page, 'resource-doc')
  await expect(active(page).locator('.resource-card-preview')).toContainText('白板引用保持关联')
  const scene = (await read('resource-board', '/canvas')).scene
  const reference = scene.elements.find((element: any) => element.type === 'embeddable').customData.officeResource
  expect(reference.anchor.kind).toBe('document'); expect(reference.anchor.blockId).toBeTruthy()
  expect(JSON.stringify(reference)).not.toMatch(/token|白板引用保持关联/)
  await active(page).getByRole('button', { name: 'AI 编辑源内容', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-doc')
  await expect(page.getByRole('region', { name: '资源引用定位' })).toContainText('已进入源文件')
  const input = active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })
  await expect(input).toHaveValue('请结合这处白板引用，继续编辑源文档。')
  await input.fill('保留白板来源目标，核对这段文档。')
  await page.getByRole('button', { name: '返回白板', exact: true }).click()
  await expect(active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })).toHaveValue('保留白板来源目标，核对这段文档。')
  await expect(active(page).getByLabel('AI 编辑目标')).toContainText('resource-doc')
  const posted = page.waitForRequest(req => req.url().endsWith('/agent-runs') && req.method() === 'POST')
  await active(page).getByRole('button', { name: '启动 Agent', exact: true }).click()
  const request = await posted
  expect(request.url()).toContain('/resource-doc/agent-runs'); expect(request.postDataJSON().target.blockId).toBe(reference.anchor.blockId)
  await expect(active(page).locator('.agent-task-run.run-completed')).toContainText('保留白板来源目标')
  await page.screenshot({ path: info.outputPath('resource-document-global-ai.png'), fullPage: true })
  await page.reload(); await expect(active(page).locator('.resource-card-preview')).toContainText('白板引用保持关联')
  expect(errors).toEqual([])
})

test('spreadsheet range opens and selects the source, with scoped AI dispatch', async ({ page }, info) => {
  await open(page, 'resource-sheet'); await expect(active(page).locator('[data-grid-pending]')).toHaveCount(0)
  await open(page, 'resource-board'); await insert(page, 'resource-sheet', 'A1:B3')
  const card = active(page).locator('.resource-card[data-resource-document="resource-sheet"]')
  await expect(card).toContainText('3600'); await expect(card).toContainText('A1:B3')
  await active(page).getByRole('button', { name: 'AI 编辑源内容', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-sheet')
  await expect(page.getByRole('region', { name: '资源引用定位' })).toContainText('已进入源文件')
  await expect(active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })).toHaveValue(/A1:B3/)
  await expect(active(page).getByLabel('选中单元格', { exact: true })).toHaveText('A1')
  await page.screenshot({ path: info.outputPath('resource-sheet-located.png'), fullPage: true })
  const formula = active(page).getByRole('textbox', { name: '单元格内容或公式', exact: true })
  await formula.fill('项目已更新'); await formula.press('Enter')
  await expect.poll(async () => (await read('resource-sheet', '/sheets/0')).cells.find((cell: any) => cell.address === 'A1').text).toBe('项目已更新')
  await tab(page, 'resource-board')
  const posted = page.waitForRequest(req => req.url().endsWith('/agent-runs') && req.method() === 'POST')
  await active(page).getByRole('button', { name: '启动 Agent', exact: true }).click()
  const request = await posted
  expect(request.url()).toContain('/resource-sheet/agent-runs'); expect(request.postDataJSON().target.cells).toHaveLength(6)
  await expect(card).toContainText('项目已更新')
  await page.screenshot({ path: info.outputPath('resource-sheet-preview.png'), fullPage: true })
  await tab(page, 'resource-sheet')
  await active(page).getByRole('button', { name: '插入', exact: true }).click()
  await active(page).getByRole('button', { name: '在选中行前插入 1 行', exact: true }).click()
  await expect.poll(async () => (await read('resource-sheet', '/sheets/0')).cells.find((cell: any) => cell.text === '项目已更新').address).toBe('A2')
  await tab(page, 'resource-board')
  await expect(card).toContainText('引用位置已变化')
  await expect(card.getByRole('button', { name: '进入源文件', exact: true })).toBeDisabled()
})

test('board access does not grant source access or merge another account AI', async ({ page }) => {
  await open(page, 'resource-doc'); await open(page, 'resource-board'); await insert(page, 'resource-doc')
  await page.evaluate(() => sessionStorage.clear()); await page.goto('about:blank')
  await open(page, 'resource-board', 'viewer', 'read')
  await expect(active(page).locator('.resource-card').first()).toContainText('打开源文件')
  await expect(active(page).locator('.resource-card-preview').filter({ hasText: '白板引用保持关联' })).toHaveCount(0)
  await open(page, 'resource-doc', 'different-user')
  await tab(page, 'resource-board')
  await expect(active(page).locator('.resource-card').first()).toContainText('打开源文件')
  await expect(active(page).locator('.agent-task-run')).toHaveCount(0)
  await open(page, 'resource-doc', 'viewer', 'read'); await tab(page, 'resource-board')
  const card = active(page).locator('.resource-card[data-resource-document="resource-doc"]').last()
  await expect(card).toContainText('白板引用保持关联')
  await expect(card.getByRole('button', { name: '让 AI 编辑引用', exact: true })).toHaveCount(0)
})


test('Word paragraph references locate their stable source block and refresh after source edits', async ({ page }, info) => {
  await open(page, 'resource-word')
  const projection = await read('resource-word', '/editor')
  const block = projection.blocks.find((item: any) => item.region === 'body' && item.content.inlines.some((inline: any) => inline.text?.trim()))
  expect(block).toBeTruthy()
  await open(page, 'resource-board'); await insert(page, 'resource-word', undefined, block.blockId)
  const card = active(page).locator('.resource-card[data-resource-document="resource-word"]')
  await expect(card).toContainText(block.content.inlines.map((inline: any) => inline.text).join(''))
  await active(page).getByRole('button', { name: '进入引用源文件', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-word')
  await expect(page.getByRole('region', { name: '资源引用定位' })).toContainText('已进入源文件')
  const paragraph = active(page).locator(`.tiptap [data-hcd-block-id="${block.blockId}"]`)
  await paragraph.click(); await page.keyboard.press('End'); await page.keyboard.insertText(' 引用更新验收')
  await active(page).getByRole('button', { name: '保存点', exact: true }).click()
  await expect.poll(async () => JSON.stringify((await read('resource-word', '/editor')).blocks.find((item: any) => item.blockId === block.blockId))).toContain('引用更新验收')
  await page.getByRole('button', { name: '返回白板', exact: true }).click()
  await expect(card).toContainText('引用更新验收')
  await page.screenshot({ path: info.outputPath('resource-word-live-update.png'), fullPage: true })
})


test('closing the AI target blocks submission until the user explicitly chooses a new target', async ({ page }) => {
  await open(page, 'resource-doc')
  await active(page).getByRole('textbox', { name: 'Agent 任务', exact: true }).fill('保留这个未发送的编辑任务')
  await open(page, 'resource-board')
  await expect(active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })).toHaveValue('保留这个未发送的编辑任务')
  await page.getByRole('button', { name: '关闭 resource-doc', exact: true }).click()
  await expect(active(page).getByLabel('AI 编辑目标')).toContainText('目标文件已关闭')
  await expect(active(page).getByRole('button', { name: '启动 Agent', exact: true })).toHaveCount(0)
  await active(page).getByRole('button', { name: '使用当前文件', exact: true }).click()
  await expect(active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })).toHaveValue('保留这个未发送的编辑任务')
  await expect(active(page).getByLabel('AI 编辑目标')).toContainText('resource-board')
})

test('tab manager pins, reorders, searches and restores saved tabs and recent files', async ({ page }, info) => {
  await open(page, 'resource-doc')
  await expect(active(page).locator('.tiptap')).toHaveAttribute('contenteditable', 'true')
  await open(page, 'resource-sheet')
  await open(page, 'resource-board')
  const management = page.getByRole('dialog', { name: '管理标签页' })
  const strip = page.locator('.document-tab-strip')
  const order = async () => strip.locator('[data-tab-id]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.tabId))
  await page.getByRole('button', { name: '管理标签页', exact: true }).click()
  await management.getByRole('button', { name: '固定 resource-board', exact: true }).click()
  await management.getByRole('button', { name: '左移 resource-sheet', exact: true }).click()
  expect(await order()).toEqual(['resource-board', 'resource-sheet', 'resource-doc'])
  await management.getByRole('textbox', { name: '搜索标签页' }).fill('XLSX')
  await expect(management.locator('.document-tab-result')).toHaveCount(1)
  await expect(management.locator('.document-tab-result')).toContainText('resource-sheet')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(strip.locator('[data-tab-id]')).toHaveCount(3)
  expect(await order()).toEqual(['resource-board', 'resource-sheet', 'resource-doc'])
  await expect(strip.locator('[data-tab-id=resource-board]')).toHaveAttribute('data-pinned', 'true')

  await tab(page, 'resource-sheet')
  await active(page).locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first().click({ position: { x: 70, y: 35 } })
  const formula = active(page).getByRole('textbox', { name: '单元格内容或公式', exact: true })
  await formula.fill('=123+456')
  await expect(active(page).getByRole('button', { name: '取消输入', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭 resource-sheet', exact: true }).click()
  await expect(page.locator('.document-tab-notice')).toContainText('请先确认单元格或公式编辑')
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-sheet')
  await expect(formula).toHaveValue('=123+456')
  await active(page).getByRole('button', { name: '取消输入', exact: true }).click()
  await tab(page, 'resource-doc')
  const text = active(page).locator('.tiptap')
  await expect(text).toHaveAttribute('contenteditable', 'true')
  await active(page).getByRole('textbox', { name: 'Agent 任务', exact: true }).fill('重新打开后继续此草稿')
  await text.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(' 标签关闭保存验证')
  await page.getByRole('button', { name: '关闭 resource-doc', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-sheet')
  expect(JSON.stringify(await read('resource-doc', '/editor'))).toContain('标签关闭保存验证')
  await page.getByRole('button', { name: '管理标签页', exact: true }).click()
  await management.getByRole('button', { name: '重新打开 resource-doc', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-doc')
  await expect(active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })).toHaveValue('重新打开后继续此草稿')
  await page.getByRole('button', { name: '关闭 resource-doc', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-sheet')
  await page.reload()
  await page.getByRole('button', { name: '管理标签页', exact: true }).click()
  await expect(management.getByRole('button', { name: '重新打开 resource-doc', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('workspace-tab-manager.png'), fullPage: true })
  const authorization = page.waitForRequest(request => request.url().endsWith('/resource-doc/auth'))
  await management.getByRole('button', { name: '重新打开 resource-doc', exact: true }).click()
  await authorization
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-doc')
  await expect(active(page).locator('.tiptap')).toContainText('标签关闭保存验证')
})

test('drag, group and batch close keep pinned tabs and unresolved spreadsheet input', async ({ page }, info) => {
  await open(page, 'resource-doc')
  await open(page, 'resource-sheet')
  await open(page, 'resource-board')
  const strip = page.locator('.document-tab-strip')
  const label = (id: string) => strip.locator(`[data-tab-id="${id}"]`)
  const order = () => strip.locator('[data-tab-id]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.tabId))
  await label('resource-doc').dragTo(label('resource-sheet'), { targetPosition: { x: 125, y: 17 } })
  await expect.poll(order).toEqual(['resource-sheet', 'resource-doc', 'resource-board'])
  const openManager = () => page.getByRole('button', { name: '管理标签页', exact: true }).click()
  const manager = page.getByRole('dialog', { name: '管理标签页' })
  const select = (id: string) => manager.getByRole('checkbox', { name: `选择标签 ${id}`, exact: true }).check()
  await openManager()
  await select('resource-doc')
  await manager.getByLabel('移动到标签组').selectOption('new')
  await manager.getByLabel('标签组名称').fill('阅读资料')
  await manager.getByRole('button', { name: '创建', exact: true }).click()
  await manager.getByRole('button', { name: '固定 resource-board', exact: true }).click()
  await page.keyboard.press('Escape')
  const group = strip.getByRole('button', { name: '阅读资料', exact: true })
  await label('resource-sheet').dragTo(group)
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(label('resource-sheet')).toHaveCount(0)
  await expect(label('resource-doc')).toHaveCount(0)
  await page.reload()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(label('resource-board')).toHaveAttribute('data-pinned', 'true')
  await group.click()
  await expect(label('resource-sheet')).toBeVisible()
  await tab(page, 'resource-sheet')
  const grid = active(page).locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await grid.click({ position: { x: 70, y: 35 } })
  const formula = active(page).getByRole('textbox', { name: '单元格内容或公式', exact: true })
  await formula.fill('=81+19')
  await expect(active(page).getByRole('button', { name: '取消输入', exact: true })).toBeVisible()

  await openManager()
  await select('resource-board')
  await select('resource-doc')
  await select('resource-sheet')
  await page.screenshot({ path: info.outputPath('grouped-tabs.png'), fullPage: true })
  await manager.getByRole('button', { name: '关闭所选', exact: true }).click()
  await expect(manager.getByRole('button', { name: '重新打开 resource-doc', exact: true })).toBeVisible()
  await expect(manager.getByRole('alert')).toContainText('请先取消固定')
  await expect(manager.getByRole('alert')).toContainText('请先确认单元格或公式编辑')
  await page.keyboard.press('Escape')
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-sheet')
  await expect(formula).toHaveValue('=81+19')
  await active(page).getByRole('button', { name: '取消输入', exact: true }).click()
  await openManager()
  await manager.getByRole('button', { name: '关闭整组 阅读资料', exact: true }).click()
  await expect(manager.getByRole('button', { name: '重新打开 resource-sheet', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-board')
})

test('board, document and spreadsheet restore view and AI drafts after tab switches, reload and reopening', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page, 'tab-board')
  await boxCanvas(page)
  await active(page).getByRole('button', { name: '让 AI 修改选区', exact: true }).click()
  const draft = () => active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })
  await draft().fill('白板选区草稿')
  await active(page).locator('.zoom-in-button').click()
  const canvas = active(page).locator('.canvas-surface')
  const boundary = active(page).locator('.canvas-region-boundary')
  const beforePan = await boundary.getAttribute('style')
  const surface = (await canvas.boundingBox())!
  await page.mouse.move(surface.x + 305, surface.y + 228)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(surface.x + 405, surface.y + 308, { steps: 6 })
  await page.mouse.up({ button: 'middle' })
  await expect(boundary).not.toHaveAttribute('style', beforePan!)
  const boardZoom = await active(page).locator('.reset-zoom-button').innerText()
  const boardRegion = await boundary.getAttribute('style')

  await open(page, 'tab-reading')
  const doc = active(page).locator('.hcd-editor-body')
  await expect(doc).toHaveAttribute('contenteditable', 'true')
  const paragraph = doc.locator('p').filter({ hasText: '第 37 段。' })
  await paragraph.click()
  // Select through the browser so ProseMirror observes a real selection change.
  await paragraph.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain('第 37 段')
  await paragraph.click({ button: 'right', position: { x: 42, y: 10 } })
  await page.getByRole('menuitem', { name: '用 Agent 修改…', exact: true }).click()
  await draft().fill('文档草稿')
  await expect(active(page).locator('.canvas-viewport')).toBeVisible()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const docScroll = await active(page).locator('.canvas-viewport').evaluate(element => element.scrollTop)
  expect(docScroll).toBeGreaterThan(0)

  await open(page, 'resource-sheet')
  const grid = active(page).locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(grid).toBeVisible()
  const rowLabels = () => grid.evaluate(element => {
    const canvas = element as HTMLCanvasElement
    const pixels = canvas.getContext('2d')!.getImageData(2, 48, 38, 130).data
    return Array.from(pixels).reduce((hash, pixel) => (Math.imul(hash, 31) + pixel) | 0, 0)
  })
  const oldRows = await rowLabels()
  await grid.hover({ position: { x: 165, y: 130 } })
  await page.mouse.wheel(0, 570)
  await expect.poll(rowLabels).not.toBe(oldRows)
  await grid.click({ button: 'right', position: { x: 165, y: 130 } })
  const address = active(page).getByLabel('选中单元格', { exact: true })
  await expect(address).not.toHaveText('A1')
  const cell = await address.innerText(), rows = await rowLabels()
  const editRange = page.getByRole('menuitem', { name: '用 Agent 修改选区…', exact: true })
  await expect(editRange).toBeEnabled()
  await editRange.click()
  await draft().fill('表格草稿')

  const verify = {
    'tab-board': async () => {
      await expect(draft()).toHaveValue('白板选区草稿')
      await expect(active(page).locator('.reset-zoom-button')).toHaveText(boardZoom)
      await expect(active(page).locator('.canvas-region-boundary')).toHaveAttribute('style', boardRegion!)
    },
    'tab-reading': async () => {
      await expect(draft()).toHaveValue('文档草稿')
      await expect(active(page).locator('.hcd-inactive-selection')).toContainText('第 37 段')
      await expect.poll(() => active(page).locator('.canvas-viewport').evaluate(element => element.scrollTop)).toBe(docScroll)
    },
    'resource-sheet': async () => {
      await expect(draft()).toHaveValue('表格草稿')
      await expect(address).toHaveText(cell)
      await expect.poll(rowLabels).toBe(rows)
    },
  }
  const ids = ['tab-board', 'tab-reading', 'resource-sheet'] as const
  for (const id of ids) { await tab(page, id); await verify[id]() }
  await page.reload()
  await expect(active(page)).toHaveAttribute('data-document-id', 'resource-sheet')
  for (const id of ids) { await tab(page, id); await verify[id]() }
  for (const id of ids) {
    await closeTab(page, id)
    if (id === 'tab-reading') await page.reload()
    await reopenTab(page, id)
    await verify[id]()
    await expect(active(page).getByLabel('AI 编辑目标')).toContainText(id)
  }
  await tab(page, 'tab-reading')
  await page.screenshot({ path: info.outputPath('restored-tab-draft.png'), fullPage: true })
  for (const id of ids) {
    await tab(page, id)
    const response = page.waitForResponse(value => value.url().endsWith(`/${id}/agent-runs`) && value.request().method() === 'POST')
    await active(page).getByRole('button', { name: '启动 Agent', exact: true }).click()
    const sent = await response
    expect(sent.status()).toBe(202)
    const { target, targetVersion } = sent.request().postDataJSON()
    expect(targetVersion).toEqual({ revision: (await read(id, '')).revision, collaborationEpoch: (await read(id, '/auth')).collaborationEpoch })
    if (id === 'tab-board') expect(target.canvas.region.width).toBeGreaterThan(0)
    if (id === 'tab-reading') expect(target.selectedText).toContain('第 37 段')
    if (id === 'resource-sheet') expect(target.range).toBe(cell)
    await expect(draft()).toHaveValue('')
  }
  await page.reload()
  await expect(draft()).toHaveValue('')
})

test('the native canvas object selection survives a reload and a recently closed reopen', async ({ page }) => {
  const id = 'tab-native-board'
  await open(page, id)
  const surface = active(page).locator('.excalidraw canvas.interactive')
  await expect(surface).toBeVisible()
  await surface.click()
  const edit = () => active(page).getByRole('button', { name: '让 AI 修改选区', exact: true })
  await edit().click()
  const draft = () => active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })
  await draft().fill('调整所选矩形')
  await page.reload()
  await expect(edit()).toBeVisible()
  await expect(draft()).toHaveValue('调整所选矩形')
  await closeTab(page, id)
  await reopenTab(page, id)
  await expect(edit()).toBeVisible()
  const response = page.waitForResponse(value => value.url().endsWith(`/${id}/agent-runs`) && value.request().method() === 'POST')
  await active(page).getByRole('button', { name: '启动 Agent', exact: true }).click()
  const sent = await response
  expect(sent.status()).toBe(202)
  expect(sent.request().postDataJSON().target.canvas.elementIds).toEqual(['selected-shape'])
})

test('a changed source keeps its draft, requires reselection and rejects a version race at submission', async ({ page }) => {
  const id = 'tab-stale-board'
  const change = async () => {
    const snapshot = await read(id, '/canvas')
    const response = await fetch(`${apiUrl}/v1/documents/${id}/canvas/patch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token(id, 'another-editor')}`, 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(snapshot.collaborationEpoch) },
      body: JSON.stringify({ schemaVersion: 'officecli-canvas/1', documentId: id, baseRevision: snapshot.revision, patchId: randomUUID(),
        operations: [{ op: 'element.add', element: { id: randomUUID(), type: 'rectangle', x: 900 + snapshot.revision * 200, y: 100, width: 100, height: 80 } }] }),
    })
    expect(response.status).toBe(200)
  }
  const draft = () => active(page).getByRole('textbox', { name: 'Agent 任务', exact: true })
  const send = () => active(page).getByRole('button', { name: '启动 Agent', exact: true })
  await open(page, id)
  await boxCanvas(page)
  await active(page).getByRole('button', { name: '让 AI 修改选区', exact: true }).click()
  await draft().fill('只调整该区域的标题')
  await closeTab(page, id)
  await change()
  await reopenTab(page, id)
  await expect(draft()).toHaveValue('只调整该区域的标题')
  await expect(active(page).getByText(/原选区需要重新确认/)).toBeVisible()
  await expect(send()).toBeDisabled()
  await active(page).getByRole('button', { name: '取消区域', exact: true }).click()
  await boxCanvas(page)
  await active(page).getByRole('button', { name: '让 AI 修改选区', exact: true }).click()
  await expect(draft()).toHaveValue('只调整该区域的标题')
  await page.reload()
  await expect(send()).toBeEnabled()
  await page.route(`**/${id}/agent-runs`, async route => {
    if (route.request().method() === 'POST') await change()
    await route.continue()
  })
  const rejected = page.waitForResponse(value => value.url().endsWith(`/${id}/agent-runs`) && value.request().method() === 'POST')
  await send().click()
  expect((await rejected).status()).toBe(409)
  await expect(send()).toBeDisabled()
  await expect(draft()).toHaveValue('只调整该区域的标题')
  expect((await read(id, '/agent-runs')).runs).toHaveLength(0)
  await closeTab(page, id)
  await open(page, id, 'different-account')
  await expect(active(page).locator('.canvas-region-boundary')).toHaveCount(0)
  const ai = active(page).getByRole('button', { name: 'AI 协作', exact: true })
  if (await ai.getAttribute('aria-pressed') !== 'true') await ai.click()
  await expect(draft()).toHaveValue('')
})

const transferPanel = (page: Page) => active(page).getByRole('region', { name: '跨文件生成' })
async function selectBoardIdea(page: Page) {
  const surface = active(page).locator('.excalidraw canvas.interactive')
  await expect(surface).toBeVisible()
  await surface.click()
  await active(page).getByRole('button', { name: '整理为文档', exact: true }).click()
  await expect(transferPanel(page)).toBeVisible()
}

async function selectLessonText(page: Page) {
  const editor = active(page).locator('.hcd-editor-body')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  const start = editor.locator('p').filter({ hasText: '前缀🚀' })
  await start.click()
  const point = await start.evaluate(paragraph => {
    const range = document.createRange()
    range.setStart(paragraph.firstChild!, '前缀'.length)
    range.setEnd(paragraph.nextElementSibling!.firstChild!, '观察错误率，'.length)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    const rect = range.getClientRects()[0]
    return { x: rect.left + 8, y: rect.top + rect.height / 2 }
  })
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain('🚀先灰度')
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await page.getByRole('menuitem', { name: '在白板讲解', exact: true }).click()
  await expect(transferPanel(page)).toBeVisible()
}

test('a whiteboard selection creates a reviewable Word draft and returns to the original idea', async ({ page }, info) => {
  const board = 'transfer-ideas', document = 'transfer-word'
  await open(page, document)
  await expect(active(page).locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
  const before = await read(document, '')
  await open(page, board)
  await selectBoardIdea(page)
  await transferPanel(page).getByRole('textbox', { name: '生成要求', exact: true }).fill('请整理上线前的待办')
  const submit = page.waitForResponse(response => response.url().endsWith(`/${board}/selection-transfers`) && response.request().method() === 'POST')
  await transferPanel(page).getByRole('button', { name: '生成预览', exact: true }).click()
  const started = await submit
  expect(started.status()).toBe(202)
  const taskId = started.request().postDataJSON().id
  await page.reload()
  await expect(transferPanel(page)).toContainText('负责人待确认')
  expect(transferInputs.at(-1)?.selection.map(item => [item.id, item.text])).toEqual([['idea', '上线前补做三轮可用性测试']])
  expect((await read(document, '')).revision).toBe(before.revision)
  await expect(transferPanel(page)).toContainText('上线讨论纪要')
  await page.screenshot({ path: info.outputPath('whiteboard-to-word-preview.png') })
  await transferPanel(page).getByRole('button', { name: '写入文档', exact: true }).click()
  await expect(transferPanel(page)).toContainText('已应用')
  await transferPanel(page).getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', document)
  await expect(active(page).locator('.hcd-editor-body')).toContainText('上线讨论纪要')
  await expect(active(page).getByRole('link', { name: '查看白板来源', exact: true })).toBeVisible()
  const retry = await fetch(`${apiUrl}/v1/documents/${board}/selection-transfers/${taskId}/apply`, {
    method: 'POST', headers: { Authorization: `Bearer ${token(board)}`, 'x-hcd-target-authorization': `Bearer ${token(document)}` },
  })
  expect(retry.ok).toBeTruthy()
  expect((await retry.json()).receipt.revision).toBe(before.revision + 1)
  expect((await read(document, '')).revision).toBe(before.revision + 1)
  const denied = await fetch(`${apiUrl}/v1/documents/${board}/selection-transfers/${taskId}/source?section=0`, {
    headers: { Authorization: `Bearer ${token(board, 'another-account', 'read')}` },
  })
  expect(denied.status).toBe(403)
  await active(page).getByRole('link', { name: '查看白板来源', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', board)
  await expect(active(page).getByRole('button', { name: '整理为文档', exact: true })).toBeVisible()
})

test('a partial multi-paragraph selection appends editable teaching sections and locates its original text', async ({ page }, info) => {
  const source = 'transfer-lesson', board = 'transfer-destination'
  await open(page, board)
  await expect(active(page).locator('.excalidraw canvas.interactive')).toBeVisible()
  const before = await read(board, '/canvas')
  await open(page, source)
  await selectLessonText(page)
  await transferPanel(page).getByRole('button', { name: '生成预览', exact: true }).click()
  await expect(transferPanel(page)).toContainText('发布方案讲解')
  expect(transferInputs.at(-1)?.selection.map(item => item.text)).toEqual(['🚀先灰度，再放量。', '观察错误率，'])
  expect((await read(board, '/canvas')).revision).toBe(before.revision)
  await transferPanel(page).getByRole('button', { name: '追加到白板', exact: true }).click()
  await expect(transferPanel(page)).toContainText('已应用')
  const after = await read(board, '/canvas')
  expect(after.revision).toBe(before.revision + 1)
  expect(after.scene.elements.find((item: { id: string }) => item.id === 'selected-shape')).toEqual(before.scene.elements[0])
  expect(after.scene.elements.some((item: { type: string }) => item.type === 'arrow')).toBe(true)
  expect(after.scene.elements.some((item: { link?: string }) => item.link?.includes(`#officecli-transfer/${source}/`))).toBe(true)
  await transferPanel(page).getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', board)
  await expect(active(page).getByRole('button', { name: '查看原文', exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath('document-to-teaching-board.png') })
  await active(page).getByRole('button', { name: '查看原文', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', source)
  await expect(active(page).locator('.hcd-inactive-selection')).toContainText('🚀先灰度，再放量。')
})

test('creating a Markdown result uses the upload grant and saves one editable file', async ({ page }) => {
  await open(page, 'transfer-ideas')
  await selectBoardIdea(page)
  await transferPanel(page).getByLabel('上传令牌', { exact: true }).fill(token('*', 'resource-user', 'upload'))
  await transferPanel(page).getByRole('button', { name: '生成预览', exact: true }).click()
  await expect(transferPanel(page)).toContainText('上线讨论纪要')
  const response = page.waitForResponse(value => value.url().endsWith('/apply') && value.request().method() === 'POST')
  await transferPanel(page).getByRole('button', { name: '写入文档', exact: true }).click()
  const applied = await response
  expect(applied.status()).toBe(200)
  const { receipt } = await applied.json()
  await expect(transferPanel(page)).toContainText('已应用')
  await transferPanel(page).getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', receipt.documentId)
  await expect(active(page).locator('.hcd-editor-body')).toContainText('负责人待确认')
  await expect(active(page).locator('.hcd-editor-body')).toHaveAttribute('contenteditable', 'true')
})

test('creating a new teaching board returns a tab with native sections', async ({ page }) => {
  await open(page, 'transfer-lesson')
  await selectLessonText(page)
  await transferPanel(page).getByLabel('上传令牌', { exact: true }).fill(token('*', 'resource-user', 'upload'))
  await transferPanel(page).getByRole('button', { name: '生成预览', exact: true }).click()
  await expect(transferPanel(page)).toContainText('发布方案讲解')
  const response = page.waitForResponse(value => value.url().endsWith('/apply') && value.request().method() === 'POST')
  await transferPanel(page).getByRole('button', { name: '追加到白板', exact: true }).click()
  const applied = await response
  expect(applied.status()).toBe(200)
  const { receipt } = await applied.json()
  await transferPanel(page).getByRole('button', { name: '查看结果', exact: true }).click()
  await expect(active(page)).toHaveAttribute('data-document-id', receipt.documentId)
  await expect(active(page).getByRole('button', { name: '查看原文', exact: true })).toBeVisible()
  expect((await read(receipt.documentId, '/canvas')).scene.elements.some((item: { type: string }) => item.type === 'arrow')).toBe(true)
})

test('cross-file generation rejects foreign targets and leaves a changed source draft unapplied', async () => {
  const board = 'transfer-ideas', document = 'transfer-word'
  const base = `${apiUrl}/v1/documents/${board}`
  const snapshot = await read(board, '/canvas')
  const request = { id: randomUUID(), sourceEpoch: snapshot.collaborationEpoch, target: { kind: 'existing', documentId: document },
    selection: { kind: 'canvas', revision: snapshot.revision, elementIds: ['idea'], region: { x: 0, y: 0, width: 350, height: 70 } } }
  const headers = { Authorization: `Bearer ${token(board)}`, 'Content-Type': 'application/json',
    'x-hcd-target-authorization': `Bearer ${token(document)}` }
  const modelCalls = transferInputs.length
  const denied = await fetch(`${base}/selection-transfers`, { method: 'POST',
    headers: { ...headers, 'x-hcd-target-authorization': `Bearer ${token(document, 'another-account')}` }, body: JSON.stringify(request) })
  expect(denied.status).toBe(403)
  expect(transferInputs).toHaveLength(modelCalls)
  const preview = await fetch(`${base}/selection-transfers`, { method: 'POST', headers, body: JSON.stringify(request) })
  expect(preview.status).toBe(202)
  const draftRoute = `/selection-transfers/${request.id}`
  await expect.poll(async () => (await read(board, draftRoute)).status).toBe('ready')
  const idea = snapshot.scene.elements.find((element: { id: string }) => element.id === 'idea')
  const text = '上线前改为两轮可用性测试'
  const update = await fetch(`${base}/canvas/patch`, {
    method: 'POST', headers: { ...headers, 'X-HCD-Collaboration-Epoch': String(snapshot.collaborationEpoch) },
    body: JSON.stringify({ schemaVersion: 'officecli-canvas/1', documentId: board, baseRevision: snapshot.revision, patchId: randomUUID(),
      operations: [{ op: 'element.update', id: 'idea', before: { text: idea.text, originalText: idea.originalText ?? null }, changes: { text, originalText: text } }] }),
  })
  expect(update.status).toBe(200)
  const before = (await read(document, '')).revision
  const rejected = await fetch(`${base}${draftRoute}/apply`, { method: 'POST', headers })
  expect(rejected.status).toBe(409)
  expect(await rejected.text()).toContain('原选区内容已变化')
  expect((await read(board, draftRoute)).status).toBe('ready')
  expect((await read(document, '')).revision).toBe(before)
})
