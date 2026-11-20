import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { expect } from '../editor/node_modules/@playwright/test/index.mjs'

/** A browser crash must retain a copied slide's unsubmitted note and owner. */
export async function verifySlideNoteDraft(browser, site, output, checks) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
  let page = await context.newPage()
  try {
    await page.goto(site + '/workbench/?ai=0')
    await page.locator('.desk-home-main input[type="file"]').setInputFiles(resolve(import.meta.dirname, 'fixtures/notes-chart.pptx'))
    await expect(page.getByRole('tab', { name: 'notes-chart.pptx', exact: true })).toHaveAttribute('aria-selected', 'true')
    let editor = page.locator('.desk-editor.is-visible')
    const button = name => editor.getByRole('button', { name, exact: true })
    await expect(editor.locator('.fixed-pages > .fixed-page')).toHaveCount(2)
    await button('开始').click()
    await button('复制本页').click()
    await expect(editor.locator('.fixed-pages > .fixed-page')).toHaveCount(3)
    await button('视图').click()
    await editor.getByRole('checkbox', { name: '幻灯片列表', exact: true }).check()
    await editor.getByRole('button', { name: '幻灯片 2', exact: true }).click()
    await button('演讲者备注').click()
    let notes = editor.getByRole('complementary', { name: '演讲者备注', exact: true })
    await notes.getByRole('button', { name: /编辑备注：/ }).first().click()
    const text = notes.getByRole('textbox', { name: '编辑文字', exact: true })
    const marker = '副本中尚未发送的备注草稿'
    await context.setOffline(true)
    await text.fill(marker)
    await expect(editor.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
    const url = page.url()
    assert(new URL(url).searchParams.get('file'), '工作台没有记录当前文件')
    await page.close({ runBeforeUnload: false })
    await context.setOffline(false)
    page = await context.newPage()
    await page.goto(url)
    editor = page.locator('.desk-editor.is-visible')
    const retained = editor.getByLabel('保留的未提交输入', { exact: true })
    await expect(retained).toBeVisible({ timeout: 45000 })
    await retained.locator('summary').click()
    await expect(retained.getByRole('textbox')).toContainText(marker)
    let writes = 0
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/node-patch')) writes++ })
    await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
    notes = editor.getByRole('complementary', { name: '演讲者备注', exact: true })
    await expect(notes).toContainText('演讲者备注 · 2')
    const restored = notes.getByRole('textbox', { name: '编辑文字', exact: true })
    await expect(restored).toHaveText(marker)
    assert.equal(writes, 0, '恢复草稿不应自动提交')
    await page.screenshot({ path: join(output, 'pptx-note-draft-restored.png') })
    await restored.press('ControlOrMeta+Enter')
    await expect(notes.getByRole('button', { name: /编辑备注：/ }).first()).toHaveText(marker)
    assert.equal(writes, 1)
    checks.push('A copied slide note survived offline browser closure; recovery reopened its owning slide without writing, then one explicit save committed the draft.')
  } finally {
    await context.setOffline(false).catch(() => {})
    await context.close()
  }
}
