import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect } from '../editor/node_modules/@playwright/test/index.mjs'

/** Real workbench gestures, shared pages, source export and independent OOXML checks. */
export async function verifyWordTableCells(page, output, checks) {
  const source = resolve(import.meta.dirname, '../editor/e2e/fixtures/word-table-edit.docx')
  const filename = join(output, 'table-cells-source.docx')
  copyFileSync(source, filename)
  const pane = page.locator('.desk-editor.is-visible')
  const button = name => pane.getByRole('button', { name, exact: true })
  const upload = async (path, name) => {
    await page.getByRole('tab', { name: '首页', exact: true }).click()
    await page.locator('.desk-home-main input[type=file]').setInputFiles(path)
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(pane.locator('.tiptap').first()).toHaveAttribute('contenteditable', 'true', { timeout: 45000 })
  }
  await upload(filename, 'table-cells-source.docx')
  const iframe = pane.locator('.hcd-opaque-preview iframe').first(), frame = iframe.contentFrame()
  const tools = pane.locator('.hcd-opaque-preview').first().locator('[data-hcd-table-controls]')
  const row = index => frame.locator('tr').nth(index)
  const cell = (r, c) => row(r).locator(':scope > td,:scope > th').nth(c)
  // CSS zoom requires frame-local -> screen conversion, including Shift clicks.
  async function clickCell(target, shift = false) {
    await target.scrollIntoViewIfNeeded()
    const outer = await iframe.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, scale: rect.width / parseFloat(getComputedStyle(element).width) }
    })
    const inner = await target.evaluate(element => element.getBoundingClientRect().toJSON())
    if (shift) await page.keyboard.down('Shift')
    try { await page.mouse.click(outer.x + (inner.x + inner.width / 2) * outer.scale, outer.y + (inner.y + inner.height / 2) * outer.scale) }
    finally { if (shift) await page.keyboard.up('Shift') }
  }
  async function action(name, op) {
    await tools.getByRole('button', { name: '表格操作', exact: true }).click()
    const saved = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/patch'))
    if (name === '合并所选单元格') await page.screenshot({ path: join(output, 'table-cells-menu.png') })
    await tools.getByRole('menuitem', { name, exact: true }).click()
    const response = await saved
    assert(response.ok(), await response.text())
    const patch = response.request().postDataJSON()
    assert.equal(patch.schemaVersion, 'hcd-patch/67')
    assert.equal(patch.operations[0].op, op)
    await expect(pane.locator('.tiptap').first()).toHaveAttribute('contenteditable', 'true', { timeout: 30000 })
  }
  await expect(frame.locator('tr')).toHaveCount(31)
  await clickCell(cell(0, 0))
  await action('向右合并单元格', 'table.cells.merge')
  await expect(cell(0, 0)).toHaveAttribute('colspan', '2')
  await expect(cell(0, 0)).toContainText('ROW 00')
  await expect(cell(0, 0)).toContainText('Value 00')
  await clickCell(cell(0, 0))
  await action('向下合并单元格', 'table.cells.merge')
  await expect(cell(0, 0)).toHaveAttribute('rowspan', '2')
  await expect(cell(0, 0)).toContainText('Value 01')
  await clickCell(cell(0, 0))
  await action('拆分单元格', 'table.cell.split')
  await expect(row(0).locator(':scope > td')).toHaveCount(2)
  await expect(row(1).locator(':scope > td')).toHaveCount(2)
  await expect(cell(0, 0)).toContainText('Value 01')
  const blank = cell(0, 1).locator('[data-hcd-inline-table-text]')
  await expect(blank).toHaveAttribute('contenteditable', 'plaintext-only')
  await blank.fill('拆分后直接输入 🙂')
  await button('保存点').click()
  await expect(pane.locator('.editor-statusbar')).toContainText('已保存', { timeout: 30000 })
  checks.push('Word table menus merge horizontally and vertically, split back into editable cells, retain original paragraph order and marks, and accept real inline input without a modal.')

  await clickCell(cell(4, 0))
  await clickCell(cell(5, 1), true)
  await expect(frame.locator('.hcd-table-cell-selected')).toHaveCount(4)
  await page.screenshot({ path: join(output, 'table-cell-selection.png') })
  await action('合并所选单元格', 'table.cells.merge')
  await expect(cell(4, 0)).toHaveAttribute('rowspan', '2')
  await expect(cell(4, 0)).toHaveAttribute('colspan', '2')
  await expect(frame.locator('.hcd-table-cell-selected')).toHaveCount(0)
  const peer = await page.context().newPage()
  try {
    await peer.goto(page.url())
    const peerPane = peer.locator('.desk-editor.is-visible')
    await expect(peerPane.locator('.tiptap').first()).toHaveAttribute('contenteditable', 'true', { timeout: 45000 })
    const peerFrame = peerPane.locator('.hcd-opaque-preview iframe').first().contentFrame()
    await expect(peerFrame.locator('tr').nth(4).locator(':scope > td').first()).toHaveAttribute('rowspan', '2')
    const paragraph = peerPane.locator('.tiptap > p').filter({ hasText: 'COVER TITLE' }).first()
    await paragraph.click(); await peer.keyboard.press('End'); await peer.keyboard.insertText(' · 同时补充的正文')
    await peerPane.getByRole('button', { name: '保存点', exact: true }).click()
    await expect(peerPane.locator('.editor-statusbar')).toContainText('已保存', { timeout: 30000 })
    await expect(pane.locator('.tiptap')).toContainText('同时补充的正文')
    await button('开始').click()
    await button('↶ 撤销').click()
    await expect(row(4).locator(':scope > td')).toHaveCount(2)
    await expect(pane.locator('.tiptap')).toContainText('同时补充的正文')
    await button('↷ 重做').click()
    await expect(cell(4, 0)).toHaveAttribute('rowspan', '2')
    await expect(peerFrame.locator('tr').nth(4).locator(':scope > td').first()).toHaveAttribute('colspan', '2', { timeout: 30000 })
    await expect(peerPane.locator('.tiptap')).toContainText('同时补充的正文')
  } finally { await peer.close() }
  checks.push('Shift-click selects a complete 2×2 rectangle. Two real pages synchronize its merge, and guarded undo/redo leaves the other page’s later body edit intact.')

  await page.reload()
  await expect(pane.locator('.tiptap').first()).toHaveAttribute('contenteditable', 'true', { timeout: 45000 })
  await expect(cell(4, 0)).toHaveAttribute('rowspan', '2')
  await pane.locator('summary[aria-label="文件操作"]').click()
  const exports = pane.locator('.export-control')
  await exports.locator('summary').click()
  await exports.getByRole('combobox', { name: '导出方式', exact: true }).selectOption('source')
  await exports.getByRole('button', { name: '准备下载', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await exports.getByRole('link', { name: /下载 .*\.docx$/ }).click()
  const native = join(output, 'table-cells-native-reopened.docx')
  await (await downloaded).saveAs(native)
  const inspected = JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', `
import json,sys,zipfile,xml.etree.ElementTree as E
old,new=map(zipfile.ZipFile,sys.argv[1:])
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
w='{'+ns['w']+'}'
assert set(old.namelist())==set(new.namelist())
unchanged=[name for name in old.namelist() if name!='word/document.xml']
assert all(old.read(name)==new.read(name) for name in unchanged)
r=E.fromstring(new.read('word/document.xml')); rows=r.findall('.//w:body/w:tbl/w:tr',ns)
first=rows[0].find('w:tc',ns)
text=lambda e: ''.join(n.text or '' for n in e.findall('.//w:t',ns))
assert text(first)=='ROW 00Value 00ROW 01Value 01'
assert text(rows[0].findall('w:tc',ns)[1])=='拆分后直接输入 🙂'
assert first.find('.//w:b',ns) is not None and first.find('.//w:i',ns) is not None
merged=rows[4].find('w:tc',ns)
assert merged.find('w:tcPr/w:gridSpan',ns).get(w+'val')=='2'
assert merged.find('w:tcPr/w:vMerge',ns).get(w+'val')=='restart'
assert rows[5].find('w:tc/w:tcPr/w:vMerge',ns) is not None
assert text(merged)=='ROW 04Value 04ROW 05Value 05'
assert '同时补充的正文' in text(r)
print(json.dumps({'nativeGrid': [len(rows),2], 'mergedText': text(merged), 'splitText': text(rows[0].findall('w:tc',ns)[1]), 'unchangedParts': unchanged}, ensure_ascii=False))
`, filename, native], { encoding: 'utf8' }))
  writeFileSync(join(output, 'table-cells-native-inspection.json'), JSON.stringify(inspected, null, 2))
  await upload(native, 'table-cells-native-reopened.docx')
  await expect(cell(4, 0)).toHaveAttribute('rowspan', '0000000002')
  await expect(cell(4, 0)).toContainText('Value 05')
  await expect(cell(0, 1)).toContainText('拆分后直接输入 🙂')
  await expect(pane.locator('.tiptap')).toContainText('同时补充的正文')
  await cell(0, 0).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, 'table-cells-native-reopened.png') })
  checks.push('The actual downloaded DOCX reopens in a new workbench file. Independent OOXML checks confirm native merges, split-cell input, bold/italic and every unrelated ZIP part; source content and the concurrent body edit survive.')
}
