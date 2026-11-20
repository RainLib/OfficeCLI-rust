import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, createWriteStream, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { selectedRegion } from '../src/canvas/changes.ts'

const repo = resolve(import.meta.dirname, '../../../..'), editor = resolve(import.meta.dirname, '..')
const binary = process.env.OFFICECLI_BIN || resolve(repo, 'target/debug/officecli')
const host = process.env.HCD_CANVAS_TEST_HOST || '127.0.0.1', urlHost = host.includes(':') ? `[${host}]` : host
const diagrams = JSON.parse(readFileSync(resolve(repo, 'crates/canvas-core/fixtures/diagrams.json'), 'utf8'))
const secret = randomBytes(32).toString('hex'), children: ChildProcess[] = [], id = 'composition-board'
let root: string, apiUrl: string, uiUrl: string, model: Server, epoch = 0
let activeWorkers = 0, maximumWorkers = 0, draftCalls = 0, hold = false, release: (() => void)[] = []
function token(scope = 'write', user = 'composer') {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url'), now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ doc: id, sub: user, name: user==='composer'?'设计同伴':'纸舟', scope, aud: 'hcd-core', iat: now, exp: now + 3600 })}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
async function port() { const s = createServer(); await new Promise<void>(r => s.listen(0, host, r)); const n = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return n }
function start(command: string, args: string[], extra: NodeJS.ProcessEnv) {
  const env = { ...process.env, HCD_TOKEN_SECRET: secret, HCD_API_TARGET: apiUrl, HCD_VITE_CACHE_DIR: resolve(root, 'vite-cache'), ...extra }; delete env.HCD_DATABASE_URL; delete env.HCD_S3_BUCKET; delete env.HCD_DEFAULT_THEME
  const child = spawn(command, args, { cwd: editor, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
  const log = createWriteStream(resolve(root, `process-${child.pid}.log`)); child.stdout?.pipe(log); child.stderr?.pipe(log)
}
async function request(route: string, body?: unknown, scope = 'write', method = 'POST', user = 'composer') {
  return fetch(`${apiUrl}/v1/documents/${id}${route}`, { method: body === undefined && method === 'POST' ? 'GET' : method, headers: { Authorization: `Bearer ${token(scope,user)}`, 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(epoch) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function read() { const r = await request('/canvas'); expect(r.ok).toBeTruthy(); const v = await r.json(); epoch = v.collaborationEpoch; return v }
async function open(page: Page, scope = 'write', user = 'composer') {
  await page.goto(`${uiUrl}/?locale=zh-CN`); if (await page.getByRole('button', { name: '文档工作台', exact: true }).isVisible()) await page.getByRole('button', { name: '文档工作台', exact: true }).click(); await page.getByPlaceholder('doc-…').fill(id); await page.getByPlaceholder('粘贴短期令牌', { exact: true }).fill(token(scope,user)); await page.getByRole('button', { name: '打开文档', exact: true }).click()
  await expect(page.locator('.canvas-workspace')).toBeVisible(); await expect(page.locator('.excalidraw canvas').first()).toBeVisible(); await expect(page.locator('.canvas-connection')).toHaveAttribute('data-connected', 'true')
}
const composition = (layout = 'grid', kind = 'bubble') => ({ title: '让协作自然发生', layout, items: [{ title: '理解问题', body: '从共同的目标出发，保留真实的使用场景。', kind }, { title: '连接资料', body: '把文档、表格和灵感连接在一起，让每个决定都有依据。', kind }, { title: '一起行动', body: '划分清晰的工作区域，逐步完成有价值的下一步。', kind }] })
const target = { canvas: { elementIds: [], region: { x: -100000000, y: -100000000, width: 200000000, height: 200000000 } }, composition: { appendOnly: true, layout: 'grid', kind: 'bubble' } }
const journalVisual = { style: 'journal', palette: 'apricot', paper: 'dot', brush: 'marker', stickers: [{ motif: 'flower', motion: 'float', position: 'heading' }, { motif: 'book', motion: 'none', position: 'heading' }, { motif: 'mascot', motion: 'wiggle', position: 'footer' }, { motif: 'spark', motion: 'none', position: 'footer' }] }
const teamVisual = { style: 'journal', palette: 'ocean', paper: 'plain', brush: 'pastel', stickers: [{ motif: 'paperPlane', motion: 'auto', position: 'footer' }] }
const journal = { title: '把春天，写进这一周', layout: 'grid', diagram: null, visual: journalVisual, items: [
  { title: '周一 · 慢慢翻开', body: '选一本想读的书，给自己留二十分钟。\n记录今天最想了解的问题。', kind: 'note' },
  { title: '周二 · 发现一句话', body: '摘下一句打动你的文字。\n写下它让你想到的一个生活片段。', kind: 'card' },
  { title: '周三 · 灵感散步', body: '带着书中的问题散步。\n用一个比喻，画出你的新发现。', kind: 'bubble' },
  { title: '周四 · 和朋友聊聊', body: '分享一个小小的发现。\n留一处空白，记下朋友的不同看法。', kind: 'note' },
  { title: '周五 · 温柔地回看', body: '这一周，什么想法发生了变化？\n给下周的自己留一句鼓励。', kind: 'card' },
  { title: '周末 · 让想法生长', body: '继续阅读，也允许自己停下来。\n在这里加上你的画、照片和新灵感。', kind: 'bubble' },
] }
const fieldJournal = { title: '春日观察手记', layout: 'grid', diagram: null, visual: {
  style: 'journal', palette: 'apricot', paper: 'dot', brush: 'watercolor',
  stickers: [{ motif: 'petals', motion: 'auto', position: 'heading' }, { motif: 'butterfly', motion: 'auto', position: 'footer' }],
}, items: [
  { title: '树梢的第一朵花', body: '先看轮廓，再看花心。\n用两种颜色记下花瓣的内外缘。', kind: 'note' },
  { title: '蝴蝶停在哪里？', body: '安静等它停下，观察翅膀收拢的瞬间。\n在旁边补画你看到的纹路。', kind: 'bubble' },
] }
const batch = (revision: number, operations: unknown[]) => ({ schemaVersion: 'officecli-canvas/1', documentId: id, patchId: randomUUID(), baseRevision: revision, operations })
async function done(runId: string, status = 'completed') {
  await expect.poll(async () => (await (await request(`/agent-runs/${runId}`)).json()).status, { timeout: 40_000 }).not.toBe('running')
  const run = await (await request(`/agent-runs/${runId}`)).json(); expect(run.status, JSON.stringify(run)).toBe(status); return run
}
function preserved(before: any, after: any) { for (const element of before.scene.elements) expect(after.scene.elements.find((e: any) => e.id === element.id)).toEqual(element) }

test.beforeAll(async () => {
  root = mkdtempSync(resolve(tmpdir(), 'officecli-composition-'))
  const source = resolve(root, 'source.excalidraw'), service = resolve(root, 'service')
  writeFileSync(source, JSON.stringify({ type: 'excalidraw', version: 2, elements: [
    { id: 'human-card', type: 'rectangle', x: 0, y: 0, width: 300, height: 180, strokeColor: '#61655c', backgroundColor: '#edf0e6', fillStyle: 'solid', roundness: { type: 3 }, customData: { humanOwned: true } },
    { id: 'human-title', type: 'text', x: 24, y: 56, width: 240, height: 30, text: '已有想法 · 保留原位', fontSize: 20, fontFamily: 2, lineHeight: 1.4 },
  ], files: {}, appState: { viewBackgroundColor: '#faf9f6' } }))
  const imported = spawnSync(binary, ['hdoc', 'import', source, '--output', resolve(service, `${id}.hcd`), '--document-id', id], { encoding: 'utf8' }); if (imported.status !== 0) throw new Error(imported.stderr)
  const apiPort = await port(), uiPort = await port(); apiUrl = `http://${urlHost}:${apiPort}`; uiUrl = `http://${urlHost}:${uiPort}`
  model = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString())
      const fn = (name: string, args: unknown) => ({ status: 'completed', output: [{ type: 'function_call', name, call_id: randomUUID(), arguments: JSON.stringify(args) }] })
      const text = (message: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: message }] }] })
      let output: unknown
      if (body.tool_choice?.name === 'hcd_plan_canvas_team') {
        output = fn('hcd_plan_canvas_team', { sharedContext: '围绕产品发布，各分区分别处理研究、执行和复盘。保留已有布局。', units: ['用户研究', '执行计划', '发布复盘'].map(title => ({ title, instructions: `为${title}制作三条简洁气泡，只准备本分区。` })) })
      } else if (body.tool_choice?.name === 'hcd_draft_canvas_region') {
        const input = JSON.parse(body.input[0].content); activeWorkers++; draftCalls++; maximumWorkers = Math.max(maximumWorkers, activeWorkers)
        try {
          if (hold && input.title !== '用户研究') await new Promise<void>(r => release.push(r)); else await new Promise<void>(r => setTimeout(r, 350))
          output = fn('hcd_draft_canvas_region', { ...(diagrams[input.target?.composition?.layout] || composition()), ...(input.target?.composition?.visualPlanning ? { visual: teamVisual } : {}), title: input.title })
        } finally { activeWorkers-- }
      } else {
        const calls = body.input.filter((v: any) => v.type === 'function_call'), results = body.input.filter((v: any) => v.type === 'function_call_output').map((v: any) => ({ call: calls.find((c: any) => c.call_id === v.call_id), result: JSON.parse(v.output) }))
        const latest = (resource: string) => results.filter((v: any) => v.call?.name === 'hcd_read' && JSON.parse(v.call.arguments).resource === resource).at(-1)?.result.data
        const layout = String(body.input[0].content).match(/"layout"\s*:\s*"(flowchart|architecture|mindmap|lesson)"/)?.[1] || Object.entries({ flowchart: '流程图', architecture: '架构图', mindmap: '头脑风暴', lesson: '课程讲解' }).find(([, label]) => String(body.input[0].content).includes(`请根据我的需求生成${label}`))?.[0]
        const autoVisual = String(body.input[0].content).includes('visualPlanning')
        const planned = results.find((v: any) => v.call?.name === 'hcd_canvas_plan')?.result.data
        if (!latest('auth')) output = fn('hcd_read', { document_id: id, resource: 'auth' })
        else if (!latest('canvas') || results.at(-1)?.call.name === 'hcd_patch') output = fn('hcd_read', { document_id: id, resource: 'canvas' })
        else if (String(body.input[0].content).includes('ATTACK') && !calls.some((v: any) => v.name === 'hcd_patch')) {
          output = fn('hcd_patch', { document_id: id, mode: 'canvas', expected_revision: latest('canvas').revision, collaboration_epoch: latest('auth').collaborationEpoch, patch: batch(latest('canvas').revision, [{ op: 'element.update', id: 'human-card', before: { x: 0 }, changes: { x: 800 } }]) })
        } else if (calls.some((v: any) => v.name === 'hcd_patch')) {
          const readback = results.slice(results.findLastIndex((v: any) => v.call?.name === 'hcd_patch') + 1).filter((v: any) => v.call?.name === 'hcd_read' && JSON.parse(v.call.arguments).resource === 'canvas').at(-1)
          const page = JSON.parse(readback.call.arguments).number || 0
          output = (page + 1) * readback.result.data.pageSize < readback.result.data.totalElements ? fn('hcd_read', { document_id: id, resource: 'canvas', number: page + 1 }) : text('已追加并回读全部新内容，已有布局保持不变。')
        }
        else if (!planned && String(body.input[0].content).includes('春日观察手账') && latest('canvas_materials')?.level !== 'detail') {
          const stage=latest('canvas_materials')
          if (stage && !['overview','candidates'].includes(stage.level)) throw Error('Unexpected catalog response')
          if (stage?.level==='candidates' && !stage.items.some((item:any)=>item.id==='petals')) throw Error('Missing spring petals')
          output=fn('hcd_read',{document_id:id, resource:'canvas_materials', ...(stage?.level==='overview'?{query:'春日'}:stage?.level==='candidates'?{material_id:'petals'}:{})})
        } else if (!planned) {
          const prompt = String(body.input[0].content)
          const draft = prompt.includes('春日观察手账') ? fieldJournal : prompt.includes('帮我规划一周阅读手账') ? journal : { ...(layout ? diagrams[layout] : composition()), ...(autoVisual ? { visual: { ...journalVisual, style: layout === 'architecture' ? 'studio' : 'journal' } } : {}) }
          output = fn('hcd_canvas_plan', { document_id: id, expected_revision: latest('canvas').revision, patch_id: randomUUID(), composition: draft })
        }
        else output = fn('hcd_patch', { document_id: id, mode: 'canvas', expected_revision: planned.batch.baseRevision, collaboration_epoch: planned.collaborationEpoch, patch: planned.batch })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(output))
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  await new Promise<void>(r => model.listen(0, host, r))
  start(binary, ['hdoc', 'serve', '--root', service, '--bind', `${urlHost}:${apiPort}`], { OPENAI_API_KEY: 'composition-test-only', HCD_OPENAI_BASE_URL: `http://${urlHost}:${(model.address() as { port: number }).port}/v1`, HCD_OPENAI_MODEL: 'composition-test', HCD_AI_ENABLED: 'true' })
  await expect.poll(async () => { try { return (await fetch(`${apiUrl}/health`)).status } catch { return 0 } }).toBe(200)
  start(process.execPath, ['node_modules/vite/bin/vite.js', '--host', host, '--port', String(uiPort), '--strictPort'], { HCD_API_TARGET: apiUrl.replace('[::1]', 'localhost') })
  await expect.poll(async () => { try { return (await fetch(uiUrl)).status } catch { return 0 } }, { timeout: 30_000 }).toBe(200)
})
test.beforeEach(async () => { hold = false; release.splice(0).forEach(r => r()); const before = await read(); if (before.revision > 0) { const r = await request('/restore/0', { expectedRevision: before.revision }); expect(r.ok, await r.clone().text()).toBeTruthy(); } await read(); maximumWorkers = 0; draftCalls = 0 })
test.afterAll(() => { hold = false; release.splice(0).forEach(r => r()); for (const child of children) child.kill('SIGTERM'); model?.close(); console.log(`Composition acceptance artifacts: ${root}`) })

test('manual bubbles append as editable native objects and keep the existing layout', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); await open(page); const before = await read()
  await page.getByRole('button', { name: 'AI 创作', exact: true }).click(); await expect(page.getByRole('dialog', { name: '把想法变成一张白板' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('composition-dialog.png'), fullPage: true }); await page.getByRole('button', { name: '直接排版', exact: true }).click()
  await page.getByLabel('分区标题', { exact: true }).fill('让协作自然发生'); await page.getByLabel('排版内容', { exact: true }).fill(composition().items.map(i => `${i.title} | ${i.body}`).join('\n'))
  await page.getByRole('button', { name: '追加到白板', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0)
  const after = await read(); preserved(before, after); expect(after.scene.elements.length).toBeGreaterThan(before.scene.elements.length)
  expect(after.scene.elements.filter((e: any) => e.type === 'text' && e.customData?.officeComposition).length).toBe(7)
  expect(after.scene.elements.filter((e: any) => e.id.endsWith('-tail')).length).toBe(3)
  await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision', String(after.revision)); await page.screenshot({ path: info.outputPath('composition-bubbles.png'), fullPage: true })
  // Native cards remain real editable objects after reload, with no image flattening.
  await page.reload(); await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision', String(after.revision)); expect((await read()).scene).toEqual(after.scene); expect(errors).toEqual([])
})

test('occupied whitespace rejects the whole batch; replan and replay are safe', async () => {
  const before = await read(), planned = await (await request('/canvas/layout', { expectedRevision: before.revision, patchId: randomUUID(), composition: composition('flow', 'card') })).json()
  expect(planned.batch.operations.filter((op: any) => op.element.type === 'arrow')).toHaveLength(2)
  const area = planned.batch.vacantRegions[0]
  const human = await request('/canvas/patch', batch(before.revision, [{ op: 'element.add', element: { id: 'human-new', type: 'ellipse', x: area.x + 5, y: area.y + 5, width: 100, height: 80 } }])); expect(human.ok).toBeTruthy()
  const occupied = await read(), rejected = await request('/canvas/patch', planned.batch); expect([409, 412]).toContain(rejected.status); expect((await read()).scene).toEqual(occupied.scene)
  const fresh = await (await request('/canvas/layout', { expectedRevision: occupied.revision, patchId: randomUUID(), composition: composition('timeline', 'note') })).json()
  const committed = await request('/canvas/patch', fresh.batch); expect(committed.ok, await committed.clone().text()).toBeTruthy(); const receipt = await committed.json()
  const replay = await (await request('/canvas/patch', fresh.batch)).json(); expect(replay.revision).toBe(receipt.revision); expect(replay.idempotentReplay).toBe(true); preserved(occupied, await read())
  const readOnly = await request('/canvas/patch', fresh.batch, 'read'); expect(readOnly.status).toBe(403)
})

test('three Agents draft concurrently and append independent aligned regions through the UI', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await open(page); const before = await read()
  const globalEntry = page.getByRole('button', { name: 'AI 协作', exact: true })
  const chatMark = page.locator('.agent-chat-tab .oc-companion')
  if (await globalEntry.getAttribute('aria-pressed') !== 'true') await globalEntry.click()
  await page.getByRole('textbox', { name: 'Agent 任务', exact: true }).focus()
  await expect(chatMark).toHaveAttribute('data-companion-state', 'listening')
  await globalEntry.click()
  await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
  await page.getByLabel('追加内容要求', { exact: true }).fill('围绕产品发布，补充用户研究、执行计划和发布复盘。'); await page.getByText('协作设置', { exact: true }).click(); await page.getByLabel('排版协同人数', { exact: true }).selectOption('3');
  hold = true
  const sent = page.waitForResponse(r => r.url().endsWith('/agent-runs') && r.request().method() === 'POST'); await page.getByRole('button', { name: '生成到白板', exact: true }).click(); const response = await sent; expect(response.status()).toBe(202)
  try {
    await expect(globalEntry.locator('.oc-companion')).toHaveAttribute('data-companion-state', 'active')
    await expect(chatMark).toHaveAttribute('data-companion-state', 'active')
    await expect(chatMark.locator('[data-sticker-layer=quote-open]')).toHaveCSS('animation-name', 'none')
    await chatMark.evaluate(mark => {
      const record = () => {
        if (mark.getAttribute('data-companion-state') === 'complete') mark.setAttribute('data-completion-seen', 'true')
      }
      new MutationObserver(record).observe(mark, { attributes: true, attributeFilter: ['data-companion-state'] })
    })
  } finally { hold = false; release.splice(0).forEach(resolve => resolve()) }
  expect(response.request().postDataJSON().agentCount).toBe(3); expect(response.request().postDataJSON().target.composition.appendOnly).toBe(true); const run = await done((await response.json()).runId); expect(maximumWorkers).toBe(3); expect(draftCalls).toBe(3); expect(run.committedRevisions).toHaveLength(1)
  expect(run.team.units.every((unit: any) => unit.status === 'completed' && unit.canvasDraft && unit.canvasRegion)).toBe(true)
  await expect(page.locator('.canvas-sticker[data-motif=paperPlane]')).toHaveCount(3)
  await expect(page.getByRole('button', { name: '沿用粉蜡笔手绘' })).toBeVisible()
  const regions = run.team.units.map((u: any) => u.canvasRegion)
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) { const a = regions[i], b = regions[j]; expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false) }
  const after = await read(); preserved(before, after); await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision', String(after.revision))
  const card = page.locator('.agent-task-run').filter({ hasText: '围绕产品发布' }); await expect(card).toHaveClass(/run-completed/)
  await expect(card.locator('.agent-response-avatar .oc-companion')).toHaveAttribute('data-companion-state', 'still')
  await expect(chatMark).toHaveAttribute('data-completion-seen', 'true')
  const team = card.locator('details').filter({ has: page.locator('[data-team-unit]') }).first(); await team.locator('summary').first().click()
  await card.getByRole('button', { name: '定位分区', exact: true }).first().click(); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); await expect(page.locator('.canvas-connection')).toContainText('1 人', { timeout: 15000 }); await page.screenshot({ path: info.outputPath('composition-team.png'), fullPage: true })
})

test('single AI uses the deterministic layout tool and cannot alter old objects in append mode', async () => {
  const before = await read(), response = await request('/agent-runs', { task: '追加三条讨论气泡。', target, agentCount: 1 }); expect(response.status).toBe(202)
  const run = await done((await response.json()).runId); expect(run.committedRevisions).toHaveLength(1); preserved(before, await read())
  const after = await read(), attack = await request('/agent-runs', { task: 'ATTACK 修改已有对象', target, agentCount: 1 }); expect(attack.status).toBe(202)
  await done((await attack.json()).runId, 'failed'); expect((await read()).scene).toEqual(after.scene)
})

test('cancelling a drafting team writes nothing; explicit continuation can finish without duplicate sections', async () => {
  hold = true; const before = await read(), started = await request('/agent-runs', { task: '制作三个产品发布分区。', target, agentCount: 3 }); expect(started.status).toBe(202); const runId = (await started.json()).runId
  await expect.poll(async () => (await (await request(`/agent-runs/${runId}`)).json()).team?.units.filter((u: any) => u.canvasDraft).length).toBe(1); await expect.poll(() => activeWorkers).toBe(2); const cancelled = await request(`/agent-runs/${runId}`, undefined, 'write', 'DELETE'); expect(cancelled.ok).toBeTruthy()
  await expect.poll(async () => (await (await request(`/agent-runs/${runId}`)).json()).status).toBe('cancelled'); hold = false; release.splice(0).forEach(r => r()); await expect.poll(() => activeWorkers).toBe(0)
  expect((await read()).scene).toEqual(before.scene); expect((await read()).revision).toBe(before.revision)
  const review = await (await request(`/agent-runs/${runId}/continuation`)).json(); expect(review.canContinue, JSON.stringify(review)).toBe(true)
  const resumed = await request(`/agent-runs/${runId}/continuation`, { fingerprint: review.fingerprint, expectedRevision: review.revision, collaborationEpoch: review.collaborationEpoch, authorizeRemaining: true }); expect(resumed.status, await resumed.clone().text()).toBe(202)
  const result = await done(runId); expect(result.committedRevisions).toHaveLength(1); preserved(before, await read()); expect(result.team.units).toHaveLength(3); expect(draftCalls).toBe(5)
})

test('read-only viewers have no composition entry, and mobile dialog remains usable', async ({ page }) => {
  await open(page, 'read'); await expect(page.getByRole('button', { name: 'AI 创作', exact: true })).toHaveCount(0)
  await page.context().clearCookies(); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() }); await open(page); await page.setViewportSize({ width: 780, height: 850 })
  await page.getByRole('button', { name: 'AI 创作', exact: true }).click(); await page.setViewportSize({ width: 390, height: 800 }); const dialog = page.getByRole('dialog', { name: '把想法变成一张白板' }); await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
})

test('a team rereads human changes before append and cannot escape a selected region', async () => {
  hold = true; const before = await read(), response = await request('/agent-runs', { task: '补充三个独立分区。', target, agentCount: 3 }); expect(response.status).toBe(202); const runId = (await response.json()).runId
  await expect.poll(async () => (await (await request(`/agent-runs/${runId}`)).json()).team?.units.filter((u: any) => u.canvasDraft).length).toBe(1)
  const moved = await request('/canvas/patch', batch(before.revision, [{ op: 'element.update', id: 'human-card', before: { x: 0 }, changes: { x: 900 } }])); expect(moved.ok).toBeTruthy(); const human = await read()
  hold = false; release.splice(0).forEach(r => r()); await done(runId); preserved(human, await read())
  const completed = await read(), narrow = { ...target, canvas: { elementIds: [], region: { x: -1000, y: -1000, width: 300, height: 300 } } }
  const limited = await request('/agent-runs', { task: '只在授权空白分区内增加内容。', target: narrow, agentCount: 2 }); expect(limited.status).toBe(202)
  await done((await limited.json()).runId, 'failed'); expect((await read()).scene).toEqual(completed.scene)
})

for (const [layout, label] of [['flowchart', '流程图'], ['architecture', '架构图'], ['mindmap', '头脑风暴'], ['lesson', '课程讲解']]) {
  test(`AI generates an editable ${layout} from a description and supports navigation`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await open(page); const before = await read()
    await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '把想法变成一张白板' }); await expect(dialog.getByRole('button', { name: 'AI 创作', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByLabel('排版内容', { exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: new RegExp(`^${label}`) })).toHaveCount(0); await dialog.getByLabel('追加内容要求', { exact: true }).fill(`请根据我的需求生成${label}：${diagrams[layout].title}。`)
    if (layout === 'architecture') await page.screenshot({ path: info.outputPath('ai-creation-dialog.png'), fullPage: true })
    const sent = page.waitForResponse(r => r.url().endsWith('/agent-runs') && r.request().method() === 'POST'); await dialog.getByRole('button', { name: '生成到白板', exact: true }).click(); const response = await sent
    expect(response.status()).toBe(202); expect(response.request().postDataJSON().target.composition).toEqual({ appendOnly: true, visualPlanning: true })
    await expect(dialog).toHaveCount(0); const run = await done((await response.json()).runId); expect(run.committedRevisions).toHaveLength(1)
    const after = await read(); preserved(before, after)
    const nodes = after.scene.elements.filter((e: any) => e.customData?.officeDiagram?.nodeId); const edges = after.scene.elements.filter((e: any) => e.type === 'arrow')
    expect(nodes).toHaveLength(diagrams[layout].diagram.nodes.length); expect(edges).toHaveLength(diagrams[layout].diagram.edges.length)
    for (const edge of edges) {
      expect(nodes.some((n: any) => n.id === edge.startBinding.elementId)).toBe(true); expect(nodes.some((n: any) => n.id === edge.endBinding.elementId)).toBe(true)
      expect(edge.elbowed).toBe(true); expect(edge.roughness).toBe(0)
      expect(edge.startBinding.fixedPoint).toHaveLength(2); expect(edge.endBinding.fixedPoint).toHaveLength(2)
      for (let i = 1; i < edge.points.length; i++) expect(edge.points[i][0] === edge.points[i - 1][0] || edge.points[i][1] === edge.points[i - 1][1]).toBe(true)
    }
    await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision', String(after.revision))
    await page.getByRole('button', { name: '定位生成作品', exact: true }).click(); await expect(page.locator('.canvas-connection')).toContainText('1 人', { timeout: 15000 })
    await page.screenshot({ path: info.outputPath(`ai-${layout}.png`), fullPage: true })
    if (layout === 'lesson') { await page.getByRole('button', { name: '下一讲解步骤', exact: true }).click(); await expect(page.getByLabel('生成作品导览')).toContainText('1/3 理解概念'); await page.getByRole('button', { name: '下一讲解步骤', exact: true }).click(); await expect(page.getByLabel('生成作品导览')).toContainText('2/3 示范与练习'); await page.screenshot({ path: info.outputPath('ai-lesson-step.png'), fullPage: true }) }
    await page.reload(); await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision', String(after.revision)); expect((await read()).scene).toEqual(after.scene); expect(errors).toEqual([])
  })
}

test('semantic diagrams also work in partitioned multi-Agent drafts', async () => {
  const before = await read(), response = await request('/agent-runs', { task: '为三个相关子系统分别生成完整架构图，保留现有内容。', target: { ...target, composition: { appendOnly: true, layout: 'architecture' } }, agentCount: 2 }); expect(response.status).toBe(202)
  const result = await done((await response.json()).runId); expect(result.team.units).toHaveLength(3); expect(result.team.units.every((u: any) => u.canvasDraft.diagram && u.status === 'completed')).toBe(true)
  expect(maximumWorkers).toBe(2); const after = await read(); preserved(before, after); expect(after.scene.elements.filter((e: any) => e.customData?.officeDiagram?.nodeId)).toHaveLength(18)
})

test('rounded connectors follow a native card drag, persist bindings and include negative route bounds', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const before = await read(), plan = await (await request('/canvas/layout', { expectedRevision: before.revision, patchId: randomUUID(), composition: diagrams.flowchart })).json()
  const saved = await request('/canvas/patch', plan.batch); expect(saved.ok, await saved.clone().text()).toBe(true)
  await open(page); await page.getByRole('button', { name: '定位生成作品', exact: true }).click()
  const snapshot = await read(), generated = snapshot.scene.elements.filter((e: any) => e.customData?.officeComposition)
  const bounds = selectedRegion(generated, generated.map((e: any) => e.id))!.region
  const surface = (await page.locator('.excalidraw').boundingBox())!
  const zoom = Number((await page.locator('.reset-zoom-button').textContent())!.replace('%', '')) / 100
  const node = generated.find((e: any) => e.customData?.officeDiagram?.nodeId === 'start')
  const edge = generated.find((e: any) => e.startBinding?.elementId === node.id)
  const x = surface.x + surface.width / 2 + (node.x + node.width / 2 - bounds.x - bounds.width / 2) * zoom
  const y = surface.y + surface.height / 2 + (node.y + node.height / 2 - bounds.y - bounds.height / 2) * zoom
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 65, y + 20, { steps: 12 }); await page.mouse.up()
  await expect.poll(async () => (await read()).scene.elements.find((e: any) => e.id === node.id).x).not.toBe(node.x)
  await page.getByRole('button', { name: '保存画布', exact: true }).click()
  const after = await read(), moved = after.scene.elements.find((e: any) => e.id === edge.id)
  expect(moved.elbowed).toBe(true); expect(moved.startBinding.elementId).toBe(node.id)
  expect([moved.x, moved.y, moved.points]).not.toEqual([edge.x, edge.y, edge.points])
  for (let i = 1; i < moved.points.length; i++) expect(Math.abs(moved.points[i][0] - moved.points[i - 1][0]) < .001 || Math.abs(moved.points[i][1] - moved.points[i - 1][1]) < .001).toBe(true)
  preserved(before, after)
  await page.reload(); await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision', String(after.revision)); expect((await read()).scene).toEqual(after.scene)
  await page.getByRole('button', { name: '定位生成作品', exact: true }).click(); await page.screenshot({ path: info.outputPath('ai-connectors-after-drag.png'), fullPage: true })
  const arrow = { id: 'negative', type: 'arrow', x: 10, y: 10, width: 1, height: 1, points: [[0, 0], [-900, 300], [80, 0]] }
  expect(selectedRegion([arrow], [arrow.id])!.region).toEqual({ x: -890, y: 10, width: 980, height: 300 })
  const stroke = { ...arrow, type: 'freedraw', points: Array.from({ length: 100_000 }, (_, i) => [-i, i / 2]) }
  expect(selectedRegion([stroke], [stroke.id])!.region).toEqual({ x: -99989, y: 10, width: 99999, height: 49999.5 })
})

test('AI plans a journal without design pickers and animated stickers persist, export and follow edits', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await open(page); const before = await read()
  await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '把想法变成一张白板' })
  await expect(dialog.getByRole('group', { name: '内容样式' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '卡片网格', exact: false })).toHaveCount(0)
  await dialog.getByLabel('追加内容要求', { exact: true }).fill('帮我规划一周阅读手账，温柔、精美，有纸张、画笔和可爱的动态贴纸。')
  await page.screenshot({ path: info.outputPath('journal-ai-dialog.png'), fullPage: true })
  const sent = page.waitForResponse(r => r.url().endsWith('/agent-runs') && r.request().method() === 'POST'); await dialog.getByRole('button', { name: '生成到白板', exact: true }).click(); const response = await sent
  expect(response.request().postDataJSON().target.composition).toEqual({ appendOnly: true, visualPlanning: true }); await done((await response.json()).runId)
  const after = await read(); preserved(before, after)
  const anchors = after.scene.elements.filter((e: any) => e.customData?.officeSticker)
  expect(anchors).toHaveLength(4); expect(after.scene.elements.some((e: any) => e.customData?.officeJournal)).toBe(true)
  await expect(page.locator('.canvas-sticker')).toHaveCount(2)
  await expect.poll(async () => page.locator('.canvas-sticker-motion').first().evaluate(e => getComputedStyle(e).animationName)).toBe('sticker-float')
  await page.getByRole('button', { name: '定位生成作品', exact: true }).click()
  await expect(page.locator('.canvas-connection')).toContainText('1 人', { timeout: 15000 })
  await page.screenshot({ path: info.outputPath('journal-animated.png'), fullPage: true })
  // CSS animation never writes a revision; reduced-motion keeps the same artwork.
  expect((await read()).revision).toBe(after.revision)
  await page.getByRole('button', { name: '暂停贴纸动画', exact: true }).click()
  await expect.poll(async () => page.locator('.canvas-sticker-motion').first().evaluate(e => getComputedStyle(e).animationName)).toBe('none')
  await page.reload()
  await expect(page.getByRole('button', { name: '播放贴纸动画', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '播放贴纸动画', exact: true }).click()
  await expect.poll(async () => page.locator('.canvas-sticker-motion').first().evaluate(e => getComputedStyle(e).animationName)).toBe('sticker-float')
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect.poll(async () => page.locator('.canvas-sticker-motion').first().evaluate(e => getComputedStyle(e).animationName)).toBe('none')
  const part = after.scene.elements.find((e: any) => e.customData?.officeStickerPart?.anchor === anchors[0].id)
  const recolored = await request('/canvas/patch', batch(after.revision, [{ op: 'element.update', id: part.id, before: { backgroundColor: part.backgroundColor }, changes: { backgroundColor: '#99B79C' } }])); expect(recolored.ok).toBe(true)
  await expect(page.locator('.canvas-sticker[data-motif=flower] ellipse').first()).toHaveAttribute('fill', '#99B79C')
  // Exports keep the native, visible static fallback instead of projected opacity.
  await page.getByText('导出', { exact: true }).click(); const download = page.waitForEvent('download'); await page.getByRole('button', { name: '画布文件', exact: true }).click()
  const file = await download; const path = await file.path(); const exported = JSON.parse(readFileSync(path!, 'utf8'))
  expect(exported.elements.find((e: any) => e.id === part.id).opacity).toBe(100)
  await page.getByText('导出', { exact: true }).click(); const pngDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'PNG', exact: true }).click(); const png = await pngDownload; expect(readFileSync((await png.path())!).length).toBeGreaterThan(1000)
  const latest = await read(); await page.reload(); await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision', String(latest.revision)); await expect(page.locator('.canvas-sticker')).toHaveCount(2); expect((await read()).scene).toEqual(latest.scene)
  await page.getByRole('button', { name: '定位生成作品', exact: true }).click(); await page.screenshot({ path: info.outputPath('journal-reduced-motion.png'), fullPage: true }); expect(errors).toEqual([])
})

test('animated sticker native groups can be dragged and deleted without leaving a visual ghost', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const before = await read(), plan = await (await request('/canvas/layout', { expectedRevision: before.revision, patchId: randomUUID(), composition: journal })).json()
  expect((await request('/canvas/patch', plan.batch)).ok).toBe(true); await open(page)
  await page.getByRole('button', { name: '定位生成作品', exact: true }).click()
  const snapshot = await read(), elements = snapshot.scene.elements.filter((e: any) => e.customData?.officeComposition)
  const bounds = selectedRegion(elements, elements.map((e: any) => e.id))!.region, anchor = elements.find((e: any) => e.customData?.officeSticker?.motif === 'flower')
  const surface = (await page.locator('.excalidraw').boundingBox())!, zoom = Number((await page.locator('.reset-zoom-button').textContent())!.replace('%', '')) / 100
  const x = surface.x + surface.width / 2 + (anchor.x + anchor.width / 2 - bounds.x - bounds.width / 2) * zoom
  const y = surface.y + surface.height / 2 + (anchor.y + anchor.height / 2 - bounds.y - bounds.height / 2) * zoom
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 45, y + 25, { steps: 10 }); await page.mouse.up()
  await expect.poll(async () => (await read()).scene.elements.find((e: any) => e.id === anchor.id).x).not.toBe(anchor.x)
  const moved = await read(), delta = moved.scene.elements.find((e: any) => e.id === anchor.id).x - anchor.x
  for (const part of elements.filter((e: any) => e.customData?.officeStickerPart?.anchor === anchor.id)) { const saved = moved.scene.elements.find((e: any) => e.id === part.id); expect(saved.x - part.x).toBeCloseTo(delta); expect(saved.opacity).toBe(100) }
  await page.keyboard.press('Backspace'); await expect(page.locator('.canvas-sticker')).toHaveCount(1)
  await page.getByRole('button', { name: '保存画布', exact: true }).click(); await expect.poll(async () => (await read()).scene.elements.find((e: any) => e.id === anchor.id).isDeleted).toBe(true); const deleted = await read()
  preserved(before, deleted); await page.reload(); await expect(page.locator('.canvas-sticker')).toHaveCount(1)
})

test('AI respects the area selected for a journal and leaves the rest of the board intact', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)
  const before = await read()
  for (let index = 0; index < 6; index++) await page.locator('.zoom-out-button').click()
  await page.getByRole('button',{name:'操作',exact:true}).click()
  await page.getByRole('button', { name: '框选区域', exact: true }).click()
  const surface = (await page.locator('.canvas-surface').boundingBox())!
  await page.mouse.move(surface.x + surface.width / 2 + 110, surface.y + 130)
  await page.mouse.down()
  await page.mouse.move(surface.x + surface.width - 35, surface.y + surface.height - 95, { steps: 10 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '把想法变成一张白板' })
  await expect(dialog).toContainText('追加到框选区域内的空位')
  await dialog.getByLabel('追加内容要求', { exact: true }).fill('帮我规划一周阅读手账')
  const sent = page.waitForResponse(r => r.url().endsWith('/agent-runs') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '生成到白板', exact: true }).click()
  const response = await sent
  expect(response.status()).toBe(202)
  const region = response.request().postDataJSON().target.canvas.region
  expect(region.width).toBeLessThan(10000)
  await done((await response.json()).runId)
  const after = await read()
  preserved(before, after)
  const paper = after.scene.elements.find((element: any) => element.customData?.officeJournal)
  expect(paper.x).toBeGreaterThanOrEqual(region.x)
  expect(paper.y).toBeGreaterThanOrEqual(region.y)
  expect(paper.x + paper.width).toBeLessThanOrEqual(region.x + region.width)
  expect(paper.y + paper.height).toBeLessThanOrEqual(region.y + region.height)
})

async function saveStickerSvg(page: Page, motif: string, info: TestInfo) {
  const bounds = (await page.locator(`.canvas-sticker[data-motif="${motif}"]`).boundingBox())!
  const inkX = motif === 'mascot' ? .29 : .50
  await page.mouse.click(bounds.x + bounds.width * inkX, bounds.y + bounds.height * .46)
  await page.getByLabel('导出画布', { exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出所选贴纸 SVG' }).click()
  const path = info.outputPath(`${motif}.svg`)
  await (await download).saveAs(path)
  const xml = readFileSync(path, 'utf8')
  expect(xml).not.toMatch(/<script|<image|<foreignObject|https?:\/\/(?!www\.w3\.org)/i)
  const standalone = await page.context().newPage()
  try {
    await standalone.emulateMedia({ reducedMotion: 'no-preference' })
    await standalone.goto(`data:image/svg+xml;base64,${Buffer.from(xml).toString('base64')}`)
    await expect(standalone.locator('parsererror')).toHaveCount(0)
    await expect(standalone.locator('svg[aria-label]')).toHaveCount(1)
    const layer = standalone.locator('[data-sticker-layer]').first()
    await expect.poll(() => layer.evaluate(e => e.getAnimations().length)).toBe(motif === 'mascot' ? 2 : 1)
    await standalone.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => layer.evaluate(e => e.getAnimations().length)).toBe(0)
  } finally { await standalone.close() }
  return xml
}

test('AI pairs watercolor with drifting petals and articulated wings; a writer can draw and export editable motion', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await open(page)
  const before = await read()
  await page.getByRole('button', { name: 'AI 创作', exact: true }).click()
  await page.getByRole('button', { name: '试试这个例子' }).click()
  const sent = page.waitForResponse(r => r.url().endsWith('/agent-runs') && r.request().method() === 'POST')
  await page.getByRole('button', { name: '生成到白板' }).click()
  const response = await sent
  expect(response.request().postDataJSON().target.composition).toEqual({ appendOnly: true, visualPlanning: true })
  await done((await response.json()).runId)
  const scene = await read()
  preserved(before, scene)
  const heading = scene.scene.elements.find((e: any) => e.customData?.officeBrush)
  expect(heading.customData.officeBrush).toEqual({ kind: 'watercolor', color: '#D48260' })
  const panel = page.getByRole('button', { name: 'AI 协作', exact: true })
  if (await panel.getAttribute('aria-pressed') === 'true') await panel.click()
  await page.getByRole('button', { name: '定位生成作品', exact: true }).click()
  const petals = page.locator('.canvas-sticker[data-motif=petals]'), wings = page.locator('.canvas-sticker[data-motif=butterfly]')
  await expect(petals.locator('[data-sticker-layer=petal-near]')).toHaveCSS('animation-name', 'petal-drift')
  await expect(wings.locator('[data-sticker-layer=wing-left]')).toHaveCSS('animation-name', 'sticker-wing')
  await expect(wings.locator('g:not([data-sticker-layer]) > ellipse').last()).toHaveCSS('animation-name', 'none')
  await page.getByRole('button', { name: '暂停贴纸动画' }).click()
  await expect(wings.locator('[data-sticker-layer=wing-right]')).toHaveCSS('animation-name', 'none')
  await expect(petals.locator('[data-sticker-layer=petal-near]')).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.canvas-connection')).toContainText('1 人', { timeout: 15000 })
  await page.screenshot({ path: info.outputPath('spring-field-journal.png'), fullPage: true })
  await page.getByLabel('盖章与即时表情', {exact:true}).click()
  await expect(page.getByRole('region',{name:'印章选择器'})).toBeVisible()
  await page.screenshot({path:info.outputPath('figjam-journal.png'),fullPage:true})
  await page.keyboard.press('Escape')
  expect(await saveStickerSvg(page, 'petals', info)).toContain('petal-near')
  expect(await saveStickerSvg(page, 'butterfly', info)).toContain('wing-right')
  await page.getByLabel('导出画布', { exact: true }).click()
  const png = page.waitForEvent('download')
  await page.getByRole('button', { name: 'PNG', exact: true }).click()
  const file = readFileSync((await (await png).path())!)
  const wingPixels = await page.evaluate(async encoded => {
    const image = new Image()
    image.src = 'data:image/png;base64,' + encoded
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 116 && pixels[i + 1] === 170 && pixels[i + 2] === 174 && pixels[i + 3] === 255) count++
    }
    return count
  }, file.toString('base64'))
  expect(wingPixels).toBeGreaterThan(24)
  expect((await read()).revision).toBe(scene.revision)
  await page.getByRole('button', { name: '沿用水彩笔手绘' }).click()
  const surface = (await page.locator('.canvas-surface').boundingBox())!
  await page.mouse.move(surface.x + surface.width * .55, surface.y + surface.height * .68)
  await page.mouse.down()
  await page.mouse.move(surface.x + surface.width * .64, surface.y + surface.height * .65, { steps: 12 })
  await page.mouse.up()
  await page.getByRole('button', { name: '保存画布', exact: true }).click()
  await expect(page.locator('.status').first()).toContainText('已保存')
  const after = await read()
  expect(after.scene.elements.find((e: any) => e.type === 'freedraw')).toMatchObject({ strokeColor: '#D48260', strokeWidth: 4, opacity: 38 })
  preserved(scene, after)
  await page.reload()
  await expect(page.getByRole('button', { name: '播放贴纸动画' })).toBeVisible()
  await expect(page.locator('.canvas-sticker[data-motif=butterfly] [data-sticker-layer=wing-right]')).toHaveCSS('animation-name', 'none')
  expect((await read()).scene).toEqual(after.scene)
})

test('an airmail sticker retains its moving dashed trail and a recolored fold in the downloaded SVG', async ({ page }, info) => {
  const before = await read(), planned = await (await request('/canvas/layout', { expectedRevision: before.revision, patchId: randomUUID(), composition: {
    ...fieldJournal, title: '下一站，出发', visual: { ...fieldJournal.visual, brush: 'fountain', stickers: [{ motif: 'paperPlane', motion: 'auto', position: 'heading' }] },
  } })).json()
  expect((await request('/canvas/patch', planned.batch)).ok).toBe(true)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)
  await page.getByRole('button', { name: '定位生成作品', exact: true }).click()
  const sticker = page.locator('.canvas-sticker[data-motif=paperPlane]')
  await expect(sticker.locator('[data-sticker-layer=trail] polyline')).toHaveAttribute('stroke-dasharray', /\d/)
  await expect(sticker.locator('[data-sticker-layer=plane]')).toHaveCSS('animation-name', 'none')
  await expect(page.getByRole('button', { name: '沿用蘸水笔手绘' })).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(sticker.locator('[data-sticker-layer=trail]')).toHaveCSS('animation-name', 'sticker-trail')
  await expect(sticker.locator('[data-sticker-layer=plane]')).toHaveCSS('animation-name', 'sticker-glide')
  const original = await saveStickerSvg(page, 'paperPlane', info)
  const scene = await read(), fold = scene.scene.elements.find((e: any) => e.customData?.officeStickerPart?.layer === 'plane' && e.backgroundColor === '#F2BE9B')
  const change = await request('/canvas/patch', batch(scene.revision, [{ op:'element.update', id:fold.id, before:{backgroundColor:fold.backgroundColor}, changes:{backgroundColor:'#83ACA4'} }]))
  expect(change.ok).toBe(true)
  await expect(sticker.locator('[fill="#83ACA4"]')).toHaveCount(1)
  const updated = await saveStickerSvg(page, 'paperPlane', info)
  expect(updated).toContain('#83ACA4'); expect(original).not.toContain('#83ACA4')
  // Keep the catalog-color acceptance asset alongside the independently verified edit.
  writeFileSync(info.outputPath('paperPlane-original.svg'), original)
  preserved(before, await read())
})

test('material library progressively reveals metadata and places animated stickers, avatars and brushes', async ({ page }, info) => {
  await open(page)
  const before = await read()
  const overview = await (await request('/canvas/materials')).json()
  expect(overview.categories.map((c:any)=>[c.id,c.count])).toEqual([['brush',6],['sticker',59],['avatar',3],['reaction',17],['emoji',3781]])
  const library=page.getByRole('region',{name:'白板素材库'})
  const showLibrary = async () => { await page.getByTitle('素材库',{exact:true}).click(); await expect(library).toBeVisible() }
  await showLibrary()
  await expect(library.getByRole('button',{name:'折纸蝶'})).toBeVisible()
  await page.screenshot({path:info.outputPath('material-library.png')})
  await library.getByLabel('搜索素材').fill('会闪')
  await library.getByRole('button',{name:'萤火微光'}).click()
  await expect(library.getByText('firefly',{exact:true})).toBeHidden()
  await library.getByText('素材参数').click()
  await expect(library.getByText('firefly',{exact:true})).toBeVisible()
  await library.getByRole('button',{name:'贴到白板'}).click()
  await expect(library).toBeHidden()
  let after = await read()
  preserved(before,after)
  expect(after.scene.elements.find((e:any)=>e.customData?.officeMaterial?.id==='firefly').customData.officeMaterial).toMatchObject({category:'sticker',catalogVersion:3})
  await expect(page.locator('.canvas-sticker[data-motif=firefly]')).toBeVisible()
  expect(await saveStickerSvg(page,'firefly',info)).toContain('glint')
  for (const [name,motif] of [['月牙团子','moonPal'],['星点伙伴','starPal']]) {
    await showLibrary()
    await library.getByRole('button',{name:'头像',exact:true}).click()
    await library.getByRole('button',{name,exact:true}).click()
    await library.getByRole('button',{name:'用作协作头像'}).click()
    await expect(page.locator('.canvas-self-avatar[data-avatar="'+motif+'"]')).toBeVisible()
    await library.getByRole('button',{name:'贴到白板'}).click()
    await expect(library).toBeHidden()
    expect(await saveStickerSvg(page,motif,info)).toContain('eyes')
  }
  await page.reload()
  await expect(page.locator('.canvas-self-avatar[data-avatar=starPal]')).toBeVisible()
  await showLibrary()
  await library.getByRole('button',{name:'画笔',exact:true}).click()
  await library.getByRole('button',{name:'粉蜡笔',exact:true}).click()
  await library.getByRole('button',{name:'用这支笔绘制'}).click()
  await expect(library).toBeHidden()
  const surface=(await page.locator('.canvas-surface').boundingBox())!
  await page.mouse.move(surface.x+surface.width*.55,surface.y+surface.height*.6)
  await page.mouse.down();await page.mouse.move(surface.x+surface.width*.62,surface.y+surface.height*.55,{steps:12});await page.mouse.up()
  await page.getByRole('button',{name:'保存画布',exact:true}).click()
  await expect.poll(async()=> (await read()).scene.elements.filter((e:any)=>e.type==='freedraw').length).toBe(1)
  after=await read()
  preserved(before,after)
})

test('two collaborators can give and withdraw independent +1 and thumbs-up on the same element', async ({page,browser},info)=>{
  await open(page)
  await expect(page.getByRole('button',{name:'AI 协作',exact:true}).locator('.oc-companion')).toHaveAttribute('data-companion-state', 'idle')
  const library=page.getByRole('region',{name:'白板素材库'})
  await page.getByTitle('素材库',{exact:true}).click()
  await library.getByRole('button',{name:'头像',exact:true}).click()
  const companion = library.getByRole('button',{name:'AI 搭子',exact:true})
  await expect(companion.locator('[data-sticker-layer="quote-open"], [data-sticker-layer="quote-close"]')).toHaveCount(2)
  await companion.click()
  await library.getByRole('button',{name:'用作协作头像'}).click()
  await library.getByRole('button',{name:'贴到白板'}).click()
  await expect(library).toBeHidden()
  const avatarSvg = await saveStickerSvg(page, 'mascot', info)
  expect(avatarSvg).toContain('data-motion="companion-idle"')
  const before=await read(), anchor=before.scene.elements.find((e:any)=>e.customData?.officeMaterial?.id==='mascot').id
  const toolbar=page.getByRole('group',{name:'回应选中元素'}), badgeSelector='.canvas-reaction-badges[data-element="'+anchor+'"]'
  await toolbar.getByRole('button',{name:'大拇指',exact:true}).click()
  await toolbar.getByRole('button',{name:'+1',exact:true}).click()
  const badge=page.locator(badgeSelector)
  await expect(badge.getByRole('button',{name:'+1 · 1 人'})).toHaveAttribute('aria-pressed','true')
  const context=await browser.newContext({viewport:{width:1440,height:900}})
  try {
    const peer=await context.newPage()
    await open(peer,'write','peer')
    const peerAvatar = peer.locator('[data-peer-avatar=mascot]')
    await expect(peerAvatar).toBeVisible({timeout:12000})
    await expect(peerAvatar.locator('[data-sticker-layer="quote-close"]')).toBeVisible()
    const other=peer.locator(badgeSelector)
    await expect(other.getByRole('button',{name:'+1 · 1 人'})).toHaveAttribute('aria-pressed','false')
    await other.getByRole('button',{name:'+1 · 1 人'}).click()
    await expect(badge.getByRole('button',{name:'+1 · 2 人'})).toBeVisible()
    const vote={elementIds:[anchor],kind:'plusOne',active:true}
    const repeated=await (await request('/canvas/reactions',vote,'write','PUT','peer')).json()
    expect(repeated.elements[anchor].plusOne).toEqual({count:2,mine:true})
    expect((await request('/canvas/reactions',vote,'read','PUT','reader')).status).toBe(403)
    expect((await request('/canvas/reactions',{...vote,elementIds:[anchor,'missing-id']},'write','PUT','third')).status).toBe(409)
    await page.screenshot({path:info.outputPath('element-feedback.png')})
    await page.reload()
    await expect(badge.getByRole('button',{name:'+1 · 2 人'})).toHaveAttribute('aria-pressed','true')
    await badge.getByRole('button',{name:'+1 · 2 人'}).click()
    await expect(other.getByRole('button',{name:'+1 · 1 人'})).toHaveAttribute('aria-pressed','true')
    const book=await (await request('/canvas/reactions')).json()
    expect(book.elements[anchor]).toEqual({plusOne:{count:1,mine:false},thumbsUp:{count:1,mine:true}})
    expect((await read()).revision).toBe(before.revision)
    const restore=await request('/restore/0',{expectedRevision:before.revision});expect(restore.ok).toBe(true)
    expect((await request('/canvas/reactions',vote,'write','PUT','peer')).status).toBe(409)
    expect((await (await request('/canvas/reactions')).json()).elements).toEqual({})
  } finally {await context.close()}
})

test('FigJam-style wheel stamps objects and open paper, and sends transient emotes to another participant', async ({page,browser},info) => {
  test.setTimeout(55000)
  const start=await read()
  const plan=await (await request('/canvas/materials/plan',{expectedRevision:start.revision,patchId:'wheel',materialId:'moonPal'})).json()
  expect((await request('/canvas/patch',plan.batch)).ok).toBe(true)
  await open(page)
  const paper=page.locator('.canvas-surface'), sprite=page.locator('.canvas-sticker[data-motif=moonPal]')
  const surface=(await paper.boundingBox())!, shape=(await sprite.boundingBox())!
  const inside={x:shape.x+shape.width*.47,y:shape.y+shape.height*.49}
  const nativeDock=(await page.getByRole('toolbar',{name:'白板工具栏'}).boundingBox())!
  expect(nativeDock.y).toBeGreaterThan(surface.y+surface.height*.7)
  expect(nativeDock.y+nativeDock.height).toBeLessThanOrEqual(surface.y+surface.height-5)
  expect(Math.abs(nativeDock.x+nativeDock.width/2-surface.x-surface.width/2)).toBeLessThan(18)
  await page.getByRole('button',{name:'插入素材与模板',exact:true}).click()
  const more=page.getByRole('region',{name:'插入素材与模板选项'})
  await expect(more).toBeVisible()
  const flyout=(await more.boundingBox())!
  expect(flyout.y+flyout.height).toBeLessThanOrEqual(nativeDock.y+4)
  await page.getByRole('button',{name:'插入素材与模板',exact:true}).click()
  const wheel=page.getByRole('region',{name:'印章选择器'})
  await page.keyboard.press('e')
  await expect(wheel).toBeVisible()
  expect(await wheel.locator('[data-choice]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-choice')))).toEqual(['thumbsUp','plusOne','favorite','question','thumbsDown','dot','profile','loveIt'])
  await page.screenshot({path:info.outputPath('stamp-wheel.png')})
  await wheel.getByRole('button',{name:'喜欢',exact:true}).click()
  await page.mouse.click(inside.x,inside.y)
  const mine=page.locator('.canvas-reaction-badges[data-element="wheel-sticker"]')
  await expect(mine.getByRole('button',{name:'喜欢 · 1 人'})).toHaveAttribute('aria-pressed','true')
  await page.mouse.click(inside.x,inside.y)
  expect((await (await request('/canvas/reactions')).json()).elements['wheel-sticker'].loveIt.count).toBe(1)
  const rev=(await read()).revision
  const spot={x:surface.x+surface.width*.61,y:surface.y+surface.height*.68}
  const cursor=page.locator('.board-stamp-preview[data-kind=loveIt]')
  await page.mouse.move(spot.x,spot.y)
  await expect(cursor).toBeVisible()
  await expect(paper.locator('canvas.interactive')).toHaveCSS('cursor',/^url\(.*4 30, crosshair/)
  await page.mouse.down()
  await expect(cursor).toHaveAttribute('data-pressed','true')
  expect((await read()).revision).toBe(rev)
  await page.mouse.up()
  await expect(page.locator('.board-stamp-impression[data-kind=loveIt]').last()).toBeAttached()
  await expect.poll(async()=> (await read()).scene.elements.filter((e:any)=>e.customData?.officeStamp?.kind==='loveIt').length).toBe(1)
  await expect(page.locator('.board-stamp-impression')).toHaveCount(0)
  await page.mouse.move(spot.x+30,spot.y);await page.mouse.down()
  await page.mouse.move(spot.x+65,spot.y,{steps:5});await page.mouse.up()
  expect((await read()).revision).toBe(rev+1)
  const saved=await read()
  expect(saved.revision).toBe(rev+1)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button',{name:'退出盖章'})).toHaveCount(0)
  const peerContext=await browser.newContext()
  try {
    const peer=await peerContext.newPage()
    await open(peer,'read','viewer')
    await expect(peer.locator('.canvas-reaction-badges').getByRole('button',{name:'喜欢 · 1 人'})).toBeDisabled()
    await page.getByLabel('盖章与即时表情',{exact:true}).click()
    await wheel.getByRole('button',{name:'更多表情印章'}).click()
    await wheel.getByRole('button',{name:'即时表情',exact:true}).click()
    await wheel.getByRole('textbox',{name:'搜索表情'}).fill('火箭')
    await wheel.getByRole('button',{name:'火箭',exact:true}).click()
    await page.mouse.click(spot.x-85,spot.y)
    const burst=peer.locator('[data-emote=emoji-1f680]')
    await expect(burst).toBeAttached({timeout:4000})
    await expect(burst).toHaveCount(0,{timeout:4500})
    await peer.getByLabel('盖章与即时表情',{exact:true}).click()
    const readWheel=peer.getByRole('region',{name:'印章选择器'})
    await expect(readWheel.getByRole('button',{name:'印章',exact:true})).toHaveCount(0)
    await readWheel.getByRole('button',{name:'大拇指',exact:true}).click()
    const peerOverlay=peer.getByLabel('点按画布发送表情')
    await peerOverlay.click({position:{x:290,y:200}})
    await expect(page.locator('[data-emote=thumbsUp]')).toBeAttached({timeout:4000})
    expect((await read()).revision).toBe(saved.revision)
  } finally { await peerContext.close() }
  await page.reload()
  await expect(mine.getByRole('button',{name:'喜欢 · 1 人'})).toBeVisible()
  expect((await read()).scene.elements.some((e:any)=>e.customData?.officeStamp?.kind==='loveIt')).toBe(true)
  const beforeMove=await read()
  const from=(await mine.boundingBox())!
  const family=beforeMove.scene.elements.filter((e:any)=>e.id==='wheel-sticker'||e.customData?.officeStickerPart?.anchor==='wheel-sticker')
  const moved=await request('/canvas/patch',batch(beforeMove.revision,family.map((e:any)=>({op:'element.update',id:e.id,before:{x:e.x},changes:{x:e.x+50}}))))
  expect(moved.ok).toBe(true)
  await expect.poll(async()=>(await mine.boundingBox())!.x).toBeGreaterThan(from.x+12)
})

test('the compact stamp wheel stays reachable on a phone',async({page})=>{
  await page.setViewportSize({width:390,height:844})
  await open(page)
  const closeAI=page.getByRole('button',{name:'AI 协作',exact:true})
  if (await closeAI.count() && await closeAI.getAttribute('aria-pressed')==='true') await closeAI.click()
  await page.getByLabel('盖章与即时表情',{exact:true}).click()
  const wheel=page.getByRole('region',{name:'印章选择器'})
  const bounds=(await wheel.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x+bounds.width).toBeLessThanOrEqual(390)
  await wheel.getByRole('button',{name:'+1',exact:true}).click()
  await expect(page.getByText('点按元素或空白处盖章')).toBeVisible()
  await page.getByRole('button',{name:'退出盖章'}).click()
  await expect(wheel).toBeHidden()
})

test('Actions searches, replaces and undoes text, then returns focus and restores the dock',async({page})=>{
  const start=await read()
  const prepared=await (await request('/canvas/layout',{expectedRevision:start.revision,patchId:'commands',composition:composition()})).json()
  expect((await request('/canvas/patch',prepared.batch)).ok).toBe(true)
  await open(page)
  const trigger=page.getByRole('button',{name:'操作',exact:true}), palette=page.getByRole('region',{name:'操作选项'})
  await page.locator('.excalidraw').first().focus()
  await page.keyboard.press('Control+k')
  const search=palette.getByLabel('搜索白板操作')
  await expect(search).toBeFocused()
  await search.fill('find')
  await search.press('Enter')
  await palette.getByLabel('查找文字').fill('理解问题')
  await palette.getByLabel('查找文字').press('Enter')
  await palette.getByLabel('替换为').fill('经过验证的文字')
  await palette.getByRole('button',{name:'替换一处'}).click()
  await expect.poll(async()=>(await read()).scene.elements.some((e:any)=>e.originalText?.includes('经过验证的文字'))).toBe(true)
  await palette.getByRole('button',{name:'返回操作'}).click()
  await search.fill('undo')
  await search.press('Enter')
  await expect(palette).toBeHidden()
  await expect.poll(async()=>(await read()).scene.elements.some((e:any)=>e.originalText?.includes('经过验证的文字'))).toBe(false)
  await trigger.click()
  await search.fill('select all')
  await search.press('Enter')
  await expect(page.locator('.canvas-selection-actions')).toBeVisible()
  await trigger.click()
  await palette.getByRole('button',{name:'最小化工具栏'}).click()
  await expect(trigger).toBeHidden()
  await page.getByRole('button',{name:'显示工具栏'}).click()
  await expect(trigger).toBeVisible()
  await trigger.click()
  await search.press('Escape')
  await expect(palette).toBeHidden()
})

test('Unicode catalog and stamps support search, native planning, personal votes and a persistent image',async({page})=>{
  const before=await read(),material='emoji-1f680'
  const list=await (await request('/canvas/materials?category=emoji&q=rocket')).json()
  expect(list.items.some((row:any)=>row.id===material)).toBe(true)
  const later=await (await request('/canvas/materials?category=emoji&page=1')).json()
  expect(later.page).toBe(1)
  expect(later.items.length).toBe(96)
  for (const transport of [
    new StdioClientTransport({command:binary,args:['mcp'],env:{...process.env,HCD_API_URL:apiUrl,HCD_MCP_TOKEN:token('write','material-agent')} as Record<string,string>}),
    new StreamableHTTPClientTransport(new URL(apiUrl+'/v1/documents/'+id+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token('write','material-agent')}}}),
  ]) {
    const client=new Client({name:'material-agent',version:'1'})
    try {
      await client.connect(transport)
      async function call(name:string,args:Record<string,unknown>){
        const result=await client.callTool({name,arguments:{document_id:id,...args}})
        const text=(result.content as {text:string}[])[0].text
        expect(result.isError,text).not.toBe(true)
        return JSON.parse(text)
      }
      const candidates=await call('hcd_read',{resource:'canvas_materials',category:'emoji',query:'火箭'})
      const chosen=candidates.items.find((r:any)=>r.name==='火箭').id
      const detail=await call('hcd_read',{resource:'canvas_materials',material_id:chosen})
      expect(detail.material.usage.emoji).toBe('🚀')
      const planned=await call('hcd_canvas_plan',{expected_revision:before.revision,patch_id:'agent-emoji-plan',material_id:chosen})
      expect(planned.batch.operations[0].element.originalText).toBe('🚀')
      expect(planned.batch.vacantRegions).toHaveLength(1)
    } finally {await client.close()}
  }
  const plan=await (await request('/canvas/materials/plan',{expectedRevision:before.revision,patchId:'unicode-art',materialId:material})).json()
  expect(plan.batch.operations[0].element.originalText).toBe('🚀')
  expect(plan.batch.vacantRegions).toHaveLength(1)
  expect((await request('/canvas/patch',plan.batch)).ok).toBe(true)
  await open(page)
  const wheel=page.getByRole('region',{name:'印章选择器'})
  await page.getByRole('button',{name:'盖章与即时表情'}).click()
  await wheel.getByRole('button',{name:'更多表情印章'}).click()
  await wheel.getByLabel('搜索表情').fill('rocket')
  await wheel.getByRole('button',{name:'火箭',exact:true}).click()
  const surface=(await page.locator('.canvas-surface').boundingBox())!
  await page.mouse.click(surface.x+surface.width*.65,surface.y+surface.height*.58)
  await expect.poll(async()=>(await read()).scene.elements.some((e:any)=>e.customData?.officeStamp?.kind===material)).toBe(true)
  const saved=await read(),el=saved.scene.elements.find((e:any)=>e.customData?.officeStamp?.kind===material)
  expect(saved.scene.files[el.fileId].dataURL).toMatch(/^data:image\/png;base64,/)
  expect((await request('/canvas/reactions',{elementIds:[el.id],kind:material,active:true},'write','PUT')).ok).toBe(true)
  await page.reload()
  await expect(page.getByRole('button',{name:'火箭 · 1 人'})).toBeVisible()
  expect((await read()).revision).toBe(saved.revision)
})

test('existing AI mind maps grow at their edges, keep their layout and navigate from the top right',async({page},info)=>{
  await page.setViewportSize({width:707,height:1033})
  await page.emulateMedia({reducedMotion:'reduce'})
  const mapId='reading-map'
  for(const [patchId, composition] of [[mapId,diagrams.mindmap],['other-work',diagrams.flowchart]] as const){
    const plan=await (await request('/canvas/layout',{expectedRevision:(await read()).revision,patchId,composition})).json()
    expect((await request('/canvas/patch',plan.batch)).ok).toBe(true)
  }
  const before=await read(), original=before.scene.elements.filter((e:any)=>e.customData?.officeDiagram?.id===mapId&&e.customData.officeDiagram.nodeId)
  const root=original.find((e:any)=>e.customData.officeDiagram.kind==='topic')
  await open(page)
  const chooser=page.getByRole('combobox',{name:'生成作品',exact:true}),nav=page.getByRole('navigation',{name:'生成作品导览'})
  const board=page.locator('.canvas-surface'), bounds=(await board.boundingBox())!, library=board.locator('.default-sidebar-trigger:visible')
  const tools=await nav.boundingBox(),lib=await library.boundingBox()
  expect(tools!.y-bounds.y).toBeLessThan(30)
  expect(tools!.x).toBeGreaterThan(bounds.x+bounds.width/2)
  expect(tools!.x+tools!.width).toBeLessThanOrEqual(lib!.x-2)
  await page.evaluate(({root,id})=>{
    const url=new URL(location.href);url.searchParams.set('node-id',root);url.searchParams.set('doc-id',id);history.replaceState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'))
  },{root:root.id,id})
  await expect(chooser).toHaveValue(mapId)
  const actions=page.getByRole('toolbar',{name:'思维导图节点操作'})
  await expect(actions).toHaveAttribute('data-node',root.id)
  await page.screenshot({path:info.outputPath('mind-map-quick-add.png')})
  await actions.getByRole('button',{name:'子节点',exact:true}).click()
  const name=page.getByRole('textbox',{name:'节点名称'})
  await name.fill('用户访谈');await name.press('Enter')
  await name.fill('访谈提纲');await name.press('Tab')
  await name.fill('试读样本');await name.press('Control+Enter')
  await expect(name).toHaveCount(0)
  await page.keyboard.press('Tab')
  await name.fill('第二轮试读');await name.press('Control+Enter')
  const created=async()=>(await read()).scene.elements.filter((e:any)=>!e.isDeleted && e.customData?.officeDiagram?.id===mapId &&
    e.customData.officeDiagram.nodeId && !original.some((n:any)=>n.id===e.id))
  await expect.poll(async()=>(await created()).map((e:any)=>e.customData.officeDiagram.nodeTitle)).toEqual(['用户访谈','访谈提纲','试读样本','第二轮试读'])
  const snapshot=await read(), added=await created(), parents=[root,root,added[1],added[2]]
  const currentOriginal=original.map((n:any)=>snapshot.scene.elements.find((el:any)=>el.id===n.id))
  for(const [i,node] of added.entries()){
    const arrow=snapshot.scene.elements.find((e:any)=>e.endBinding?.elementId===node.id)
    expect(arrow.startBinding.elementId).toBe(parents[i].id)
    expect(arrow.elbowed).toBe(true)
    expect(arrow.y+arrow.points.at(-1)[1]).toBeCloseTo(node.y+node.height/2,0)
    expect(snapshot.scene.elements.some((e:any)=>e.groupIds?.includes(node.groupIds[0]) && e.originalText===node.customData.officeDiagram.nodeTitle)).toBe(true)
    for(const old of [...currentOriginal,...added.slice(0,i)]) expect(node.x+node.width<=old.x || old.x+old.width<=node.x || node.y+node.height<=old.y || old.y+old.height<=node.y).toBe(true)
  }
  const branchSide=Math.sign(added[0].x-root.x)
  for(const old of before.scene.elements.filter((e:any)=>e.customData?.officeDiagram?.id==='other-work' ||
    e.id==='human-card' || e.id===root.id || original.includes(e) && Math.sign(e.x-root.x)!==branchSide)){
    const n=snapshot.scene.elements.find((e:any)=>e.id===old.id)
    expect([n.x,n.y,n.width,n.height]).toEqual([old.x,old.y,old.width,old.height])
  }
  const siblings=snapshot.scene.elements.filter((e:any)=>e.startBinding?.elementId===root.id)
    .map((e:any)=>snapshot.scene.elements.find((n:any)=>n.id===e.endBinding.elementId))
    .filter((n:any)=>Math.sign(n.x-root.x)===branchSide).sort((a:any,b:any)=>a.y-b.y)
  expect(siblings.map((n:any)=>n.id)).toContain(added[0].id)
  expect(siblings.findIndex((n:any)=>n.id===added[1].id)).toBe(siblings.findIndex((n:any)=>n.id===added[0].id)+1)
  for(let i=1;i<siblings.length;i++){
    expect(siblings[i].x).toBe(siblings[i-1].x)
    expect(siblings[i].y-siblings[i-1].y-siblings[i-1].height).toBeGreaterThanOrEqual(24)
  }
  await page.reload();await expect(chooser).toHaveValue(mapId)
  expect((await created()).length).toBe(4)
})

test('mind cards can omit both fields, refill them independently and filter only legacy generated badges', async ({page},info) => {
  await page.setViewportSize({width:900,height:820})
  const patchId='optional-map'
  const composition={ title:'阅读讨论',layout:'mindmap',items:[],diagram:{groups:[],nodes:[
    {id:'root',kind:'topic',group:null,title:'书单'},
    {id:'reader',kind:'concept',group:null,body:'概念讲解'},
    {id:'later',kind:'concept',group:null,title:null,body:null},
  ],edges:[{from:'root',to:'reader',kind:'association',label:''},{from:'root',to:'later',kind:'association',label:''}]}}
  const planned=await request('/canvas/layout',{expectedRevision:(await read()).revision,patchId,composition})
  expect(planned.status,await planned.clone().text()).toBe(200)
  const {batch:plan}=await planned.json()
  const agent = new Client({name:'mind-map-author',version:'1'})
  try {
    await agent.connect(new StreamableHTTPClientTransport(new URL(apiUrl+'/v1/documents/'+id+'/mcp'), {
      requestInit:{headers:{Authorization:'Bearer '+token('write','mind-map-author')}}
    }))
    const result=await agent.callTool({name:'hcd_canvas_plan',arguments:{
      document_id:id,expected_revision:plan.baseRevision,patch_id:patchId,composition
    }})
    const reply=(result.content as {text:string}[])[0].text
    expect(result.isError,reply).not.toBe(true)
    expect(JSON.parse(reply).batch.operations).toEqual(plan.operations)
  } finally { await agent.close() }
  expect((await request('/canvas/patch',plan)).ok).toBe(true)
  const nodeId=patchId+'-node-1', bodyId=patchId+'-text-1', badgeId=patchId+'-badge-1'
  const before=await read(), original=before.scene.elements.find((el:any)=>el.id===bodyId)
  expect(before.scene.elements.some((el:any)=>el.id.includes('-badge-'))).toBe(false)
  const {index:_index,...legacy}=original
  legacy.id=badgeId;legacy.fontSize=11;delete legacy.customData.officeNodeField
  expect((await request('/canvas/patch',batch(before.revision,[{op:'element.add',element:legacy}]))).ok).toBe(true)
  const seeded=await read()
  await open(page)
  await page.evaluate(({id,nodeId})=>{
    const url=new URL(location.href);url.searchParams.set('doc-id',id);url.searchParams.set('node-id',nodeId)
    history.replaceState(null,'',url);dispatchEvent(new PopStateEvent('popstate'))
  },{id,nodeId})
  const controls=page.getByRole('toolbar',{name:'思维导图节点操作'})
  await expect(controls).toHaveAttribute('data-node',nodeId)
  async function editNode(){
    const box=(await controls.boundingBox())!
    await page.mouse.dblclick(box.x+box.width/2,box.y+box.height/2)
    await expect(page.getByRole('group',{name:'编辑思维导图节点'})).toBeVisible()
  }
  const title=page.getByLabel('节点名称',{exact:true}),body=page.getByLabel('节点描述',{exact:true})
  await editNode()
  await expect(title).toHaveValue('');await expect(body).toHaveValue('概念讲解');await expect(body).toBeFocused()
  await page.screenshot({path:info.outputPath('optional-mind-fields.png')})
  await page.keyboard.press('Escape')
  expect((await read()).revision).toBe(seeded.revision)
  await page.locator('summary[aria-label="导出画布"]').click()
  const download=page.waitForEvent('download')
  await page.getByRole('button',{name:'画布文件',exact:true}).click()
  const exported=JSON.parse(readFileSync((await (await download).path())!,'utf8'))
  expect(exported.elements.some((el:any)=>el.id===badgeId)).toBe(false)
  expect(exported.elements.find((el:any)=>el.id===bodyId).originalText).toBe('概念讲解')
  const active=async()=>(await read()).scene.elements.filter((el:any)=>!el.isDeleted)
  await editNode();await body.fill('');await body.press('Control+Enter')
  await expect.poll(async()=>(await active()).some((el:any)=>el.id===bodyId)).toBe(false)
  await page.reload();await expect(controls).toHaveAttribute('data-node',nodeId)
  await editNode();await expect(title).toHaveValue('');await expect(body).toHaveValue('')
  await title.fill('读后讨论');await title.press('Control+Enter')
  await expect.poll(async()=>(await active()).find((el:any)=>el.id===nodeId)?.customData.officeDiagram.nodeTitle).toBe('读后讨论')
  await editNode();await title.fill('');await body.fill('下次讨论选书的理由。');await body.press('Control+Enter')
  await expect.poll(async()=>(await active()).filter((el:any)=>el.type==='text'&&el.groupIds?.[0]===original.groupIds[0]&&el.id!==badgeId).map((el:any)=>el.originalText)).toEqual(['下次讨论选书的理由。'])
  const saved=await active()
  const node=saved.find((el:any)=>el.id===nodeId)
  expect(node.customData.officeDiagram.nodeTitle).toBe('')
  expect(node.boundElements.some((el:any)=>el.type==='arrow')).toBe(true)
})

test('mind handles attract inside a round target, spring home and edit on the printed card',async({page},info)=>{
  await page.setViewportSize({width:1000,height:820})
  const patchId='magnetic-map', rootId=patchId+'-node-0'
  const plan=await (await request('/canvas/layout',{expectedRevision:(await read()).revision,patchId,composition:diagrams.mindmap})).json()
  expect((await request('/canvas/patch',plan.batch)).ok).toBe(true)
  await open(page)
  await page.evaluate(({id,rootId})=>{
    const url=new URL(location.href);url.searchParams.set('doc-id',id);url.searchParams.set('node-id',rootId)
    history.replaceState(null,'',url);dispatchEvent(new PopStateEvent('popstate'))
  },{id,rootId})
  const board=page.locator('.canvas-surface')
  const actions=board.getByRole('toolbar',{name:'思维导图节点操作'})
  await expect(actions).toHaveAttribute('data-node',rootId)
  const handle=actions.getByRole('button',{name:'子节点',exact:true}),face=handle.locator('.mind-handle-motion')
  const rect=(await handle.boundingBox())!, cx=rect.x+rect.width/2, cy=rect.y+rect.height/2
  const hit=(x:number,y:number)=>handle.evaluate((button,p)=>button.contains(document.elementFromPoint(p.x,p.y)),{x,y})
  expect(await hit(cx+16,cy)).toBe(true)
  expect(await hit(cx+18,cy+18)).toBe(false)
  const offset=()=>face.evaluate(el=>new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)
  await page.emulateMedia({reducedMotion:'no-preference'})
  await page.mouse.move(cx+16,cy)
  await expect.poll(offset).toBeGreaterThan(4)
  await page.mouse.move(cx+18,cy+19)
  await expect.poll(offset).toBe(0)
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.mouse.move(cx+16,cy)
  expect(await offset()).toBe(0)
  await page.mouse.click(cx+16,cy)
  const inline=board.getByRole('group',{name:'编辑思维导图节点'}), name=inline.getByLabel('节点名称')
  await expect(name).toBeFocused()
  await expect(board.locator('form.mind-node-editor,[role=dialog]:visible')).toHaveCount(0)
  await name.fill('原位输入')
  const b=(await board.boundingBox())!
  await page.mouse.click(b.x+b.width*.55,b.y+78)
  await expect(inline).toHaveCount(0)
  const stored=async()=>(await read()).scene.elements
  await expect.poll(async()=>(await stored()).filter((el:any)=>el.originalText==='原位输入'&&!el.isDeleted).length).toBe(1)
  const saved=await stored(), label=saved.find((el:any)=>el.originalText==='原位输入'),added=saved.find((el:any)=>el.customData?.officeDiagram?.nodeTitle==='原位输入')
  expect(label.opacity).toBe(100)
  const edge=saved.find((el:any)=>el.endBinding?.elementId===added.id)
  expect(edge.startBinding.elementId).toBe(rootId)
  await page.getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
  await page.evaluate((target)=>{
    const url=new URL(location.href);url.searchParams.set('node-id',target)
    history.replaceState(null,'',url);dispatchEvent(new PopStateEvent('popstate'))
  },added.id)
  await expect(actions).toHaveAttribute('data-node',added.id)
  const card=(await actions.boundingBox())!
  const px=card.x+(label.x-added.x+8)*card.width/added.width, py=card.y+(label.y-added.y+label.height/2)*card.height/added.height
  await page.mouse.dblclick(px,py)
  const local=(await inline.boundingBox())!, text=(await name.boundingBox())!
  for(const k of ['x','y','width','height'] as const)expect(Math.abs(local[k]-card[k])).toBeLessThan(1)
  expect(Math.abs(text.y-(card.y+(label.y-added.y)*card.height/added.height))).toBeLessThan(1)
  await expect(name).toHaveValue('原位输入')
  await page.screenshot({path:info.outputPath('mind-inline-dark.png')})
  await name.fill('取消本次输入');await name.press('Escape')
  await page.reload()
  await expect(actions).toHaveAttribute('data-node',added.id)
  expect((await stored()).find((el:any)=>el.id===label.id).originalText).toBe('原位输入')
})

test('board context menus fit the board and expose native actions in light and dark',async({page},info)=>{
  await page.setViewportSize({width:707,height:1033});await open(page)
  const board=page.locator('.canvas-surface'), box=(await board.boundingBox())!,menu=board.locator('ul.context-menu')
  for(const theme of ['light','dark']){
    await page.getByRole('combobox',{name:'界面主题',exact:true}).selectOption(theme)
    await page.mouse.click(box.x+box.width-75,box.y+box.height-95,{button:'right'})
    await expect(menu).toBeVisible();await expect(menu).toHaveCSS('border-radius','13px')
    const m=(await menu.boundingBox())!
    expect(m.x).toBeGreaterThanOrEqual(box.x);expect(m.y).toBeGreaterThanOrEqual(box.y)
    expect(m.x+m.width).toBeLessThanOrEqual(box.x+box.width+1);expect(m.y+m.height).toBeLessThanOrEqual(box.y+box.height+1)
    expect(await menu.getByRole('button').count()).toBeGreaterThan(2)
    await menu.getByRole('button').first().focus()
    await page.screenshot({path:info.outputPath('board-context-'+theme+'.png')})
    await page.keyboard.press('Escape');await expect(menu).toHaveCount(0)
  }
})

test('a held stamp grows in four steps, lands once at release, and cancels cleanly',async({page},info)=>{
  await page.setViewportSize({width:707,height:1033});await open(page)
  const surface=page.locator('.canvas-surface'), board=(await surface.boundingBox())!
  const revision=(await read()).revision
  const cursor=page.locator('.board-stamp-preview')
  await page.getByRole('button',{name:'盖章与即时表情'}).click()
  const wheel=page.getByRole('region',{name:'印章选择器'})
  // The current stamp is usable even when the picker was opened only to inspect it.
  const pos={x:board.x+board.width*.64,y:board.y+board.height*.34}
  await page.mouse.move(pos.x,pos.y);await expect(cursor).toBeVisible()
  await page.mouse.down()
  await expect(wheel).toBeHidden()
  await expect(cursor).toHaveAttribute('data-stage','4')
  expect((await read()).revision).toBe(revision)
  await page.screenshot({path:info.outputPath('stamp-press.png')})
  await page.mouse.up();await expect(page.locator('.board-stamp-impression')).toBeAttached()
  const stamps=async()=>(await read()).scene.elements.filter((e:any)=>!e.isDeleted && e.customData?.officeStamp)
  await expect.poll(async()=>(await stamps()).length).toBe(1)
  expect((await stamps())[0].width).toBe(128)
  await expect(page.locator('.board-stamp-impression')).toHaveCount(0)
  // Inspect the native drawing itself after the release overlay has gone away.
  async function boardPixels() {
    return surface.locator('canvas.excalidraw__canvas').first().evaluate((raw,p)=>{
      const canvas=raw as HTMLCanvasElement,box=canvas.getBoundingClientRect(),ctx=canvas.getContext('2d')!
      const sx=canvas.width/box.width,sy=canvas.height/box.height
      const rgba=ctx.getImageData(Math.floor((p.x-box.x-20)*sx),Math.floor((p.y-box.y-20)*sy),Math.ceil(40*sx),Math.ceil(40*sy)).data
      let greens=0
      for(let i=0;i<rgba.length;i+=4) if(rgba[i+1]>rgba[i]+18 && rgba[i+1]>rgba[i+2]+8 && rgba[i+3]>210)greens++
      return greens
    },pos)
  }
  await expect.poll(boardPixels).toBeGreaterThan(20)
  await page.mouse.move(pos.x-80,pos.y);await page.mouse.down();await page.keyboard.press('Escape');await page.mouse.up()
  await expect(cursor).toHaveCount(0)
  expect((await stamps()).length).toBe(1)
  await page.getByRole('button',{name:'盖章与即时表情'}).click()
  await wheel.getByRole('button',{name:'大拇指',exact:true}).click()
  await page.mouse.move(pos.x-165,pos.y-90);await page.mouse.click(pos.x-165,pos.y-90)
  await expect.poll(async()=>(await stamps()).length).toBe(2)
  expect((await stamps())[1].width).toBe(54)
  await page.getByRole('toolbar',{name:'白板工具栏'}).locator('button[data-tool=select]').click()
  await expect(cursor).toHaveCount(0)
})

test('native stamp cursor stays separate from zoomed ink and a cold transparent print never flashes a tile',async({page},info)=>{
  await open(page)
  const board=page.locator('.canvas-surface'), canvas=board.locator('canvas.interactive')
  const tool=board.getByRole('button',{name:'盖章与即时表情'}), wheel=board.getByRole('region',{name:'印章选择器'})
  await tool.click();await wheel.getByRole('button',{name:'大拇指',exact:true}).click()
  const ink=board.locator('.board-stamp-preview'), stage=(await board.boundingBox())!
  const spot={x:Math.round(stage.x+stage.width*.69),y:Math.round(stage.y+stage.height*.54)}
  const zoom=async()=>Number((await board.locator('.reset-zoom-button').textContent())!.replace('%',''))/100
  await page.mouse.move(spot.x,spot.y)
  const native=await canvas.evaluate(el=>getComputedStyle(el).cursor)
  expect(native).toMatch(/^url\(.*4 30, crosshair/)
  for(let i=0;i<2;i++){
    const scale=await zoom();await expect.poll(async()=>Math.abs((await ink.boundingBox())!.width-54*scale)).toBeLessThan(.04)
    if(i===0){await board.locator('.zoom-in-button').click();await page.mouse.move(spot.x,spot.y)}
  }
  expect(await canvas.evaluate(el=>getComputedStyle(el).cursor)).toBe(native)
  const size=54*await zoom()
  // Slow the native file load after the wheel has prepared the selected artwork.
  // Sample the static drawing canvas every frame, independently of the release overlay.
  await page.evaluate(({spot,size})=>{
    const state={frames:0,squares:0,active:true,delayed:0}
    Object.assign(window,{stampFrames:state})
    const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src')!
    Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(this:HTMLImageElement,src:string){
      if(src.startsWith('data:image/png')){state.delayed++;setTimeout(()=>desc.set!.call(this,src),320)}
      else desc.set!.call(this,src)
    }})
    const sample=()=>{
      if(!state.active)return
      const surface=document.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas:not(.interactive)')!
      const rect=surface.getBoundingClientRect(),sx=surface.width/rect.width,sy=surface.height/rect.height
      const ctx=surface.getContext('2d')!
      const pixels=[[-.43,-.43],[.43,-.43],[-.43,.43],[.43,.43]].map(([x,y])=>ctx.getImageData(
        Math.floor((spot.x-rect.x+size*x)*sx),Math.floor((spot.y-rect.y+size*y)*sy),1,1).data)
      if(pixels.every(px=>Math.abs(px[0]-231)<=1 && Math.abs(px[1]-231)<=1 && Math.abs(px[2]-231)<=1 && px[3]>245))state.squares++
      state.frames++;requestAnimationFrame(sample)
    };requestAnimationFrame(sample)
  },{spot,size})
  await page.mouse.down()
  await expect(canvas).not.toHaveCSS('cursor',native)
  await page.mouse.up()
  const effect=board.locator('.board-stamp-impression').last()
  const rays=effect.locator('.stamp-release-lines line')
  await expect(rays).toHaveCount(6)
  await expect(effect.locator('.stamp-release-lines :is(path, polygon, circle, marker)')).toHaveCount(0)
  expect(await effect.evaluate(el=>getComputedStyle(el,'::after').content)).toBe('none')
  await page.screenshot({path:info.outputPath('stamp-release-lines.png'),clip:{x:spot.x-84,y:spot.y-66,width:168,height:132}})
  const marks=async()=>(await read()).scene.elements.filter((e:any)=>!e.isDeleted&&e.customData?.officeStamp)
  await expect.poll(async()=>(await marks()).length).toBe(1)
  const first=(await marks())[0];expect(first.width).toBe(54)
  await expect.poll(()=>page.evaluate(()=>(window as any).stampFrames.frames)).toBeGreaterThan(35)
  const recorded=await page.evaluate(()=>{const record=(window as any).stampFrames;record.active=false;return record})
  expect(recorded.delayed).toBeGreaterThan(0);expect(recorded.squares).toBe(0)
  await page.emulateMedia({reducedMotion:'reduce'})
  await page.mouse.click(spot.x+64,spot.y+100)
  const quietImpression=board.locator('.board-stamp-impression').last()
  await expect(quietImpression).toBeAttached()
  await expect(quietImpression.locator('.stamp-release-lines')).toBeHidden()
  await expect.poll(async()=>(await marks()).length).toBe(2)
  const [a,b]=await marks()
  expect(a.id).not.toBe(b.id);expect(a.groupIds).toEqual([]);expect(b.groupIds).toEqual([])
  expect(a.fileId).toBe(b.fileId)
  expect(a.customData.officeStamp.author).toBe('设计同伴')
  await page.keyboard.press('Escape');await page.mouse.move(spot.x,spot.y)
  await expect(board.getByRole('tooltip').filter({hasText:'设计同伴'})).toBeVisible()
  await page.screenshot({path:info.outputPath('stamp-author.png'),clip:{x:spot.x-70,y:spot.y-90,width:140,height:135}})

  await page.reload()
  await expect(board.locator('canvas.interactive')).toBeVisible()
  expect((await marks()).map((e:any)=>[e.width,e.height,e.opacity])).toEqual([[54,54,100],[54,54,100]])
})
