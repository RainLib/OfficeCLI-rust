import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect } from '../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs'
import { verifySheetPivots } from '../../../examples/hdoc/embed-host/verify-sheet-pivots.mjs'
import { verifySheetConditions } from '../../../examples/hdoc/embed-host/verify-sheet-conditions.mjs'
import { verifyPdfOcr } from '../../../examples/hdoc/embed-host/verify-pdf-ocr.mjs'
import { verifyImageLayers } from '../../../examples/hdoc/embed-host/verify-image-layers.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const root = resolve(process.env.OFFICECLI_NATIVE_ARTIFACTS || mkdtempSync(join(tmpdir(), 'officecli-workbench-native-')))
const assets = resolve(process.env.OFFICECLI_WORKSPACE_DIST || join(repo, 'apps/workspace/dist'))
const fixtures = join(repo, 'examples/hdoc/embed-host/fixtures/native-office')
const binary = join(assets, 'officecli')
const python = process.env.OFFICECLI_NATIVE_PYTHON || 'python3'
mkdirSync(root, { recursive: true })
const sources = JSON.parse(readFileSync(join(fixtures, 'sources.json'))).sha256
for (const [name, expected] of Object.entries(sources)) {
  assert.equal(createHash('sha256').update(readFileSync(join(fixtures, name))).digest('hex'), expected, `Fixture changed: ${name}`)
}
const cases = [
  ['pivots', verifySheetPivots, 'verify_pivots.py', ['pivot-source.xlsx']],
  ['conditions', verifySheetConditions, 'verify_conditions.py', ['native-conditions-source.xlsx']],
  ['ocr', verifyPdfOcr, 'verify_pdf_ocr.py', ['workshop-scan.pdf']],
  ['layers', verifyImageLayers, 'verify_image_layers.py', ['素材原件.png', '橙色卡片.png', '蓝色卡片.png']],
].filter(([name]) => !process.env.OFFICECLI_NATIVE_CASE || process.env.OFFICECLI_NATIVE_CASE === name)
assert(cases.length, 'OFFICECLI_NATIVE_CASE must be pivots, conditions, ocr or layers')

const listener = createServer().listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = listener.address().port
await new Promise(done => listener.close(done))
const site = `http://fold.localhost:${port}`
const service = spawn(process.execPath, [join(repo, 'examples/hdoc/embed-host/demo.mjs')], {
  cwd: repo, env: { ...process.env, OFFICECLI_EMBED_PORT: String(port), OFFICECLI_DEMO_ENGINE_AI: 'false', OFFICECLI_WORKSPACE_DIST: assets },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = '', browser, page, activeCase
const checks = [], completed = [], errors = []
service.stdout.on('data', chunk => { log += chunk })
service.stderr.on('data', chunk => { log += chunk })
const stopped = once(service, 'exit')

async function nativeCheck(script, folder) {
  const child = spawn(python, [join(fixtures, script), folder, binary], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGTERM'), 300_000)
  try {
    const [code, signal] = await once(child, 'exit')
    writeFileSync(join(folder, 'native.log'), stdout + stderr)
    assert.equal(code, 0, `${script}: ${signal || ''}\n${stdout}\n${stderr}`)
  } finally { clearTimeout(timer) }
}

try {
  await expect.poll(() => log.includes('业务系统 '), { timeout: 60000 }).toBe(true)
  browser = await chromium.launch({ ...(process.env.HCD_BROWSER_PATH && { executablePath: process.env.HCD_BROWSER_PATH }), args: ['--no-proxy-server'] })
  for (const [name, verify, native, originals] of cases) {
    activeCase = name
    const folder = join(root, name), caseChecks = []
    mkdirSync(folder, { recursive: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
      permissions: ['clipboard-read', 'clipboard-write'], serviceWorkers: 'block', locale: 'zh-CN', reducedMotion: 'reduce' })
    page = await context.newPage()
    page.on('pageerror', error => errors.push({ name, message: error.message }))
    try {
      await page.goto(site + '/workbench/?ai=0')
      await verify(page, folder, caseChecks)
      await nativeCheck(native, folder)
      // Native validators must use the same immutable source files as the UI.
      for (const file of originals) {
        const path = join(folder, file)
        assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sources[file], `Source changed: ${file}`)
      }
      completed.push({ name, checks: caseChecks, native: JSON.parse(readFileSync(join(folder, 'native-verification.json'))) })
      checks.push(...caseChecks)
      writeFileSync(join(root, 'validation.json'), JSON.stringify({ status: 'running', completed, errors }, null, 2))
      console.log(`Passed browser and native checks: ${name}`)
    } catch (error) {
      await page.screenshot({ path: join(folder, 'failure.png'), timeout: 6000 }).catch(() => {})
      throw error
    } finally { await context.close() }
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(root, 'validation.json'), JSON.stringify({ status: 'passed', completed, checks, errors, sourceSha256: sources }, null, 2))
  console.log(JSON.stringify({ status: 'passed', root, checks }, null, 2))
} catch (error) {
  writeFileSync(join(root, 'failure.json'), JSON.stringify({ activeCase, completed, errors, message: error.message }, null, 2))
  console.error(JSON.stringify({ root, activeCase }), log.slice(-1800))
  throw error
} finally {
  await browser?.close()
  service.kill('SIGTERM')
  await stopped
}
