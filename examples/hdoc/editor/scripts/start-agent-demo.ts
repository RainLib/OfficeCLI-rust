/** Isolated, public-fixture workspace. No private documents are imported. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createWriteStream, copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const editorRoot = resolve(import.meta.dirname, '..'), repo = resolve(editorRoot, '../../..')
const binary = process.env.OFFICECLI_BIN || resolve(repo, 'target/debug/officecli')
const root = mkdtempSync(resolve(tmpdir(), 'officecli-agent-demo-')), service = resolve(root, 'service')
mkdirSync(resolve(service, 'sources'), { recursive: true })
for (const [id, file] of Object.entries({
  'accept-image': 'docs/design/officecli-image-workspace/assets/ceramic-portrait.jpg',
  'accept-docx': 'assets/showcase/project-proposal.docx', 'accept-xlsx': 'assets/showcase/gradebook.xlsx',
  'accept-pronunciation': 'examples/ppt/textboxes/textboxes-basic.pptx',
  'accept-pptx': 'examples/ppt/textboxes/textboxes-basic.pptx', 'accept-md': 'md',
  'accept-txt': 'txt', 'accept-html': 'html', 'demo-pdf-raster-quality': 'examples/test.pdf',
  'accept-agent-table': 'examples/hdoc/editor/e2e/fixtures/word-table-edit.docx',
  'accept-sushi': 'docs/acceptance/hcd-openai-agent-harness/sushi-rebuilt.pptx',
})) {
  const extension = file.split('.').at(-1)!, source = resolve(service, 'sources', `${id}.${extension}`)
  if (file === 'md') writeFileSync(source, '# Agent 协同工作区\n\n这是一份公开演示文档。\n\n## 交付计划\n\n第一阶段完成文档阅读与整理，第二阶段核对修改和导出。\n\n请在空白段落输入 /，或选中文字后右键使用 Agent。\n')
  else if (file === 'txt') writeFileSync(source, 'OfficeCLI 人与 Agent 协同演示\n\n你可以与多个独立 Agent 同时处理文档。\n\n所有修改都能在修订历史中核对。\n')
  else if (file === 'html') writeFileSync(source, '<!doctype html><html><body><h1>协同编辑 HTML</h1><p>让 Agent 整理文字，同时保留其他人的修改。</p></body></html>')
  else copyFileSync(resolve(repo, file), source)
  const result = spawnSync(binary, ['hdoc', 'import', source, '--output', resolve(service, `${id}.hcd`), '--document-id', id], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Import failed: ${id}: ${result.stderr}`)
}
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve())); return port
}
const apiPort = await freePort(), uiPort = await freePort(), collabPort = await freePort()
const apiUrl = `http://127.0.0.1:${apiPort}`, uiUrl = `http://127.0.0.1:${uiPort}`
const env: NodeJS.ProcessEnv = { ...process.env, HCD_TOKEN_SECRET: randomBytes(32).toString('hex'), HCD_API_URL: apiUrl,
  HCD_API_TARGET: apiUrl, HCD_COLLAB_PORT: String(collabPort), VITE_HCD_COLLAB_URL: `ws://127.0.0.1:${collabPort}`,
  HCD_DEMO_ROOT: service, HCD_VITE_CACHE_DIR: resolve(root, 'vite-cache') }
for (const key of ['HCD_DATABASE_URL', 'HCD_S3_BUCKET', 'HCD_DEFAULT_THEME']) delete env[key]
const log = createWriteStream(resolve(root, 'services.log')), children: ChildProcess[] = []
function start(command: string, args: string[]) {
  const child = spawn(command, args, { cwd: editorRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false }); children.push(child)
  child.on('error', error => { console.error(error.message); shutdown() })
}
function shutdown() { for (const child of children) child.kill('SIGTERM'); log.end(); process.exit() }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
start(binary, ['hdoc', 'serve', '--root', service, '--bind', `127.0.0.1:${apiPort}`])
start(resolve(editorRoot, 'node_modules/.bin/tsx'), ['sidecar.ts'])
start(resolve(editorRoot, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'])
const descriptor = { uiUrl, apiUrl, collaborationUrl: env.VITE_HCD_COLLAB_URL, root, pid: process.pid }
writeFileSync(resolve(tmpdir(), 'officecli-agent-demo.json'), JSON.stringify(descriptor, null, 2))
console.log(JSON.stringify(descriptor, null, 2))
console.log('Open the UI and choose a public sample. Stop with Ctrl+C. OpenAI credentials stay in the API process.')
