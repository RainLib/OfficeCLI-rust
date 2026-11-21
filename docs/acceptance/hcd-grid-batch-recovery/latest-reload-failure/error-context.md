# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace.spec.ts >> grid input journal keeps unapplied text bound to its cell across selections and page closure
- Location: examples/hdoc/editor/e2e/workspace.spec.ts:2452:1

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator: getByLabel('单元格内容或公式', { exact: true })
Expected: "=SUM(B1:B2)*2"
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toHaveValue" getByLabel('单元格内容或公式', { exact: true }) with timeout 20000ms
  - waiting for getByLabel('单元格内容或公式', { exact: true })

```

```yaml
- main:
  - complementary "工作空间导航":
    - strong: office.
    - button "收起导航" [expanded]
    - text: O 我的工作空间
    - navigation:
      - button "所有文档 0"
      - button "已打开的文档 0"
      - button "连接文档"
      - button "导入 HCD"
    - text: O OfficeCLI 文档工作空间
  - text: 工作空间所有文档
  - textbox "搜索文档":
    - /placeholder: 搜索文档名称或格式
  - combobox "界面主题":
    - option "跟随系统" [selected]
    - option "浅色"
    - option "深色"
  - text: 语言
  - combobox "语言":
    - option "English (US)"
    - option "English (UK)"
    - option "简体中文" [selected]
    - option "繁體中文（台灣）"
    - option "繁體中文（香港）"
  - heading "所有文档" [level=1]
  - paragraph: 让文档、想法与协作，留在同一个工作空间。
  - button "连接 / 导入文档"
  - navigation "文档格式筛选":
    - button "全部" [pressed]
    - button "DOCX"
    - button "XLSX"
    - button "PPTX"
    - button "PDF"
    - button "MD"
    - button "HTML"
    - button "TXT"
    - button "PNG"
    - button "JPG"
    - button "WEBP"
  - table "文档列表":
    - row "名称 格式 访问权限":
      - columnheader "名称"
      - columnheader "格式"
      - columnheader "访问权限"
  - heading "在这里开始你的工作" [level=2]
  - paragraph: 连接已有文档，或导入 HCD 文件。
  - button "连接文档"
  - group:
    - text: 连接文档 / 导入 HCD
    - region "待恢复的文档":
      - heading "待恢复的文档" [level=3]
      - strong: grid-draft-reopen
      - status: 暂时无法恢复文档，请重试连接。
      - button "重新连接"
      - button "重试"
      - button "移除"
    - paragraph: 输入文档 ID 和短期访问令牌。只读令牌无法提交修改。
    - text: 文档 ID
    - textbox "文档 ID":
      - /placeholder: doc-…
      - text: grid-draft-reopen
    - text: 访问令牌
    - textbox "访问令牌":
      - /placeholder: 粘贴短期令牌
      - text: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkb2MiOiJncmlkLWRyYWZ0LXJlb3BlbiIsInNjb3BlIjoid3JpdGUiLCJzdWIiOiJicm93c2VyLXVzZXIiLCJuYW1lIjoiYnJvd3Nlci11c2VyIiwiYXVkIjoiaGNkLWNvcmUiLCJpYXQiOjE3OTQ3OTgzMzQsImV4cCI6MTc5NDgwMTkzNH0.-XgQcxsYrS4R9S0d1BwscI2w2gS7KPaiRaNtAD3E0P8
    - button "打开文档"
    - paragraph: 重新打开HCD 或独立图片。上传令牌用于导入。
    - text: HCD / 图片文件
    - button "HCD / 图片文件"
    - text: 上传令牌
    - textbox "上传令牌":
      - /placeholder: 粘贴短期上传令牌
    - button "导入文档 / 图片" [disabled]
  - text: 支持 DOCX、XLSX、PPTX、PDF、HTML、Markdown、TXT 和 PNG / JPEG / WebP 0 个文档
```

# Test source

```ts
  2386 |     await active.getByRole('button',{name:'放大文档',exact:true}).click({clickCount:3})
  2387 |     await expect(active.locator('.canvas-viewport')).toHaveAttribute('data-canvas-zoom','1.3')
  2388 |     await active.getByRole('button',{name:'专注模式',exact:true}).click()
  2389 |     const apply=async(label:string)=>{
  2390 |       const projection=(await call(client,'hcd_read',{document_id:id,resource:'editor'})).data
  2391 |       const auth=(await call(client,'hcd_read',{document_id:id,resource:'auth'})).data
  2392 |       const block=projection.blocks.find((block:{region:string;readOnly:boolean})=>block.region==='body'&&!block.readOnly)
  2393 |       const result=await call(client,'hcd_patch',{document_id:id,mode:'structure',expected_revision:projection.revision,collaboration_epoch:auth.collaborationEpoch,patch:{schemaVersion:'hcd-patch/4',documentId:id,patchId:label.replaceAll(' ','-'),baseRevision:projection.revision,operations:[{op:'block.replace',blockId:block.blockId,block:{...block.content,inlines:[{text:label}]},precondition:{blockHash:block.blockHash}}]}})
  2394 |       expect(result.error).toBe(false)
  2395 |     }
  2396 |     await apply('First remote view update')
  2397 |     await expect(active.locator('.hcd-editor-body')).toContainText('First remote view update')
  2398 |     await expect(active.locator('.hcd-editor-body')).toHaveAttribute('contenteditable','false')
  2399 |     await expect(active.locator('.workspace')).toHaveClass(/focus-mode/)
  2400 |     await expect(active.locator('.canvas-viewport')).toHaveAttribute('data-canvas-zoom','1.3')
  2401 |     await expect(active.locator('.mode-switch').getByRole('button',{name:'预览',exact:true})).toHaveAttribute('aria-pressed','true')
  2402 |     await active.getByRole('button',{name:'退出专注模式',exact:true}).click()
  2403 |     await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  2404 |     await active.locator(`.history button[data-revision="${initial.revision}"]`).click()
  2405 |     await active.locator('.revision-workspace').getByRole('button',{name:'对比当前',exact:true}).click()
  2406 |     await expect(active.locator('.revision-column').last()).toContainText('First remote view update')
  2407 |     await apply('Second remote view update')
  2408 |     await expect(active.locator('.revision-column').last()).toContainText('Second remote view update')
  2409 |     await expect(active.locator('.revision-column').first()).toContainText('First paragraph')
  2410 |     await expect(active.locator('.revision-scroll')).toHaveAttribute('data-canvas-zoom','1.3')
  2411 |     await expect(active.locator(`.history button[data-revision="${initial.revision}"]`)).toHaveAttribute('aria-pressed','true')
  2412 |     await page.screenshot({path:info.outputPath('comparison-after-agent-commit.png')})
  2413 |     await active.locator('.revision-workspace').getByRole('button',{name:'返回当前',exact:true}).click()
  2414 |     await expect(active.locator('main.document .hcd-editor-body')).toHaveAttribute('contenteditable','false')
  2415 |     await expect(active.locator('main.document .hcd-editor-body')).toContainText('Second remote view update')
  2416 |     await expect(active.locator('.canvas-viewport')).toHaveAttribute('data-canvas-zoom','1.3')
  2417 |   } finally {await client.close()}
  2418 | })
  2419 |
  2420 | test('history uses the selected outline and closes the mobile drawer after selection', async ({page},info) => {
  2421 |   const id='history-outline',headers={Authorization:`Bearer ${token(id,'outline-author')}`}
  2422 |   const get=async(path:string)=>(await fetch(`${apiUrl}/v1/documents/${id}${path}`,{headers})).json()
  2423 |   const imported=await get('/editor')
  2424 |   const projected=await fetch(`${apiUrl}/v1/documents/${id}/project`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:imported.revision})})
  2425 |   expect(projected.ok,await projected.text()).toBe(true)
  2426 |   const baseline=await get('/editor'),auth=await get('/auth')
  2427 |   const blocks=baseline.blocks.filter((block:{region:string})=>block.region==='body').map((block:{blockId:string;content:{kind:string}})=>({blockId:block.blockId,content:block.content.kind==='heading'?{...block.content,inlines:[{text:'Updated current heading'}]}:block.content}))
  2428 |   const saved=await fetch(`${apiUrl}/v1/documents/${id}/checkpoints`,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-HCD-Collaboration-Epoch':String(auth.collaborationEpoch)},body:JSON.stringify({expectedRevision:baseline.revision,blocks})})
  2429 |   expect(saved.ok,await saved.text()).toBe(true)
  2430 |   await open(page,id,'read')
  2431 |   const active=page.locator('.document-tab-panel:not([hidden])')
  2432 |   await expect(active.locator('.outline-panel nav')).toContainText('Updated current heading')
  2433 |   await active.getByRole('button',{name:'修订历史',exact:true}).first().click()
  2434 |   await active.locator(`.history button[data-revision="${baseline.revision}"]`).click()
  2435 |   await expect(active.locator('.outline-panel nav')).toContainText('Markdown workspace')
  2436 |   await expect(active.locator('.outline-panel nav')).not.toContainText('Updated current heading')
  2437 |   await active.locator('.outline-panel nav').getByRole('button',{name:'Markdown workspace',exact:true}).click()
  2438 |   await expect(active.locator('.revision-paper .history-search-hit')).toContainText('Markdown workspace')
  2439 |   await expect(active.locator('.revision-preview-title')).toContainText('outline-author')
  2440 |   await active.locator('.revision-workspace').getByRole('button',{name:'返回当前',exact:true}).click()
  2441 |   await expect(active.locator('.outline-panel nav')).toContainText('Updated current heading')
  2442 |   await active.getByRole('button',{name:'收起左侧面板',exact:true}).click()
  2443 |   await page.setViewportSize({width:390,height:844})
  2444 |   await active.locator(`.history button[data-revision="${baseline.revision}"]`).click()
  2445 |   await expect(active.locator('.workspace-sidebar:visible')).toHaveCount(0)
  2446 |   await expect(active.locator('.revision-paper')).toContainText('Markdown workspace')
  2447 |   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  2448 |   await page.screenshot({path:info.outputPath('phone-history-selection.png')})
  2449 | })
  2450 |
  2451 |
  2452 | test('grid input journal keeps unapplied text bound to its cell across selections and page closure', async ({page, context, request}, info) => {
  2453 |   const id = 'grid-draft-reopen', expression = '=SUM(B1:B2)*2'
  2454 |   const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  2455 |   await open(page, id)
  2456 |   const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  2457 |   await expect(canvas).toBeVisible()
  2458 |   const field = page.getByLabel('单元格内容或公式', { exact: true })
  2459 |   await expect(field).toHaveValue('=LEN("中文")')
  2460 |   await context.setOffline(true)
  2461 |   await field.fill(expression)
  2462 |   await canvas.click({ position: { x: 144, y: 30 } })
  2463 |   await expect(field).toHaveValue(expression)
  2464 |   await expect(page.getByLabel('未应用输入位置', { exact: true })).toHaveText('Sheet1!A1')
  2465 |   expect((await field.boundingBox())!.width).toBeGreaterThan(150)
  2466 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2467 |   await page.close({ runBeforeUnload: false }); await context.setOffline(false)
  2468 |   const reopened = await context.newPage()
  2469 |   await open(reopened, id)
  2470 |   const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  2471 |   await retained.locator('summary').click()
  2472 |   const restoredCanvas = reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  2473 |   await expect(restoredCanvas).toBeVisible()
  2474 |   await restoredCanvas.evaluate(element => { (window as any).__restoredGridCanvas = element })
  2475 |   await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  2476 |   const restored = reopened.getByLabel('单元格内容或公式', { exact: true })
  2477 |   await expect(restored).toHaveValue(expression)
  2478 |   expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
  2479 |   await reopened.screenshot({ path: info.outputPath('grid-unapplied-recovered.png') })
  2480 |   await reopened.getByRole('button', { name: '应用内容', exact: true }).click()
  2481 |   await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(1)
  2482 |   await expect(reopened.getByLabel('未应用输入位置', { exact: true })).toHaveCount(0)
  2483 |   expect(await restoredCanvas.evaluate(element => (window as any).__restoredGridCanvas === element)).toBe(true)
  2484 |   await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2485 |   await reopened.reload()
> 2486 |   await expect(reopened.getByLabel('单元格内容或公式', { exact: true })).toHaveValue(expression)
       |                                                                  ^ Error: expect(locator).toHaveValue(expected) failed
  2487 |   await expect(reopened.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0)
  2488 | })
  2489 |
  2490 | test('grid input journal protects native cell typing before confirmation and restores it into the formula field', async ({page, context, request}) => {
  2491 |   const id = 'grid-draft-cell', marker = 'NATIVE_UNCONFIRMED_INPUT'
  2492 |   await open(page, id)
  2493 |   const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  2494 |   await expect(canvas).toBeVisible()
  2495 |   await canvas.dblclick({ position: { x: 144, y: 30 } })
  2496 |   await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(marker)
  2497 |   await expect(page.getByLabel('单元格内容或公式', { exact: true })).toHaveValue(marker)
  2498 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2499 |   await page.close({ runBeforeUnload: false })
  2500 |   const reopened = await context.newPage()
  2501 |   await open(reopened, id)
  2502 |   const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  2503 |   await retained.locator('summary').click()
  2504 |   await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  2505 |   await expect(reopened.getByLabel('单元格内容或公式', { exact: true })).toHaveValue(marker)
  2506 |   await expect(reopened.getByLabel('未应用输入位置', { exact: true })).toContainText('!B1')
  2507 |   const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  2508 |   expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
  2509 |   await reopened.getByRole('button', { name: '取消输入', exact: true }).click()
  2510 |   await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2511 |   await reopened.reload()
  2512 |   const refreshedCanvas = reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  2513 |   await expect(refreshedCanvas).toBeVisible()
  2514 |   await expect(reopened.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0)
  2515 |   await refreshedCanvas.dblclick({ position: { x: 144, y: 30 } })
  2516 |   await reopened.keyboard.press('ControlOrMeta+A'); await reopened.keyboard.insertText('7')
  2517 |   await reopened.keyboard.press('Enter')
  2518 |   await expect.poll(async () => (await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(1)
  2519 |   await expect(reopened.getByLabel('未应用输入位置', { exact: true })).toHaveCount(0)
  2520 |   await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2521 |   await reopened.reload()
  2522 |   await expect(reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()).toBeVisible()
  2523 |   await expect(reopened.getByLabel('保留的未提交输入', { exact: true })).toHaveCount(0)
  2524 | })
  2525 |
  2526 | test('grid input journal leaves changed workbooks untouched and retains the original expression', async ({page, context, request}) => {
  2527 |   const id = 'grid-draft-stale', marker = '=SUM(B1:B2)*2'
  2528 |   const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  2529 |   await open(page, id)
  2530 |   await expect(page.getByLabel('单元格内容或公式', { exact: true })).toHaveValue('=LEN("中文")')
  2531 |   await page.getByLabel('单元格内容或公式', { exact: true }).fill(marker)
  2532 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2533 |   await page.close({ runBeforeUnload: false })
  2534 |   const sheet = await (await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`, { headers })).json()
  2535 |   const node = sheet.cells.find((cell: { address: string }) => cell.address === 'B1')
  2536 |   const saved = await request.post(`${apiUrl}/v1/documents/${id}/node-patch`, { headers, data: {
  2537 |     schemaVersion: 'hcd-patch/29', documentId: id, patchId: 'remote-before-draft-recovery', baseRevision: 0,
  2538 |     operations: [{ op: 'xlsx.number.set', nodeId: node.nodeId, sheetId: sheet.sheetId, value: '9', precondition: { nodeHash: node.nodeHash } }],
  2539 |   } })
  2540 |   expect(saved.ok(), await saved.text()).toBe(true)
  2541 |   const reopened = await context.newPage()
  2542 |   await open(reopened, id)
  2543 |   const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  2544 |   await retained.locator('summary').click()
  2545 |   await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  2546 |   await expect(reopened.locator('.toast.error')).toContainText('文档版本已变化')
  2547 |   await expect(retained.getByRole('textbox')).toContainText(marker)
  2548 |   await expect(reopened.getByLabel('单元格内容或公式', { exact: true })).toHaveValue('=LEN("中文")')
  2549 |   expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(1)
  2550 | })
  2551 |
  2552 | test('fixed input journal restores closed offline text once without submitting it or rebuilding its canvas', async ({page, context, request}, info) => {
  2553 |   const id = 'fixed-draft-reopen', marker = 'CLOSED_FIXED_INPUT_🙂'
  2554 |   await open(page, id)
  2555 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2556 |   await page.locator('.fixed-page-hitbox').first().click()
  2557 |   const text = page.locator('.fixed-pages iframe').first().contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })
  2558 |   await context.setOffline(true)
  2559 |   await text.fill(marker)
  2560 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2561 |   await page.close({ runBeforeUnload: false }); await context.setOffline(false)
  2562 |   const reopened = await context.newPage()
  2563 |   await open(reopened, id)
  2564 |   const retained = reopened.getByLabel('保留的未提交输入', { exact: true })
  2565 |   await expect(retained).toHaveCount(1)
  2566 |   await retained.locator('summary').click()
  2567 |   await expect(retained.getByRole('textbox')).toContainText(marker)
  2568 |   const frame = reopened.locator('.fixed-pages iframe').first()
  2569 |   await expect(frame).toBeVisible()
  2570 |   await frame.evaluate(element => { (window as any).__fixedDraftFrame = element })
  2571 |   let patches = 0
  2572 |   reopened.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/node-patch')) patches++ })
  2573 |   await retained.getByRole('button', { name: '恢复输入', exact: true }).click()
  2574 |   const restored = frame.contentFrame().getByRole('textbox', { name: '编辑文字', exact: true })
  2575 |   await expect(restored).toHaveText(marker)
  2576 |   expect(patches).toBe(0)
  2577 |   expect(await frame.evaluate(element => (window as any).__fixedDraftFrame === element)).toBe(true)
  2578 |   const headers = { Authorization: `Bearer ${token(id, 'draft-inspector')}` }
  2579 |   expect((await (await request.get(`${apiUrl}/v1/documents/${id}`, { headers })).json()).revision).toBe(0)
  2580 |   await reopened.screenshot({ path: info.outputPath('fixed-text-recovered-input.png') })
  2581 |   await restored.press('ControlOrMeta+Enter')
  2582 |   await expect(restored).toHaveCount(0)
  2583 |   await expect(reopened.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection', 'protected')
  2584 |   expect(patches).toBe(1)
  2585 |   await reopened.reload()
  2586 |   await expect(reopened.locator('.fixed-pages iframe').first().contentFrame().locator('body')).toContainText(marker)
```
