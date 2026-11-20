import assert from 'node:assert/strict'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect } from '../editor/node_modules/@playwright/test/index.mjs'
const fixtures = resolve(import.meta.dirname, 'fixtures/native-office')

export async function verifySheetConditions(page, folder, checks) {
  copyFileSync(join(fixtures, 'native-conditions-source.xlsx'), join(folder, 'native-conditions-source.xlsx'))
  const home = page.getByRole('tab', {name: '首页', exact: true})
  const editor = page.locator('.desk-editor.is-visible')
  const tab = name => page.getByRole('tab', {name, exact: true})
  const button = name => editor.getByRole('button', {name, exact: true})
  const dialog = page.getByRole('dialog', {name: '条件格式', exact: true})
  const dialogButton = name => dialog.getByRole('button', {name, exact: true})
  const label = name => dialog.getByLabel(name, {exact: true})
  const sheetCanvas = editor.locator('canvas[id^="univer-sheet-main-canvas_"]')
  async function upload(name) {
    await home.click()
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(join(folder, name))
    await expect(tab(name)).toHaveAttribute('aria-selected', 'true', {timeout: 45_000})
    await expect(editor.getByLabel('选中单元格', {exact: true})).toHaveText('A1', {timeout: 45_000})
  }
  async function openConditions() {
    await button('单元格格式').click()
    await button('条件格式').click()
    await expect(dialog).toBeVisible()
  }
  const colorCount = color => sheetCanvas.evaluateAll((canvases, color) => {
    const rgb = color.match(/../g).map(v => parseInt(v, 16))
    let count = 0
    for (const canvas of canvases) {
      if (!canvas.checkVisibility() || !canvas.width || !canvas.height) continue
      const ctx = canvas.getContext('2d')
      const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2] && data[i + 3] === 255) count++
      }
    }
    return count
  }, color)
  async function submit(name) {
    const patch = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/node-patch')
      && response.request().method() === 'POST')
    await dialogButton(name).click()
    const response = await patch
    assert(response.ok(), await response.text())
    const data = await response.json()
    await expect(dialog).toHaveCount(0)
    return data.revision
  }
  await upload('native-conditions-source.xlsx')
  await openConditions()
  await expect(label('应用区域')).toHaveValue('B2:B4')
  await expect(label('阈值')).toHaveValue('80')
  await expect(label('条件成立时停止应用后续规则')).toBeChecked()
  await expect.poll(() => colorCount('c8ecf8'), {timeout: 15_000}).toBeGreaterThan(100)
  checks.push('Existing conditional rule appears in the editor and draws in the native grid canvas.')
  await label('阈值').fill('120')
  assert.equal(await submit('保存规则'), 1)
  await openConditions()
  await dialogButton('新建规则').click()
  await expect(label('阈值')).toHaveValue('0')
  await label('应用区域').fill('B2:B4')
  await label('条件').selectOption('between')
  await label('阈值').fill('5')
  await label('第二个阈值').fill('100')
  await label('规则填充色').fill('#acd8bd')
  assert.equal(await submit('保存规则'), 2)
  await expect.poll(() => colorCount('acd8bd'), {timeout: 15_000}).toBeGreaterThan(100)
  await expect.poll(() => colorCount('c8ecf8'), {timeout: 15_000}).toBeGreaterThan(100)
  await page.screenshot({ path: join(folder, 'conditional-format-sheet.png') })
  const current = page.url()
  await page.reload()
  await expect(editor.getByLabel('选中单元格', {exact: true})).toHaveText('A1', {timeout: 45_000})
  assert.equal(page.url(), current)
  await openConditions()
  await expect(label('阈值')).toHaveValue('120')
  await dialog.getByRole('button', {name: /B2:B4 介于 5/}).click()
  await expect(label('第二个阈值')).toHaveValue('100')
  await page.screenshot({ path: join(folder, 'conditional-format-dialog.png') })
  await dialogButton('关闭').click()
  checks.push('Edited imported rule, created a range rule, verified both fill colors, and reopened the rule editor after a page refresh.')
  const exports = editor.locator('.export-control')
  await editor.locator('summary[aria-label="文件操作"]').click()
  await exports.locator('summary').click()
  await exports.getByRole('combobox', {name: '导出方式', exact: true}).selectOption('source')
  await exports.getByRole('button', {name: '准备下载', exact: true}).click()
  const download = page.waitForEvent('download')
  await exports.getByRole('link', {name: /下载 .*\.xlsx$/ }).click()
  await (await download).saveAs(join(folder, 'native-conditions-roundtrip.xlsx'))
  await upload('native-conditions-roundtrip.xlsx')
  await expect.poll(() => colorCount('acd8bd'), {timeout: 15_000}).toBeGreaterThan(100)
  await openConditions()
  await dialog.getByRole('button', {name: /B2:B4 介于 5/}).click()
  assert.equal(await submit('删除规则'), 1)
  await expect.poll(() => colorCount('acd8bd'), {timeout: 15_000}).toBe(0)
  await button('开始').click()
  const undoStarted = Date.now()
  const undoReceipt = page.waitForResponse(response => /\/restore\/\d+$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
  await button('↶ 撤销').click()
  assert((await undoReceipt).ok(), 'conditional rule undo must commit')
  try {
    await expect.poll(() => colorCount('acd8bd'), {timeout: 15_000}).toBeGreaterThan(100)
  } catch (error) {
    const canvases = await editor.locator('canvas').evaluateAll(canvases => canvases.map(canvas => {
      const rect = canvas.getBoundingClientRect()
      const ctx = canvas.getContext('2d')
      const colors = { green: 0, blue: 0 }
      if (ctx && canvas.width && canvas.height) {
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === 172 && data[i + 1] === 216 && data[i + 2] === 189 && data[i + 3] === 255) colors.green++
          if (data[i] === 200 && data[i + 1] === 236 && data[i + 2] === 248 && data[i + 3] === 255) colors.blue++
        }
      }
      return { id: canvas.id, size: [canvas.width, canvas.height], rect: rect.toJSON(), colors,
        display: getComputedStyle(canvas).display, visibility: getComputedStyle(canvas).visibility }
    }))
    writeFileSync(join(folder, 'conditional-canvases.json'), JSON.stringify(canvases, null, 2))
    throw error
  }
  const paintedAfterMs = Date.now() - undoStarted
  await button('↷ 重做').click()
  await expect.poll(() => colorCount('acd8bd'), {timeout: 15_000}).toBe(0)
  await button('↶ 撤销').click()
  await expect.poll(() => colorCount('acd8bd'), {timeout: 15_000}).toBeGreaterThan(100)
  writeFileSync(join(folder, 'conditional-undo.json'), JSON.stringify({ paintedAfterMs, redoRemovedFill: true, secondUndoRestoredFill: true }, null, 2))
  checks.push('Downloaded XLSX, opened it as a new tab, removed its native rule and restored it using revision undo; redo and a second undo immediately update the grid colors.')
}
