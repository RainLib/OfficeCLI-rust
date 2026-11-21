import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, expect } from '../editor/node_modules/@playwright/test/index.mjs'

const output=resolve(process.env.OFFICECLI_INPUT_ARTIFACTS||mkdtempSync(join(tmpdir(),'canvas-input-proof-')))
mkdirSync(output,{recursive:true})
const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r))
const service=spawn(process.execPath,[join(import.meta.dirname,'demo.mjs')],{env:{...process.env,OFFICECLI_EMBED_PORT:String(port)},stdio:['ignore','pipe','pipe']})
const stopped=once(service,'exit');let log='',browser,page;const checks=[],errors=[]
service.stdout.on('data',c=>{log+=c});service.stderr.on('data',c=>{log+=c})
const nativeElement=(id,x,y,width=190,height=110)=>({id,type:'rectangle',x,y,width,height,angle:0,strokeColor:'#556a61',backgroundColor:'#e8f0eb',fillStyle:'solid',strokeWidth:1,strokeStyle:'solid',roughness:0,opacity:100,groupIds:[],frameId:null,index:id==='reacted-card'?'a0':'a1',roundness:{type:3},seed:31,version:1,versionNonce:31,isDeleted:false,boundElements:[],updated:1,link:null,locked:false})
const file=join(output,'canvas-input.excalidraw')
writeFileSync(file,JSON.stringify({type:'excalidraw',version:2,source:'OfficeCLI',elements:[nativeElement('reacted-card',380,370),nativeElement('move-card',150,530,140,90)],appState:{viewBackgroundColor:'#f8faf9',scrollX:0,scrollY:0,zoom:{value:1}},files:{}}))
try {
  await expect.poll(()=>log.includes('业务系统 '),{timeout:60000}).toBe(true)
  browser=await chromium.launch({...(process.env.HCD_BROWSER_PATH?{executablePath:process.env.HCD_BROWSER_PATH}:{}),args:['--no-proxy-server']})
  page=await browser.newPage({viewport:{width:1076,height:1291},reducedMotion:'reduce'})
  page.on('pageerror',e=>errors.push(e.message))
  await page.goto(`http://fold.localhost:${port}/workbench/`)
  await page.getByRole('button',{name:'收起全局 AI',exact:true}).click()
  await page.locator('.desk-home-main input[type=file]').setInputFiles(file)
  const pane=page.locator('.desk-editor.is-visible'),surface=pane.locator('.canvas-surface'),canvas=pane.locator('canvas.excalidraw__canvas.interactive')
  await expect(canvas).toBeVisible({timeout:45000})
  await page.evaluate(async()=>{
    const {files}=await(await fetch('/workspace/api/files')).json(),file=files.find(f=>f.name==='canvas-input.excalidraw')
    const {csrf}=await(await fetch('/workspace/api/session')).json()
    const launch=await(await fetch(`/workspace/api/files/${file.id}/editor-session`,{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-CSRF':csrf},body:JSON.stringify({sessionId:crypto.randomUUID()})})).json()
    const url='/v1/documents/'+file.resourceDocumentId
    const auth=await(await fetch(url+'/auth',{headers:{Authorization:'Bearer '+launch.token}})).json()
    const response=await fetch(url+'/canvas/reactions',{method:'PUT',headers:{Authorization:'Bearer '+launch.token,'Content-Type':'application/json','X-HCD-Collaboration-Epoch':String(auth.collaborationEpoch)},body:JSON.stringify({elementIds:['reacted-card'],kind:'thumbsUp',active:true})})
    if(!response.ok)throw Error(await response.text())
  })
  const badge=surface.getByRole('button',{name:'大拇指 · 1 人',exact:true});await expect(badge).toBeVisible()
  const camera=()=>surface.evaluate(el=>({x:el.style.getPropertyValue('--board-dot-x'),y:el.style.getPropertyValue('--board-dot-y'),step:el.style.getPropertyValue('--board-dot-step')}))
  const wheel=async(modifiers={},target=badge)=>{
    const box=await target.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
    return target.evaluate((el,modifiers)=>{const r=el.getBoundingClientRect();const e=new WheelEvent('wheel',{clientX:r.x+r.width/2,clientY:r.y+r.height/2,deltaY:-6,deltaX:0,bubbles:true,cancelable:true,...modifiers});el.dispatchEvent(e);return e.defaultPrevented},modifiers)
  }
  const before=await camera(),prevented=await wheel({ctrlKey:true})
  if(process.env.OFFICECLI_INPUT_PROBE==='1'){
    await page.waitForTimeout(180)
    const initial=await camera();await pane.getByRole('button',{name:'手形',exact:true}).click();const r=await badge.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+75,r.y+r.height/2+35,{steps:8});await page.mouse.up();await page.waitForTimeout(180)
    writeFileSync(join(output,'probe.json'),JSON.stringify({ctrlWheelPrevented:prevented,cameraBefore:before,cameraAfterWheel:initial,cameraAfterBadgePan:await camera(),errors},null,2));console.log('Baseline probe saved',output)
  }else{
    assert.equal(prevented,true,'Ctrl-wheel on a badge must cancel browser zoom')
    await expect.poll(camera).not.toEqual(before)
    checks.push('Ctrl-wheel over a reaction badge changes only the drawing camera and cancels browser zoom.')
    const viewport=await page.evaluate(()=>({dpr:devicePixelRatio,scale:visualViewport.scale,width:innerWidth,height:innerHeight}))
    for (const modifiers of [{metaKey:true},{}]) { const previous=await camera(); assert.equal(await wheel(modifiers),true); await expect.poll(camera).not.toEqual(previous) }
    checks.push('Meta-wheel and unmodified trackpad panning over DOM content both reach the drawing camera.')
    const previous=await camera(); await pane.getByRole('button',{name:'手形',exact:true}).click()
    let r=await badge.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down()
    await expect(surface).toHaveAttribute('data-canvas-gesture','true')
    await page.mouse.move(r.x+r.width/2+75,r.y+r.height/2+35,{steps:8});await page.mouse.up()
    await expect.poll(camera).not.toEqual(previous);await expect(surface).not.toHaveAttribute('data-canvas-gesture','true')
    checks.push('Hand drag can begin on a reaction and continues across DOM layers without toggling a vote.')
    await expect(badge).toHaveAttribute('aria-pressed','true')
    // A new plug-in layer needs no component-specific forwarding handlers.
    await surface.evaluate(root=>{const layer=document.createElement('div');layer.id='new-content-layer';layer.style.cssText='position:absolute;left:210px;top:220px;width:180px;height:80px;z-index:5;background:#e8f0eb;pointer-events:auto';layer.innerHTML='<span>New DOM content</span><svg width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>';root.append(layer)})
    const generic=surface.locator('#new-content-layer'),prior=await camera();assert.equal(await wheel({ctrlKey:true},generic.locator('svg')),true);await expect.poll(camera).not.toEqual(prior)
    let point=await generic.boundingBox();const panBefore=await camera();await page.mouse.move(point.x+20,point.y+20);await page.mouse.down();await page.mouse.move(point.x+95,point.y+50,{steps:8});await page.mouse.up();await expect.poll(camera).not.toEqual(panBefore)
    checks.push('Unknown future DOM/SVG content inherits zoom and hand panning from the surface.')
    const bounds=await surface.boundingBox(),acrossBefore=await camera()
    await page.mouse.move(bounds.x+170,bounds.y+250);await page.mouse.down()
    assert.equal(await generic.evaluate(el=>getComputedStyle(el).pointerEvents),'none')
    await page.mouse.move(bounds.x+300,bounds.y+250,{steps:10});const acrossMiddle=await camera()
    await page.mouse.move(bounds.x+440,bounds.y+250,{steps:10});await page.mouse.up()
    await expect.poll(camera).not.toEqual(acrossMiddle);assert.notDeepEqual(acrossMiddle,acrossBefore)
    await expect(surface).not.toHaveAttribute('data-canvas-gesture','true')
    assert.equal(await generic.evaluate(el=>getComputedStyle(el).pointerEvents),'auto')
    checks.push('A drag beginning on the drawing continues through and beyond a DOM layer; hit testing is restored on release.')
    await pane.getByRole('button',{name:'选择',exact:true}).click()
    for(const mode of ['space','middle']) {
      const prior=await camera(),point=await generic.boundingBox()
      await page.mouse.move(point.x+25,point.y+25)
      if(mode==='space')await page.keyboard.down('Space')
      await page.mouse.down({button:mode==='middle'?'middle':'left'})
      await page.mouse.move(point.x+65,point.y+45,{steps:6});await page.mouse.up({button:mode==='middle'?'middle':'left'})
      if(mode==='space')await page.keyboard.up('Space')
      await expect.poll(camera).not.toEqual(prior)
    }
    checks.push('Space-drag and middle-button navigation also work when starting on DOM content.')
    await surface.evaluate(root=>{const scroll=document.createElement('div');scroll.id='local-document-scroll';scroll.style.cssText='position:absolute;left:220px;top:330px;width:220px;height:100px;overflow:auto;z-index:6;pointer-events:auto';scroll.innerHTML='<div style="height:500px;background:#eef3f0">Scrollable document content</div>';root.append(scroll)})
    const scroller=surface.locator('#local-document-scroll'),scrollBefore=await camera(),b=await scroller.boundingBox();await page.mouse.move(b.x+50,b.y+50);await page.mouse.wheel(0,80)
    await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);assert.deepEqual(await camera(),scrollBefore)
    assert.equal(await wheel({ctrlKey:true},scroller),true);await expect.poll(camera).not.toEqual(scrollBefore)
    checks.push('Document-local scrolling is preserved, while modified wheel zoom still targets the board.')
    await surface.locator('.excalidraw').evaluate(root=>{const input=document.createElement('textarea');input.id='embedded-editor-input';input.style.cssText='position:absolute;left:220px;top:470px;z-index:7';input.value='Preserved';root.append(input)})
    const input=surface.locator('#embedded-editor-input'),keyBefore=await camera();await input.click();await input.press('Meta+-')
    await expect.poll(camera).not.toEqual(keyBefore);await expect(input).toHaveValue('Preserved');await input.press('Space');await expect(input).toHaveValue(/ /)
    await input.evaluate(el=>el.remove())
    checks.push('Zoom shortcuts on an embedded editor affect the board, while ordinary text input and spaces remain editable.')
    await surface.evaluate(root=>{for(const id of ['new-content-layer','local-document-scroll'])root.querySelector('#'+id)?.remove()})
    // Safari reports an additional, native pinch stream instead of ctrl-wheel.
    const safariBefore=await camera();await badge.evaluate(el=>{for(const [type,scale] of [['gesturestart',1],['gesturechange',1.1],['gestureend',1.1]]){const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'scale',{value:scale});el.dispatchEvent(e);if(!e.defaultPrevented)throw Error('Native pinch must cancel browser scaling')}});await expect.poll(camera).not.toEqual(safariBefore)
    assert.deepEqual(await page.evaluate(()=>({dpr:devicePixelRatio,scale:visualViewport.scale,width:innerWidth,height:innerHeight})),viewport)
    checks.push('WebKit gesture streams are cancelled at the non-passive surface; browser viewport and device scale stay unchanged.')
    await badge.click();await expect(badge).toHaveCount(0)
    checks.push('A normal selection-mode click still toggles the reaction.')
    await pane.getByRole('button',{name:'帮助',exact:true}).click()
    const help=page.getByRole('dialog');await expect(help).toBeVisible();await expect(help.locator('.HelpDialog__header')).toBeHidden();await expect(help.getByText('快捷键列表',{exact:true})).toBeVisible()
    assert.equal(await help.getByRole('link').filter({hasText:/文档|博客|反馈|YouTube/}).count(),0)
    await page.screenshot({path:join(output,'help-shortcuts.png')});await help.press('Escape')
    checks.push('Help retains keyboard shortcuts and removes the upstream documentation/blog/feedback/YouTube strip.')

  }
  await page.screenshot({path:join(output,'canvas-input.png')})
  assert.deepEqual(errors,[],'The navigation flow must not throw browser errors')
  writeFileSync(join(output,'results.json'),JSON.stringify({checks,observation:{ctrlWheelPrevented:prevented,cameraBefore:before,cameraAfter:await camera()},errors},null,2))
}catch(e){if(page){await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});writeFileSync(join(output,'failure-state.txt'),await page.locator('body').innerText().catch(()=>''))}throw e}
finally{writeFileSync(join(output,'service.log'),log);await browser?.close();service.kill('SIGTERM');await stopped}
