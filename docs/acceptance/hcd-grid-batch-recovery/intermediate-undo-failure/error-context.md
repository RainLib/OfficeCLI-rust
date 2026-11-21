# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace.spec.ts >> XLSX batch input journal live retry keeps identity and new edits follow the epoch after undo
- Location: e2e/workspace.spec.ts:625:1

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator:  getByLabel('单元格内容或公式', { exact: true })
Expected: "2"
Received: "中文😀 normal 斜体"
Timeout:  20000ms

Call log:
  - Expect "toHaveValue" getByLabel('单元格内容或公式', { exact: true }) with timeout 20000ms
  - waiting for getByLabel('单元格内容或公式', { exact: true })
    44 × locator resolved to <input maxlength="100000" aria-label="单元格内容或公式" value="中文😀 normal 斜体" placeholder="输入文字、数字或 =SUM(A1:A10)" id="xlsx-formula-expression-grid-batch-live"/>
       - unexpected value "中文😀 normal 斜体"

```

```yaml
- textbox "单元格内容或公式":
  - /placeholder: 输入文字、数字或 =SUM(A1:A10)
  - text: 中文😀 normal 斜体
```

# Test source

```ts
  547 |       expect(saved.ok(), await saved.text()).toBe(true)
  548 |     }
  549 |     await route.abort('failed')
  550 |   })
  551 |   await open(page,id)
  552 |   const pending = await pasteDurableGridBatch(page)
  553 |   expect(submitted).toBe(1)
  554 |   expect((await manifest()).revision).toBe(outcome === 'lost' ? 1 : 0)
  555 |   const download = page.waitForEvent('download')
  556 |   await pending.getByRole('button',{name:'下载本地草稿',exact:true}).click()
  557 |   const local = JSON.parse(readFileSync((await (await download).path())!, 'utf8'))
  558 |   expect(local.patch).toEqual(originalPatch)
  559 |   expect(local.changes).toHaveLength(6)
  560 |   if (outcome === 'ready') await context.setOffline(true)
  561 |   await page.close({runBeforeUnload:false})
  562 |   if (outcome === 'ready') await context.setOffline(false)
  563 |   if (outcome !== 'ready') {
  564 |     // A later collaborator revision must not turn a lost receipt into a replay.
  565 |     const sheet = await (await request.get(`${apiUrl}/v1/documents/${id}/sheets/0`,{headers})).json()
  566 |     const b1 = sheet.cells.find((c:{address:string}) => c.address === 'B1')
  567 |     const peer = await request.post(`${apiUrl}/v1/documents/${id}/node-patch`, {headers, data: {
  568 |       schemaVersion:'hcd-patch/29',documentId:id,patchId:`peer-after-${outcome}`,baseRevision:(await manifest()).revision,
  569 |       operations:[{op:'xlsx.number.set',nodeId:b1.nodeId,sheetId:sheet.sheetId,value:'9',precondition:{nodeHash:b1.nodeHash}}],
  570 |     }})
  571 |     expect(peer.ok(),await peer.text()).toBe(true)
  572 |   }
  573 |   if (outcome !== 'stale') {
  574 |     // Restart only the temporary test API, retaining its root and service identity.
  575 |     const exited = new Promise<void>(resolve => apiProcess.once('exit', () => resolve()))
  576 |     if (process.platform !== 'win32') process.kill(-apiProcess.pid!, 'SIGKILL'); else apiProcess.kill('SIGKILL')
  577 |     await exited
  578 |     apiProcess = start(binary,['hdoc','serve','--root',resolve(root,'service'),'--bind',`127.0.0.1:${new URL(apiUrl).port}`],serviceEnvironment)
  579 |     await ready(`${apiUrl}/health`)
  580 |   }
  581 |   const reopened = await context.newPage()
  582 |   const replayed: any[] = []
  583 |   reopened.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/node-patch')) replayed.push(req.postDataJSON()) })
  584 |   await open(reopened,id)
  585 |   const canvas = reopened.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  586 |   await expect(canvas).toBeVisible()
  587 |   await canvas.evaluate(element => { (window as any).batchCanvas = element })
  588 |   const retained = reopened.getByLabel('保留的未提交输入',{exact:true})
  589 |   await expect(retained).toHaveCount(1)
  590 |   await retained.locator('summary').click()
  591 |   await expect(retained.getByRole('textbox')).toHaveValue(local.text)
  592 |   await retained.getByRole('button',{name:'恢复输入',exact:true}).click()
  593 |   if (outcome === 'ready') {
  594 |     const restored = reopened.getByLabel('待保存的单元格修改',{exact:true})
  595 |     await expect(restored).toBeVisible()
  596 |     expect(replayed).toHaveLength(0)
  597 |     expect((await manifest()).revision).toBe(0)
  598 |     await restored.getByRole('button',{name:'核对并提交',exact:true}).click()
  599 |     await expect(restored).toHaveCount(0)
  600 |     expect(replayed).toEqual([originalPatch])
  601 |     expect((await manifest()).revision).toBe(1)
  602 |     await expect(reopened.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('新😀 normal')
  603 |     // Numeric and formula cells must reconcile too; optimistic values were lost with the old page.
  604 |     await canvas.click({position:{x:180,y:35}}); await reopened.keyboard.press('ArrowRight')
  605 |     await expect(reopened.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('7')
  606 |     await reopened.keyboard.press('ArrowRight')
  607 |     await expect(reopened.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('=SUM(B1,2)')
  608 |   } else if (outcome === 'lost') {
  609 |     await expect(retained).toHaveCount(0)
  610 |     await expect(reopened.getByLabel('待保存的单元格修改',{exact:true})).toHaveCount(0)
  611 |     expect(replayed).toHaveLength(0)
  612 |     expect((await manifest()).revision).toBe(2)
  613 |   } else {
  614 |     await expect(reopened.locator('.toast.error')).toContainText('文档版本或提交回执不一致')
  615 |     await expect(retained).toHaveCount(1)
  616 |     expect(replayed).toHaveLength(0)
  617 |     expect((await manifest()).revision).toBe(1)
  618 |     await expect(retained.getByRole('button',{name:'下载本地草稿',exact:true})).toBeEnabled()
  619 |   }
  620 |   expect(await canvas.evaluate(element => (window as any).batchCanvas === element)).toBe(true)
  621 |   await reopened.screenshot({path:info.outputPath(`xlsx-batch-${outcome}.png`)})
  622 |   writeFileSync(info.outputPath(`xlsx-batch-${outcome}.json`),JSON.stringify({outcome,exactPatch:originalPatch,local,originalPosts:submitted,replayedPosts:replayed.length,revision:(await manifest()).revision,canvasPreserved:true},null,2))
  623 | })
  624 |
  625 | test('XLSX batch input journal live retry keeps identity and new edits follow the epoch after undo', async ({page,context,request},info) => {
  626 |   const id='grid-batch-live',headers={Authorization:`Bearer ${token(id,'batch-inspector')}`}
  627 |   const manifest=async()=>(await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()
  628 |   const writes:Array<{patch:any;epoch:string|null}>=[]
  629 |   page.on('request',req=>{if(req.method()==='POST'&&req.url().endsWith('/node-patch'))writes.push({patch:req.postDataJSON(),epoch:req.headers()['x-hcd-collaboration-epoch']??null})})
  630 |   await context.grantPermissions(['clipboard-read','clipboard-write'])
  631 |   await page.route('**/node-patch',route=>route.abort('failed'))
  632 |   await open(page,id)
  633 |   const pending=await pasteDurableGridBatch(page)
  634 |   const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  635 |   await canvas.evaluate(element=>{(window as any).retryCanvas=element})
  636 |   await page.unroute('**/node-patch')
  637 |   await pending.getByRole('button',{name:'核对并提交',exact:true}).click()
  638 |   await expect(pending).toHaveCount(0)
  639 |   await expect.poll(async()=>(await manifest()).revision).toBe(1)
  640 |   expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0])
  641 |   await expect(page.getByRole('button',{name:'↶ 撤销',exact:true})).toBeEnabled()
  642 |   await page.getByRole('button',{name:'↶ 撤销',exact:true}).click()
  643 |   await expect.poll(async()=>(await manifest()).revision).toBe(2)
  644 |   await expect(page.getByRole('button',{name:'↷ 重做',exact:true})).toBeEnabled()
  645 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  646 |   await canvas.click({position:{x:180,y:35}});await page.keyboard.press('ArrowRight')
> 647 |   await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('2')
      |                                                          ^ Error: expect(locator).toHaveValue(expected) failed
  648 |   await page.getByLabel('单元格内容或公式',{exact:true}).fill('11')
  649 |   await page.getByRole('button',{name:'应用内容',exact:true}).click()
  650 |   await expect.poll(async()=>(await manifest()).revision).toBe(3)
  651 |   expect(writes).toHaveLength(3);expect(writes[2].epoch).toBe('1')
  652 |   expect(writes[2].patch.baseRevision).toBe(2)
  653 |   await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('11')
  654 |   expect(await canvas.evaluate(element=>(window as any).retryCanvas===element)).toBe(true)
  655 |   await page.screenshot({path:info.outputPath('xlsx-batch-live-retry.png')})
  656 |   writeFileSync(info.outputPath('xlsx-batch-live-retry.json'),JSON.stringify({exactRetry:true,writes,revision:3,canvasPreserved:true},null,2))
  657 | })
  658 |
  659 | test('XLSX batch input journal storage failure blocks submission and allows full live download and discard', async ({page,context,request},info) => {
  660 |   const id = 'grid-batch-storage', writes: string[] = []
  661 |   await context.grantPermissions(['clipboard-read','clipboard-write'])
  662 |   await page.addInitScript(() => {
  663 |     const put = IDBObjectStore.prototype.put
  664 |     IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
  665 |       if (this.name === 'drafts' && this.transaction.db.name === 'hcd-input-drafts-v1') throw new DOMException('Batch storage failure','QuotaExceededError')
  666 |       return put.apply(this,args)
  667 |     }
  668 |   })
  669 |   page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/node-patch')) writes.push(req.url()) })
  670 |   await open(page,id)
  671 |   // Unlike the helper's successful durability check, this write must report failed protection.
  672 |   await page.evaluate(async () => { await navigator.clipboard.writeText('STORAGE_BATCH\t7\t=SUM(B1,2)\nother\tnew\t=B1*2') })
  673 |   const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  674 |   await expect(canvas).toBeVisible()
  675 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  676 |   await canvas.click({position:{x:180,y:35}}); await page.keyboard.press('ControlOrMeta+v')
  677 |   const pending = page.getByLabel('待保存的单元格修改',{exact:true})
  678 |   await expect(pending).toBeVisible()
  679 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','failed')
  680 |   expect(writes).toHaveLength(0)
  681 |   expect(await page.evaluate(() => { const e = new Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
  682 |   const downloaded = page.waitForEvent('download')
  683 |   await pending.getByRole('button',{name:'下载本地草稿',exact:true}).click()
  684 |   const local = JSON.parse(readFileSync((await (await downloaded).path())!,'utf8'))
  685 |   expect(local.changes).toHaveLength(6)
  686 |   expect(local.text).toContain('A1: STORAGE_BATCH')
  687 |   expect(local.patch.operations.some((op:{op:string}) => op.op === 'xlsx.formula.create')).toBe(true)
  688 |   // A rejected formula paste restores its checked display cache as well as its expression.
  689 |   await canvas.click({position:{x:180,y:35}})
  690 |   await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
  691 |   await expect.poll(async () => {
  692 |     await page.keyboard.press('ControlOrMeta+c')
  693 |     return page.evaluate(() => navigator.clipboard.readText())
  694 |   }).toBe('13')
  695 |   await page.screenshot({path:info.outputPath('xlsx-batch-storage.png')})
  696 |   await pending.getByRole('button',{name:'舍弃本地修改',exact:true}).click()
  697 |   await expect(pending).toHaveCount(0)
  698 |   const response = await request.get(`${apiUrl}/v1/documents/${id}`,{headers:{Authorization:`Bearer ${token(id,'inspector')}`}})
  699 |   expect((await response.json()).revision).toBe(0)
  700 |   expect(writes).toHaveLength(0)
  701 | })
  702 |
  703 | test('XLSX batch input journal keeps a corrupt intent downloadable and never sends it to review or apply', async ({page,context},info) => {
  704 |   const id = 'grid-batch-corrupt'
  705 |   await context.grantPermissions(['clipboard-read','clipboard-write'])
  706 |   await page.route('**/node-patch',route => route.abort('failed'))
  707 |   await open(page,id); await pasteDurableGridBatch(page)
  708 |   await page.close({runBeforeUnload:false})
  709 |   const reopened = await context.newPage()
  710 |   await reopened.goto(`${uiUrl}/?locale=zh-CN`)
  711 |   await reopened.evaluate(async id => {
  712 |     const db = await new Promise<IDBDatabase>((resolve,reject) => { const r = indexedDB.open('hcd-input-drafts-v1'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error) })
  713 |     await new Promise<void>((resolve,reject) => {
  714 |       const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),r=store.getAll()
  715 |       r.onsuccess=()=>{ for(const record of r.result) if(record.documentId===id) { const content=JSON.parse(record.content);content.changes[0].column=-1;store.put({...record,content:JSON.stringify(content)}) } }
  716 |       tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error)
  717 |     });db.close()
  718 |   },id)
  719 |   const writes: string[] = []
  720 |   reopened.on('request',req=>{if(req.method()==='POST'&&/\/node-patch(?:-review)?$/.test(req.url()))writes.push(req.url())})
  721 |   await open(reopened,id)
  722 |   const retained=reopened.getByLabel('保留的未提交输入',{exact:true})
  723 |   await expect(retained).toHaveCount(1);await retained.locator('summary').click()
  724 |   await retained.getByRole('button',{name:'恢复输入',exact:true}).click()
  725 |   await expect(reopened.locator('.toast.error')).toContainText('无法安全恢复')
  726 |   await expect(retained.getByRole('button',{name:'下载本地草稿',exact:true})).toBeEnabled()
  727 |   expect(writes).toHaveLength(0)
  728 |   await reopened.screenshot({path:info.outputPath('xlsx-batch-corrupt.png')})
  729 | })
  730 |
  731 | test('XLSX rich input journal recovers uncommitted selection formatting after offline page closure', async ({page,context,request}, info) => {
  732 |   const id='rich-draft', headers={Authorization:`Bearer ${token(id,'draft-reader')}`}
  733 |   await open(page,id)
  734 |   const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  735 |   await expect(canvas).toBeVisible()
  736 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  737 |   await context.setOffline(true)
  738 |   await canvas.dblclick({position:{x:180,y:35}})
  739 |   await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('ArrowLeft')
  740 |   for(let i=0;i<4;i++) await page.keyboard.press('ArrowRight')
  741 |   for(let i=0;i<6;i++) await page.keyboard.press('Shift+ArrowRight')
  742 |   await page.getByRole('button',{name:'加粗',exact:true}).click()
  743 |   await expect(page.getByLabel('未应用输入位置',{exact:true})).toContainText('A1')
  744 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  745 |   await page.close({runBeforeUnload:false}); await context.setOffline(false)
  746 |   expect((await (await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(0)
  747 |   const reopened=await context.newPage(); await open(reopened,id)
```
