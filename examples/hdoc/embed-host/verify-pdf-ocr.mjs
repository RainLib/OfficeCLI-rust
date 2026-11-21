import assert from 'node:assert/strict'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect } from '../editor/node_modules/@playwright/test/index.mjs'
const fixtures = resolve(import.meta.dirname, 'fixtures/native-office')

export async function verifyPdfOcr(page, proof, checks) {
  copyFileSync(join(fixtures, 'workshop-scan.pdf'), join(proof, 'workshop-scan.pdf'))
  const context = page.context(), site = new URL(page.url()).origin
  const external = [], traffic = [], patches = []
  const step = detail => checks.push(detail)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  context.on('response', response => {
    const path = new URL(response.url()).pathname, code = response.status()
    if (/pdf-ocr|pdf-render/.test(path)) traffic.push({ path, code })
    if (path.endsWith('/node-patch') && response.request().method() === 'POST') patches.push({ code, payload: response.request().postDataJSON() })
  })
  await context.route(/^https?:/, route => {
    if (new URL(route.request().url()).origin === site) return route.continue()
    external.push(route.request().url())
    return route.abort()
  })
  async function bounded(task, note, ms=8000) {
    let timer
    try { return await Promise.race([task, new Promise((_,reject) => { timer=setTimeout(() => reject(new Error(note)),ms) })]) }
    finally { clearTimeout(timer) }
  }
  const home = page.getByRole('tab',{name:'首页',exact:true})
  const editor = page.locator('.desk-editor.is-visible')
  const tool = name => editor.getByRole('button',{name,exact:true})
  const sheet = index => editor.locator('.fixed-page').nth(index).frameLocator('iframe')
  const raster = sheet(0).locator('.hcd-pdf-page-raster')
  const dialog = page.getByRole('dialog',{name:'识别扫描文字',exact:true})
  const recognized = (i, mapping = 'ocr') => sheet(i).locator(`.hcd-pdf-text[data-hcd-mapping="${mapping}"]`)
  const findTool = async locator => {
    if(!(await locator.isVisible())) {
      const more=tool('展开功能区')
      if(await more.isVisible()) await more.click()
    }
    await expect(locator).toBeVisible()
  }
  async function upload(name) {
    await home.click()
    await page.locator('.desk-home-main input[type=file]').setInputFiles(join(proof,name))
    await expect(page.getByRole('tab',{name,exact:true})).toHaveAttribute('aria-selected','true',{timeout:45000})
    await expect(raster).toBeVisible({timeout:45000})
  }
  async function recognize(scope,total,currentPage) {
    await tool('视图').click()
    if(currentPage) {
      const input=editor.getByRole('spinbutton',{name:'要调整的页码',exact:true})
      await findTool(input)
      await input.fill(String(currentPage))
    }
    const ocr=tool('识别扫描文字')
    await findTool(ocr)
    await ocr.click()
    const range=dialog.getByLabel('识别范围',{exact:true})
    await expect(range).toBeEnabled({timeout:20000})
    await expect(range.locator('option[value="scans"]')).toContainText(`(${scope==='scans'?2:0})`)
    await range.selectOption(scope)
    await dialog.getByRole('button',{name:'开始识别',exact:true}).click()
    await expect(dialog.getByRole('button',{name:'完成',exact:true})).toBeVisible({timeout:90000})
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog).toContainText(`已处理 ${total} / ${total} 页`)
    await expect(dialog).toContainText(/已保存识别文字 [1-9]\d* 行/)
    await page.screenshot({path:join(proof,scope==='scans'?'recognition-complete.png':'mixed-page-complete.png')})
    await dialog.getByRole('button',{name:'完成',exact:true}).click()
  }
  async function search(text) {
    await tool('查找全文').click()
    const search=editor.getByRole('region',{name:'文档内容搜索'})
    await search.getByRole('searchbox').fill(text)
    const hit=search.getByRole('listitem').filter({hasText:text})
    await expect(hit).toHaveCount(1,{timeout:25000})
    await hit.click()
    return search
  }
  async function download(name) {
    const exportControls=editor.locator('.export-control')
    await editor.locator('summary[aria-label="文件操作"]').click()
    await exportControls.locator('summary').click()
    await exportControls.getByRole('combobox',{name:'导出格式',exact:true}).selectOption('pdf')
    const mode=exportControls.getByRole('combobox',{name:'导出方式',exact:true})
    if(await mode.isVisible()) await mode.selectOption('source')
    await exportControls.getByRole('button',{name:'准备下载',exact:true}).click()
    const result=page.waitForEvent('download')
    await exportControls.getByRole('link',{name:/下载 .*\.pdf$/}).click({timeout:35000})
    await (await result).saveAs(join(proof,name))
  }
  await upload('workshop-scan.pdf')
  await expect.poll(()=>raster.evaluate(img=>img.naturalWidth)).toBeGreaterThan(0)
  const initialWidth=await raster.evaluate(img=>img.naturalWidth)
  for(let click=0;click<3;click++) await tool('放大文档').click()
  await expect(raster).toHaveAttribute('data-hcd-detail-dpi',/192|288|384/,{timeout:20000})
  const detailWidth=await raster.evaluate(img=>img.naturalWidth)
  assert(detailWidth >= initialWidth*1.75)
  await page.screenshot({path:join(proof,'high-dpi-zoom.png')})
  await tool('重置文档缩放').click()
  step(`PDF zoom changed the decoded raster from ${initialWidth} to ${detailWidth} pixels at DPR 1.`)
  await recognize('scans',2)
  const p1=recognized(0)
  await expect(p1.getByText(/^华东计划于十一月二十日启动/)).toBeVisible()
  const phrase=p1.getByText('Release Review Checklist',{exact:true})
  await expect(phrase).toBeVisible()
  step('A blocked-external-network browser recognized both scan-only pages using the bundled Chinese and English models.')
  await recognize('page',1,2)
  await editor.locator('.fixed-page').nth(1).scrollIntoViewIfNeeded()
  const page2=sheet(1).locator('.hcd-pdf-page')
  await expect(page2.getByText('Native header read once',{exact:true})).toHaveCount(1)
  await expect(recognized(1).getByText('Training agenda',{exact:true})).toBeVisible()
  const page3=editor.locator('.fixed-page').nth(2)
  await page3.scrollIntoViewIfNeeded()
  await expect(recognized(2).getByText('Rotated scan document',{exact:true})).toBeVisible()
  await expect(recognized(2).getByText(/^请提前十分钟入场/)).toBeVisible()
  step('The mixed page preserved its real header and the rotated crop retained upright Chinese and English line boxes.')
  await editor.locator('.fixed-page').first().scrollIntoViewIfNeeded()
  await phrase.scrollIntoViewIfNeeded()
  const box=await bounded(page.evaluate(() => {
    const frame=document.querySelector('.desk-editor.is-visible .fixed-page iframe')
    const node=[...frame.contentDocument.querySelectorAll('.hcd-pdf-text[data-hcd-mapping="ocr"] > span')].find(el=>el.textContent==='Release Review Checklist')
    const line=node.getBoundingClientRect(), host=frame.getBoundingClientRect()
    return {x:host.left+line.left, y:host.top+line.top, width:line.width, height:line.height, viewport:innerHeight}
  }), 'OCR bounding box evaluation timed out')
  assert(box && box.width>0 && box.y>0 && box.y+box.height<box.viewport, JSON.stringify(box))
  // Dispatch genuine pointer events without Playwright's HTML drag-interception path.
  const pointer=await context.newCDPSession(page)
  const x=box.x+.25, y=box.y+box.height/2
  await bounded(pointer.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none'}),'move to OCR line timed out')
  await bounded(pointer.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1}),'press in OCR line timed out')
  const end=box.x+box.width+.75
  await bounded(pointer.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:end,y,button:'left',buttons:1}),'drag across OCR line timed out')
  await bounded(pointer.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:end,y,button:'left',clickCount:1}),'release OCR line timed out')
  const selection=await bounded(page.evaluate(() => document.querySelector('.desk-editor.is-visible .fixed-page iframe').contentDocument.getSelection()?.toString()), 'OCR selection read timed out')
  assert.equal(selection,'Release Review Checklist')
  await page.screenshot({path:join(proof,'selected-OCR-text.png')})
  await page.keyboard.press('ControlOrMeta+c')
  await tool('查找全文').click()
  const pasteRegion=editor.getByRole('region',{name:'文档内容搜索'})
  const pasteTarget=pasteRegion.getByRole('searchbox')
  await pasteTarget.fill('')
  await pasteTarget.press('ControlOrMeta+v')
  await expect.poll(()=>pasteTarget.evaluate(input=>input.value==='Release Review Checklist')).toBe(true)
  await pasteRegion.getByRole('button',{name:'关闭搜索',exact:true}).click()
  await phrase.dblclick()
  const textEditor=sheet(0).getByRole('textbox',{name:'编辑文字',exact:true})
  await expect(textEditor).toBeVisible()
  await textEditor.fill('Release Review Approved')
  await textEditor.press('ControlOrMeta+Enter')
  await expect(p1.getByText('Release Review Approved',{exact:true})).toBeVisible()
  await editor.locator('.fixed-page').nth(2).scrollIntoViewIfNeeded()
  const rotatedLine=recognized(2).getByText(/^第二场.{1,3}训安排$/)
  await rotatedLine.dblclick()
  const rotatedEditor=sheet(2).getByRole('textbox',{name:'编辑文字',exact:true})
  await expect(rotatedEditor).toBeVisible()
  await rotatedEditor.fill('第二场培训安排')
  await rotatedEditor.press('ControlOrMeta+Enter')
  await expect(recognized(2).getByText('第二场培训安排',{exact:true})).toBeVisible()
  await page.reload()
  await editor.locator('.fixed-page').first().scrollIntoViewIfNeeded({timeout:45000})
  await expect(p1.getByText('Release Review Approved',{exact:true})).toBeVisible({timeout:45000})
  const result=await search('Release Review Approved')
  await expect(p1.getByText('Release Review Approved',{exact:true})).toHaveClass(/hcd-search-hit/)
  await result.getByRole('button',{name:'关闭搜索',exact:true}).click()
  step('OCR text was selected with the pointer, copied to the clipboard, corrected inline, saved, reloaded and searched.')
  await download('searchable-workshop.pdf')
  await upload('searchable-workshop.pdf')
  await expect(recognized(0,'source-ocr').filter({hasText:'Release Review Approved'})).toBeVisible({timeout:20000})
  const reopened=await search('第二场培训安排')
  await expect(reopened.getByRole('listitem')).toContainText('第 3 页')
  const reopenedTarget = recognized(2, 'source-ocr').filter({ hasText: '第二场培训安排' }).locator('[data-hcd-id]')
  await expect(reopenedTarget).toHaveClass(/hcd-search-hit/)
  await expect(reopenedTarget).toBeInViewport({ ratio: .5 })
  await page.screenshot({path:join(proof,'searchable-reopened.png')})
  await reopened.getByRole('button',{name:'关闭搜索',exact:true}).click()
  step('The source-backed PDF was downloaded, uploaded as a fresh file, and searched by its native invisible OCR layer.')
  assert.deepEqual(external, [])
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(patches.filter(p => p.payload.schemaVersion === 'hcd-patch/62').map(p => [p.code, p.payload.operations[0].pages[0].page]), [[200,1],[200,3],[200,2]])
  writeFileSync(join(proof, 'browser-verification.json'), JSON.stringify({ checks, traffic, external, pageErrors, patches }, null, 2))
}
