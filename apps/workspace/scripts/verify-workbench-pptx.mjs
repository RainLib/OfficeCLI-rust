import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect } from '../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs'
import { verifyPptxInheritance } from '../../../examples/hdoc/embed-host/verify-pptx-inheritance.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const root = mkdtempSync(join(tmpdir(), 'officecli-workbench-pptx-'))
const listener = createServer().listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = listener.address().port
await new Promise(done => listener.close(done))
const site = `http://fold.localhost:${port}`
const service = spawn(process.execPath, [join(repo, 'examples/hdoc/embed-host/demo.mjs')], {
  cwd: repo, env: { ...process.env, OFFICECLI_EMBED_PORT: String(port), OFFICECLI_DEMO_ENGINE_AI: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
service.stdout.on('data', chunk => { log += chunk })
service.stderr.on('data', chunk => { log += chunk })
const stopped = once(service, 'exit')
let browser, page
try {
  await expect.poll(() => log.includes('业务系统 '), { timeout: 60000 }).toBe(true)
  browser = await chromium.launch({ ...(process.env.HCD_BROWSER_PATH && { executablePath: process.env.HCD_BROWSER_PATH }), args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'no-preference', locale: 'zh-CN' })
  page = await context.newPage()
  const errors = [], checks = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(site + '/workbench/?ai=0')
  await verifyPptxInheritance(page, root, checks, { baseline: process.env.OFFICECLI_PPTX_BASELINE === '1' })
  assert.deepEqual(errors, [])
  writeFileSync(join(root, 'validation.json'), JSON.stringify({ checks }, null, 2))
  console.log(JSON.stringify({ status: 'passed', root, checks }, null, 2))
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  console.error(JSON.stringify({ root }), log.slice(-1800))
  throw error
} finally {
  await browser?.close()
  service.kill('SIGTERM')
  await stopped
}
