import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect } from '../editor/node_modules/@playwright/test/index.mjs'

// Exercise the actual embedded workspace, native edits and exported files.
const repo = resolve(import.meta.dirname, '../../..')
const output = resolve(process.env.OFFICECLI_RIBBON_ARTIFACTS || mkdtempSync(join(tmpdir(), 'office-ribbon-proof-')))
mkdirSync(output, { recursive: true })
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise(done => socket.close(done))
const site = `http://fold.localhost:${port}`
const service = spawn(process.execPath, [join(import.meta.dirname, 'demo.mjs')], {
  env: { ...process.env, OFFICECLI_EMBED_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = '', browser, page
service.stdout.on('data', chunk => { log += chunk })
service.stderr.on('data', chunk => { log += chunk })
const stopped = once(service, 'exit'), checks = [], errors = []
const native = join(process.env.OFFICECLI_WORKSPACE_DIST || join(repo, 'apps/workspace/dist'), 'officecli')
const fixture = (file, name) => { const destination = join(output, name); copyFileSync(join(repo, file), destination); return destination }
try {
  await expect.poll(() => log.includes('业务系统 '), { timeout: 60000 }).toBe(true)
  browser = await chromium.launch({ ...(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {}), args: ['--no-proxy-server'] })
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  const pane = page.locator('.desk-editor.is-visible')
  const button = name => pane.getByRole('button', { name, exact: true })
  const ribbon = () => pane.locator('.office-ribbon')
  async function upload(file, name) {
    await page.getByRole('tab', { name: '首页', exact: true }).click()
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(file)
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(ribbon()).toBeVisible({ timeout: 45000 })
  }
  async function compact() {
    if (await button('收起功能区').isVisible()) await button('收起功能区').click()
    await expect(ribbon()).toHaveAttribute('data-expanded', 'false')
  }
  async function expanded() {
    if (await button('展开功能区').isVisible()) await button('展开功能区').click()
    await expect(ribbon()).toHaveAttribute('data-expanded', 'true')
  }
  async function command(name) {
    const target = ribbon().getByRole('button', { name, exact: true })
    if (!await target.isVisible()) await expanded()
    await target.click()
  }
  async function geometry() {
    await expect.poll(() => ribbon().evaluate(element => ({
      overflow: element.scrollWidth > element.clientWidth + 1,
      radius: getComputedStyle(element).borderBottomLeftRadius,
      out: [...element.querySelectorAll('.ribbon-section-slot:not([hidden])')].some(node => node.getBoundingClientRect().right > element.getBoundingClientRect().right + 1),
    }))).toEqual({ overflow: false, radius: '16px', out: false })
  }
  async function selectText(target) {
    await target.evaluate(element => {
      element.closest('.tiptap').focus()
      const range = document.createRange(); range.selectNodeContents(element)
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).not.toBe('')
  }
  async function download(format, filename, mode = 'source') {
    const fileMenu = pane.locator('summary[aria-label="文件操作"]')
    if (!await fileMenu.evaluate(node => node.parentElement.open)) await fileMenu.click()
    const exports = pane.locator('.export-control')
    if (!await exports.evaluate(node => node.open)) await exports.locator('summary').click()
    await exports.getByRole('combobox', { name: '导出格式', exact: true }).selectOption(format)
    await exports.getByRole('combobox', { name: '导出方式', exact: true }).selectOption(mode)
    await exports.getByRole('button', { name: '准备下载', exact: true }).click()
    const link = exports.getByRole('link', { name: new RegExp(`下载 .*\\.${format}$`) })
    await expect(link).toBeVisible({ timeout: 45000 })
    const downloaded = page.waitForEvent('download'); await link.click()
    const path = join(output, filename); await (await downloaded).saveAs(path)
    await fileMenu.click()
    return path
  }
  await page.goto(site + '/workbench/')
  await expect(page.getByRole('heading', { name: '工作空间', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '收起全局 AI', exact: true }).click()
  const wordName = 'ribbon-word.docx'
  await upload(fixture('examples/word/numbering-showcase.docx', wordName), wordName)
  const paragraph = pane.locator('.tiptap').first().getByText('Numbering & List Showcase', { exact: true })
  await selectText(paragraph)
  await expect(ribbon().getByRole('button', { name: '加粗', exact: true })).toBeVisible()
  await command('加粗'); await command('右对齐')
  await expect(paragraph.locator('xpath=ancestor::*[@data-hcd-block-id][1]')).toHaveCSS('text-align', 'right')
  const selection = await page.evaluate(() => getSelection()?.toString())
  await compact(); await geometry()
  await page.screenshot({ path: join(output, 'word-compact.png') })
  await expanded()
  await expect(ribbon().getByRole('group', { name: '字体', exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, 'word-expanded.png') })
  await ribbon().screenshot({ path: join(output, 'word-ribbon-detail.png') })
  assert.equal(await page.evaluate(() => getSelection()?.toString()), selection)
  await button('布局').click(); await command('左对齐')
  await expect(paragraph.locator('xpath=ancestor::*[@data-hcd-block-id][1]')).toHaveCSS('text-align', 'left')
  await button('引用').click()
  await expect(ribbon().getByRole('button', { name: '引用段落到白板', exact: true })).toBeVisible()
  await button('开始').click(); await command('右对齐'); await command('保存点')
  await page.reload()
  await expect(pane.locator('.tiptap')).toBeVisible({ timeout: 45000 })
  await expect(ribbon()).toHaveAttribute('data-expanded', 'true')
  const exportedWord = await download('docx', 'word-edited.docx', 'semantic')
  const xml = execFileSync('python3', ['-c', "import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode())", exportedWord], { encoding: 'utf8' })
  assert(xml.includes('w:val="right"')); assert(xml.includes('Numbering'))
  await upload(exportedWord, 'word-edited.docx')
  await expect(pane.locator('.tiptap').getByText('Numbering & List Showcase', { exact: true }).locator('xpath=ancestor::*[@data-hcd-block-id][1]')).toHaveCSS('text-align', 'right')
  console.log('Verified Word formatting, selection and DOCX export/reopen')
  checks.push('Word selection survives density changes; alignment edit saves, exports via the editable DOCX rebuild and reopens correctly. Layout and reference commands are connected.')

  await upload(fixture('assets/showcase/gradebook.xlsx', 'ribbon-sheet.xlsx'), 'ribbon-sheet.xlsx')
  const canvas = pane.locator('canvas[id^="univer-sheet-main-canvas_"]').first()
  await expect(canvas).toBeVisible({ timeout: 45000 })
  await canvas.click({ position: { x: 58, y: 32 } })
  await expect(pane.getByLabel('选中单元格', { exact: true })).toHaveText('A1')
  await command('加粗'); await command('右对齐')
  await compact(); await geometry()
  await page.screenshot({ path: join(output, 'sheet-compact.png') })
  await button('工作表').click(); await compact()
  await page.setViewportSize({ width: 813, height: 1033 })
  await button('更多命令').click()
  const more = ribbon().getByRole('region', { name: '更多命令', exact: true })
  await expect(more).toBeVisible()
  const draft = more.getByRole('textbox', { name: '新增工作表名', exact: true })
  await draft.fill('未提交的工作表')
  await draft.press('Escape'); await expect(more).toBeHidden()
  await button('更多命令').click(); await expect(draft).toHaveValue('未提交的工作表')
  await page.screenshot({ path: join(output, 'sheet-more-813.png') })
  await draft.press('Escape'); await expanded()
  await expect(ribbon().getByRole('textbox', { name: '新增工作表名', exact: true })).toHaveValue('未提交的工作表')
  await compact(); await page.setViewportSize({ width: 1440, height: 1000 }); await geometry()
  await page.setViewportSize({ width: 813, height: 1033 })
  await button('数据').click(); await compact()
  await button('更多命令').click()
  const filterDraft = ribbon().getByRole('textbox', { name: '筛选关键词', exact: true })
  await filterDraft.fill('待核对的筛选条件')
  await filterDraft.press('Escape'); await button('更多命令').click()
  await expect(filterDraft).toHaveValue('待核对的筛选条件')
  await expanded(); await expect(filterDraft).toHaveValue('待核对的筛选条件')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await button('公式').click(); await command('求和函数')
  await expect(pane.getByRole('textbox', { name: '单元格内容或公式', exact: true })).toHaveValue('=SUM(')
  await pane.getByRole('textbox', { name: '单元格内容或公式', exact: true }).press('Escape')
  const exportedSheet = await download('xlsx', 'sheet-edited.xlsx')
  const sheetXml = execFileSync('python3', ['-c', "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.read('xl/styles.xml').decode())", exportedSheet], { encoding: 'utf8' })
  assert(sheetXml.includes('horizontal="right"'))
  await upload(exportedSheet, 'sheet-edited.xlsx')
  await expect(pane.locator('.hcd-univer-host')).toBeVisible({ timeout: 45000 })
  console.log('Verified worksheet formats, retained drafts and XLSX export/reopen')
  checks.push('XLSX font and alignment edits export/reopen. Overflow menu, Escape, resize and density changes preserve an unapplied worksheet name and the local filter draft of a child component; formula shortcut retains A1 target.')

  await upload(fixture('examples/ppt/textboxes/textboxes-basic.pptx', 'ribbon-slides.pptx'), 'ribbon-slides.pptx')
  await expect(pane.locator('.fixed-page iframe').first()).toBeVisible({ timeout: 45000 })
  const text = pane.locator('.fixed-page').first().frameLocator('iframe').getByText('Horizontal Alignment', { exact: true }).first()
  await text.click()
  await expanded(); await command('加粗'); await command('右对齐')
  await text.click()
  await expect(ribbon().getByRole('button', { name: '加粗', exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, 'slides-expanded.png') })
  const exportedDeck = await download('pptx', 'slides-edited.pptx')
  execFileSync('python3', ['-c', `import sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(sys.argv[1]); r=E.fromstring(z.read('ppt/slides/slide1.xml'))
ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
shape=next(s for s in r.findall('.//p:sp',ns) if ''.join(s.itertext()).strip() == 'Horizontal Alignment')
assert any(p.get('algn') == 'r' for p in shape.findall('.//a:pPr',ns))
`, exportedDeck])
  await upload(exportedDeck, 'slides-edited.pptx')
  await expect(pane.locator('.fixed-page iframe').first()).toBeVisible({ timeout: 45000 })
  for (const tab of ['设计', '动画', '放映', '审阅', '视图']) { await button(tab).click(); await expect(ribbon()).toBeVisible(); await geometry() }
  await button('放映').click(); await command('从当前页放映')
  await expect(pane.locator('.slide-show')).toBeVisible(); await page.keyboard.press('Escape')
  console.log('Verified PPT formatting and presentation menus')
  checks.push('PPTX text formatting saves, exports and reopens; design, object animation, notes and presentation use existing native capabilities.')

  for (const [name, mimeType, content] of [
    ['ribbon-text.txt', 'text/plain', '文本工具栏验收'], ['ribbon-markdown.md', 'text/markdown', '# Markdown 工具栏\n\n正文内容'],
    ['ribbon-page.html', 'text/html', '<html><body><h1>HTML 工具栏</h1><p>正文内容</p></body></html>'],
    ['ribbon-data.csv', 'text/csv', '区域,数值\n华东,108\n'], ['ribbon-data.tsv', 'text/tab-separated-values', '区域\t数值\n华东\t108\n'],
  ]) {
    await upload({ name, mimeType, buffer: Buffer.from(content) }, name)
    await compact(); await geometry()
    await page.getByRole('button', { name: '关闭 ' + name, exact: true }).click()
  }
  await upload(fixture('examples/test.pdf', 'ribbon-pages.pdf'), 'ribbon-pages.pdf')
  for (const tab of ['插入', '页面', '识别', '视图']) { await button(tab).click(); await expanded(); await geometry() }
  await button('页面').click(); await command('向右旋转')
  await page.screenshot({ path: join(output, 'pdf-pages.png') })
  const exportedPdf = await download('pdf', 'pages-edited.pdf')
  execFileSync(native, ['view', exportedPdf, '--mode', 'stats'])
  await upload(exportedPdf, 'pages-edited.pdf')
  await expect(pane.locator('.fixed-page')).toBeVisible({ timeout: 45000 })
  checks.push('TXT, Markdown, HTML, CSV and TSV have working format-specific ribbons; a PDF page edit exports and opens again.')

  await upload(fixture('assets/showcase/project-proposal.png', 'ribbon-image.png'), 'ribbon-image.png')
  await compact(); await geometry(); await expanded()
  await command('裁剪与旋转')
  await expect(pane.getByRole('heading', { name: '裁剪与旋转', exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, 'image-tools.png') })
  await button('收起图片面板').click()
  await page.setViewportSize({ width: 813, height: 1033 }); await compact(); await geometry()
  await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('dark')
  await geometry(); await page.screenshot({ path: join(output, 'image-dark-813.png') })
  checks.push('Image tools share the command surface while retaining the pixel canvas, crop panel and image editing handlers.')
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'results.json'), JSON.stringify({ status: 'passed', checks, browserErrors: errors }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks, output }, null, 2))
} catch (error) {
  if (page) { await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {}); writeFileSync(join(output, 'failure-state.txt'), await page.locator('body').innerText().catch(() => '')) }
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ error: String(error), browserErrors: errors }, null, 2))
  console.error('Office ribbon verification failed:', error, '\nArtifacts:', output)
  process.exitCode = 1
} finally {
  await browser?.close(); service.kill('SIGTERM'); await Promise.race([stopped, new Promise(done => setTimeout(done, 10000))])
}
