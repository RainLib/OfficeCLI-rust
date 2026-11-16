import { test, expect, chromium, type Page } from '@playwright/test'
import { createHmac, randomBytes } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
test.use({ viewport: { width:1600,height:1040 } })
const repo = resolve(import.meta.dirname, '../../../..'), editorRoot = resolve(import.meta.dirname, '..')
const binary = process.env.OFFICECLI_BIN || resolve(repo, 'target/debug/officecli')
const secret = randomBytes(32).toString('hex'), children: ChildProcess[] = []
const root = mkdtempSync(resolve(tmpdir(), 'officecli-image-test-'))
let apiUrl: string, uiUrl: string, model: Server, source: Buffer, generated: Buffer, mask: Buffer, modelCalls: string[] = []
let apiProcess: ChildProcess, serverEnv: NodeJS.ProcessEnv, providerRequests = 0, generatedSquare: Buffer
async function port() { const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const p = (server.address() as { port: number }).port; await new Promise<void>(done => server.close(() => done())); return p }
function token(doc: string, scope = 'write', user = 'image-tester') {
  const now = Math.floor(Date.now() / 1000), enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const text = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ doc, scope, sub: user, name: user, aud: 'hcd-core', iat: now, exp: now + 3600 })}`
  return `${text}.${createHmac('sha256', secret).update(text).digest('base64url')}`
}
function start(command: string, args: string[], extra: NodeJS.ProcessEnv, detached = false) {
  const env = { ...process.env, ...extra }; delete env.HCD_DATABASE_URL; delete env.HCD_S3_BUCKET; delete env.HCD_DEFAULT_THEME
  const child = spawn(command, args, { cwd: editorRoot, env, detached, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
  const log = createWriteStream(resolve(root, `${child.pid}.log`)); child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false }); child.once('close', () => log.end())
  return child
}
async function ready(url: string) { await expect.poll(async () => { try { return (await fetch(url)).status } catch { return 0 } }, { timeout: 45_000 }).toBe(200) }
async function request(id: string, route: string, data?: unknown, scope = 'write', user = 'image-tester', method?: string) {
  return fetch(`${apiUrl}/v1/documents/${id}${route}`, { method: method || (data ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${token(id, scope, user)}`, 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': '0' }, body: data ? JSON.stringify(data) : undefined })
}
async function json(id: string, route: string, data?: unknown) { const r = await request(id, route, data); if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json() }
async function upload() {
  const r = await fetch(`${apiUrl}/v1/images?filename=${encodeURIComponent('陶艺时刻.png')}`, { method: 'POST', headers: { Authorization: `Bearer ${token('*', 'upload')}` }, body: source })
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json() as Promise<{ documentId: string; token: string; title: string }>
}
async function open(page: Page, doc: Awaited<ReturnType<typeof upload>>) {
  await page.addInitScript(item => { sessionStorage.setItem('hcd-editor-workspace-v1', JSON.stringify({ version: 1, tabs: [item], activeDocument: item.documentId })) }, doc)
  await page.goto(uiUrl); await expect(page.getByRole('region', { name: '图片画布，滚轮缩放，空格拖动' })).toBeVisible()
  await expect(page.locator('canvas.image-pixels')).toHaveJSProperty('width', 1080)
}
test.beforeAll(async () => {
  mkdirSync(resolve(root, 'service'), { recursive: true })
  const photo = await loadImage(readFileSync(resolve(repo, 'docs/design/officecli-image-workspace/assets/ceramic-portrait.jpg'))), c = createCanvas(1080, 720), ctx = c.getContext('2d')
  ctx.drawImage(photo, 0, 0, 1080, 720); source = c.toBuffer('image/png'); ctx.fillStyle = '#448844'; ctx.fillRect(0, 0, 1080, 720); generated = c.toBuffer('image/png')
  ctx.clearRect(0, 0, 1080, 720); ctx.fillStyle = 'white'; ctx.fillRect(450, 400, 80, 100); mask = c.toBuffer('image/png')
  generatedSquare = createCanvas(1024, 1024).toBuffer('image/png')
  model = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const b of req) chunks.push(Buffer.from(b)); const body = Buffer.concat(chunks)
    providerRequests++
    await new Promise<void>(done => { const timer = setTimeout(done, body.includes(Buffer.from('SLOW_RECOVERY')) ? 30_000 : 900); res.once('close', () => { clearTimeout(timer); done() }) })
    if (res.destroyed) return
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/images/edits' && body.includes(Buffer.from('FORCE_FAILURE'))) { res.statusCode=503; res.end(JSON.stringify({error:'scripted failure'})); return }
    if (req.url === '/v1/images/generations') { res.end(JSON.stringify({ data: [{ b64_json: generatedSquare.toString('base64') }] })); return }
    if (req.url === '/v1/images/edits') { expect(req.headers['content-type']).toContain('multipart/form-data'); expect(body.includes(Buffer.from('name="mask"'))).toBe(true); modelCalls.push('image'); res.end(JSON.stringify({ data: [{ b64_json: generated.toString('base64') }] })) }
    else { const payload = JSON.parse(body.toString()); modelCalls.push(payload.model); res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '保留未选中内容和花瓶纹理，仅调整涂抹区域。' }] }] })) }
  }); const mp = await port(); await new Promise<void>(done => model.listen(mp, '127.0.0.1', done))
  const ap = await port(), up = await port(); apiUrl = `http://127.0.0.1:${ap}`; uiUrl = `http://127.0.0.1:${up}`
  const env = { HCD_TOKEN_SECRET: secret, HCD_OPENAI_BASE_URL: `http://127.0.0.1:${mp}/v1`, HCD_OPENAI_IMAGE_BASE_URL: `http://127.0.0.1:${mp}/v1`, OPENAI_API_KEY: 'scripted-image-test', HCD_OPENAI_MODEL: 'gpt-6.1-sol', HCD_OPENAI_IMAGE_MODEL: 'image-test', HCD_OPENAI_ENV_FILE: '/nonexistent-test-env', HCD_API_TARGET: apiUrl, HCD_VITE_CACHE_DIR: resolve(root, 'vite') }
  serverEnv = env
  apiProcess = start(binary, ['hdoc', 'serve', '--root', resolve(root, 'service'), '--bind', `127.0.0.1:${ap}`], env)
  start(resolve(editorRoot, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(up), '--strictPort'], env)
  await Promise.all([ready(`${apiUrl}/health`), ready(uiUrl)])
})
test.afterAll(async () => { for (const c of children) c.kill('SIGTERM'); model?.close() })

test('image revisions, real encoding, canvas isolation, tabs and responsive design', async ({ page }) => {
  test.setTimeout(150_000)
  const doc = await upload(), id = doc.documentId; await open(page, doc)
  const canvas = page.locator('canvas.image-pixels'); await canvas.evaluate(el => { (window as any).__imageCanvas = el })
  const viewport = page.getByRole('region', { name: '图片画布，滚轮缩放，空格拖动' }), initialZoom = await page.getByRole('button', { name: '图片缩放比例' }).innerText()
  await viewport.hover(); await page.mouse.wheel(0, -150); await expect(page.getByRole('button', { name: '图片缩放比例' })).not.toHaveText(initialZoom)
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
  const before = await viewport.boundingBox(); await page.getByRole('button', { name: '收起图片面板' }).click(); expect((await viewport.boundingBox())!.width).toBeGreaterThan(before!.width + 250)
  await page.getByRole('button', { name: '面板', exact: true }).click()
  await page.screenshot({ path: resolve(root, 'preview-desktop.png') })
  await page.getByLabel('界面与主题').click(); await page.locator('.im-profile-menu select').selectOption('dark'); await page.getByLabel('界面与主题').click()
  await page.getByRole('button',{name:'收起图片面板'}).click(); await page.screenshot({path:resolve(root,'focus-dark.png')}); await page.getByRole('button',{name:'面板',exact:true}).click()
  await page.getByLabel('界面与主题').click(); await page.locator('.im-profile-menu select').selectOption('light'); await page.getByLabel('界面与主题').click()

  await page.getByRole('button', { name: '开始编辑' }).click(); await page.getByRole('button', { name: '顺时针旋转' }).click(); await page.getByRole('button', { name: '光线与色彩', exact: true }).click()
  await page.getByRole('slider', { name: '曝光', exact: true }).fill('12'); await page.getByRole('button', { name: '应用编辑', exact: true }).click()
  await expect.poll(async () => (await json(id, '/image')).revision).toBe(1)
  expect(await canvas.evaluate(el => el === (window as any).__imageCanvas)).toBe(true)
  expect((await json(id, '/image')).width).toBe(720)
  await page.getByRole('button', { name: '预览', exact: true }).click(); await page.getByRole('button', { name: '转换格式', exact: true }).click()
  await page.getByRole('button', { name: 'JPEG', exact: true }).click(); await expect(page.getByLabel('JPEG 背景颜色')).toBeVisible()
  await page.getByRole('button', { name: 'PNG', exact: true }).click(); await expect(page.getByRole('slider', { name: '画质' })).toHaveCount(0)
  await page.getByRole('button', { name: 'WEBP', exact: true }).click(); await page.getByRole('button', { name: '转换为副本', exact: true }).click(); await expect(page.locator('.document-tab-panel:visible').getByText('转换完成。', { exact: true })).toBeVisible()
  await expect(page.locator('.im-result-card').getByText(/WEBP/)).toBeVisible()
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'下载图片',exact:true}).click();const high=await downloadEvent;await high.saveAs(resolve(root,'quality-90.webp'));const highBytes=readFileSync(resolve(root,'quality-90.webp'));expect(highBytes.subarray(0,4).toString()).toBe('RIFF');expect(highBytes.subarray(8,12).toString()).toBe('WEBP')
  await page.getByRole('button',{name:'继续转换',exact:true}).click();await page.getByRole('slider',{name:'画质',exact:true}).fill('20');await page.getByRole('button',{name:'转换为副本',exact:true}).click();await expect(page.locator('.document-tab-panel:visible').getByText('转换完成。',{exact:true})).toBeVisible()
  const lowEvent=page.waitForEvent('download');await page.getByRole('button',{name:'下载图片',exact:true}).click();const low=await lowEvent;await low.saveAs(resolve(root,'quality-20.webp'));expect(readFileSync(resolve(root,'quality-20.webp')).length).toBeLessThan(highBytes.length)
  await page.getByRole('button', { name: '在新标签打开' }).click()
  await expect(page.locator('.document-tab')).toHaveCount(2)
  await page.locator('.document-tab').first().getByRole('button').first().click(); await expect(page.locator('.document-tab-panel:visible').getByText('转换完成。', { exact: true })).toBeVisible()
  const zoom = await page.getByRole('button', { name: '图片缩放比例' }).first().innerText()
  expect(zoom).not.toBe('100%')
  await page.getByRole('button', { name: '版本记录', exact: true }).first().click(); await page.getByRole('button', { name: '版本 r0' }).click(); await expect(page.getByRole('img', { name: '版本 0' })).toBeVisible()
  await page.screenshot({ path: resolve(root, 'history-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250); await page.screenshot({ path: resolve(root, 'preview-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('real inpaint stages, region lease, owner cancellation, pixel boundaries and guarded apply', async ({ page }) => {
  test.setTimeout(150_000)
  const doc = await upload(), id = doc.documentId; modelCalls = []; await open(page, doc)
  await page.getByRole('button', { name: '用 AI 处理这张图片' }).click()
  await page.getByRole('textbox', { name: '重绘内容' }).fill('将花瓶改为绿色，保留人物与背景')
  const plane = await page.locator('[data-image-plane]').boundingBox(); await page.mouse.move(plane!.x + plane!.width * .45, plane!.y + plane!.height * .7); await page.mouse.down(); await page.mouse.move(plane!.x + plane!.width * .48, plane!.y + plane!.height * .72, { steps: 8 }); await page.mouse.up()
  await page.getByRole('button', { name: '生成局部重绘候选', exact: true }).click()
  await expect.poll(async () => (await json(id, '/image/jobs')).jobs.length).toBe(1)
  const j = (await json(id, '/image/jobs')).jobs[0]
  const lock = await request(id, '/image/commit', { expectedRevision: 0, png: source.toString('base64') }); expect(lock.status).toBe(409)
  const cancelOther = await request(id, `/image/jobs/${j.jobId}`, undefined, 'write', 'other-user', 'DELETE'); expect(cancelOther.status).toBe(403)
  await expect(page.locator('.image-agent-pointer:not([aria-hidden=true])')).toHaveCount(1)
  await page.screenshot({ path: resolve(root, 'inpaint-progress.png') })
  await expect.poll(async () => (await json(id, '/image/jobs')).jobs[0].status, { timeout: 40_000 }).toBe('ready')
  expect(modelCalls).toEqual(['gpt-6.1-sol', 'image', 'gpt-6.1-sol'])
  await page.getByRole('button', { name: '对比候选', exact: true }).click(); await expect(page.getByRole('img', { name: '局部重绘候选' })).toBeVisible()
  await page.screenshot({ path: resolve(root, 'inpaint-compare.png') })
  const bytes = Buffer.from(await (await request(id, `/image/jobs/${j.jobId}/content`)).arrayBuffer()), image = await loadImage(bytes), original = await loadImage(source), c = createCanvas(1080, 720), ctx = c.getContext('2d')
  ctx.drawImage(original, 0, 0); const originalPixels = ctx.getImageData(0, 0, 1080, 720).data; ctx.clearRect(0, 0, 1080, 720); ctx.drawImage(image, 0, 0); const after = ctx.getImageData(0, 0, 1080, 720).data
  const [x, y, w, h] = j.region; let changed = 0
  for (let row = 0; row < 720; row++) for (let col = 0; col < 1080; col++) { const i = (row * 1080 + col) * 4, same = [0, 1, 2, 3].every(k => after[i + k] === originalPixels[i + k]); if (!same) { changed++; expect(col >= x && col < x + w && row >= y && row < y + h).toBe(true) } }
  expect(changed).toBeGreaterThan(20)
  await page.getByRole('button', { name: '应用候选版本', exact: true }).click(); await expect.poll(async () => (await json(id, '/image')).revision).toBe(1)
  const stale = await request(id, '/image/commit', { expectedRevision: 0, png: source.toString('base64') }); expect(stale.status).toBe(409)
  expect((await request(id, '/image/commit', { expectedRevision: 1, png: source.toString('base64') }, 'read')).status).toBe(403)
  const emptyMask = createCanvas(1080, 720).toBuffer('image/png').toString('base64')
  expect((await request(id, '/image/jobs', { expectedRevision: 1, mask: emptyMask, prompt: 'edit', agents: 1, feather: 0 })).status).toBe(400)
  const pending = await json(id, '/image/jobs', { expectedRevision: 1, mask: mask.toString('base64'), prompt: 'cancel test', agents: 1, feather: 0 })
  expect((await request(id, `/image/jobs/${pending.jobId}`, undefined, 'write', 'image-tester', 'DELETE')).status).toBe(200)
  expect((await request(id, '/image/commit', { expectedRevision: 1, png: source.toString('base64') })).status).toBe(200)
  const client = new Client({ name: 'image-test', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(`${apiUrl}/v1/documents/${id}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token(id)}` } } }))
  expect((await client.listTools()).tools.some(t => t.name === 'hcd_image_edit')).toBe(true)
  const content = await client.callTool({ name: 'hcd_image_edit', arguments: { document_id: id, action: 'info' } }); expect(content.isError).not.toBe(true); await client.close()
})

test('overlapping jobs wait, failures release leases, and copies validate actual encoding', async () => {
  const doc = await upload(), id = doc.documentId
  const r = { expectedRevision: 0, mask: mask.toString('base64'), prompt: 'FORCE_FAILURE', agents: 1, feather: 0 }
  const first = await json(id, '/image/jobs', r), second = await json(id, '/image/jobs', { ...r, prompt: 'queued request' })
  expect(second.status).toBe('queued')
  await expect.poll(async () => (await json(id, '/image/jobs')).jobs.find((j: any) => j.jobId === first.jobId).status).toBe('failed')
  await expect.poll(async () => (await json(id, '/image/jobs')).jobs.find((j: any) => j.jobId === second.jobId).status).toBe('ready')
  expect((await request(id, `/image/jobs/${second.jobId}`, undefined, 'write', 'image-tester', 'DELETE')).status).toBe(200)
  expect((await json(id, '/image/jobs')).jobs.find((j: any) => j.jobId === second.jobId).status).toBe('discarded')
  const shared = await request(id, `/image/jobs/${second.jobId}/mask`, undefined, 'read', 'other-reader'); expect(shared.status).toBe(200); expect(shared.headers.get('content-type')).toBe('image/png')
  expect((await request(id, '/image/copies', { filename: 'fake.jpg', data: source.toString('base64') })).status).toBe(400)
  const badEpoch = await fetch(`${apiUrl}/v1/documents/${id}/image/commit`, { method: 'POST', headers: { Authorization: `Bearer ${token(id)}`, 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': '9' }, body: JSON.stringify({ expectedRevision: 0, png: source.toString('base64') }) }); expect(badEpoch.status).toBe(409)
  expect((await request(id, '/image/commit', { expectedRevision: 0, png: source.toString('base64') })).status).toBe(200)
  const restored=await json(id,'/restore/0',{expectedRevision:1});expect(restored.revision).toBe(2);expect((await json(id,'/image')).revision).toBe(2)
  const capabilities = await json(id, '/export-capabilities'); expect(capabilities.formats.map((f: any) => f.format)).toEqual(['png','jpeg','webp','hcd'])
  for (const format of ['png','jpeg','webp']) { const exported=await request(id,`/export/${format}`);expect(exported.status).toBe(200);expect(exported.headers.get('content-type')).toBe(`image/${format}`);const decoded=await loadImage(Buffer.from(await exported.arrayBuffer()));expect(decoded.width).toBe(1080);expect(decoded.height).toBe(720) }
})

test('image input journal restores offline adjustments and conversion parameters without changing its canvas or revision', async ({ page, context }, info) => {
  const doc = await upload(); await open(page, doc)
  await page.getByRole('button', { name: '开始编辑', exact: true }).click()
  await page.getByRole('button', { name: '光线与色彩', exact: true }).click()
  await context.setOffline(true)
  await page.getByRole('slider', { name: '曝光', exact: true }).fill('17')
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await page.getByRole('button', { name: 'JPEG', exact: true }).click()
  await page.getByRole('slider', { name: '画质', exact: true }).fill('63')
  await page.getByRole('spinbutton', { name: '导出宽度', exact: true }).fill('900')
  await page.getByRole('textbox', { name: '导出文件名', exact: true }).fill('离线图片调整')
  await expect(page.getByLabel('图片草稿保护状态')).toHaveAttribute('data-protection', 'protected')
  await page.close(); await context.setOffline(false)
  const reopened = await context.newPage(); await open(reopened, doc)
  const canvas = reopened.locator('canvas.image-pixels'); await canvas.evaluate(el => { (window as any).__recoveredCanvas = el })
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true }); await retained.locator('summary').click()
  await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  await expect(reopened.getByRole('textbox', { name: '导出文件名', exact: true })).toHaveValue('离线图片调整')
  await expect(reopened.getByRole('spinbutton', { name: '导出宽度', exact: true })).toHaveValue('900')
  await expect(reopened.getByRole('slider', { name: '画质', exact: true })).toHaveValue('63')
  await reopened.getByRole('button', { name: '光线与色彩', exact: true }).click()
  await expect(reopened.getByRole('slider', { name: '曝光', exact: true })).toHaveValue('17')
  expect(await canvas.evaluate(el => el === (window as any).__recoveredCanvas)).toBe(true)
  expect((await json(doc.documentId, '/image')).revision).toBe(0)
  await expect(retained).toHaveCount(0)
  await reopened.screenshot({ path: info.outputPath('image-adjustments-recovered.png') })
  await reopened.getByRole('button', { name: '舍弃当前图片草稿', exact: true }).click()
  await expect(reopened.getByLabel('图片草稿保护状态')).toHaveCount(0)
})

async function paintDraft(page: Page, prompt: string) {
  await page.getByRole('button', { name: '用 AI 处理这张图片', exact: true }).click()
  await page.getByRole('textbox', { name: '重绘内容', exact: true }).fill(prompt)
  const plane = (await page.locator('[data-image-plane]').boundingBox())!
  await page.mouse.move(plane.x + plane.width * .46, plane.y + plane.height * .63); await page.mouse.down()
  await page.mouse.move(plane.x + plane.width * .58, plane.y + plane.height * .74, { steps: 12 }); await page.mouse.up()
  await expect(page.getByLabel('图片草稿保护状态')).toHaveAttribute('data-protection', 'protected')
  return page.locator('canvas.image-mask').evaluate(c => (c as HTMLCanvasElement).toDataURL())
}

test('image input journal restores an offline mask pixel for pixel without resubmitting generation', async ({ page, context }, info) => {
  const doc = await upload(); await open(page, doc)
  const before = providerRequests, prompt = '找回蒙版与提示词，不自动生成'
  await page.getByRole('button', { name: '用 AI 处理这张图片', exact: true }).click()
  await context.setOffline(true)
  // Return to info without discarding inputs, then use the same painting path.
  await page.getByRole('button', { name: '预览', exact: true }).click()
  const pixels = await paintDraft(page, prompt)
  await page.close(); await context.setOffline(false)
  const reopened = await context.newPage(); await open(reopened, doc)
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true }); await retained.locator('summary').click(); await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  await expect(reopened.getByRole('textbox', { name: '重绘内容', exact: true })).toHaveValue(prompt)
  await expect(reopened.getByRole('button', { name: '生成局部重绘候选', exact: true })).toBeEnabled()
  expect(await reopened.locator('canvas.image-mask').evaluate(c => (c as HTMLCanvasElement).toDataURL())).toBe(pixels)
  expect(providerRequests).toBe(before); expect((await json(doc.documentId, '/image')).revision).toBe(0)
  expect((await json(doc.documentId, '/image/jobs')).jobs).toHaveLength(0)
  await reopened.screenshot({ path: info.outputPath('image-mask-recovered.png') })
})

test('image input journal keeps changed revisions downloadable and isolates another signed user', async ({ page, context }, info) => {
  const doc = await upload(); await open(page, doc); await paintDraft(page, '保留旧版图片草稿')
  await page.close()
  expect((await request(doc.documentId, '/image/commit', { expectedRevision: 0, png: source.toString('base64') })).status).toBe(200)
  const other = await context.newPage(); await open(other, { ...doc, token: token(doc.documentId, 'write', 'another-signed-user') })
  await expect(other.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0); await other.close()
  const reopened = await context.newPage(); await open(reopened, doc)
  const retained = reopened.getByLabel('保留的未提交输入', { exact: true }); await retained.locator('summary').click(); await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  await expect(reopened.getByRole('alert')).toContainText('图片版本或尺寸已变化')
  await expect(retained).toBeVisible(); expect((await json(doc.documentId, '/image')).revision).toBe(1)
  const downloading = reopened.waitForEvent('download'); await retained.getByRole('button', { name: '下载本地草稿', exact: true }).click()
  const downloaded = await downloading; await downloaded.saveAs(info.outputPath('stale-image-draft.json'))
  expect(readFileSync(info.outputPath('stale-image-draft.json'), 'utf8')).toContain('保留旧版图片草稿')
  await reopened.screenshot({ path: info.outputPath('stale-image-draft-retained.png') })
})

test('image input journal reports storage failures and warns before unprotected inputs are closed', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'drafts' && this.transaction.db.name === 'hcd-input-drafts-v1') throw new DOMException('Simulated image draft quota', 'QuotaExceededError')
      return original.apply(this, args)
    }
  })
  const doc = await upload(); await open(page, doc)
  await page.getByRole('button', { name: '开始编辑', exact: true }).click(); await page.getByRole('button', { name: '光线与色彩', exact: true }).click()
  await page.getByRole('slider', { name: '曝光', exact: true }).fill('13')
  await expect(page.getByLabel('本地草稿保护不可用', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(true)
  expect((await json(doc.documentId, '/image')).revision).toBe(0)
  await page.getByRole('button', { name: '应用编辑', exact: true }).click()
  await expect.poll(async () => (await json(doc.documentId, '/image')).revision).toBe(1)
  await expect(page.getByLabel('图片草稿保护状态')).toHaveCount(0)
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(false)
})

test('image input journal survives browser SIGKILL and keeps masks unsubmitted until explicit generation', async ({}, info) => {
  const doc = await upload(), profile = resolve(root, 'image-crash-profile'), prompt = '强杀浏览器后恢复蒙版'
  const launch = async () => {
    const debugPort = await port()
    const child = start(process.env.HCD_BROWSER_PATH || chromium.executablePath(), ['--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], {}, process.platform !== 'win32')
    await ready(`http://127.0.0.1:${debugPort}/json/version`)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
    return { child, browser, context: browser.contexts()[0] }
  }
  const first = await launch(), page = await first.context.newPage(); await open(page, doc)
  const pixels = await paintDraft(page, prompt)
  const exited = new Promise<void>(done => first.child.once('exit', () => done()))
  if (process.platform === 'win32') first.child.kill('SIGKILL'); else process.kill(-first.child.pid!, 'SIGKILL')
  await exited
  const second = await launch()
  try {
    const reopened = await second.context.newPage(); await open(reopened, doc)
    const retained = reopened.getByLabel('保留的未提交输入', { exact: true }); await retained.locator('summary').click(); await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
    await expect(reopened.getByRole('textbox', { name: '重绘内容', exact: true })).toHaveValue(prompt)
    expect(await reopened.locator('canvas.image-mask').evaluate(c => (c as HTMLCanvasElement).toDataURL())).toBe(pixels)
    expect((await json(doc.documentId, '/image/jobs')).jobs).toHaveLength(0); expect((await json(doc.documentId, '/image')).revision).toBe(0)
    await reopened.screenshot({ path: info.outputPath('image-browser-crash-recovered.png') })
  } finally { await second.browser.close() }
})

test('image task checkpoints survive API SIGKILL with candidates, private ownership, released locks and idempotent receipts', async ({ page }, info) => {
  test.setTimeout(120_000)
  const doc = await upload(), id = doc.documentId
  const generatedDoc = 'checkpoint-illustration', markdown = resolve(root, 'checkpoint.md')
  writeFileSync(markdown, '# Illustration recovery\n\nA generated asset is staged separately.\n')
  const imported = spawnSync(binary, ['hdoc', 'import', markdown, '--output', resolve(root, `service/${generatedDoc}.hcd`), '--document-id', generatedDoc], { encoding: 'utf8' })
  expect(imported.status, imported.stderr).toBe(0)
  const readyInpaint = await json(id, '/image/jobs', { expectedRevision: 0, mask: mask.toString('base64'), prompt: 'persist ready inpaint', agents: 1, feather: 0 })
  const readyGeneration = await json(generatedDoc, '/image-jobs', { prompt: 'persist ready illustration', width: 1024, height: 1024 })
  await expect.poll(async () => (await json(id, '/image/jobs')).jobs.find((j: any) => j.jobId === readyInpaint.jobId)?.status).toBe('ready')
  await expect.poll(async () => (await json(generatedDoc, '/image-jobs')).jobs.find((j: any) => j.jobId === readyGeneration.jobId)?.status).toBe('ready')
  const pixels = Buffer.from(await (await request(id, `/image/jobs/${readyInpaint.jobId}/content`)).arrayBuffer())
  const shared = Buffer.from(await (await request(id, `/image/jobs/${readyInpaint.jobId}/mask`)).arrayBuffer())
  const slowInpaint = await json(id, '/image/jobs', { expectedRevision: 0, mask: mask.toString('base64'), prompt: 'SLOW_RECOVERY inpaint', agents: 1, feather: 0 })
  const queued = await json(id, '/image/jobs', { expectedRevision: 0, mask: mask.toString('base64'), prompt: 'queued behind recovery', agents: 1, feather: 0 })
  const slowGeneration = await json(generatedDoc, '/image-jobs', { prompt: 'SLOW_RECOVERY generation', width: 1024, height: 1024 })
  await expect.poll(async () => (await json(id, '/image/jobs')).jobs.find((j: any) => j.jobId === slowInpaint.jobId)?.status).toBe('generating')
  await expect.poll(async () => (await json(generatedDoc, '/image-jobs')).jobs.find((j: any) => j.jobId === slowGeneration.jobId)?.status).toBe('generating')
  expect((await request(id, '/image/commit', { expectedRevision: 0, png: source.toString('base64') })).status).toBe(409)
  const requested = providerRequests, exited = new Promise<void>(done => apiProcess.once('exit', () => done())); apiProcess.kill('SIGKILL'); await exited
  apiProcess = start(binary, ['hdoc', 'serve', '--root', resolve(root, 'service'), '--bind', new URL(apiUrl).host], serverEnv)
  await ready(`${apiUrl}/health`)
  const restored = (await json(id, '/image/jobs')).jobs
  expect(restored.find((j: any) => j.jobId === slowInpaint.jobId).status).toBe('interrupted')
  expect(restored.find((j: any) => j.jobId === queued.jobId).status).toBe('interrupted')
  expect(restored.find((j: any) => j.jobId === readyInpaint.jobId).status).toBe('ready')
  const illustration = (await json(generatedDoc, '/image-jobs')).jobs
  expect(illustration.find((j: any) => j.jobId === slowGeneration.jobId).status).toBe('interrupted')
  expect(illustration.find((j: any) => j.jobId === readyGeneration.jobId).status).toBe('ready')
  expect(illustration.every((j: any) => j.owner === undefined && j.href === undefined && j.cancelled === undefined)).toBe(true)
  expect(Buffer.from(await (await request(generatedDoc, `/image-jobs/${readyGeneration.jobId}/content`)).arrayBuffer())).toEqual(generatedSquare)
  expect(Buffer.from(await (await request(id, `/image/jobs/${readyInpaint.jobId}/content`)).arrayBuffer())).toEqual(pixels)
  expect(Buffer.from(await (await request(id, `/image/jobs/${readyInpaint.jobId}/mask`)).arrayBuffer())).toEqual(shared)
  expect((await request(id, `/image/jobs/${readyInpaint.jobId}`, undefined, 'write', 'other-user', 'DELETE')).status).toBe(403)
  expect((await request(generatedDoc, `/image-jobs/${readyGeneration.jobId}`, undefined, 'write', 'other-user', 'DELETE')).status).toBe(403)
  expect((await request(id, `/image/jobs/${slowInpaint.jobId}/apply`, { expectedRevision: 0 })).status).toBe(409)
  await open(page, doc); await page.getByRole('button', { name: '用 AI 处理这张图片', exact: true }).click()
  await expect(page.getByText('已中断，区域已释放', { exact: true }).first()).toBeVisible()
  await page.getByText('已中断，区域已释放', { exact: true }).last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('image-service-restarted.png') })
  const applied = await json(id, `/image/jobs/${readyInpaint.jobId}/apply`, { expectedRevision: 0 }); expect(applied.revision).toBe(1)
  const retry = await json(id, `/image/jobs/${readyInpaint.jobId}/apply`, { expectedRevision: 0 }); expect(retry).toMatchObject({ revision: 1, alreadyApplied: true })
  expect((await json(id, '/image')).revision).toBe(1)
  expect((await request(id, '/image/commit', { expectedRevision: 1, png: source.toString('base64') })).status).toBe(200)
  expect(providerRequests).toBe(requested)
})
