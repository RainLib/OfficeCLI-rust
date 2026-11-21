# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace.spec.ts >> XLSX batch input journal live retry keeps identity and new edits follow the epoch after undo
- Location: examples/hdoc/editor/e2e/workspace.spec.ts:625:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByLabel('选中单元格', { exact: true })
Expected: "B1"
Received: "A1"
Timeout:  20000ms

Call log:
  - Expect "toHaveText" getByLabel('选中单元格', { exact: true }) with timeout 20000ms
  - waiting for getByLabel('选中单元格', { exact: true })
    44 × locator resolved to <span aria-label="选中单元格" class="xlsx-formula-address">A1</span>
       - unexpected value "A1"

```

```yaml
- text: A1
```

# Test source

```ts
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
  646 |   await canvas.click({position:{x:180,y:35}})
  647 |   const nativeEditor=page.locator('.hcd-univer-host [id="__editor___INTERNAL_EDITOR__DOCS_NORMAL"]')
  648 |   await expect(nativeEditor).toBeFocused()
  649 |   // Canvas focus and its native selection context finish on the paint frame.
  650 |   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())))
  651 |   await nativeEditor.press('ArrowRight')
> 652 |   await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('B1')
      |                                                       ^ Error: expect(locator).toHaveText(expected) failed
  653 |   await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('2')
  654 |   await page.getByLabel('单元格内容或公式',{exact:true}).fill('11')
  655 |   await page.getByRole('button',{name:'应用内容',exact:true}).click()
  656 |   await expect.poll(async()=>(await manifest()).revision).toBe(3)
  657 |   expect(writes).toHaveLength(3);expect(writes[2].epoch).toBe('1')
  658 |   expect(writes[2].patch.baseRevision).toBe(2)
  659 |   await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('11')
  660 |   expect(await canvas.evaluate(element=>(window as any).retryCanvas===element)).toBe(true)
  661 |   await page.screenshot({path:info.outputPath('xlsx-batch-live-retry.png')})
  662 |   writeFileSync(info.outputPath('xlsx-batch-live-retry.json'),JSON.stringify({exactRetry:true,writes,revision:3,canvasPreserved:true},null,2))
  663 | })
  664 |
  665 | test('XLSX batch input journal remote refresh keeps a newer canvas selection while the index is in flight', async ({page,context},info) => {
  666 |   const id='grid-sync-selection'
  667 |   await open(page,id)
  668 |   const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  669 |   await expect(canvas).toBeVisible()
  670 |   await canvas.evaluate(element=>{(window as any).syncSelectionCanvas=element})
  671 |   const peer=await context.newPage()
  672 |   await open(peer,id)
  673 |   const peerCanvas=peer.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  674 |   await expect(peerCanvas).toBeVisible()
  675 |   await expect(peer.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  676 |   let held=false,released=false
  677 |   let release!:()=>void
  678 |   const heldResponse=new Promise<void>(resolve=>{release=resolve})
  679 |   await page.route(`**/v1/documents/${id}`,async route=>{
  680 |     if(!released) {held=true;await heldResponse}
  681 |     await route.continue()
  682 |   })
  683 |   try {
  684 |     await peerCanvas.click({position:{x:180,y:35}});await peer.keyboard.press('ArrowRight')
  685 |     await expect(peer.getByLabel('选中单元格',{exact:true})).toHaveText('B1')
  686 |     await peer.getByLabel('单元格内容或公式',{exact:true}).fill('9')
  687 |     await peer.getByRole('button',{name:'应用内容',exact:true}).click()
  688 |     await expect.poll(()=>held).toBe(true)
  689 |     await page.bringToFront()
  690 |     await canvas.click({position:{x:180,y:35}});await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight')
  691 |     await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('C1')
  692 |     const synced=page.waitForResponse(response=>response.url().endsWith(`/v1/documents/${id}/auth`))
  693 |     released=true;release()
  694 |     await synced
  695 |     await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('C1')
  696 |     await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('=LEN(A1)')
  697 |     expect(await canvas.evaluate(element=>(window as any).syncSelectionCanvas===element)).toBe(true)
  698 |     await page.screenshot({path:info.outputPath('xlsx-batch-inflight-selection.png')})
  699 |     writeFileSync(info.outputPath('xlsx-batch-inflight-selection.json'),JSON.stringify({delayedRemoteIndex:true,newerSelection:'C1',canvasPreserved:true,revision:1},null,2))
  700 |   } finally {released=true;release();await peer.close()}
  701 | })
  702 |
  703 | test('XLSX batch input journal storage failure blocks submission and allows full live download and discard', async ({page,context,request},info) => {
  704 |   const id = 'grid-batch-storage', writes: string[] = []
  705 |   await context.grantPermissions(['clipboard-read','clipboard-write'])
  706 |   await page.addInitScript(() => {
  707 |     const put = IDBObjectStore.prototype.put
  708 |     IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
  709 |       if (this.name === 'drafts' && this.transaction.db.name === 'hcd-input-drafts-v1') throw new DOMException('Batch storage failure','QuotaExceededError')
  710 |       return put.apply(this,args)
  711 |     }
  712 |   })
  713 |   page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/node-patch')) writes.push(req.url()) })
  714 |   await open(page,id)
  715 |   // Unlike the helper's successful durability check, this write must report failed protection.
  716 |   await page.evaluate(async () => { await navigator.clipboard.writeText('STORAGE_BATCH\t7\t=SUM(B1,2)\nother\tnew\t=B1*2') })
  717 |   const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  718 |   await expect(canvas).toBeVisible()
  719 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  720 |   await canvas.click({position:{x:180,y:35}}); await page.keyboard.press('ControlOrMeta+v')
  721 |   const pending = page.getByLabel('待保存的单元格修改',{exact:true})
  722 |   await expect(pending).toBeVisible()
  723 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','failed')
  724 |   expect(writes).toHaveLength(0)
  725 |   expect(await page.evaluate(() => { const e = new Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
  726 |   const downloaded = page.waitForEvent('download')
  727 |   await pending.getByRole('button',{name:'下载本地草稿',exact:true}).click()
  728 |   const local = JSON.parse(readFileSync((await (await downloaded).path())!,'utf8'))
  729 |   expect(local.changes).toHaveLength(6)
  730 |   expect(local.text).toContain('A1: STORAGE_BATCH')
  731 |   expect(local.patch.operations.some((op:{op:string}) => op.op === 'xlsx.formula.create')).toBe(true)
  732 |   // A rejected formula paste restores its checked display cache as well as its expression.
  733 |   await canvas.click({position:{x:180,y:35}})
  734 |   await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
  735 |   await expect.poll(async () => {
  736 |     await page.keyboard.press('ControlOrMeta+c')
  737 |     return page.evaluate(() => navigator.clipboard.readText())
  738 |   }).toBe('13')
  739 |   await page.screenshot({path:info.outputPath('xlsx-batch-storage.png')})
  740 |   await pending.getByRole('button',{name:'舍弃本地修改',exact:true}).click()
  741 |   await expect(pending).toHaveCount(0)
  742 |   const response = await request.get(`${apiUrl}/v1/documents/${id}`,{headers:{Authorization:`Bearer ${token(id,'inspector')}`}})
  743 |   expect((await response.json()).revision).toBe(0)
  744 |   expect(writes).toHaveLength(0)
  745 | })
  746 |
  747 | test('XLSX batch input journal keeps a corrupt intent downloadable and never sends it to review or apply', async ({page,context},info) => {
  748 |   const id = 'grid-batch-corrupt'
  749 |   await context.grantPermissions(['clipboard-read','clipboard-write'])
  750 |   await page.route('**/node-patch',route => route.abort('failed'))
  751 |   await open(page,id); await pasteDurableGridBatch(page)
  752 |   await page.close({runBeforeUnload:false})
```
