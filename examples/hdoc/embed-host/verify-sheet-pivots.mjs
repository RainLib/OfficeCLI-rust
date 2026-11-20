import assert from 'node:assert/strict'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect } from '../editor/node_modules/@playwright/test/index.mjs'
const fixtures = resolve(import.meta.dirname, 'fixtures/native-office')

export async function verifySheetPivots(page, proof, checks) {
  copyFileSync(join(fixtures, 'pivot-source.xlsx'), join(proof, 'pivot-source.xlsx'))
  const home = page.getByRole('tab', {name: '首页', exact: true})
  const editor = page.locator('.desk-editor.is-visible')
  const menu = name => editor.getByRole('button', {name, exact: true})
  const activeCell = editor.getByLabel('选中单元格', {exact: true})
  const formula = editor.getByRole('textbox', {name: '单元格内容或公式', exact: true})
  const canvas = editor.locator('canvas[id^="univer-sheet-main-canvas_"]').first()
  const dialog = page.getByRole('dialog', {name:'数据透视表', exact:true})
  const field = name => dialog.getByLabel(name, {exact: true})
  const button = name => dialog.getByRole('button', {name,exact:true})
  const report = dialog.getByRole('table', {name:'透视表汇总结果', exact:true})
  let filename
  async function upload(name) {
    filename = name
    await home.click()
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(join(proof, name))
    await expect(page.getByRole('tab', {name, exact: true})).toHaveAttribute('aria-selected','true',{timeout:45_000})
    await expect(activeCell).toHaveText('A1',{timeout:45_000})
  }
  async function pivotDialog() {
    await menu('数据').click()
    await menu('数据透视表').click()
    await expect(dialog).toBeVisible()
  }
  async function savePivot(action) {
    await expect(button(action)).toBeEnabled()
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/node-patch')
        && response.request().method()==='POST'),
      button(action).click(),
    ])
    assert(response.ok(), await response.text())
    await expect(dialog).toHaveCount(0)
    return (await response.json()).revision
  }
  async function sheet(name) {
    return page.evaluate(async ({filename,name})=>{
      const files=(await (await fetch('/workspace/api/files')).json()).files
      const file=files.find(file=>file.name===filename)
      const {csrf} = await (await fetch('/workspace/api/session')).json()
      const launch = await (await fetch('/workspace/api/files/'+file.id+'/editor-session',{
        method:'POST',headers:{'Content-Type':'application/json','X-Workspace-CSRF':csrf},
        body:JSON.stringify({sessionId:crypto.randomUUID()})})).json()
      const headers={Authorization:'Bearer '+launch.token}
      const url='/v1/documents/'+file.resourceDocumentId+'/sheets/'
      const sheet=await (await fetch(url+(name==='汇总'?1:0),{headers})).json()
      if (sheet.sheetName!==name) throw new Error('Incorrect worksheet')
      return Object.fromEntries(sheet.cells.map(cell=>[cell.address,cell.calculation?.value ?? cell.text]))
    },{filename,name})
  }
  async function chooseSheet(name) {
    await editor.locator('.hcd-univer-host').getByText(name,{exact:true}).last().click()
  }

  await upload('pivot-source.xlsx')
  await pivotDialog()
  await expect(field('源数据区域')).toHaveValue('A1:D6')
  await field('透视表名称').fill('RevenueByRegion')
  await field('结果工作表').selectOption({label:'汇总'})
  await field('结果起点').fill('D3')
  const catalog=dialog.getByRole('region',{name:'源字段',exact:true})
  await catalog.getByText('地区',{exact:true}).dragTo(dialog.getByRole('region',{name:'行',exact:true}))
  await catalog.getByText('品类',{exact:true}).dragTo(dialog.getByRole('region',{name:'列',exact:true}))
  await expect(dialog.getByRole('region',{name:'行',exact:true}).locator('.pivot-assigned-field')).toContainText('地区')
  await expect(dialog.getByRole('region',{name:'列',exact:true}).locator('.pivot-assigned-field')).toContainText('品类')
  await field('添加汇总字段').selectOption({label:'金额'})
  await field('添加汇总字段').selectOption({label:'件数'})
  await field('件数 汇总方式').selectOption('count')
  await expect(report.getByText('240',{exact:true})).toBeVisible()
  await expect(report.getByText('130',{exact:true})).toBeVisible()
  await field('结果起点').fill('A1')
  await expect(dialog.getByRole('alert')).toContainText('would overwrite')
  await expect(button('保存透视表')).toBeDisabled()
  await field('结果起点').fill('D3')
  await expect(report.getByText('240',{exact:true})).toBeVisible()
  await page.screenshot({path:join(proof,'pivot-field-preview.png')})
  assert.equal(await savePivot('保存透视表'),1)
  await expect(activeCell).toHaveText('D3')
  await expect(formula).toBeDisabled()
  assert.equal((await sheet('汇总')).B1,'210')
  assert.equal((await sheet('汇总')).E5,'130')
  await page.screenshot({path:join(proof,'pivot-grid.png')})
  checks.push('Created a cross-sheet pivot by dragging dimension fields, validated live formula-derived output, rejected an occupied destination and verified that result cells are read-only.')
  await page.reload()
  await expect(activeCell).toHaveText('D3',{timeout:45_000})
  await expect(formula).toBeDisabled()
  await chooseSheet('销售')
  await canvas.click({position:{x:200,y:52}})
  await expect(activeCell).toHaveText('C2')
  await formula.fill('120')
  await menu('应用内容').click()
  await expect.poll(async () => (await sheet('销售')).C2).toBe('120')
  assert.equal((await sheet('汇总')).E5,'130')
  await pivotDialog()
  await field('选择透视表').selectOption({label:'RevenueByRegion · 汇总'})
  await expect(report.getByText('480',{exact:true})).toBeVisible()
  assert.equal(await savePivot('刷新透视表'),3)
  await expect(activeCell).toHaveText('D3')
  assert.equal((await sheet('汇总')).E5,'210')
  assert.equal((await sheet('汇总')).E6,'240')
  assert.equal((await sheet('汇总')).I7,'480')
  assert.equal((await sheet('汇总')).B1,'450')
  await menu('开始').click()
  await menu('↶ 撤销').click()
  await expect.poll(async () => (await sheet('汇总')).I7).toBe('240')
  assert.equal((await sheet('销售')).C2,'120')
  await menu('↷ 重做').click()
  await expect.poll(async () => (await sheet('汇总')).I7).toBe('480')
  checks.push('Recovered the workbook view on reload. A source edit updated a dependent formula and refreshed the report from 240 to 480.')
  const exports = editor.locator('.export-control')
  await editor.locator('summary[aria-label="文件操作"]').click()
  await exports.locator('summary').click()
  await exports.getByRole('combobox',{name:'导出方式',exact:true}).selectOption('source')
  await exports.getByRole('button',{name:'准备下载',exact:true}).click()
  const download = page.waitForEvent('download')
  await exports.getByRole('link',{name:/下载 .*\.xlsx$/}).click()
  await (await download).saveAs(join(proof,'pivot-browser-roundtrip.xlsx'))
  await upload('pivot-browser-roundtrip.xlsx')
  await chooseSheet('汇总')
  await pivotDialog()
  await field('选择透视表').selectOption({label:'RevenueByRegion · 汇总'})
  await expect(field('源数据区域')).toHaveValue('A1:D6')
  await field('金额 汇总方式').selectOption('average')
  await expect(report.getByText('96',{exact:true})).toBeVisible()
  assert.equal(await savePivot('保存透视表'),1)
  await expect(activeCell).toHaveText('D3')
  assert.equal((await sheet('汇总')).I7,'96')
  checks.push('Downloaded the original-format XLSX, reopened it in the workbench and changed the native PivotTable aggregation.')
}
