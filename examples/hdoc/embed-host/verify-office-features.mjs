import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect } from '../editor/node_modules/@playwright/test/index.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const output = resolve(process.env.OFFICECLI_FEATURE_ARTIFACTS || mkdtempSync(join(tmpdir(), 'office-features-proof-')))
mkdirSync(output, { recursive: true })
const socket = createServer().listen(0, '127.0.0.1'); await once(socket, 'listening')
const port = socket.address().port; await new Promise(done => socket.close(done))
const site = `http://fold.localhost:${port}`
const service = spawn(process.execPath, [join(import.meta.dirname, 'demo.mjs')], { env: { ...process.env, OFFICECLI_EMBED_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', browser, page
service.stdout.on('data', c => { log += c }); service.stderr.on('data', c => { log += c })
const stopped = once(service, 'exit'), checks = [], errors = [], responses = []
const native = join(process.env.OFFICECLI_WORKSPACE_DIST || join(repo, 'apps/workspace/dist'), 'officecli')
function xml(file, part) { return execFileSync('python3', ['-c', 'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', file, part], { encoding: 'utf8' }) }
function fixture(relative, name) { const path = join(output, name); copyFileSync(join(repo, relative), path); return path }
try {
  await expect.poll(() => log.includes('业务系统 '), { timeout: 60000 }).toBe(true)
  browser = await chromium.launch({ ...(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {}), args: ['--no-proxy-server'] })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page.on('pageerror', e => errors.push(e.message))
  page.on('response', r => { if (r.url().includes('/office-features')) responses.push({ method: r.request().method(), status: r.status() }) })
  const pane = page.locator('.desk-editor.is-visible'), ribbon = () => pane.locator('.office-ribbon')
  const button = name => pane.getByRole('button', { name, exact: true })
  async function upload(file, name) {
    await page.getByRole('tab', { name: '首页', exact: true }).click()
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(file)
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(ribbon()).toBeVisible({ timeout: 45000 })
  }
  async function command(name) {
    const target = ribbon().getByRole('button', { name, exact: true })
    if (!await target.isVisible() && await button('展开功能区').isVisible()) await button('展开功能区').click()
    await target.click()
  }
  async function confirmationContrast(dialog) {
    const ratio = await dialog.getByRole('button', {name:'应用设置',exact:true}).evaluate(element => {
      const style=getComputedStyle(element), canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
      const luminance=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const rgb=ctx.getImageData(0,0,1,1).data;const s=[...rgb].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return .2126*s[0]+.7152*s[1]+.0722*s[2]};
      const a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)
    }); assert(ratio>=4.5,`Confirmation contrast ${ratio} must be >=4.5`)
  }
  async function settings(name, title) { await command(name); const dialog = page.getByRole('dialog', { name: title, exact: true }); await expect(dialog).toBeVisible({ timeout: 20000 }); return dialog }
  async function save(dialog, label = '应用设置') { await dialog.getByRole('button', { name: label, exact: true }).click(); await expect(dialog).toBeHidden({ timeout: 30000 }) }
  async function read(name, route = '/office-features', request) {
    return page.evaluate(async ({ name, route, request }) => {
      const { files } = await (await fetch('/workspace/api/files')).json(), file = files.find(f => f.name === name)
      const { csrf } = await (await fetch('/workspace/api/session')).json()
      const launch = await (await fetch('/workspace/api/files/' + file.id + '/editor-session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-CSRF': csrf }, body: JSON.stringify({ sessionId: crypto.randomUUID() }) })).json()
      const headers = { Authorization: 'Bearer ' + launch.token, ...(request?.body && { 'Content-Type': 'application/json', 'X-HCD-Collaboration-Epoch': String(launch.collaborationEpoch ?? 0) }) }
      const result = await fetch('/v1/documents/' + file.resourceDocumentId + route, { method: request?.method || 'GET', headers, body: request?.body ? JSON.stringify(request.body) : undefined })
      if (request?.status) { if (result.status !== request.status) throw Error(`Expected ${request.status}, got ${result.status}: ${await result.text()}`); return { status: result.status } }
      if (!result.ok) throw Error(`${result.status}: ${await result.text()}`)
      return result.json()
    }, { name, route, request })
  }
  async function download(format, filename, mode = 'source') {
    const menu = pane.locator('summary[aria-label="文件操作"]'); if (!await menu.evaluate(n => n.parentElement.open)) await menu.click()
    const exports = pane.locator('.export-control'); if (!await exports.evaluate(n => n.open)) await exports.locator('summary').click()
    await exports.getByRole('combobox', { name: '导出格式', exact: true }).selectOption(format)
    await exports.getByRole('combobox', { name: '导出方式', exact: true }).selectOption(mode)
    await exports.getByRole('button', { name: '准备下载', exact: true }).click()
    const link = exports.getByRole('link', { name: new RegExp(`下载 .*\\.${format}$`) }); await expect(link).toBeVisible({ timeout: 45000 })
    const downloaded = page.waitForEvent('download'); await link.click(); const path = join(output, filename); await (await downloaded).saveAs(path)
    await menu.click(); return path
  }
  await page.goto(site + '/workbench/'); await expect(page.getByRole('heading', { name: '工作空间', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '收起全局 AI', exact: true }).click()
  const wordName = 'office-features-word.docx', wordSource = fixture('examples/word/numbering-showcase.docx', wordName)
  execFileSync('python3', ['-c', `import sys,zipfile,xml.etree.ElementTree as E
path=sys.argv[1]; z=zipfile.ZipFile(path); entries={n:z.read(n) for n in z.namelist()}; z.close()
w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'; r=E.fromstring(entries['word/document.xml']); p=r.find('.//{'+w+'}body/{'+w+'}p'); pr=p.find('{'+w+'}pPr')
if pr is None: pr=E.Element('{'+w+'}pPr'); p.insert(0,pr)
E.SubElement(pr,'{'+w+'}outlineLvl',{'{'+w+'}val':'0'}); entries['word/document.xml']=E.tostring(r,encoding='utf-8',xml_declaration=True)
with zipfile.ZipFile(path,'w',zipfile.ZIP_DEFLATED) as z:
 for n,b in entries.items(): z.writestr(n,b)
`, wordSource])
  await upload(wordSource, wordName)
  const initialParagraph = pane.locator('.tiptap [data-hcd-block-id]').filter({ hasText: 'Numbering & List Showcase' }).first()
  await expect(initialParagraph).toBeVisible({ timeout: 45000 })
  const blockId = await initialParagraph.getAttribute('data-hcd-block-id')
  const paragraph = pane.locator('.tiptap [data-hcd-block-id=\"' + blockId + '\"]')
  async function caretAtEnd() { await paragraph.evaluate(element => { element.closest('.tiptap').focus(); const range = document.createRange(); range.selectNodeContents(element); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')) }); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight') }
  await button('布局').click()
  let dialog = await settings('页边距', '页边距与纸张')
  await dialog.getByRole('combobox', { name: 'Word 纸张大小', exact: true }).selectOption('a4')
  await dialog.getByRole('spinbutton', { name: '上边距', exact: true }).fill('1.27')
  await dialog.getByRole('spinbutton', { name: '左边距', exact: true }).fill('1.91')
  await page.screenshot({ path: join(output, 'word-page-layout.png') }); await save(dialog)
  await expect(pane.locator('.document[data-office-page="true"]')).toHaveCSS('padding-top', '48px')
  await button('引用').click(); dialog = await settings('目录', '目录')
  await dialog.getByRole('textbox', { name: '目录标题', exact: true }).fill('项目导航')
  await save(dialog, '插入目录')
  await expect(pane.getByRole('navigation', { name: '文档目录', exact: true })).toContainText('Numbering & List Showcase')
  await caretAtEnd()
  dialog = await settings('插入脚注', '脚注')
  await dialog.getByRole('textbox', { name: '脚注内容', exact: true }).fill('核对说明 🧭\n来自原始访谈。')
  await save(dialog, '插入脚注'); await expect(pane.locator('.word-footnote-reference')).toHaveText('1')
  await caretAtEnd(); await page.keyboard.type(' · 已核对')
  await command('保存点')
  await expect.poll(async () => (await read(wordName)).word.headings[0].text).toContain('已核对')
  await page.screenshot({ path: join(output, 'word-inline-toc-footnote.png') })
  const state = await read(wordName)
  assert.equal(state.word.footnotes.length, 1); assert.equal(state.word.footnotes[0].anchorChanged, false)
  assert.equal(state.word.sections[0].layout.topTwips, 720)
  const exportedWord = await download('docx', 'office-word-reopened.docx')
  assert(xml(exportedWord, 'word/document.xml').includes('TOC ')); assert(xml(exportedWord, 'word/footnotes.xml').includes('核对说明'))
  await upload(exportedWord, 'office-word-reopened.docx')
  const reopenedWord = await read('office-word-reopened.docx')
  assert.equal(reopenedWord.word.toc.title, '项目导航'); assert.equal(reopenedWord.word.sections[0].layout.topTwips, 720)
  assert.equal(reopenedWord.word.footnotes[0].text, '核对说明 🧭\n来自原始访谈。')
  await expect(pane.locator('.word-footnotes')).toContainText('来自原始访谈。')
  checks.push('Word: edited page margins and paper, inserted linked TOC and Unicode multiline footnote, then edited body text; source DOCX export and reimport retain margins, current headings and anchored footnote.')
  console.log('Verified Word page layout, TOC, footnote and body edit/export/reopen')

  const sheetName = 'office-features-sheet.xlsx'
  await upload(fixture('assets/showcase/gradebook.xlsx', sheetName), sheetName)
  await expect(pane.locator('.hcd-univer-host')).toBeVisible({ timeout: 45000 })
  await button('页面布局').click(); dialog = await settings('打印布局', '打印布局')
  await dialog.getByRole('combobox', { name: '打印方向', exact: true }).selectOption('true')
  await dialog.getByRole('combobox', { name: '打印纸张', exact: true }).selectOption('8')
  await dialog.getByRole('textbox', { name: '打印区域', exact: true }).fill('A1:H20')
  await dialog.getByRole('textbox', { name: '顶端重复行', exact: true }).fill('1:2')
  await dialog.getByRole('textbox', { name: '左端重复列', exact: true }).fill('A:B')
  await dialog.getByRole('checkbox', { name: '打印网格线', exact: true }).check()
  await page.screenshot({ path: join(output, 'excel-print-layout.png') }); await save(dialog)
  const sheet = await read(sheetName)
  assert.equal(sheet.sheets[0].layout.landscape, true); assert.equal(sheet.sheets[0].layout.printArea, 'A1:H20')
  const exportedSheet = await download('xlsx', 'office-sheet-reopened.xlsx')
  assert(xml(exportedSheet, 'xl/workbook.xml').includes('_xlnm.Print_Area'))
  await upload(exportedSheet, 'office-sheet-reopened.xlsx')
  const reopenedSheet = await read('office-sheet-reopened.xlsx')
  assert.deepEqual(reopenedSheet.sheets[0].layout, sheet.sheets[0].layout)
  await button('页面布局').click(); dialog = await settings('打印布局', '打印布局')
  await expect(dialog.getByRole('textbox', { name: '顶端重复行', exact: true })).toHaveValue('1:2')
  await expect(dialog.getByRole('textbox', { name: '打印区域', exact: true })).toHaveValue('A1:H20')
  await dialog.getByRole('button', { name: '关闭页面设置', exact: true }).click()
  checks.push('Excel: edited landscape A3, fit-to-page print area, repeated title rows/columns and printed gridlines; real XLSX export/reimport preserves every setting and the dialog restores them.')
  console.log('Verified Excel print layout export/reopen')

  const deckName = 'office-features-slides.pptx'
  await upload(fixture('examples/ppt/textboxes/textboxes-basic.pptx', deckName), deckName)
  await expect(pane.locator('.fixed-page iframe').first()).toBeVisible({ timeout: 45000 })
  await button('切换').click(); dialog = await settings('转场效果', '幻灯片转场')
  await dialog.getByRole('button', { name: '推进', exact: true }).click()
  await dialog.getByRole('combobox', { name: '转场方向', exact: true }).selectOption('up')
  await dialog.getByRole('spinbutton', { name: '转场持续时间（秒）', exact: true }).fill('0.85')
  await dialog.getByRole('checkbox', { name: '自动换片', exact: true }).check()
  await dialog.getByRole('spinbutton', { name: '自动换片间隔（秒）', exact: true }).fill('2')
  await dialog.getByRole('checkbox', { name: '应用到全部幻灯片', exact: true }).check()
  await confirmationContrast(dialog); await page.screenshot({ path: join(output, 'ppt-transition-layout.png') }); await save(dialog)
  const deck = await read(deckName); assert(deck.slides.every(s => s.transition.kind === 'push' && s.transition.durationMs === 850 && s.transition.advanceAfterMs === 2000))
  const exportedDeck = await download('pptx', 'office-slides-reopened.pptx')
  assert(xml(exportedDeck, 'ppt/slides/slide1.xml').includes('advTm="2000"'))
  await upload(exportedDeck, 'office-slides-reopened.pptx')
  const reopenedDeck = await read('office-slides-reopened.pptx')
  assert.deepEqual(reopenedDeck.slides.map(s => s.transition), deck.slides.map(s => s.transition))
  await button('放映').click(); await command('从当前页放映')
  await expect(page.locator('.slide-show')).toBeVisible()
  await expect(page.locator('[data-slide-transition="push"]')).toBeVisible()
  await expect.poll(() => page.locator('.slide-show output').innerText(), { timeout: 15000 }).toMatch(/^2/)
  await page.screenshot({ path: join(output, 'ppt-auto-transition.png') })
  await page.getByRole('button', { name: '结束放映', exact: true }).click()
  checks.push('PPT: applied directional 850ms push transitions to all slides with 2s advance, exported/reopened native PPTX, and observed automatic advance in the real slideshow.')
  console.log('Verified PowerPoint transition export/reopen and slideshow auto-advance')

  const current = await read('office-slides-reopened.pptx')
  await read('office-slides-reopened.pptx', '/office-features', { method: 'POST', status: 409, body: { protocolVersion: 'office-features/1', baseRevision: current.revision + 100, patchId: crypto.randomUUID(), action: { op: 'pptx.transition.set', chunkIds: [current.slides[0].chunkId], transition: current.slides[0].transition } } })
  await page.setViewportSize({ width: 813, height: 1033 })
  await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('dark')
  await button('切换').click(); dialog = await settings('转场效果', '幻灯片转场')
  await expect(dialog.getByRole('button', { name: '应用设置', exact: true })).toBeInViewport()
  await confirmationContrast(dialog); await page.screenshot({ path: join(output, 'ppt-transition-dark-813.png') })
  await dialog.getByRole('button', { name: '关闭页面设置', exact: true }).click()
  checks.push('Settings remain within a narrow viewport in dark mode and keep confirmation actions visible.')
  checks.push('Host-managed Office settings route is classified and authorized; a stale revision is rejected without overwriting newer content.')
  assert(!responses.some(r => r.status === 403), 'Office features must not trigger unclassified host operation')
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'results.json'), JSON.stringify({ ok: true, checks, responses, consoleErrors: errors }, null, 2))
  console.log(`Verified ${checks.length} Office feature scenarios: ${output}`)
} catch (error) {
  writeFileSync(join(output, 'failure.txt'), String(error?.stack || error))
  if (page) { await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); writeFileSync(join(output, 'failure-page.txt'), await page.locator('body').innerText().catch(() => '')) }
  writeFileSync(join(output, 'errors.json'), JSON.stringify({ errors, responses }, null, 2)); throw error
} finally {
  writeFileSync(join(output, 'service.log'), log)
  if (browser) await browser.close(); service.kill('SIGTERM'); await stopped
}
