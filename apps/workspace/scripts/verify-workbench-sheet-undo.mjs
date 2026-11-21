import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect } from '../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const app = join(repo, 'apps/workspace')
const assets = resolve(process.env.OFFICECLI_WORKSPACE_DIST || join(app, 'dist'))
const binary = join(assets, 'officecli')
const root = mkdtempSync(join(tmpdir(), 'officecli-sheet-undo-'))
const password = randomBytes(24).toString('base64url')
const peerPassword = randomBytes(24).toString('base64url')
const name = '富文本协作.xlsx'
const ports = Array.from({ length: 3 }, () => createServer())
await Promise.all(ports.map(server => new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done))))
const [port, enginePort, collabPort] = ports.map(server => server.address().port)
await Promise.all(ports.map(server => new Promise(done => server.close(done))))
const base = `http://127.0.0.1:${port}`
const aiValues = { A2: '新内容', B2: 'AI新增格', C2: '临时格', D2: '98' }
const model = createHttpServer(async (request, response) => {
  try {
    assert.equal(request.url, '/api/chat')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(JSON.parse(Buffer.concat(chunks)).messages[1].content)
    assert.equal(input.targets.length, 1)
    const target = input.targets[0]
    assert.equal(target.kind, 'sheet')
    assert.deepEqual(target.cells.map(cell => cell.address), Object.keys(aiValues))
    const plan = { reply: '', actions: [{ fileId: target.fileId, tool: 'edit_selected_cells',
      args: { edits: Object.entries(aiValues).map(([address, value]) => ({ address, value })) } }] }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ message: { content: JSON.stringify(plan) } }))
  } catch (error) { response.writeHead(400).end(String(error)) }
})
model.listen(0, '127.0.0.1')
await once(model, 'listening')

function run(file, args, env = process.env) {
  const result = spawnSync(file, args, { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
async function request(path, { account, token, method = 'GET', data, bytes } = {}) {
  const response = await fetch(base + path, { method, headers: {
    Origin: base,
    ...(account && { Cookie: account.cookie, 'X-Workspace-CSRF': account.csrf }),
    ...(token && { Authorization: `Bearer ${token}` }),
    ...(data && { 'Content-Type': 'application/json' }),
    ...(bytes && { 'Content-Type': 'application/octet-stream' }),
  }, body: data ? JSON.stringify(data) : bytes })
  const raw = Buffer.from(await response.arrayBuffer())
  let value
  try { value = JSON.parse(raw.toString()) } catch { value = raw }
  assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`)
  return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
async function login(username, pass) {
  const result = await request('/workspace/api/login', { method: 'POST', data: { username, password: pass } })
  return { ...result.value, cookie: result.cookie }
}
const pane = page => page.locator('.desk-editor.is-visible')
const canvas = page => pane(page).locator('canvas[id^="univer-sheet-main-canvas_"]').first()
const field = page => pane(page).getByRole('textbox', { name: '单元格内容或公式', exact: true })
async function select(page, row = 0, column = 0) {
  await canvas(page).click({ position: { x: 100, y: 34 } })
  for (let i = 0; i < row; i++) await page.keyboard.press('ArrowDown')
  for (let i = 0; i < column; i++) await page.keyboard.press('ArrowRight')
  await expect(pane(page).getByLabel('选中单元格', { exact: true }))
    .toHaveText(String.fromCharCode(65 + column) + (row + 1))
}

run(process.execPath, [join(app, 'cli.mjs'), 'init', '--root', root, '--selection-mcp', '--public-url', base,
  '--engine-port', String(enginePort), '--collab-port', String(collabPort)],
{ ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: password })
const service = spawn(process.execPath, [join(app, 'cli.mjs'), 'start', '--root', root, '--assets', assets], {
  cwd: repo, env: { ...process.env, OFFICECLI_AI_ENABLED: 'true', HCD_OPENAI_MODEL: 'sheet-undo-fixture',
    OPENAI_API_KEY: 'local-fixture', OFFICECLI_WORKBENCH_OLLAMA_MODEL: 'sheet-undo-fixture',
    OFFICECLI_WORKBENCH_OLLAMA_URL: `http://127.0.0.1:${model.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
service.stdout.on('data', chunk => { log += chunk })
service.stderr.on('data', chunk => { log += chunk })
const stopped = once(service, 'exit')
let browser, owner, peer
try {
  await expect.poll(async () => {
    try { return (await fetch(base + '/workspace/api/status')).ok } catch { return false }
  }, { timeout: 60000 }).toBe(true)
  const admin = await login('admin', password)
  const member = (await request('/workspace/api/users', { account: admin, method: 'POST', data: {
    username: 'colleague', displayName: '协作者', password: peerPassword, role: 'member',
  } })).value.user
  const colleague = await login('colleague', peerPassword)
  assert.notEqual(admin.user.id, colleague.user.id)
  const source = join(root, name)
  run('python3', [join(repo, 'docs/acceptance/hcd-xlsx-rich-text/make_fixture.py'), source])
  run(binary, ['set', source, '/Rich text/D2', '--prop', 'value=12'])
  const file = (await request('/workspace/api/files?filename=' + encodeURIComponent(name), {
    account: admin, method: 'POST', bytes: readFileSync(source),
  })).value.file
  await request(`/workspace/api/files/${file.id}/acl`, { account: admin, method: 'PUT', data: {
    userId: member.id, profile: 'editor', operations: ['document.view', 'document.edit', 'document.ai', 'document.copy'],
  } })
  const launchFor = async id => (await request(`/workspace/api/files/${id}/editor-session`, {
    account: admin, method: 'POST', data: { sessionId: randomUUID() },
  })).value
  const launch = await launchFor(file.id)
  const read = path => request(`/v1/documents/${launch.documentId}${path}`, { account: admin, token: launch.token }).then(r => r.value)
  const sheet = () => read('/sheets/0')
  const documentIdentity = await read('/auth')
  const initial = await sheet()
  const richCell = initial.cells.find(cell => cell.address === 'A2')
  const original = await read('/nodes/' + richCell.nodeId)
  assert.equal(original.xlsxRuns.length, 3)

  browser = await chromium.launch({ ...(process.env.HCD_BROWSER_PATH && { executablePath: process.env.HCD_BROWSER_PATH }),
    args: ['--no-proxy-server'] })
  const contexts = await Promise.all([admin, colleague].map(async account => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const index = account.cookie.indexOf('=')
    await context.addCookies([{ name: account.cookie.slice(0, index), value: account.cookie.slice(index + 1), url: base }])
    await context.addInitScript(() => {
      window.sheetPaints = []
      const draw = CanvasRenderingContext2D.prototype.fillText
      CanvasRenderingContext2D.prototype.fillText = function (...args) {
        const paints = window.sheetPaints
        paints.push({ text: args[0], font: this.font, color: String(this.fillStyle) })
        if (paints.length > 4000) paints.splice(0, 2000)
        return draw.apply(this, args)
      }
    })
    return context
  }))
  ;[owner, peer] = await Promise.all(contexts.map(context => context.newPage()))
  const errors = [], writes = []
  for (const page of [owner, peer]) page.on('pageerror', error => errors.push(String(error)))
  peer.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/node-patch')) writes.push(req.postDataJSON()) })
  await Promise.all([owner, peer].map(page => page.goto(`${base}/workbench/?file=${file.id}`)))
  await Promise.all([owner, peer].map(page => expect(canvas(page)).toBeVisible({ timeout: 60000 })))
  await select(owner, 1)
  for (let i = 0; i < 3; i++) await owner.keyboard.press('Shift+ArrowRight')
  const target = owner.getByRole('checkbox', { name: '加入任务 ' + name, exact: true })
  await expect(target).toBeEnabled()
  await target.check()
  await expect(owner.locator('.desk-targets label').filter({ has: target })).toContainText('A2:D2')
  await owner.getByRole('textbox', { name: '全局 AI 指令' }).fill('改写所选文字、记录新增结论并更新数字')
  await owner.getByRole('button', { name: '发送全局指令' }).click()
  let job = owner.locator('.desk-thread article').last()
  await expect(job.getByText('新内容', { exact: true })).toBeVisible()
  await job.getByRole('button', { name: '应用到 ' + name, exact: true }).click()
  await expect(job.locator('em[data-phase="complete"]')).toHaveCount(1, { timeout: 45000 })
  const committedAt = performance.now()
  await expect.poll(async () => (await read('/nodes/' + richCell.nodeId)).text).toBe('新内容')

  await select(peer, 1)
  await expect(field(peer)).toHaveValue('新内容')
  const peerUpdateMs = Math.round(performance.now() - committedAt)
  assert(peerUpdateMs < 5000, 'The peer must update before the 15-second fallback poll')
  await canvas(peer).dblclick({ position: { x: 100, y: 70 } })
  await peer.keyboard.press('ControlOrMeta+A')
  await peer.keyboard.press('ArrowLeft')
  await peer.keyboard.press('ArrowRight')
  await peer.keyboard.insertText('📍')
  await peer.keyboard.press('Shift+ArrowLeft')
  await pane(peer).getByRole('button', { name: '下划线', exact: true }).click()
  await peer.keyboard.press('Enter')
  await expect.poll(async () => (await read('/nodes/' + richCell.nodeId)).text).toBe('新📍内容')
  const supplemented = await read('/nodes/' + richCell.nodeId)
  const inserted = supplemented.xlsxRuns.find(run => run.text === '📍')
  assert(inserted?.properties.u)
  assert(writes.some(patch => patch.schemaVersion === 'hcd-patch/49'))
  await select(peer, 1, 1)
  await expect(field(peer)).toHaveValue('AI新增格')
  await field(peer).fill('AI新增格【同事】')
  await pane(peer).getByRole('button', { name: '应用内容', exact: true }).click()
  await expect.poll(async () => (await sheet()).cells.find(cell => cell.address === 'B2')?.text).toBe('AI新增格【同事】')
  // The canonical write precedes the browser's index refresh. Structural
  // commands are available once the protected input has finished reconciling.
  await expect(field(peer)).toBeEnabled()
  await pane(peer).getByRole('button', { name: '插入', exact: true }).click()
  const insertedRow = peer.waitForResponse(response => response.url().endsWith('/node-patch')
    && response.request().method() === 'POST')
  await pane(peer).getByRole('button', { name: '在选中行前插入 1 行', exact: true }).click()
  const rowResponse = await insertedRow
  assert(rowResponse.ok(), await rowResponse.text())
  await expect.poll(async () => (await sheet()).cells.find(cell => cell.nodeId === richCell.nodeId)?.address).toBe('A3')
  const beforeUndo = await sheet()
  await owner.reload()
  await expect(canvas(owner)).toBeVisible({ timeout: 60000 })
  job = owner.locator('.desk-thread article').last()
  await job.getByRole('button', { name: /撤销 富文本协作\.xlsx r\d+ 的修改/ }).click()
  await expect(job.getByText('已撤销', { exact: true })).toBeVisible({ timeout: 45000 })
  const expected = original.text + '📍'
  await expect.poll(async () => (await read('/nodes/' + richCell.nodeId)).text).toBe(expected)
  const final = await sheet()
  const restored = await read('/nodes/' + richCell.nodeId)
  assert.deepEqual(restored.xlsxRuns, [...original.xlsxRuns, inserted])
  assert.equal(final.revision, beforeUndo.revision + 1)
  assert.equal(final.cells.find(cell => cell.address === 'B3').text, '【同事】')
  assert(!final.cells.some(cell => cell.address === 'C3'))
  assert.equal(final.cells.find(cell => cell.address === 'D3').numberValue, '12')
  for (const page of [owner, peer]) {
    await page.bringToFront()
    await select(page, 2)
    await expect(field(page)).toHaveValue(expected)
    await expect.poll(() => page.evaluate(() => window.sheetPaints.some(p => p.text.includes('中') &&
      p.color.toLowerCase() === '#cc2244' && /bold|700/.test(p.font)))).toBe(true)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.evaluate(() => navigator.clipboard.writeText('awaiting-grid-copy'))
    await page.keyboard.press('ControlOrMeta+C')
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).trim()))
      .toBe(`${expected}\t【同事】\t\t12`)
    await select(page, 2)
  }
  const db = new DatabaseSync(join(root, 'business.sqlite'), { readOnly: true })
  let saved
  try { saved = JSON.parse(db.prepare('SELECT state FROM workbench_jobs ORDER BY rowid DESC LIMIT 1').get().state) }
  finally { db.close() }
  assert.equal(saved.targets[0].undoReceipt, final.revision)
  assert.equal(saved.targets[0].prepared.undo.format, 'xlsx')
  assert.deepEqual(saved.targets[0].prepared.undo.edits.find(edit => edit.nodeId === richCell.nodeId).beforeRuns, original.xlsxRuns)
  const record = JSON.parse(readFileSync(join(root, 'engine', launch.documentId + '.hcd', 'revisions',
    String(final.revision).padStart(20, '0') + '.json'), 'utf8'))
  assert.equal(record.parentRevision, beforeUndo.revision)
  assert.equal(record.authorId, documentIdentity.userId)
  assert(record.removedNodeIds.includes(beforeUndo.cells.find(cell => cell.address === 'C3').nodeId))
  await owner.screenshot({ path: join(root, 'sheet-undo.png') })

  const exported = (await request(`/v1/documents/${launch.documentId}/export/xlsx?source=true`, { account: admin, token: launch.token })).value
  const exportedPath = join(root, '撤销后.xlsx')
  writeFileSync(exportedPath, exported)
  const reopenedFile = (await request('/workspace/api/files?filename=' + encodeURIComponent('撤销后.xlsx'), {
    account: admin, method: 'POST', bytes: exported,
  })).value.file
  const reopened = await launchFor(reopenedFile.id)
  const reopenedSheet = (await request(`/v1/documents/${reopened.documentId}/sheets/0`, { account: admin, token: reopened.token })).value
  const reopenedCell = reopenedSheet.cells.find(cell => cell.address === 'A3')
  const reopenedNode = (await request(`/v1/documents/${reopened.documentId}/nodes/${reopenedCell.nodeId}`, { account: admin, token: reopened.token })).value
  assert.deepEqual(reopenedNode.xlsxRuns, restored.xlsxRuns)
  assert.equal(reopenedSheet.cells.find(cell => cell.address === 'B3').text, '【同事】')
  assert(!reopenedSheet.cells.some(cell => cell.address === 'C3'))
  assert.equal(reopenedSheet.cells.find(cell => cell.address === 'D3').numberValue, '12')
  await owner.goto(`${base}/workbench/?file=${reopenedFile.id}`)
  await expect(canvas(owner)).toBeVisible({ timeout: 60000 })
  await select(owner, 2)
  await expect(field(owner)).toHaveValue(expected)
  await owner.screenshot({ path: join(root, 'sheet-undo-reopened.png') })
  assert.deepEqual(errors, [])
  const result = { status: 'passed', root, original: original.xlsxRuns, restored: restored.xlsxRuns,
    revision: final.revision, parentRevision: record.parentRevision, peerUpdateMs, checks: [
      'Distinct users used real browser workbench AI review and native cell text formatting.',
      'The peer inserted styled Unicode inside AI text and supplemented an AI-created cell.',
      'After row insertion and owner reload, one atomic inverse preserved peer input and native styles, restored the number and cleared only the untouched created cell.',
      'Both browsers and source-backed XLSX export, reupload, metadata and reopened grid agree.',
    ] }
  writeFileSync(join(root, 'validation.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ status: result.status, root, checks: result.checks }, null, 2))
} catch (error) {
  await owner?.screenshot({ path: join(root, 'owner-failure.png') }).catch(() => {})
  await peer?.screenshot({ path: join(root, 'peer-failure.png') }).catch(() => {})
  console.error('Isolated verification directory:', root, '\n', log.slice(-4000))
  throw error
} finally {
  await browser?.close()
  service.kill('SIGTERM')
  await stopped
  await new Promise(done => model.close(done))
}
