# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace.spec.ts >> XLSX batch input journal remote refresh keeps a newer canvas selection while the index is in flight
- Location: e2e/workspace.spec.ts:661:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByLabel('选中单元格', { exact: true })
Expected: "C1"
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
  647 |   await page.keyboard.press('ArrowRight')
  648 |   await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('B1')
  649 |   await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('2')
  650 |   await page.getByLabel('单元格内容或公式',{exact:true}).fill('11')
  651 |   await page.getByRole('button',{name:'应用内容',exact:true}).click()
  652 |   await expect.poll(async()=>(await manifest()).revision).toBe(3)
  653 |   expect(writes).toHaveLength(3);expect(writes[2].epoch).toBe('1')
  654 |   expect(writes[2].patch.baseRevision).toBe(2)
  655 |   await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('11')
  656 |   expect(await canvas.evaluate(element=>(window as any).retryCanvas===element)).toBe(true)
  657 |   await page.screenshot({path:info.outputPath('xlsx-batch-live-retry.png')})
  658 |   writeFileSync(info.outputPath('xlsx-batch-live-retry.json'),JSON.stringify({exactRetry:true,writes,revision:3,canvasPreserved:true},null,2))
  659 | })
  660 |
  661 | test('XLSX batch input journal remote refresh keeps a newer canvas selection while the index is in flight', async ({page,context},info) => {
  662 |   const id='grid-sync-selection'
  663 |   await open(page,id)
  664 |   const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  665 |   await expect(canvas).toBeVisible()
  666 |   await canvas.evaluate(element=>{(window as any).syncSelectionCanvas=element})
  667 |   const peer=await context.newPage()
  668 |   await open(peer,id)
  669 |   const peerCanvas=peer.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  670 |   await expect(peerCanvas).toBeVisible()
  671 |   await expect(peer.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  672 |   let held=false,released=false
  673 |   let release!:()=>void
  674 |   const heldResponse=new Promise<void>(resolve=>{release=resolve})
  675 |   await page.route(`**/v1/documents/${id}`,async route=>{
  676 |     if(!released) {held=true;await heldResponse}
  677 |     await route.continue()
  678 |   })
  679 |   try {
  680 |     await peerCanvas.click({position:{x:180,y:35}});await peer.keyboard.press('ArrowRight')
  681 |     await expect(peer.getByLabel('选中单元格',{exact:true})).toHaveText('B1')
  682 |     await peer.getByLabel('单元格内容或公式',{exact:true}).fill('9')
  683 |     await peer.getByRole('button',{name:'应用内容',exact:true}).click()
  684 |     await expect.poll(()=>held).toBe(true)
  685 |     await page.bringToFront()
  686 |     await canvas.click({position:{x:180,y:35}});await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight')
  687 |     await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('C1')
  688 |     const synced=page.waitForResponse(response=>response.url().endsWith(`/v1/documents/${id}/auth`))
  689 |     released=true;release()
  690 |     await synced
> 691 |     await expect(page.getByLabel('选中单元格',{exact:true})).toHaveText('C1')
      |                                                         ^ Error: expect(locator).toHaveText(expected) failed
  692 |     await expect(page.getByLabel('单元格内容或公式',{exact:true})).toHaveValue('=LEN(A1)')
  693 |     expect(await canvas.evaluate(element=>(window as any).syncSelectionCanvas===element)).toBe(true)
  694 |     await page.screenshot({path:info.outputPath('xlsx-batch-inflight-selection.png')})
  695 |     writeFileSync(info.outputPath('xlsx-batch-inflight-selection.json'),JSON.stringify({delayedRemoteIndex:true,newerSelection:'C1',canvasPreserved:true,revision:1},null,2))
  696 |   } finally {released=true;release();await peer.close()}
  697 | })
  698 |
  699 | test('XLSX batch input journal storage failure blocks submission and allows full live download and discard', async ({page,context,request},info) => {
  700 |   const id = 'grid-batch-storage', writes: string[] = []
  701 |   await context.grantPermissions(['clipboard-read','clipboard-write'])
  702 |   await page.addInitScript(() => {
  703 |     const put = IDBObjectStore.prototype.put
  704 |     IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
  705 |       if (this.name === 'drafts' && this.transaction.db.name === 'hcd-input-drafts-v1') throw new DOMException('Batch storage failure','QuotaExceededError')
  706 |       return put.apply(this,args)
  707 |     }
  708 |   })
  709 |   page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/node-patch')) writes.push(req.url()) })
  710 |   await open(page,id)
  711 |   // Unlike the helper's successful durability check, this write must report failed protection.
  712 |   await page.evaluate(async () => { await navigator.clipboard.writeText('STORAGE_BATCH\t7\t=SUM(B1,2)\nother\tnew\t=B1*2') })
  713 |   const canvas = page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  714 |   await expect(canvas).toBeVisible()
  715 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  716 |   await canvas.click({position:{x:180,y:35}}); await page.keyboard.press('ControlOrMeta+v')
  717 |   const pending = page.getByLabel('待保存的单元格修改',{exact:true})
  718 |   await expect(pending).toBeVisible()
  719 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','failed')
  720 |   expect(writes).toHaveLength(0)
  721 |   expect(await page.evaluate(() => { const e = new Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented })).toBe(true)
  722 |   const downloaded = page.waitForEvent('download')
  723 |   await pending.getByRole('button',{name:'下载本地草稿',exact:true}).click()
  724 |   const local = JSON.parse(readFileSync((await (await downloaded).path())!,'utf8'))
  725 |   expect(local.changes).toHaveLength(6)
  726 |   expect(local.text).toContain('A1: STORAGE_BATCH')
  727 |   expect(local.patch.operations.some((op:{op:string}) => op.op === 'xlsx.formula.create')).toBe(true)
  728 |   // A rejected formula paste restores its checked display cache as well as its expression.
  729 |   await canvas.click({position:{x:180,y:35}})
  730 |   await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight')
  731 |   await expect.poll(async () => {
  732 |     await page.keyboard.press('ControlOrMeta+c')
  733 |     return page.evaluate(() => navigator.clipboard.readText())
  734 |   }).toBe('13')
  735 |   await page.screenshot({path:info.outputPath('xlsx-batch-storage.png')})
  736 |   await pending.getByRole('button',{name:'舍弃本地修改',exact:true}).click()
  737 |   await expect(pending).toHaveCount(0)
  738 |   const response = await request.get(`${apiUrl}/v1/documents/${id}`,{headers:{Authorization:`Bearer ${token(id,'inspector')}`}})
  739 |   expect((await response.json()).revision).toBe(0)
  740 |   expect(writes).toHaveLength(0)
  741 | })
  742 |
  743 | test('XLSX batch input journal keeps a corrupt intent downloadable and never sends it to review or apply', async ({page,context},info) => {
  744 |   const id = 'grid-batch-corrupt'
  745 |   await context.grantPermissions(['clipboard-read','clipboard-write'])
  746 |   await page.route('**/node-patch',route => route.abort('failed'))
  747 |   await open(page,id); await pasteDurableGridBatch(page)
  748 |   await page.close({runBeforeUnload:false})
  749 |   const reopened = await context.newPage()
  750 |   await reopened.goto(`${uiUrl}/?locale=zh-CN`)
  751 |   await reopened.evaluate(async id => {
  752 |     const db = await new Promise<IDBDatabase>((resolve,reject) => { const r = indexedDB.open('hcd-input-drafts-v1'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error) })
  753 |     await new Promise<void>((resolve,reject) => {
  754 |       const tx=db.transaction('drafts','readwrite'),store=tx.objectStore('drafts'),r=store.getAll()
  755 |       r.onsuccess=()=>{ for(const record of r.result) if(record.documentId===id) { const content=JSON.parse(record.content);content.changes[0].column=-1;store.put({...record,content:JSON.stringify(content)}) } }
  756 |       tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error)
  757 |     });db.close()
  758 |   },id)
  759 |   const writes: string[] = []
  760 |   reopened.on('request',req=>{if(req.method()==='POST'&&/\/node-patch(?:-review)?$/.test(req.url()))writes.push(req.url())})
  761 |   await open(reopened,id)
  762 |   const retained=reopened.getByLabel('保留的未提交输入',{exact:true})
  763 |   await expect(retained).toHaveCount(1);await retained.locator('summary').click()
  764 |   await retained.getByRole('button',{name:'恢复输入',exact:true}).click()
  765 |   await expect(reopened.locator('.toast.error')).toContainText('无法安全恢复')
  766 |   await expect(retained.getByRole('button',{name:'下载本地草稿',exact:true})).toBeEnabled()
  767 |   expect(writes).toHaveLength(0)
  768 |   await reopened.screenshot({path:info.outputPath('xlsx-batch-corrupt.png')})
  769 | })
  770 |
  771 | test('XLSX rich input journal recovers uncommitted selection formatting after offline page closure', async ({page,context,request}, info) => {
  772 |   const id='rich-draft', headers={Authorization:`Bearer ${token(id,'draft-reader')}`}
  773 |   await open(page,id)
  774 |   const canvas=page.locator('.hcd-univer-host canvas[id^="univer-sheet-main-canvas_"]').first()
  775 |   await expect(canvas).toBeVisible()
  776 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  777 |   await context.setOffline(true)
  778 |   await canvas.dblclick({position:{x:180,y:35}})
  779 |   await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('ArrowLeft')
  780 |   for(let i=0;i<4;i++) await page.keyboard.press('ArrowRight')
  781 |   for(let i=0;i<6;i++) await page.keyboard.press('Shift+ArrowRight')
  782 |   await page.getByRole('button',{name:'加粗',exact:true}).click()
  783 |   await expect(page.getByLabel('未应用输入位置',{exact:true})).toContainText('A1')
  784 |   await expect(page.locator('[data-draft-protection]')).toHaveAttribute('data-draft-protection','protected')
  785 |   await page.close({runBeforeUnload:false}); await context.setOffline(false)
  786 |   expect((await (await request.get(`${apiUrl}/v1/documents/${id}`,{headers})).json()).revision).toBe(0)
  787 |   const reopened=await context.newPage(); await open(reopened,id)
  788 |   const retained=reopened.getByLabel('保留的未提交输入',{exact:true})
  789 |   await expect(retained).toHaveCount(1)
  790 |   await retained.locator('summary').click()
  791 |   await expect(retained.getByRole('textbox')).toHaveValue('中文😀 normal 斜体')
```
