import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect } from '../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const app = join(repo, 'apps/workspace')
const assets = resolve(process.env.OFFICECLI_WORKSPACE_DIST || join(app, 'dist'))
const binary = join(assets, 'officecli')
const root = mkdtempSync(join(tmpdir(), 'officecli-workbench-undo-'))
const password = randomBytes(24).toString('base64url')
const peerPassword = randomBytes(24).toString('base64url')
const pendingCase = process.env.OFFICECLI_UNDO_CASE === 'pending'
const appendCase = process.env.OFFICECLI_UNDO_CASE === 'append'
const ports = Array.from({ length: 3 }, () => createServer())
await Promise.all(ports.map(server => new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done))))
const [port, enginePort, collabPort] = ports.map(server => server.address().port)
await Promise.all(ports.map(server => new Promise(done => server.close(done))))
const base = `http://127.0.0.1:${port}`

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
  const raw = await response.arrayBuffer()
  let value
  try { value = JSON.parse(Buffer.from(raw).toString()) } catch { value = Buffer.from(raw) }
  if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`)
  return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
async function login(username, pass) {
  const result = await request('/workspace/api/login', { method: 'POST', data: { username, password: pass } })
  return { ...result.value, cookie: result.cookie }
}
async function waitForEditableParagraph(page, needle) {
  // A new collaboration epoch can render its text before the editor accepts input.
  const paragraph = page.locator('.desk-editor.is-visible .tiptap[contenteditable="true"] p')
    .filter({ hasText: needle }).first()
  await expect(paragraph).toBeVisible({ timeout: 45000 })
  return paragraph
}
async function selectText(page, needle) {
  const paragraph = await waitForEditableParagraph(page, needle)
  const point = await paragraph.evaluate((p, value) => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode, index = node.textContent.indexOf(value)
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index); range.setEnd(node, index + value.length)
      const box = range.getBoundingClientRect()
      return { x: box.left + 1, end: box.right - 1, y: box.top + box.height / 2 }
    }
    throw Error('selection text is missing')
  }, needle)
  await page.mouse.move(point.x, point.y); await page.mouse.down()
  await page.mouse.move(point.end, point.y, { steps: 12 }); await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(needle)
}
async function insertInside(page, needle, offset, value, bold = false) {
  const paragraph = await waitForEditableParagraph(page, needle)
  const point = await paragraph.evaluate((paragraph, { needle, offset }) => {
    const ownerDocument = paragraph.ownerDocument
    const walker = ownerDocument.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode, index = node.textContent.indexOf(needle)
      if (index < 0) continue
      const range = ownerDocument.createRange()
      range.setStart(node, index + offset); range.setEnd(node, index + offset + 1)
      const box = range.getBoundingClientRect()
      return { x: box.left + 0.5, y: box.top + box.height / 2 }
    }
    throw Error('insertion text is missing')
  }, { needle, offset })
  await page.mouse.click(point.x, point.y)
  if (bold) await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.insertText(value)
  if (bold) await page.keyboard.press('ControlOrMeta+b')
}

run(process.execPath, [join(app, 'cli.mjs'), 'init', '--root', root, '--selection-mcp', '--public-url', base,
  '--engine-port', String(enginePort), '--collab-port', String(collabPort)],
{ ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: password })
const service = spawn(process.execPath, [join(app, 'cli.mjs'), 'start', '--root', root, '--assets', assets], {
  cwd: repo, env: { ...process.env, OFFICECLI_AI_ENABLED: 'true', HCD_OPENAI_MODEL: 'workbench-test',
    OPENAI_API_KEY: 'local-fixture', OFFICECLI_WORKBENCH_OLLAMA_MODEL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
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
    username: 'collaborator', displayName: '协作者', password: peerPassword, role: 'member',
  } })).value.user
  const colleague = await login('collaborator', peerPassword)
  assert.notEqual(admin.user.id, colleague.user.id)
  const source = join(root, '协作简报.docx')
  run(binary, ['create', source, '--locale', 'zh-CN'])
  run(binary, ['add', source, '/body', '--type', 'paragraph', '--prop', 'text=保留原话，再提炼下一步可以验证的假设。'])
  const file = (await request('/workspace/api/files?filename=' + encodeURIComponent('协作简报.docx'), {
    account: admin, method: 'POST', bytes: readFileSync(source),
  })).value.file
  await request(`/workspace/api/files/${file.id}/acl`, { account: admin, method: 'PUT', data: {
    userId: member.id, profile: 'editor', operations: ['document.view', 'document.edit', 'document.ai', 'document.copy'],
  } })
  const launch = (await request(`/workspace/api/files/${file.id}/editor-session`, {
    account: admin, method: 'POST', data: { sessionId: randomUUID() },
  })).value
  const projection = () => request(`/v1/documents/${launch.documentId}/editor`, { account: admin, token: launch.token }).then(result => result.value)
  const projectionText = async () => (await projection()).blocks.map(block => block.content.inlines.map(run => run.text).join('')).join('\n')
  browser = await chromium.launch({ ...(process.env.HCD_BROWSER_PATH && { executablePath: process.env.HCD_BROWSER_PATH }),
    args: ['--no-proxy-server'] })
  const contexts = await Promise.all([admin, colleague].map(async account => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const index = account.cookie.indexOf('=')
    await context.addCookies([{ name: account.cookie.slice(0, index), value: account.cookie.slice(index + 1), url: base }])
    return context
  }))
  ;[owner, peer] = await Promise.all(contexts.map(context => context.newPage()))
  const errors = []
  for (const page of [owner, peer]) page.on('pageerror', error => errors.push(String(error)))
  await Promise.all([owner, peer].map(page => page.goto(`${base}/workbench/?file=${file.id}`)))
  await Promise.all([owner, peer].map(page => expect(page.locator('.desk-editor.is-visible .tiptap')).toContainText('可以验证的假设', { timeout: 60000 })))
  const target = owner.getByRole('checkbox', { name: '加入任务 协作简报.docx', exact: true })
  await expect(target).toBeEnabled({ timeout: 45000 })
  await target.check()
  if (!appendCase) await selectText(owner, '可以验证的假设')
  await expect(owner.locator('.desk-targets label').filter({ has: target })).toContainText(appendCase ? '追加到文末' : '正文')
  const aiText = appendCase ? 'AI草拟结论' : '能够试验的假设'
  await owner.getByRole('textbox', { name: '全局 AI 指令' }).fill((appendCase ? '追加：' : '改写为：') + aiText)
  await owner.getByRole('button', { name: '发送全局指令' }).click()
  const job = owner.locator('.desk-thread article').last()
  await job.getByRole('button', { name: '应用到 协作简报.docx' }).click()
  await expect(job.locator('em[data-phase="complete"]')).toHaveCount(1, { timeout: 45000 })
  await expect(peer.locator('.desk-editor.is-visible .tiptap')).toContainText(aiText, { timeout: 45000 })
  const undo = job.getByRole('button', { name: /撤销 协作简报\.docx r\d+ 的修改/ })
  const note = pendingCase ? '【并发】' : '【同事】'
  if (pendingCase) {
    let release, intercepted
    const gate = new Promise(done => { release = done })
    const reached = new Promise(done => { intercepted = done })
    await owner.route('**/workspace/api/agent-jobs/*/undo', async route => {
      intercepted()
      await gate
      await route.continue()
    }, { times: 1 })
    const rejected = owner.waitForResponse(response => response.url().includes('/agent-jobs/') && response.url().endsWith('/undo'))
    const click = undo.click()
    try {
      await Promise.race([reached, new Promise((_, fail) => {
        setTimeout(() => fail(Error('undo request was not intercepted')), 15000).unref()
      })])
      await insertInside(peer, '能够试验的假设', 2, note)
      const epochPath = join(root, 'engine/collaboration', `${launch.documentId}.epoch`)
      await expect.poll(() => {
        try {
          const epoch = readFileSync(epochPath, 'utf8').trim()
          return JSON.parse(readFileSync(join(root, 'engine/collaboration', `${launch.documentId}.${epoch}.pending`), 'utf8')).dirty
        } catch { return false }
      }, { timeout: 10000 }).toBe(true)
    } finally { release() }
    assert.equal((await rejected).status(), 409)
    await click
    await expect(peer.locator('.desk-editor.is-visible .tiptap')).toContainText(`能够${note}试验的假设`)
    await expect.poll(projectionText, { timeout: 45000 }).toContain(`能够${note}试验的假设`)
  } else {
    await insertInside(peer, aiText, 2, note, appendCase)
    const supplemented = aiText.slice(0, 2) + note + aiText.slice(2)
    await expect(peer.locator('.desk-editor.is-visible .tiptap')).toContainText(supplemented)
    await expect.poll(projectionText, { timeout: 45000 }).toContain(supplemented)
  }
  await undo.click()
  await expect(job.getByText('已撤销', { exact: true })).toBeVisible({ timeout: 45000 })
  const expected = appendCase ? note : `保留原话，再提炼下一步可以验证的假设${note}。`
  await Promise.all([owner, peer].map(page => expect(page.locator('.desk-editor.is-visible .tiptap')).toContainText(expected, { timeout: 45000 })))
  await expect.poll(projectionText, { timeout: 45000 }).toContain(expected)
  if (appendCase) {
    await Promise.all([owner, peer].map(page => expect(page.locator('.desk-editor.is-visible .tiptap strong')).toHaveText(note)))
    const state = await projection()
    const paragraph = state.blocks.find(block => block.content.inlines.some(run => run.text.includes(note)))
    assert.equal(paragraph.content.inlines.map(run => run.text).join(''), note)
    assert(paragraph.content.inlines.every(run => run.bold))
    assert((await projectionText()).includes('保留原话，再提炼下一步可以验证的假设。'))
    assert(!(await projectionText()).includes('AI'))
  }
  await owner.reload()
  await expect(owner.locator('.desk-editor.is-visible .tiptap')).toContainText(expected, { timeout: 45000 })
  const exported = await request(`/v1/documents/${launch.documentId}/export/docx?source=true`, { account: admin, token: launch.token })
  const output = join(root, '撤销后.docx')
  writeFileSync(output, exported.value)
  assert(run(binary, ['view', output, 'text']).includes(expected))
  await owner.screenshot({ path: join(root, 'workbench-undo.png') })
  if (appendCase) {
    const reopened = (await request('/workspace/api/files?filename=' + encodeURIComponent('撤销后.docx'), {
      account: admin, method: 'POST', bytes: exported.value,
    })).value.file
    await owner.goto(`${base}/workbench/?file=${reopened.id}`)
    await expect(owner.locator('.desk-editor.is-visible .tiptap strong')).toHaveText(note, { timeout: 45000 })
    await owner.screenshot({ path: join(root, 'workbench-undo-reopened.png') })
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', root, checks: pendingCase ? [
    'An undo racing a distinct user’s unsaved input was rejected; after checkpoint, retry preserved the input.',
    'Both clients, reload, the server projection and a source-backed DOCX agree.',
  ] : appendCase ? [
    'A distinct user added bold text inside an AI-created paragraph; undo removed only the AI text.',
    'Both clients and reload kept the original document and formatted supplement; native DOCX reopening preserved bold text.',
  ] : [
    'Distinct users edited the same paragraph in separate browsers; undo preserved the collaborator insertion.',
    'Both clients, reload, the server projection and a source-backed DOCX agree.',
  ] }, null, 2))
} catch (error) {
  await owner?.screenshot({ path: join(root, 'owner-failure.png') }).catch(() => {})
  await peer?.screenshot({ path: join(root, 'peer-failure.png') }).catch(() => {})
  console.error('Isolated verification directory:', root, '\n', log.slice(-4000))
  throw error
} finally {
  await browser?.close()
  service.kill('SIGTERM')
  await stopped
}
