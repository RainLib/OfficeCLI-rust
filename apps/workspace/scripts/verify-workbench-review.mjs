import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect } from '../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs'
import { verifyWordReview, verifyWordTracked } from '../../../examples/hdoc/embed-host/verify-word-review.mjs'
import { verifyWordMargin } from '../../../examples/hdoc/embed-host/verify-word-margin.mjs'
import { verifyWordTableCells } from '../../../examples/hdoc/embed-host/verify-word-table-cells.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const root = mkdtempSync(join(tmpdir(), 'officecli-workbench-review-'))
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
  browser = await chromium.launch({ ...(process.env.HCD_BROWSER_PATH && { executablePath: process.env.HCD_BROWSER_PATH }),
    args: ['--no-proxy-server'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
  const backgroundFocus = []
  await context.exposeBinding('hcdUnexpectedWorkbookFocus', (_source, entry) => backgroundFocus.push(entry))
  await context.addInitScript(() => {
    document.addEventListener('focusin', event => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.dataset.uComp !== 'editor') return
      const active = document.querySelector('.desk-editor.is-visible')
      const owner = target.closest('.desk-editor')
      if (!active?.querySelector('.hcd-univer-host') || owner && owner !== active) {
        void window.hcdUnexpectedWorkbookFocus({ active: active?.getAttribute('data-file-id'), owner: owner?.getAttribute('data-file-id'), editor: target.id })
      }
    }, true)
  })
  page = await context.newPage()
  if (process.env.OFFICECLI_REVIEW_FOCUS_TRACE === '1') await page.addInitScript(() => {
    window.__reviewFocusTrace = []
    const record = data => {
      window.__reviewFocusTrace.push({ time: performance.now(), ...data })
      if (window.__reviewFocusTrace.length > 400) window.__reviewFocusTrace.shift()
    }
    const focus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (...args) {
      record({ type: 'focus-call', element: this.outerHTML.slice(0, 220), pane: this.closest('.desk-editor')?.dataset.fileId,
        stack: new Error().stack?.slice(0, 900) })
      return focus.apply(this, args)
    }
    for (const type of ['focusin', 'focusout', 'selectionchange', 'click']) document.addEventListener(type, event => {
      record({ type, target: event.target?.outerHTML?.slice(0, 180), text: getSelection()?.toString(),
        anchor: getSelection()?.anchorNode?.parentElement?.outerHTML.slice(0, 180),
        active: document.activeElement?.outerHTML.slice(0, 180) })
    }, true)
  })
  const errors = [], checks = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(site + '/workbench/?ai=0')
  if (process.env.OFFICECLI_REVIEW_WARM_TABS === '1') {
    for (let index = 0; index < 10; index++) {
      const fixture = index === 8 ? 'examples/excel/charts.xlsx' : index === 9 ? 'examples/word/numbering-showcase.docx'
        : 'examples/hdoc/embed-host/fixtures/notes-chart.pptx'
      const name = `review-restoration-${index + 1}.${fixture.split('.').at(-1)}`
      const filename = join(root, name)
      copyFileSync(join(repo, fixture), filename)
      await page.getByRole('tab', { name: '首页', exact: true }).click()
      await page.locator('.desk-home-main input[type="file"]').setInputFiles(filename)
      await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.locator('.desk-editor.is-visible .workspace')).toBeVisible()
    }
  }
  if (process.env.OFFICECLI_REVIEW_CASE !== 'table-cells') {
    await verifyWordReview(page, root, checks)
    await verifyWordMargin(page, root, checks)
    await verifyWordTracked(page, root, checks)
  }
  await verifyWordTableCells(page, root, checks)
  if (process.env.OFFICECLI_REVIEW_WARM_TABS === '1') checks.push('After ten mixed tabs are restored, a background workbook does not steal the Word comment selection, focus or subsequent review edits.')
  assert.deepEqual(errors, [])
  assert.deepEqual(backgroundFocus, [], 'restored background workbooks never receive native keyboard focus')
  writeFileSync(join(root, 'focus-validation.json'), JSON.stringify({ unexpectedWorkbookFocus: backgroundFocus, warmTabs: process.env.OFFICECLI_REVIEW_WARM_TABS === '1' }, null, 2))
  writeFileSync(join(root, 'validation.json'), JSON.stringify({ checks }, null, 2))
  console.log(JSON.stringify({ status: 'passed', root, checks }, null, 2))
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {})
  const state = await page?.evaluate(() => ({ selection: window.getSelection()?.toString(),
    focus: document.activeElement?.outerHTML.slice(0, 300),
    highlights: [...document.querySelectorAll('.desk-editor.is-visible [data-word-comment-id]')].map(element => ({
      id: element.getAttribute('data-word-comment-id'), text: element.textContent,
    })),
    editorSelection: [...document.querySelectorAll('.desk-editor.is-visible .tiptap')].map(element => {
      const range = element.pmViewDesc?.view?.state.selection
      return range ? { from: range.from, to: range.to } : null
    }),
  })).catch(() => null)
  console.error(JSON.stringify({ root, state }), log.slice(-1800))
  if (process.env.OFFICECLI_REVIEW_FOCUS_TRACE === '1') writeFileSync(join(root, 'focus-trace.json'),
    JSON.stringify(await page?.evaluate(() => window.__reviewFocusTrace).catch(() => null), null, 2))
  throw error
} finally {
  await browser?.close()
  service.kill('SIGTERM')
  await stopped
}
