import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect } from '../editor/node_modules/@playwright/test/index.mjs'

// This original fixture exercises the real OOXML inheritance chain; it does not
// insert expected coordinates or fonts directly into the slide being imported.
export async function verifyPptxInheritance(page, output, checks, { baseline = false } = {}) {
  const source = join(output, 'master-inheritance.pptx')
  execFileSync('python3', [resolve(import.meta.dirname, 'fixtures/pptx-inheritance.py'), source])
  const home = page.getByRole('tab', { name: '首页', exact: true })
  const editor = page.locator('.desk-editor.is-visible')
  const tool = name => editor.getByRole('button', { name, exact: true })
  const frame = editor.locator('.fixed-page').first().frameLocator('iframe')
  const title = frame.locator('[data-hcd-shape-id="2"]')
  const body = frame.locator('[data-hcd-shape-id="3"]')
  async function upload(filename) {
    await home.click()
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(filename)
    await expect(page.getByRole('tab', { name: filename.split('/').at(-1), exact: true }))
      .toHaveAttribute('aria-selected', 'true', { timeout: 45000 })
    await expect(title).toBeVisible()
  }
  async function command(name) {
    if (!(await tool(name).isVisible())) await tool('展开功能区').click()
    await tool(name).click()
  }
  async function capture(name) {
    const values = await title.evaluate(element => ({
      x: element.getAttribute('data-hcd-x-emu'), y: element.getAttribute('data-hcd-y-emu'),
      width: element.getAttribute('data-hcd-width-emu'), height: element.getAttribute('data-hcd-height-emu'),
      text: element.textContent,
      runs: [...element.querySelectorAll('.hcd-ppt-run')].map(run => {
        const style = getComputedStyle(run)
        return { font: style.fontFamily, size: style.fontSize, color: style.color, weight: style.fontWeight }
      }),
    }))
    await page.screenshot({ path: join(output, `pptx-inheritance-${name}.png`) })
    return values
  }
  async function download(name) {
    const menu = editor.locator('summary[aria-label="文件操作"]')
    const exports = editor.locator('.export-control')
    if (!(await menu.evaluate(element => element.parentElement.open))) await menu.click()
    if (!(await exports.evaluate(element => element.open))) await exports.locator('summary').click()
    await exports.getByRole('combobox', { name: '导出格式', exact: true }).selectOption('pptx')
    await exports.getByRole('combobox', { name: '导出方式', exact: true }).selectOption('source')
    await exports.getByRole('button', { name: '准备下载', exact: true }).click()
    const pending = page.waitForEvent('download')
    await exports.getByRole('link', { name: /下载 .*\.pptx$/ }).click()
    const saved = join(output, name)
    await (await pending).saveAs(saved)
    await menu.click()
    return saved
  }
  async function typography() {
    const run = title.locator('.hcd-ppt-run').first()
    await expect(run).toHaveCSS('font-family', /Georgia/)
    await expect(run).toHaveCSS('font-size', '40px')
    await expect(run).toHaveCSS('font-weight', '700')
    await expect(run).toHaveCSS('color', 'rgb(34, 34, 34)')
    const paragraphs = body.locator(':scope > p')
    await expect(paragraphs).toHaveCount(4)
    await expect(paragraphs.nth(0).locator('.hcd-ppt-run')).toHaveCSS('font-size', '26.6667px')
    await expect(paragraphs.nth(1).locator('.hcd-ppt-run')).toHaveCSS('font-size', '22.6667px')
    await expect(paragraphs.nth(1).locator('.hcd-ppt-run')).toHaveCSS('font-weight', '400')
    await expect(paragraphs.nth(1).locator('.hcd-ppt-run')).toHaveCSS('font-style', 'normal')
    await expect(paragraphs.nth(2).locator('.hcd-ppt-run')).toHaveCSS('font-size', '16px')
    await expect(paragraphs.nth(2)).toHaveCSS('text-align', 'right')
    await expect(paragraphs.nth(3).locator('.hcd-ppt-run')).toHaveCSS('font-family', /Noto Sans SC/)
  }
  await upload(source)
  const sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex')
  if (baseline) {
    const observed = await capture('before')
    assert.notEqual(observed.x, '914400', 'Baseline must actually reproduce missing inheritance')
    writeFileSync(join(output, 'inheritance-before.json'), JSON.stringify({ sourceSha256, observed }, null, 2))
    checks.push('Original native fixture reproduces missing placeholder geometry before the fix.')
    return
  }
  await expect(title).toHaveAttribute('data-hcd-x-emu', '914400')
  await expect(title).toHaveAttribute('data-hcd-y-emu', '457200')
  await expect(title).toHaveAttribute('data-hcd-width-emu', '7315200')
  await expect(body).toHaveAttribute('data-hcd-x-emu', '1371600')
  await expect(body).toHaveAttribute('data-hcd-width-emu', '6400800')
  const explicitZero = frame.locator('[data-hcd-shape-id="4"]')
  await expect(explicitZero).toHaveAttribute('data-hcd-x-emu', '0')
  await expect(explicitZero).toHaveAttribute('data-hcd-width-emu', '6400800')
  await typography()
  const imported = await capture('imported')
  await tool('开始').click()
  await editor.getByRole('button', { name: /^编辑文字：Master-led layout/ }).click()
  const input = frame.getByRole('textbox', { name: '编辑文字', exact: true })
  await input.fill('Master-led title revised')
  const saving = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/node-patch') && response.request().method() === 'POST')
  await input.press('ControlOrMeta+Enter')
  assert((await saving).ok(), 'Native title edit must be saved before moving')
  await expect(title).toContainText('Master-led title revised')
  await page.keyboard.press('Escape')
  const objectMode = tool('选择对象')
  if ((await objectMode.getAttribute('aria-pressed')) !== 'true') await command('选择对象')
  const id = await title.getAttribute('data-hcd-id')
  const hitbox = editor.locator(`[data-pptx-object="${id}"]`)
  await hitbox.click()
  await expect(hitbox).toHaveAttribute('aria-pressed', 'true')
  const handle = tool('移动所选对象')
  const rect = await handle.boundingBox()
  assert(rect)
  const start = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 22, start.y + 14, { steps: 9 })
  await page.mouse.up()
  await expect(title).not.toHaveAttribute('data-hcd-x-emu', imported.x)
  const moved = await capture('moved')
  const native = await download('inherited-native-edited.pptx')
  // The export creates only the moved placeholder's local transform. Shared
  // layout/master/theme parts must remain byte-identical after text+move edits.
  const preserved = JSON.parse(execFileSync('python3', ['-c', `
import sys,json,zipfile,xml.etree.ElementTree as E
with zipfile.ZipFile(sys.argv[1]) as before, zipfile.ZipFile(sys.argv[2]) as after:
 parts=['ppt/slideMasters/slideMaster1.xml','ppt/slideLayouts/slideLayout1.xml','ppt/theme/theme1.xml']
 assert all(before.read(p)==after.read(p) for p in parts)
 ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
 slide=E.fromstring(after.read('ppt/slides/slide1.xml'))
 title=next(s for s in slide.findall('.//p:sp',ns) if s.find('p:nvSpPr/p:cNvPr',ns).get('id')=='2')
 off=title.find('p:spPr/a:xfrm/a:off',ns)
 assert off is not None and off.get('x')==sys.argv[3] and off.get('y')==sys.argv[4]
 assert 'Master-led title revised' in ''.join(title.itertext())
 print(json.dumps(parts))
`, source, native, moved.x, moved.y], { encoding: 'utf8' }))
  await upload(native)
  await expect(title).toHaveAttribute('data-hcd-x-emu', moved.x)
  await expect(title).toHaveAttribute('data-hcd-y-emu', moved.y)
  await expect(title).toContainText('Master-led title revised')
  await typography()
  checks.push('A native PPTX inherits placeholder geometry by idx, master styles and theme Latin/CJK fonts. Text edits and pointer moves survive native export/reopen without changing shared layout, master or theme XML.')
  await tool('视图').click()
  await command('幻灯片母版')
  const master = page.getByRole('dialog', { name: '幻灯片母版', exact: true })
  await master.getByRole('textbox', { name: '母版背景色值', exact: true }).fill('#f6f4ef')
  await master.getByRole('button', { name: '应用到母版', exact: true }).click()
  await expect(master).toHaveCount(0)
  await expect(frame.locator('.hcd-slide')).toHaveCSS('background-color', 'rgb(246, 244, 239)')
  await tool('动画').click()
  await command('编辑本页动画')
  const animations = page.getByRole('dialog', { name: '幻灯片动画', exact: true })
  async function add(target, kind, trigger, duration, delay) {
    await animations.getByLabel('幻灯片对象', { exact: true }).selectOption(target)
    await animations.getByRole('button', { name: '添加动画', exact: true }).click()
    const row = animations.getByRole('listitem').last()
    await row.getByLabel('效果', { exact: true }).selectOption(kind)
    await row.getByLabel('开始', { exact: true }).selectOption(trigger)
    await row.getByLabel('时长（毫秒）', { exact: true }).fill(String(duration))
    await row.getByLabel('延迟（毫秒）', { exact: true }).fill(String(delay))
  }
  await add('s2', 'fadeIn', 'onClick', 280, 0)
  await add('s3', 'flyIn', 'withPrevious', 300, 80)
  await add('s2', 'fadeOut', 'onClick', 250, 0)
  await page.screenshot({ path: join(output, 'pptx-inheritance-animations.png') })
  await animations.getByRole('button', { name: '保存动画', exact: true }).click()
  await expect(animations).toHaveCount(0)
  await page.reload()
  await expect(frame.locator('.hcd-slide')).toHaveAttribute('data-hcd-pptx-animation-edited', 'true', { timeout: 45000 })
  await tool('动画').click()
  await command('编辑本页动画')
  await expect(animations.getByRole('listitem')).toHaveCount(3)
  await expect(animations.getByRole('listitem').nth(1).getByLabel('延迟（毫秒）', { exact: true })).toHaveValue('80')
  await animations.getByRole('button', { name: '关闭', exact: true }).click()
  await command('从当前页放映')
  const show = page.getByRole('dialog', { name: '幻灯片放映', exact: true })
  const stage = show.frameLocator('iframe[data-hcd-thumbnail]')
  const shownTitle = stage.locator('[data-hcd-shape-id="2"]')
  await expect(shownTitle).toHaveCSS('visibility', 'hidden')
  await show.getByRole('button', { name: '下一步动画', exact: true }).click()
  await expect(shownTitle).toHaveCSS('visibility', 'visible')
  await expect(stage.locator('[data-hcd-shape-id="3"]')).toHaveCSS('visibility', 'visible')
  await show.getByRole('button', { name: '下一步动画', exact: true }).click()
  await expect(shownTitle).toHaveCSS('visibility', 'hidden')
  await show.getByRole('button', { name: '上一步动画', exact: true }).click()
  await expect(shownTitle).toHaveCSS('visibility', 'visible')
  await show.getByRole('button', { name: '结束放映', exact: true }).click()
  const finalNative = await download('inherited-native-master-animations.pptx')
  await upload(finalNative)
  await expect(title).toHaveAttribute('data-hcd-x-emu', moved.x)
  await expect(frame.locator('.hcd-slide')).toHaveCSS('background-color', 'rgb(246, 244, 239)')
  await expect(frame.locator('.hcd-slide')).toHaveAttribute('data-hcd-pptx-animations', /flyIn/)
  await typography()
  const reopened = await capture('reopened')
  await tool('动画').click()
  await command('编辑本页动画')
  await expect(animations.getByRole('listitem')).toHaveCount(3)
  await animations.getByRole('button', { name: '关闭', exact: true }).click()
  checks.push('Inherited placeholders retain their positions and typography through a native master-background edit and a three-effect animation track; reload, presentation forward/back and native export/reopen preserve the track.')
  await tool('视图').click()
  await command('幻灯片母版')
  await master.getByRole('button', { name: '文字样式', exact: true }).click()
  await expect(master.getByLabel('母版字号', { exact: true })).toHaveValue('30')
  await expect(master.getByLabel('西文字体', { exact: true })).toHaveValue('Georgia')
  await master.getByLabel('母版字号', { exact: true }).fill('36')
  await master.getByLabel('母版文字颜色', { exact: true }).fill('#b34e32')
  await master.getByLabel('母版加粗', { exact: true }).selectOption('false')
  await master.getByLabel('西文字体', { exact: true }).fill('Verdana')
  await master.getByLabel('东亚字体', { exact: true }).fill('Noto Serif SC')
  await page.screenshot({ path: join(output, 'pptx-master-text-dialog.png') })
  await master.getByRole('button', { name: '应用到母版', exact: true }).click()
  await expect(master).toHaveCount(0)
  const titleRun = title.locator('.hcd-ppt-run').first()
  await expect(titleRun).toHaveCSS('font-size', '48px')
  await expect(titleRun).toHaveCSS('font-weight', '400')
  await expect(titleRun).toHaveCSS('font-family', /Verdana/)
  await expect(titleRun).toHaveCSS('color', 'rgb(179, 78, 50)')
  await command('幻灯片母版')
  await master.getByRole('button', { name: '文字样式', exact: true }).click()
  await master.getByLabel('文字类型', { exact: true }).selectOption('body')
  await master.getByLabel('母版字号', { exact: true }).fill('22')
  await master.getByLabel('母版文字颜色', { exact: true }).fill('#334455')
  await master.getByLabel('母版加粗', { exact: true }).selectOption('false')
  await master.getByRole('button', { name: '应用到母版', exact: true }).click()
  await expect(master).toHaveCount(0)
  async function retainedOverrides() {
    const runs = body.locator('.hcd-ppt-run')
    await expect(runs.nth(0)).toHaveCSS('font-size', '26.6667px')
    await expect(runs.nth(0)).toHaveCSS('color', 'rgb(36, 107, 87)')
    await expect(runs.nth(0)).toHaveCSS('font-weight', '400')
    await expect(runs.nth(1)).toHaveCSS('font-size', '22.6667px')
    await expect(runs.nth(1)).toHaveCSS('font-style', 'normal')
    await expect(runs.nth(2)).toHaveCSS('font-size', '16px')
    await expect(runs.nth(2)).toHaveCSS('color', 'rgb(99, 59, 30)')
    await expect(runs.nth(2)).toHaveCSS('font-family', /Times New Roman/)
  }
  await retainedOverrides()
  await page.reload()
  await expect(titleRun).toHaveCSS('font-size', '48px', { timeout: 45000 })
  await retainedOverrides()
  const styledNative = await download('inherited-master-text-styles.pptx')
  execFileSync('python3', ['-c', `
import sys,zipfile,xml.etree.ElementTree as E
ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
with zipfile.ZipFile(sys.argv[1]) as old,zipfile.ZipFile(sys.argv[2]) as new:
 for part in ['ppt/slideLayouts/slideLayout1.xml','ppt/theme/theme1.xml']:
  assert old.read(part)==new.read(part), part
 master=E.fromstring(new.read('ppt/slideMasters/slideMaster1.xml'))
 title=master.find('p:txStyles/p:titleStyle/a:lvl1pPr/a:defRPr',ns)
 assert title.get('sz')=='3600' and title.get('b')=='0'
 assert title.find('a:latin',ns).get('typeface')=='Verdana'
 assert title.find('a:ea',ns).get('typeface')=='Noto Serif SC'
 body=master.find('p:txStyles/p:bodyStyle/a:lvl1pPr/a:defRPr',ns)
 assert body.get('sz')=='2200' and body.get('b')=='0'
 slide=E.fromstring(new.read('ppt/slides/slide1.xml'))
 shape=next(s for s in slide.findall('.//p:sp',ns) if s.find('p:nvSpPr/p:cNvPr',ns).get('id')=='2')
 assert shape.find('p:txBody/a:p/a:r/a:rPr',ns) is None, 'master changes must remain inherited'
`, source, styledNative])
  await upload(styledNative)
  await expect(titleRun).toHaveCSS('font-size', '48px')
  await expect(titleRun).toHaveCSS('font-family', /Verdana/)
  await expect(titleRun).toHaveCSS('font-weight', '400')
  await retainedOverrides()
  await capture('master-text-reopened')
  checks.push('Edited title and body master text styles through the real dialog. Reload and native export/reopen retain shared font, size, color and explicit false values, while layout, paragraph and direct run overrides remain unchanged and title XML stays inherited.')
  writeFileSync(join(output, 'inheritance-roundtrip.json'), JSON.stringify({ sourceSha256, imported, moved, reopened, preserved }, null, 2))
}
