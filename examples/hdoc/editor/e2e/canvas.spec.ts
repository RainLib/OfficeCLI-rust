import { test, expect, type Page } from '@playwright/test'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const repo=resolve(import.meta.dirname,'../../../..'),editorRoot=resolve(import.meta.dirname,'..')
const binary=process.env.OFFICECLI_BIN || resolve(repo,'target/debug/officecli')
const testHost=process.env.HCD_CANVAS_TEST_HOST || '127.0.0.1',urlHost=testHost.includes(':')?`[${testHost}]`:testHost
const secret=randomBytes(32).toString('hex'),children:ChildProcess[]=[]
let root:string,apiUrl:string,uiUrl:string,model:Server,epoch=0
let modelWaiting:(()=>void)|null=null,allowModel:(()=>void)|null=null
function token(user='alice',scope='write') {
  const b64=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url'),now=Math.floor(Date.now()/1000)
  const payload=`${b64({alg:'HS256',typ:'JWT'})}.${b64({doc:'canvas-accept',scope,sub:user,name:user,aud:'hcd-core',iat:now,exp:now+3600})}`
  return `${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`
}
async function freePort(){const server=createServer();await new Promise<void>(done=>server.listen(0,testHost,done));const value=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return value}
function start(command:string,args:string[],extra:NodeJS.ProcessEnv){const env={...process.env,HCD_TOKEN_SECRET:secret,HCD_API_TARGET:apiUrl,HCD_VITE_CACHE_DIR:resolve(root,'vite-cache'),...extra};delete env.HCD_DATABASE_URL;delete env.HCD_S3_BUCKET;delete env.HCD_DEFAULT_THEME;const child=spawn(command,args,{cwd:editorRoot,env,stdio:['ignore','pipe','pipe']});children.push(child);const log=createWriteStream(resolve(root,`process-${child.pid}.log`));child.stdout?.pipe(log);child.stderr?.pipe(log);return child}
async function request(route:string,init:RequestInit={},user='alice',scope='write'){return fetch(`${apiUrl}/v1/documents/canvas-accept${route}`,{...init,headers:{Authorization:`Bearer ${token(user,scope)}`,'Content-Type':'application/json','X-HCD-Collaboration-Epoch':String(epoch),...init.headers}})}
async function read(){const response=await request('/canvas');expect(response.ok).toBeTruthy();const value=await response.json();epoch=value.collaborationEpoch;return value}
async function open(page:Page,user='alice',scope='write'){
  await page.goto(`${uiUrl}/?locale=zh-CN`);await page.getByPlaceholder('doc-…').fill('canvas-accept');await page.getByPlaceholder('粘贴短期令牌',{exact:true}).fill(token(user,scope));await page.getByRole('button',{name:'打开文档',exact:true}).click()
  await expect(page.locator('.canvas-workspace')).toBeVisible();await expect(page.locator('.excalidraw canvas').first()).toBeVisible();await expect(page.locator('.canvas-connection')).toHaveAttribute('data-connected','true')
}
function batch(revision:number,operations:unknown[]){return {schemaVersion:'officecli-canvas/1',documentId:'canvas-accept',patchId:randomUUID(),baseRevision:revision,operations}}

test.beforeAll(async()=>{
  root=mkdtempSync(resolve(tmpdir(),'officecli-canvas-'))
  const service=resolve(root,'service'),source=resolve(root,'source.excalidraw')
  writeFileSync(source,JSON.stringify({type:'excalidraw',version:2,elements:[
    {id:'focus',type:'rectangle',x:0,y:0,width:260,height:160,strokeColor:'#000000',backgroundColor:'#e0f2fe',fillStyle:'solid'},
    {id:'label',type:'text',x:30,y:45,width:180,height:30,text:'正在讨论的方案',fontSize:20,fontFamily:2,lineHeight:1.25},
    {id:'outside',type:'rectangle',x:620,y:0,width:240,height:160,strokeColor:'#000000',backgroundColor:'#fef3c7',fillStyle:'solid'},
  ],files:{},appState:{viewBackgroundColor:'#ffffff'}}))
  const imported=spawnSync(binary,['hdoc','import',source,'--output',resolve(service,'canvas-accept.hcd'),'--document-id','canvas-accept'],{encoding:'utf8'})
  if(imported.status!==0)throw new Error(imported.stderr)
  const apiPort=await freePort(),uiPort=await freePort();apiUrl=`http://${urlHost}:${apiPort}`;uiUrl=`http://${urlHost}:${uiPort}`
  model=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/v1/models'){
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'canvas-test',object:'model'}]}));return
    }
    if(req.method!=='POST'||req.url!=='/v1/responses'){res.writeHead(404);res.end();return}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk))
    if(!chunks.length){res.writeHead(400);res.end();return}
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const calls=body.input.filter((item:any)=>item.type==='function_call'),outputs=body.input.filter((item:any)=>item.type==='function_call_output')
    const results=outputs.map((item:any)=>({call:calls.find((call:any)=>call.call_id===item.call_id),result:JSON.parse(item.output)}))
    const latest=(resource:string)=>results.filter((item:any)=>item.call?.name==='hcd_read'&&JSON.parse(item.call.arguments).resource===resource).at(-1)?.result.data
    const task=String(body.input[0].content)
    const fn=(name:string,args:unknown)=>({status:'completed',output:[{type:'function_call',call_id:randomUUID(),name,arguments:JSON.stringify(args)}]})
    let output:unknown
    if(!latest('auth'))output=fn('hcd_read',{document_id:'canvas-accept',resource:'auth'})
    else if(!latest('canvas') || results.at(-1)?.call.name==='hcd_patch')output=fn('hcd_read',{document_id:'canvas-accept',resource:'canvas'})
    else if(!calls.some((call:any)=>call.name==='hcd_patch')){
      const current=latest('canvas'),element=current.scene.elements.find((element:any)=>element.id==='focus')
      if((task.includes('CONCURRENT')||task.includes('"specSentence"'))&&modelWaiting){modelWaiting();await new Promise<void>(done=>{allowModel=done})}
      const target=String(body.input[0].content).includes('OUTSIDE')?'outside':'focus',object=current.scene.elements.find((element:any)=>element.id===target)
      const region=task.includes('EMPTY')?JSON.parse(task.split('Requested target (data): ')[1].split('\nUser task:')[0]).canvas.region:null
      const sentence=task.includes('"specSentence"')?JSON.parse(task.split('Requested target (data): ')[1].split('\nUser task:')[0]).specSentence:null
      const operations=sentence?[{op:'spec.splice',id:sentence.id,block:sentence.block,start:sentence.start,end:sentence.end,expected:sentence.expected,insert:'秋季上线。'}]:region?[{op:'element.add',element:{id:`empty-${randomUUID()}`,type:'rectangle',x:region.x+5,y:region.y+5,width:region.width-10,height:region.height-10,strokeColor:'#7c3aed'}}]:[{op:'element.update',id:target,before:{strokeColor:object.strokeColor},changes:{strokeColor:object.strokeColor==='#0284c7'?'#7c3aed':'#0284c7'}}]
      output=fn('hcd_patch',{document_id:'canvas-accept',mode:'canvas',expected_revision:sentence?.revision??current.revision,collaboration_epoch:latest('auth').collaborationEpoch,patch:batch(sentence?.revision??current.revision,operations)})
    }else output={status:'completed',output:[{type:'message',content:[{type:'output_text',text:'已修改选区颜色，并回读核对。'}]}]}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(output))
  });await new Promise<void>(done=>model.listen(0,testHost,done));const modelUrl=`http://${urlHost}:${(model.address() as {port:number}).port}/v1`
  start(binary,['hdoc','serve','--root',service,'--bind',`${urlHost}:${apiPort}`],{OPENAI_API_KEY:'canvas-test-only',HCD_OPENAI_BASE_URL:modelUrl,HCD_OPENAI_MODEL:'canvas-test',HCD_AI_ENABLED:'true'})
  await expect.poll(async()=>{try{return(await fetch(`${apiUrl}/health`)).status}catch{return 0}}).toBe(200)
  start(process.execPath,['node_modules/vite/bin/vite.js','--host',testHost,'--port',String(uiPort)],{HCD_API_TARGET:apiUrl.replace('[::1]','localhost')})
  await expect.poll(async()=>{try{return(await fetch(uiUrl)).status}catch{return 0}},{timeout:30_000}).toBe(200)
})
test.afterAll(async()=>{allowModel?.();for(const child of children)child.kill('SIGTERM');model?.close();console.log(`Canvas acceptance artifacts: ${root}`)})

test('object transactions merge independent edits and reject stale fields, scopes and readonly writes',async()=>{
  const before=await read()
  const moved=await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(before.revision,[{op:'element.update',id:'outside',before:{x:620},changes:{x:650}}]))},'bob')
  expect(moved.status).toBe(200)
  const unrelated=await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(before.revision,[{op:'element.update',id:'focus',before:{backgroundColor:'#e0f2fe'},changes:{backgroundColor:'#dcfce7'}}]))})
  expect(unrelated.status).toBe(200)
  const stale=await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(before.revision,[{op:'element.update',id:'outside',before:{x:620},changes:{x:680}}]))})
  expect(stale.status).toBe(412)
  const denied=await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(before.revision,[{op:'element.update',id:'focus',before:{x:0},changes:{x:10}}]))},'reader','read')
  expect(denied.status).toBe(403)
  expect((await read()).scene.elements.find((e:any)=>e.id==='outside').x).toBe(650)
})

test('two browser canvases render free drawing, receive each other and retain content after reload',async({browser},info)=>{
  const a=await browser.newContext(),b=await browser.newContext(),first=await a.newPage(),second=await b.newPage()
  const errors:string[]=[];first.on('pageerror',error=>errors.push(error.message))
  await open(first);await open(second,'bob')
  const before=(await read()).scene.elements.length
  await first.getByRole('button',{name:'画笔',exact:true}).click()
  const bounds=await first.locator('.canvas-surface').boundingBox();expect(bounds).toBeTruthy()
  const x=bounds!.x+280,y=bounds!.y+360
  await first.mouse.move(x,y);await first.mouse.down();await first.mouse.move(x+70,y+30,{steps:8});await first.mouse.move(x+130,y-20,{steps:8});await first.mouse.up()
  await expect.poll(async()=>(await read()).scene.elements.length,{timeout:20_000}).toBeGreaterThan(before)
  // A long stroke can create the object before its last pointer update is
  // committed. Capture the revision for the completed drawing.
  await first.getByRole('button',{name:'保存画布',exact:true}).click()
  await expect(first.locator('.canvas-workspace .status')).toContainText('已保存')
  const snapshot=await read();expect(snapshot.scene.elements.some((e:any)=>e.type==='freedraw'&&e.points.length>3)).toBeTruthy()
  await expect(second.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision',String(snapshot.revision))
  await first.reload();await expect(first.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision',String(snapshot.revision))
  await first.screenshot({path:info.outputPath('canvas-two-person.png'),fullPage:true})
  expect(errors).toEqual([]);await a.close();await b.close()
})

test('two live users and an AI edit the same board without overwriting independent changes',async({browser},info)=>{
  const first=await browser.newContext(),second=await browser.newContext()
  const alice=await first.newPage(),bob=await second.newPage()
  try{
    await Promise.all([open(alice),open(bob,'bob')])
    const before=await read(),outside=before.scene.elements.find((e:any)=>e.id==='outside'),focus=before.scene.elements.find((e:any)=>e.id==='focus')
    const waiting=new Promise<void>(done=>{modelWaiting=done})
    const run=await request('/agent-runs',{method:'POST',body:JSON.stringify({task:'CONCURRENT 修改所选方案的边框颜色。',target:{canvas:{elementIds:['focus'],region:{x:focus.x,y:focus.y,width:focus.width,height:focus.height}}}})})
    expect(run.status).toBe(202);const started=await run.json();await waiting;modelWaiting=null
    // Locate the existing rectangle through the editor's public navigation, then drag it on Bob's canvas while the agent holds the old snapshot.
    await bob.emulateMedia({reducedMotion:'reduce'})
    await bob.evaluate(()=>window.dispatchEvent(new CustomEvent('officecli:canvas-locate',{detail:{documentId:'canvas-accept',region:{x:0,y:0,width:260,height:160}}})))
    const board=bob.getByRole('main',{name:'自由画布'}),bounds=(await board.boundingBox())!
    await expect.poll(async()=>Number((await bob.locator('.reset-zoom-button').innerText()).replace('%',''))).toBe(100)
    // "label" is an independent object in the center, so grab the filled rectangle closer to its bottom edge.
    const origin=await board.evaluate(el=>{const s=getComputedStyle(el);return {x:parseFloat(s.getPropertyValue('--board-dot-x')),y:parseFloat(s.getPropertyValue('--board-dot-y'))}})
    const x=bounds.x+origin.x+focus.x+focus.width*.7,y=bounds.y+origin.y+focus.y+focus.height*.8
    await bob.mouse.move(x,y);await bob.mouse.down();await bob.mouse.move(x+90,y,{steps:12});await bob.mouse.up()
    await expect.poll(async()=>(await read()).scene.elements.find((e:any)=>e.id==='focus').x).toBeGreaterThan(focus.x+70)
    const moved=(await read()).scene.elements.find((e:any)=>e.id==='focus').x
    allowModel?.();allowModel=null
    await expect.poll(async()=>(await(await request('/agent-runs/'+started.runId)).json()).status,{timeout:40_000}).toBe('completed')
    const after=await read(),changed=after.scene.elements.find((e:any)=>e.id==='focus')
    expect(changed.x).toBe(moved);expect(changed.strokeColor).not.toBe(focus.strokeColor);expect(after.scene.elements.find((e:any)=>e.id==='outside')).toEqual(outside)
    for(const p of [alice,bob])await expect(p.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision',String(after.revision))
    await alice.screenshot({path:info.outputPath('canvas-human-and-ai.png')})
  }finally{allowModel?.();allowModel=null;modelWaiting=null;await first.close();await second.close()}
})

test('a real marquee selection starts a scoped AI task from the canvas',async({page},info)=>{
  const before=await read()
  if(before.revision>0){const restored=await request('/restore/0',{method:'POST',body:JSON.stringify({expectedRevision:before.revision})});expect(restored.status).toBe(200)}
  await open(page)
  const bounds=(await page.locator('.canvas-surface').boundingBox())!,left=bounds.x+(bounds.width-860)/2,top=bounds.y+(bounds.height-160)/2
  await page.mouse.move(left-20,top-20);await page.mouse.down();await page.mouse.move(left+280,top+180,{steps:12});await page.mouse.up()
  await expect(page.getByRole('button',{name:'让 AI 修改选区',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'让 AI 修改选区',exact:true}).click()
  const input=page.getByRole('textbox',{name:'Agent 任务',exact:true});await input.fill('修改选中方案的颜色，保留其他区域。')
  const requested=page.waitForRequest(request=>request.url().endsWith('/agent-runs')&&request.method()==='POST')
  await page.getByRole('button',{name:'启动 Agent',exact:true}).click()
  const invocation=(await requested).postDataJSON();expect(invocation.target.canvas.elementIds).toContain('focus');expect(invocation.target.canvas.elementIds).not.toContain('outside')
  await expect(page.locator('.agent-task-run.run-completed').filter({hasText:'修改选中方案的颜色，保留其他区域。'})).toBeVisible()
  const after=await read();expect(after.scene.elements.find((e:any)=>e.id==='focus').strokeColor).toBe('#0284c7');expect(after.scene.elements.find((e:any)=>e.id==='outside').strokeColor).toBe('#000000')
  await page.screenshot({path:info.outputPath('canvas-selected-ai.png'),fullPage:true})
})

test('an AI task cannot modify an object outside its server-authorized selection',async()=>{
  const before=await read(),outside=before.scene.elements.find((e:any)=>e.id==='outside')
  const started=await request('/agent-runs',{method:'POST',body:JSON.stringify({task:'OUTSIDE 尝试修改选区之外对象。',target:{canvas:{elementIds:['focus'],region:{x:0,y:0,width:260,height:160}}}})})
  expect(started.status).toBe(202);const run=await started.json()
  await expect.poll(async()=>(await(await request(`/agent-runs/${run.runId}`)).json()).status,{timeout:30_000}).toBe('failed')
  expect((await read()).scene.elements.find((e:any)=>e.id==='outside')).toEqual(outside)
})

test('a blank region can contain new AI objects without editing existing content',async({page})=>{
  await open(page)
  const before=await read(),bounds=(await page.locator('.canvas-surface').boundingBox())!
  await page.getByRole('button',{name:'操作',exact:true}).click()
  await page.getByRole('button',{name:'框选区域',exact:true}).click()
  await page.mouse.move(bounds.x+80,bounds.y+520);await page.mouse.down();await page.mouse.move(bounds.x+300,bounds.y+680,{steps:8});await page.mouse.up()
  await expect(page.getByText('已框选空白区域',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'让 AI 修改选区',exact:true}).click()
  await page.getByRole('textbox',{name:'Agent 任务',exact:true}).fill('EMPTY 在这个空白区域添加一个方案框。')
  const sent=page.waitForRequest(request=>request.url().endsWith('/agent-runs')&&request.method()==='POST')
  await page.getByRole('button',{name:'启动 Agent',exact:true}).click()
  const target=(await sent).postDataJSON().target.canvas
  expect(target.elementIds).toEqual([]);expect(target.region.width).toBeGreaterThan(200)
  await expect(page.locator('.agent-task-run.run-completed').filter({hasText:'EMPTY'})).toBeVisible()
  const after=await read();expect(after.scene.elements.length).toBe(before.scene.elements.length+1)
  for(const element of before.scene.elements)expect(after.scene.elements.find((e:any)=>e.id===element.id)).toEqual(element)
})

test('native undo and redo preserve changes committed by another person',async({page})=>{
  await open(page)
  const before=await read(),ids=new Set(before.scene.elements.map((e:any)=>e.id)),bounds=(await page.locator('.canvas-surface').boundingBox())!
  await page.getByRole('button',{name:'形状与连接线',exact:true}).click()
  await page.mouse.move(bounds.x+480,bounds.y+480);await page.mouse.down();await page.mouse.move(bounds.x+580,bounds.y+560,{steps:6});await page.mouse.up()
  await expect.poll(async()=>(await read()).scene.elements.length).toBe(before.scene.elements.length+1)
  const own=(await read()).scene.elements.find((e:any)=>!ids.has(e.id))
  const outside=(await read()).scene.elements.find((e:any)=>e.id==='outside')
  const result=await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch((await read()).revision,[{op:'element.update',id:'outside',before:{x:outside.x},changes:{x:outside.x+15}}]))},'bob')
  expect(result.status).toBe(200)
  await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision',String((await read()).revision))
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async()=>(await read()).scene.elements.find((e:any)=>e.id===own.id)?.isDeleted).toBe(true)
  expect((await read()).scene.elements.find((e:any)=>e.id==='outside').x).toBe(outside.x+15)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(async()=>(await read()).scene.elements.find((e:any)=>e.id===own.id)?.isDeleted).not.toBe(true)
})

test('a disconnected edit stays in the local journal and retries once on reconnect',async({page,context})=>{
  await open(page)
  const before=await read(),bounds=(await page.locator('.canvas-surface').boundingBox())!
  await context.setOffline(true)
  await page.getByRole('button',{name:'形状与连接线',exact:true}).click()
  await page.mouse.move(bounds.x+610,bounds.y+460);await page.mouse.down();await page.mouse.move(bounds.x+710,bounds.y+540,{steps:6});await page.mouse.up()
  await expect(page.getByRole('status')).toContainText('草稿已保留')
  expect((await read()).revision).toBe(before.revision)
  await context.setOffline(false)
  await page.getByRole('button',{name:'重试保存',exact:true}).click()
  await expect.poll(async()=>(await read()).scene.elements.length).toBe(before.scene.elements.length+1)
  await expect(page.getByRole('status')).toContainText('已保存')
  await page.reload();await expect(page.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision',String((await read()).revision))
  expect((await read()).revision).toBe(before.revision+1)
})

test('canvas shares the Pen panel shell in both themes and preserves its editor and draft when panels change',async({page},info)=>{
  const current=await read();expect((await request('/restore/0',{method:'POST',body:JSON.stringify({expectedRevision:current.revision})})).status).toBe(200);await read()
  await open(page,'designer')
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  const panel=page.getByRole('complementary',{name:'Agent 协作动态',exact:true}),input=page.getByRole('textbox',{name:'Agent 任务',exact:true})
  await expect(panel).toBeVisible();await input.fill('保留这份画布草稿，继续梳理方案。')
  await page.locator('.excalidraw canvas').first().evaluate(element=>{(window as any).__canvasStyleElement=element})
  const geometry=()=>page.evaluate(()=>{
    const canvas=document.querySelector('.canvas-surface')!,panel=document.querySelector('.pen-agent-panel')!,main=panel.querySelector('.agent-panel-main')!,form=panel.querySelector('form')!
    const a=canvas.getBoundingClientRect(),b=panel.getBoundingClientRect(),c=main.getBoundingClientRect(),d=form.getBoundingClientRect()
    return {width:b.width,gap:b.left-a.right,overlap:a.right>b.left,canvasRadius:getComputedStyle(canvas).borderRadius,panelRadius:getComputedStyle(main).borderRadius,formRadius:getComputedStyle(form).borderRadius,inputGap:d.top-c.bottom,panelColor:getComputedStyle(main).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth}
  })
  const light=await geometry();expect(light).toMatchObject({width:344,gap:10,overlap:false,canvasRadius:'26px',panelRadius:'16px',formRadius:'16px',inputGap:10,overflow:false})
  await page.screenshot({path:info.outputPath('canvas-pen-light.png'),fullPage:true})
  const beforeWidth=(await page.locator('.canvas-surface').boundingBox())!.width
  await page.getByRole('button',{name:'收起协作面板',exact:true}).click();await expect(panel).toBeHidden()
  expect((await page.locator('.canvas-surface').boundingBox())!.width).toBeGreaterThan(beforeWidth+300)
  await page.getByRole('button',{name:'展开右侧栏',exact:true}).click();await expect(panel).toBeVisible();await expect(input).toHaveValue('保留这份画布草稿，继续梳理方案。')
  await page.getByRole('button',{name:'图片与资源',exact:true}).click();await expect(page.getByRole('region',{name:'画布图片资源',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'对话',exact:true}).click();await expect(input).toHaveValue('保留这份画布草稿，继续梳理方案。')
  await page.getByRole('button',{name:'展开聊天区域',exact:true}).click();expect((await geometry()).width).toBe(480)
  await page.getByRole('button',{name:'展开聊天区域',exact:true}).click()
  await page.getByRole('combobox',{name:'界面主题',exact:true}).selectOption('dark')
  await expect(page.locator('.excalidraw.theme--dark')).toBeVisible();await expect.poll(async()=>(await geometry()).panelColor).toBe('rgb(28, 34, 45)')
  await page.screenshot({path:info.outputPath('canvas-pen-dark.png'),fullPage:true})
  await page.getByRole('button',{name:'画布历史',exact:true}).click();await expect(page.getByRole('complementary',{name:'画布历史版本',exact:true})).toBeVisible();await expect(panel).toBeHidden()
  await page.getByRole('button',{name:'关闭历史',exact:true}).click();await page.getByRole('button',{name:'协作',exact:true}).click();await expect(input).toHaveValue('保留这份画布草稿，继续梳理方案。')
  expect(await page.locator('.excalidraw canvas').first().evaluate(element=>element===(window as any).__canvasStyleElement)).toBe(true)
  expect(errors).toEqual([])
})

test('phone canvas uses the content column for AI and restores the same canvas without an overlay',async({page},info)=>{
  await page.setViewportSize({width:390,height:844})
  await page.goto(`${uiUrl}/?locale=zh-CN`);await page.getByPlaceholder('doc-…').fill('canvas-accept');await page.getByPlaceholder('粘贴短期令牌',{exact:true}).fill(token('phone-designer'));await page.getByRole('button',{name:'打开文档',exact:true}).click()
  const canvas=page.getByRole('main',{name:'自由画布',exact:true}),panel=page.getByRole('complementary',{name:'Agent 协作动态',exact:true})
  await expect(canvas).toBeVisible();await expect(panel).toBeHidden()
  await page.locator('.excalidraw canvas').first().evaluate(element=>{(window as any).__canvasPhoneElement=element})
  await page.screenshot({path:info.outputPath('canvas-pen-phone.png'),fullPage:true})
  await page.getByRole('button',{name:'协作',exact:true}).click();await expect(panel).toBeVisible();await expect(canvas).toBeHidden()
  const input=page.getByRole('textbox',{name:'Agent 任务',exact:true});await input.fill('手机上的未提交草稿')
  expect(await panel.evaluate(element=>getComputedStyle(element).position)).toBe('static')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false)
  await page.screenshot({path:info.outputPath('canvas-pen-phone-ai.png'),fullPage:true})
  await page.keyboard.press('Escape');await expect(canvas).toBeVisible();await expect(panel).toBeHidden()
  expect(await page.locator('.excalidraw canvas').first().evaluate(element=>element===(window as any).__canvasPhoneElement)).toBe(true)
  await page.getByRole('button',{name:'协作',exact:true}).click();await expect(input).toHaveValue('手机上的未提交草稿')
})

test('FigJam dock drops an editable note, opens a Spec, and exchanges transient cursor chat between two people',async({browser},info)=>{
  const a=await browser.newContext({viewport:{width:1440,height:960}}),b=await browser.newContext({viewport:{width:1440,height:960}})
  try {
    const alice=await a.newPage(),bob=await b.newPage()
    await open(alice);await open(bob,'bob')
    for(const p of [alice,bob]){
      const toggle=p.getByRole('button',{name:'AI 协作',exact:true})
      if(await toggle.count()&&await toggle.getAttribute('aria-pressed')==='true')await toggle.click()
    }
    const dock=alice.getByRole('toolbar',{name:'白板工具栏'}), board=alice.getByRole('main',{name:'自由画布'}), bobBoard=bob.getByRole('main',{name:'自由画布'})
    await expect(dock.getByRole('button')).toHaveCount(13)
    const menuOrder=await dock.getByRole('button').evaluateAll(els=>els.map(e=>e.getAttribute('aria-label')))
    expect(menuOrder).toEqual(['选择','手形','画笔','便利贴','形状与连接线','文字','分区','表格','Spec 文档','盖章与即时表情','评论','操作','插入素材与模板'])
    const bb=(await board.boundingBox())!,tb=(await dock.boundingBox())!
    expect(tb.y+tb.height).toBeLessThan(bb.y+bb.height)
    expect(Math.abs(tb.x+tb.width/2-bb.x-bb.width/2)).toBeLessThan(2)
    await dock.getByRole('button',{name:'便利贴'}).dragTo(board,{targetPosition:{x:360,y:180}})
    await alice.getByRole('textbox',{name:'便利贴内容'}).fill('两位协作者一起梳理反馈')
    await alice.getByRole('button',{name:'完成',exact:true}).click()
    const scene=async()=>(await read()).scene.elements
    await expect.poll(async()=>(await scene()).some((e:any)=>e.originalText==='两位协作者一起梳理反馈')).toBe(true)
    const note=(await scene()).find((e:any)=>e.customData?.officeBoard?.kind==='sticky'&&!e.isDeleted)
    await expect(bob.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision',String((await read()).revision))
    const specButton=bob.getByRole('toolbar',{name:'白板工具栏'}).getByRole('button',{name:'Spec 文档'})
    await specButton.click()
    await bob.getByLabel('画布放置区').click({position:{x:635,y:190}})
    await bob.getByRole('textbox',{name:'文档标题'}).fill('工作坊观察记录')
    await bob.getByRole('button',{name:'全屏编辑'}).click()
    await bob.getByRole('textbox',{name:'文档正文'}).fill('汇总观察，列出问题。\n下一步由两位参与者共同确认。')
    const moveNote=async()=>{
      await dock.getByRole('button',{name:'选择',exact:true}).click()
      await alice.mouse.move(bb.x+384,bb.y+200);await alice.mouse.down()
      await alice.mouse.move(bb.x+462,bb.y+259,{steps:12});await alice.mouse.up()
    }
    await Promise.all([bob.getByRole('button',{name:'完成',exact:true}).click(),moveNote()])
    await expect.poll(async()=>(await scene()).find((e:any)=>e.id===note.id).x).toBeGreaterThan(note.x+20)
    await expect.poll(async()=>(await scene()).some((e:any)=>e.originalText==='工作坊观察记录')).toBe(true)
    await bob.getByRole('button',{name:'全屏',exact:true}).click()
    await expect(bob.getByRole('textbox',{name:'文档正文'})).toContainText(/两位参与者/)
    await bob.getByRole('button',{name:'关闭编辑'}).click()
    await alice.mouse.move(bb.x+312,bb.y+352)
    const revision=(await read()).revision
    await alice.keyboard.press('/')
    await alice.getByRole('textbox',{name:'光标聊天'}).fill('我在这里')
    await alice.getByRole('textbox',{name:'光标聊天'}).press('Enter')
    await expect(bobBoard.locator('.board-chat-bubble')).toContainText('我在这里')
    await expect(bobBoard.locator('.board-chat-bubble')).toHaveCount(0,{timeout:7000})
    expect((await read()).revision).toBe(revision)
    await bob.reload();await expect(bob.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision',String(revision))
    await alice.screenshot({path:info.outputPath('figjam-two-people.png')})
  }finally{await a.close();await b.close()}
})

test('canvas corners and FigJam tool popovers follow the trigger at desktop and compact widths', async ({page}, info) => {
  await page.setViewportSize({width:891,height:1033})
  await open(page)
  const board=page.getByRole('main',{name:'自由画布'})
  const ai=page.getByRole('button',{name:'AI 协作',exact:true})
  if(await ai.count() && await ai.getAttribute('aria-pressed')==='true') await ai.click()
  const menu=board.locator('.main-menu-trigger'), library=board.locator('.default-sidebar-trigger')
  const dock=board.getByRole('toolbar',{name:'白板工具栏'})
  const pen=dock.getByRole('button',{name:'画笔',exact:true}), panel=board.getByRole('region',{name:'画笔选项'})
  for (const width of [390,891,1440]) {
    await page.setViewportSize({width,height:1033})
    await expect(library).toBeVisible()
    // Excalidraw swaps both controls when it enters mobile mode. Sample one layout.
    await expect.poll(()=>board.evaluate(element=>{
      const b=element.getBoundingClientRect()
      const l=element.querySelector('.default-sidebar-trigger')?.getBoundingClientRect()
      const m=element.querySelector('.main-menu-trigger')?.getBoundingClientRect()
      if (!l?.width || !m?.width) return Infinity
      return Math.max(Math.abs((b.right-l.right)-(m.left-b.left)),Math.abs(m.top-l.top))
    })).toBeLessThan(2)
  }
  await page.setViewportSize({width:891,height:1033})
  await menu.click()
  const dropdown=board.locator('.dropdown-menu')
  await expect(dropdown).toContainText('帮助')
  await expect(dropdown).toContainText('重置画布')
  await expect(dropdown).toContainText('画布背景')
  await expect(dropdown.getByText(/Excalidraw links|GitHub|Follow us|Discord chat/i)).toHaveCount(0)
  await menu.click()
  await library.click()
  await expect(board.getByRole('region',{name:'白板素材库'})).toBeVisible()
  await board.getByTestId('sidebar-close').click()
  await pen.click()
  await expect(pen).toHaveAttribute('aria-expanded','true')
  await expect(panel).toHaveCSS('animation-name','board-drawing-tray-open')
  const aligned=async()=>{
    const p=(await panel.getByRole('button',{name:'记号笔'}).boundingBox())!, t=(await pen.boundingBox())!
    return Math.abs((p.x+p.width/2)-(t.x+t.width/2))
  }
  await expect.poll(aligned).toBeLessThan(1)
  await panel.getByRole('button',{name:'荧光笔'}).click()
  await panel.getByRole('button',{name:'橙色'}).click()
  await panel.getByRole('button',{name:'粗',exact:true}).click()
  await expect(panel.getByRole('button',{name:'粗',exact:true})).toHaveAttribute('aria-pressed','true')
  await panel.getByRole('button',{name:'记号笔'}).click()
  await expect(panel.getByRole('button',{name:'墨黑'})).toHaveAttribute('aria-pressed','true')
  await panel.getByRole('button',{name:'荧光笔'}).click()
  await expect(panel.getByRole('button',{name:'橙色'})).toHaveAttribute('aria-pressed','true')
  await expect(pen.locator('path[fill="#e09243"]').first()).toBeVisible()
  await page.screenshot({path:info.outputPath('board-drawing-palette.png')})
  const before=await read(), b=(await board.boundingBox())!
  await page.mouse.move(b.x+100,b.y+190);await page.mouse.down();await page.mouse.move(b.x+157,b.y+208,{steps:8});await page.mouse.up()
  await expect(panel).toBeVisible()
  await expect.poll(async()=>(await read()).scene.elements.some((item:any)=>item.type==='freedraw' && item.strokeColor==='#e09243' && item.opacity===36 && !before.scene.elements.some((old:any)=>old.id===item.id))).toBe(true)
  await expect(pen).toHaveAttribute('aria-pressed','true')
  const closing=await panel.evaluate(async element=>{
    element.parentElement!.querySelector<HTMLButtonElement>('button[data-tool="pen"]')!.click()
    await new Promise(requestAnimationFrame)
    return {inert:element.inert,animation:getComputedStyle(element).animationName}
  })
  expect(closing).toEqual({inert:true,animation:'board-popover-close'})
  await expect(board.locator('.board-popup-pen')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dock.getByRole('button',{name:'选择',exact:true})).toHaveAttribute('aria-pressed','true')
  await page.emulateMedia({reducedMotion:'reduce'})
  await pen.focus();await page.keyboard.press('ArrowUp')
  await expect(panel).toHaveCSS('animation-name','none')
  await expect(panel.getByRole('button',{name:'荧光笔'})).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(pen).toBeFocused()
  await page.setViewportSize({width:390,height:844})
  await menu.click();await expect(dropdown).toContainText('帮助');await menu.click()
  const plus=dock.getByRole('button',{name:'插入素材与模板'})
  await plus.click()
  const insert=board.getByRole('region',{name:'插入素材与模板选项'})
  await expect(insert).toBeVisible()
  const bounds=(await board.boundingBox())!, popup=(await insert.boundingBox())!
  expect(popup.x).toBeGreaterThanOrEqual(bounds.x)
  expect(popup.x+popup.width).toBeLessThanOrEqual(bounds.x+bounds.width)
})

test('FigJam drawing presets, patterned tape, editable table and anchored discussion persist as native board objects',async({page},info)=>{
  await open(page)
  const ai=page.getByRole('button',{name:'AI 协作',exact:true});if(await ai.count()&&await ai.getAttribute('aria-pressed')==='true')await ai.click()
  const dock=page.getByRole('toolbar',{name:'白板工具栏'}), board=page.getByRole('main',{name:'自由画布'}),bb=(await board.boundingBox())!
  await dock.getByRole('button',{name:'画笔'}).click()
  const pen=page.getByRole('region',{name:'画笔选项'})
  await pen.getByRole('button',{name:'和纸胶带'}).click();await pen.getByRole('button',{name:'棋盘格'}).click()
  await page.mouse.move(bb.x+340,bb.y+160);await page.mouse.down();await page.mouse.move(bb.x+690,bb.y+165,{steps:14});await page.mouse.up()
  const elements=async()=>(await read()).scene.elements.filter((e:any)=>!e.isDeleted)
  await expect.poll(async()=>(await elements()).filter((e:any)=>e.customData?.officeBoard?.kind==='tape').length).toBeGreaterThan(10)
  await dock.getByRole('button',{name:'表格',exact:true}).click()
  await page.getByRole('button',{name:'2 行 3 列',exact:true}).click()
  await page.getByLabel('画布放置区').click({position:{x:310,y:280}})
  await expect.poll(async()=>(await elements()).filter((e:any)=>e.customData?.officeBoard?.kind==='table').length).toBeGreaterThanOrEqual(6)
  await page.getByRole('button',{name:'编辑单元格'}).click()
  await page.getByRole('textbox',{name:'单元格内容'}).fill('访谈问题')
  await page.getByRole('button',{name:'完成',exact:true}).click()
  await expect.poll(async()=>(await elements()).some((e:any)=>e.originalText==='访谈问题')).toBe(true)
  await dock.getByRole('button',{name:'评论',exact:true}).click()
  await page.getByLabel('画布放置区').click({position:{x:700,y:300}})
  await page.getByRole('textbox',{name:'评论内容'}).fill('这里需要核对原文')
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await page.getByRole('button',{name:'打开评论'}).click()
  await page.getByRole('textbox',{name:'评论内容'}).fill('已和文档核对')
  await page.getByRole('button',{name:'发送',exact:true}).click()
  await expect.poll(async()=>(await elements()).some((e:any)=>e.customData?.officeBoard?.part==='reply'&&e.text==='已和文档核对')).toBe(true)
  await page.getByRole('button',{name:'打开评论'}).click()
  await page.getByRole('button',{name:'解决评论'}).click()
  await expect.poll(async()=>(await elements()).some((e:any)=>e.customData?.officeBoard?.resolved)).toBe(true)
  await dock.getByRole('button',{name:'插入素材与模板'}).click()
  await page.getByRole('button',{name:'模板',exact:true}).click()
  await page.getByRole('button',{name:'头脑风暴',exact:true}).click()
  await expect(page.getByRole('region',{name:'插入素材与模板选项'})).toBeHidden()
  await dock.getByRole('button',{name:'画笔'}).click()
  await page.screenshot({path:info.outputPath('figjam-drawing-tools.png')})
})

test('insert palette searches editable stickers, drops onto an existing object, and shares timer and votes',async({browser},info)=>{
  const first=await browser.newContext(),second=await browser.newContext(),alice=await first.newPage(),bob=await second.newPage()
  try{
    await Promise.all([open(alice,'shelf-owner'),open(bob,'shelf-partner')])
    for(const p of [alice,bob]){
      const toggle=p.getByRole('button',{name:'AI 协作',exact:true});if(await toggle.getAttribute('aria-pressed')==='true')await toggle.click()
      await p.emulateMedia({reducedMotion:'reduce'})
    }
    const board=alice.getByRole('main',{name:'自由画布'}),dock=alice.getByRole('toolbar',{name:'白板工具栏'})
    const plus=dock.getByRole('button',{name:'插入素材与模板',exact:true}),picker=alice.getByRole('region',{name:'插入素材与模板选项'})
    const focus=(await read()).scene.elements.find((e:any)=>e.id==='focus')
    await alice.evaluate(f=>window.dispatchEvent(new CustomEvent('officecli:canvas-locate',{detail:{documentId:'canvas-accept',region:f}})),focus)
    const transform=await board.evaluate(el=>{const s=getComputedStyle(el);return {x:parseFloat(s.getPropertyValue('--board-dot-x')),y:parseFloat(s.getPropertyValue('--board-dot-y')),zoom:parseFloat(s.getPropertyValue('--board-dot-step'))/16}})
    const target={x:(focus.x+focus.width/2)*transform.zoom+transform.x,y:(focus.y+focus.height/2)*transform.zoom+transform.y}
    await plus.click()
    for(const name of ['全部','贴纸','模板','小组件','插件','更多'])await expect(picker.getByRole('button',{name,exact:true})).toBeVisible()
    await picker.getByRole('button',{name:'贴纸',exact:true}).click()
    await expect(picker.getByRole('button',{name:/团队反馈/})).toBeVisible()
    await alice.screenshot({path:info.outputPath('figjam-insert-packs.png')})
    await picker.getByRole('textbox',{name:'搜索插入项目'}).fill('OK hand')
    // Drag from the collection into occupied paper. AI append tests separately guard empty space.
    await picker.getByRole('button',{name:'放置收到',exact:true}).dragTo(board,{targetPosition:target})
    const stickers=async()=>(await read()).scene.elements.filter((e:any)=>e.customData?.officeSticker?.motif==='fluentOkHand'&&!e.isDeleted)
    await expect.poll(async()=>(await stickers()).length).toBeGreaterThan(0)
    const newest=(await stickers()).at(-1);expect(Math.abs(newest.x+newest.width/2-focus.x-focus.width/2)).toBeLessThan(6)
    expect((await read()).scene.elements.find((e:any)=>e.id==='focus')).toEqual(focus)
    await expect(bob.locator('[data-motif="fluentOkHand"]')).toBeAttached()
    const place=async(name:string,x:number,y:number)=>{
      await plus.click();await picker.getByRole('button',{name:'小组件',exact:true}).click();await picker.getByRole('button',{name:new RegExp(name)}).click()
      await alice.getByLabel('画布放置区').click({position:{x,y}})
    }
    await place('工作坊计时器',140,180)
    await alice.getByRole('button',{name:'开始计时'}).click()
    await expect(bob.getByRole('button',{name:'暂停计时'})).toBeVisible()
    await bob.getByLabel('查看在线协作者',{exact:true}).click()
    await bob.getByRole('button',{name:'跟随 shelf-owner',exact:true}).click()
    await expect(bob.getByRole('button',{name:'停止跟随'})).toBeVisible()
    await bob.getByRole('button',{name:'暂停计时'}).click()
    await expect(alice.getByRole('button',{name:'开始计时'})).toBeVisible()
    await place('举手表决',400,260)
    await alice.getByRole('button',{name:'赞成 0',exact:true}).click()
    await bob.getByRole('button',{name:'赞成 1',exact:true}).click()
    await expect(alice.getByRole('button',{name:'赞成 2',exact:true})).toBeVisible()
    const rev=(await read()).revision;await bob.reload()
    await expect(bob.locator('.canvas-workspace')).toHaveAttribute('data-canvas-revision',String(rev))
    await expect(bob.getByRole('button',{name:'赞成 2',exact:true})).toHaveAttribute('aria-pressed','true')
  }finally{await first.close();await second.close()}
})

test('tab navigates native cells, clicking away saves sticky text, and scoped layout plugins survive reload',async({page})=>{
  await open(page,'keyboard-editor')
  const dock=page.getByRole('toolbar',{name:'白板工具栏'})
  await dock.getByRole('button',{name:'表格',exact:true}).click();await page.getByRole('button',{name:'2 行 2 列'}).click();await page.getByLabel('画布放置区').click({position:{x:320,y:220}})
  await page.getByRole('button',{name:'编辑单元格'}).click()
  const cell=page.getByRole('textbox',{name:'单元格内容'})
  await cell.fill('议题');await cell.press('Tab');await cell.fill('负责人');await cell.press('Tab');await cell.fill('排期')
  await dock.getByRole('button',{name:'便利贴',exact:true}).click()
  await page.getByLabel('画布放置区').click({position:{x:445,y:130}})
  await page.getByRole('textbox',{name:'便利贴内容'}).fill('点击画布也会保存')
  await dock.getByRole('button',{name:'选择',exact:true}).click()
  const texts=async()=>(await read()).scene.elements.map((e:any)=>e.originalText)
  await expect.poll(texts).toEqual(expect.arrayContaining(['议题','负责人','排期','点击画布也会保存']))
  const plus=dock.getByRole('button',{name:'插入素材与模板'}),picker=page.getByRole('region',{name:'插入素材与模板选项'})
  await plus.click();await picker.getByRole('button',{name:'插件',exact:true}).click()
  const manifest={schema:'officecli-board-plugin/1',id:'weekly',name:'周会工具',actions:[{name:'生成待办区',composition:{title:'周会待办区',layout:'grid',items:[{title:'负责人',body:'确定下一步',kind:'note'}]}}]}
  await picker.getByLabel('选择排版插件').setInputFiles({name:'weekly.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(manifest))})
  await expect(picker.getByRole('button',{name:/生成待办区/})).toBeVisible()
  await page.reload();await plus.click();await picker.getByRole('button',{name:'插件',exact:true}).click();await picker.getByRole('button',{name:/生成待办区/}).click()
  await expect.poll(texts).toContain('周会待办区')
})

test('an object link reopens its exact document and Spec without carrying session credentials',async({browser})=>{
  const ctx=await browser.newContext({permissions:['clipboard-read','clipboard-write'],reducedMotion:'reduce'})
  try{
    const page=await ctx.newPage();await open(page,'link-owner')
    await page.getByRole('toolbar',{name:'白板工具栏'}).getByRole('button',{name:'Spec 文档'}).click()
    await page.getByLabel('画布放置区').click({position:{x:370,y:180}});await page.getByLabel('文档标题').fill('对象定位');await page.getByLabel('文档正文').fill('保留这段文字');await page.getByRole('button',{name:'完成',exact:true}).click()
    await page.getByRole('button',{name:'复制对象链接',exact:true}).click()
    await expect(page.getByText('已复制对象链接',{exact:true})).toBeVisible()
    const link=new URL(await page.evaluate(()=>navigator.clipboard.readText()))
    expect(link.searchParams.get('node-id')).toMatch(/^spec-/);expect(link.searchParams.get('doc-id')).toBe('canvas-accept');expect([...link.searchParams.keys()].sort()).toEqual(['doc-id','locale','node-id'])
    await page.goto(link.href);await page.getByRole('button',{name:'全屏',exact:true}).click();await expect(page.getByLabel('文档标题')).toHaveValue('对象定位')
    const guest=await browser.newPage();await guest.goto(link.href);await expect(guest.getByPlaceholder('doc-…')).toHaveValue('canvas-accept');await expect(guest.getByRole('toolbar',{name:'白板工具栏'})).toHaveCount(0);await guest.close()
  }finally{await ctx.close()}
})

test('a legacy Spec becomes rich blocks and two live writers plus a stale MCP agent converge within one paragraph', async ({
  browser,
}, info) => {
  test.setTimeout(90000)
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  )
  const agent = new Client({ name: 'Spec-editor-agent', version: '1' }),
    contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const [alice, bob] = await Promise.all(contexts.map((c) => c.newPage()))
  const key = 'spec-concurrent',
    bodyId = key + '-body',
    initial = '我们🙂计划春季发布'
  const at = await read(),
    objects = [
      {
        id: key,
        type: 'rectangle',
        x: 80,
        y: 80,
        width: 520,
        height: 300,
        backgroundColor: '#ffffff',
      },
      {
        id: key + '-title',
        type: 'text',
        x: 106,
        y: 101,
        width: 465,
        height: 38,
        text: '发布计划',
        originalText: '发布计划',
        fontSize: 27,
        fontFamily: 2,
        lineHeight: 1.25,
      },
      {
        id: bodyId,
        type: 'text',
        x: 106,
        y: 161,
        width: 465,
        height: 65,
        text: initial + '\n里程碑',
        originalText: initial + '\n里程碑',
        fontSize: 17,
        fontFamily: 2,
        lineHeight: 1.25,
      },
    ].map((e, i) => ({
      ...e,
      groupIds: [key + '-g'],
      customData: {
        officeBoard: {
          kind: 'spec',
          root: key,
          part: ['paper', 'title', 'body'][i],
        },
      },
    }))
  expect(
    (
      await request('/canvas/patch', {
        method: 'POST',
        body: JSON.stringify(
          batch(
            at.revision,
            objects.map((element) => ({ op: 'element.add', element })),
          ),
        ),
      })
    ).ok,
  ).toBe(true)
  const form = (p: Page) => p.getByRole('form', { name: '编辑 Spec 文档' })
  const editor = (p: Page) => form(p).getByRole('textbox', { name: '文档正文' })
  async function range(p: Page, text: string, start: number, end = start) {
    await editor(p).evaluate(
      (el, args) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const pos = node.textContent?.indexOf(args.text) ?? -1
          if (pos < 0) continue
          ;(el as HTMLElement).focus()
          const r = document.createRange()
          r.setStart(node, pos + args.start)
          r.setEnd(node, pos + args.end)
          const s = getSelection()!
          s.removeAllRanges()
          s.addRange(r)
          document.dispatchEvent(new Event('selectionchange'))
          return
        }
        throw Error('找不到文字 ' + args.text)
      },
      { text, start, end },
    )
  }
  const held = new Map<Page, () => void>()
  try {
    await Promise.all([open(alice, 'alice'), open(bob, 'bob')])
    for (const p of [alice, bob])
      await p.goto(uiUrl + '/?locale=zh-CN&doc-id=canvas-accept&node-id=' + key)
    await alice.getByRole('button', { name: '编辑文档', exact: true }).click()
    await bob.getByRole('button', { name: '全屏', exact: true }).click()
    await expect(editor(alice)).toContainText(initial)
    await expect(form(bob)).toHaveAttribute('data-full', 'true')
    await range(alice, '里程碑', 0, 3)
    await form(alice).getByLabel('块样式').selectOption('h2')
    await expect(editor(bob).locator('h2')).toHaveText('里程碑')
    await range(bob, '我们', 0, 2)
    await form(bob).getByRole('button', { name: '粗体', exact: true }).click()
    await expect(editor(alice).locator('strong')).toHaveText('我们')
    await agent.connect(
      new StreamableHTTPClientTransport(
        new URL(apiUrl + '/v1/documents/canvas-accept/mcp'),
        {
          requestInit: {
            headers: { Authorization: 'Bearer ' + token('spec-agent') },
          },
        },
      ),
    )
    async function call(name: string, params: Record<string, unknown>) {
      const r = await agent.callTool({
        name,
        arguments: { document_id: 'canvas-accept', ...params },
      })
      const t = (r.content as { text: string }[])[0].text
      expect(r.isError, t).not.toBe(true)
      return JSON.parse(t)
    }
    const seen = await call('hcd_read', { resource: 'canvas', node_id: bodyId })
    expect(seen.scene.elements[0].customData.officeSpec.blocks[0]).toBe(initial)
    // Both people type before either write arrives. Deliver Bob first so the
    // agent edits a genuinely historical revision, with Alice still in flight.
    let capture = true
    for (const p of [alice, bob])
      await p.route('**/canvas/patch', async (route) => {
        if (
          capture &&
          route
            .request()
            .postDataJSON()
            .operations.some((o: any) => o.op === 'spec.update')
        )
          await new Promise<void>((resolve) => held.set(p, resolve))
        await route.continue()
      })
    await range(alice, '我们', 0)
    await alice.keyboard.insertText('建议：')
    await range(alice, '计划', 0, 2)
    await form(alice).getByRole('button', { name: '下划线', exact: true }).click()
    await range(bob, '春季', 1)
    await bob.keyboard.insertText('（候选）')
    await expect.poll(() => held.size).toBe(2)
    capture = false
    held.get(bob)!()
    held.delete(bob)
    await expect
      .poll(
        async () =>
          (await read()).scene.elements.find((e: any) => e.id === bodyId)
            .originalText,
      )
      .toContain('春（候选）季')
    const beforeAgent = (await read()).revision
    expect(beforeAgent).toBeGreaterThan(seen.revision)
    const edit = batch(seen.revision, [
      {
        op: 'spec.splice',
        id: bodyId,
        block: 0,
        start: 5,
        end: 7,
        expected: '春季',
        insert: '秋季',
      },
    ])
    await call('hcd_patch', {
      mode: 'canvas',
      expected_revision: seen.revision,
      collaboration_epoch: seen.collaborationEpoch,
      patch: edit,
    })
    held.get(alice)!()
    held.delete(alice)
    const persisted = async () => {
      const r = await read()
      return r.scene.elements.find((el: any) => el.id === bodyId)
        .originalText as string
    }
    const pattern =
      /^建议：我们🙂计划(?:（候选）秋季|秋季（候选）)发布\n里程碑$/
    await expect.poll(persisted).toMatch(pattern)
    const merged = await persisted(),
      line = merged.split('\n')[0]
    for (const p of [alice, bob]) {
      await expect(editor(p).locator('p').first()).toHaveText(line)
      await expect(editor(p).locator('h2')).toHaveText('里程碑')
      await expect(editor(p).locator('strong')).toContainText('我们')
      await expect(editor(p).locator('u')).toHaveText('计划')
    }
    await form(alice).getByRole('button', { name: '全屏编辑' }).click()
    await expect(editor(alice).locator('p').first()).toHaveText(line)
    await form(bob).getByRole('button', { name: '返回画布' }).click()
    await expect(editor(bob).locator('h2')).toHaveText('里程碑')
    await bob.screenshot({ path: info.outputPath('spec-inline.png') })
    await alice.screenshot({ path: info.outputPath('spec-full.png') })
    await form(bob).getByRole('button', { name: '完成' }).click()
    const preview = bob
      .getByRole('article', { name: 'Spec 正文预览' })
      .filter({ hasText: '里程碑' })
    await expect(preview.locator('strong')).toContainText('我们')
    await expect(preview.locator('u')).toHaveText('计划')
    await expect(preview.locator('h2')).toHaveText('里程碑')
    await bob.reload()
    await expect(preview.locator('p').first()).toHaveText(line)
    const verify = await call('hcd_read', {
      resource: 'canvas',
      node_id: bodyId,
    })
    expect(verify.scene.elements[0].originalText).toBe(merged)
    const competing = batch(seen.revision, [
      {
        op: 'spec.splice',
        id: bodyId,
        block: 0,
        start: 5,
        end: 7,
        expected: '春季',
        insert: '冬季',
      },
    ])
    const rejected = await agent.callTool({
      name: 'hcd_patch',
      arguments: {
        document_id: 'canvas-accept',
        mode: 'canvas',
        expected_revision: seen.revision,
        collaboration_epoch: seen.collaborationEpoch,
        patch: competing,
      },
    })
    expect(rejected.isError).toBe(true)
    expect((await read()).revision).toBe(verify.revision)
    expect(await persisted()).toBe(merged)
    writeFileSync(
      info.outputPath('spec-convergence.json'),
      JSON.stringify(
        {
          baseline: initial,
          baseRevision: seen.revision,
          revisionBeforeAgent: beforeAgent,
          finalRevision: verify.revision,
          competingRewriteRejected: rejected.isError,
          alice: await editor(alice).innerText(),
          reopened: await preview.innerText(),
          mcp: merged,
        },
        null,
        2,
      ),
    )
  } finally {
    for (const resume of held.values()) resume()
    await agent.close()
    await Promise.all(contexts.map((c) => c.close()))
  }
})

test('structured Spec blocks retain their formatting on the canvas and for a reader after reload', async ({
  browser,
}) => {
  const author = await browser.newPage()
  const reader = await browser.newPage()
  try {
    await open(author, 'spec-author')
    await author
      .getByRole('toolbar', { name: '白板工具栏' })
      .getByRole('button', { name: 'Spec 文档' })
      .click()
    await author
      .getByLabel('画布放置区')
      .click({ position: { x: 260, y: 170 } })
    const doc = author.getByRole('form', { name: '编辑 Spec 文档' })
    const body = doc.getByRole('textbox', { name: '文档正文' })
    await doc.getByLabel('文档标题').fill('富文本发布说明')
    await body.click()
    for (const [index, line] of [
      '验收步骤',
      '分组检查',
      '依次复核',
      '证据准确',
      'release()',
    ].entries()) {
      if (index) await author.keyboard.press('Enter')
      await author.keyboard.insertText(line)
    }
    await body.getByText('验收步骤', { exact: true }).click()
    await doc.getByLabel('块样式').selectOption('h3')
    await expect(body.locator('h3')).toHaveText('验收步骤')
    for (const [line, command] of [
      ['分组检查', '无序列表'],
      ['依次复核', '有序列表'],
      ['证据准确', '引用'],
    ]) {
      await body.getByText(line, { exact: true }).click()
      await doc.getByRole('button', { name: command, exact: true }).click()
    }
    await body.getByText('release()', { exact: true }).click()
    await doc.getByLabel('块样式').selectOption('code')
    await expect(body.locator('pre')).toHaveText('release()')
    await doc.getByRole('button', { name: '完成' }).click()
    await expect(doc).toHaveCount(0)
    const snapshot = await read()
    const title = snapshot.scene.elements.find(
      (e: any) => e.originalText === '富文本发布说明',
    )
    const id = title.customData.officeBoard.root
    const paper = snapshot.scene.elements.find((e:any) => e.id === id)
    expect(title.width).toBe(paper.width - 56)
    expect(snapshot.scene.elements.find((e:any) => e.id === id + '-body').width).toBe(title.width)
    const article = (p: Page) =>
      p.locator('article[data-spec-root="' + id + '"]')
    const blocks = [
      ['h3', '验收步骤'],
      ['ul li', '分组检查'],
      ['ol li', '依次复核'],
      ['blockquote', '证据准确'],
      ['pre', 'release()'],
    ]
    for (const [selector, text] of blocks)
      await expect(article(author).locator(selector)).toHaveText(text)
    // Check actual painted pixels. An article can have the correct accessible
    // tree and still be covered by Excalidraw's opaque canvas.
    const heading = article(author).locator('h3')
    const clip = (await heading.boundingBox())!
    const painted = await author.screenshot({ clip })
    await heading.evaluate((el) => {
      el.style.visibility = 'hidden'
    })
    const withoutHeading = await author.screenshot({ clip })
    await heading.evaluate((el) => {
      el.style.visibility = ''
    })
    expect(painted.equals(withoutHeading)).toBe(false)
    await open(reader, 'spec-reviewer', 'read')
    await reader.goto(
      uiUrl + '/?locale=zh-CN&doc-id=canvas-accept&node-id=' + id,
    )
    await reader.getByRole('button', { name: '全屏', exact: true }).click()
    const readonly = reader.getByRole('textbox', { name: '文档正文' })
    await expect(readonly).toHaveAttribute('contenteditable', 'false')
    await expect(reader.getByRole('toolbar', { name: '正文格式' })).toHaveCount(
      0,
    )
    for (const [selector, text] of blocks)
      await expect(readonly.locator(selector)).toHaveText(text)
    await author.reload()
    for (const [selector, text] of blocks)
      await expect(article(author).locator(selector)).toHaveText(text)
  } finally {
    await Promise.all([author.close(), reader.close()])
  }
})

test('Spec sentence presence in both views and selective undo preserve a second writer inside the rewrite',async({browser},info)=>{
  const key='spec-sentence-proof', id=key+'-body', initial='计划🙂：春季发布。春季发布。', phrase='春季发布。'
  const base=await read()
  const shape=(part:string,text?:string)=>({
    id:part==='paper'?key:key+'-'+part,type:text?'text':'rectangle',x:text?112:80,y:part==='body'?168:part==='title'?106:80,
    width:text?450:520,height:text?48:280,groupIds:[key+'-group'],backgroundColor:text?'transparent':'#ffffff',
    ...(text && {text,originalText:text,fontSize:part==='title'?24:17,fontFamily:2,lineHeight:1.25}),
    customData:{officeBoard:{kind:'spec',root:key,part}}
  })
  expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(base.revision,[shape('paper'),shape('title','上线安排'),shape('body',initial)].map(element=>({op:'element.add',element}))))})).ok).toBe(true)
  const contexts=await Promise.all([browser.newContext({viewport:{width:1440,height:950}}),browser.newContext({viewport:{width:1280,height:900}})])
  const [alice,bob]=await Promise.all(contexts.map(c=>c.newPage()))
  const form=(p:Page)=>p.getByRole('form',{name:'编辑 Spec 文档'}), prose=(p:Page)=>form(p).getByRole('textbox',{name:'文档正文'})
  const persisted=async()=>(await read()).scene.elements.find((el:any)=>el.id===id).originalText as string
  // DOM ranges (UTF-16) cross the actual marked text and peer decorations.
  async function select(p:Page,from:number,to=from){
    await prose(p).evaluate((el,{from,to})=>{
      const row=el.querySelector('p')!
      const nodeAt=(index:number):[Node,number]=>{
        const walk=document.createTreeWalker(row,NodeFilter.SHOW_TEXT)
        let n:Node|null
        while((n=walk.nextNode())){ const size=n.textContent!.length; if(index<=size)return [n,index];index-=size }
        throw Error('Offset outside the rendered paragraph')
      }
      ;(el as HTMLElement).focus()
      const range=document.createRange();range.setStart(...nodeAt(from));range.setEnd(...nodeAt(to))
      const sel=getSelection()!;sel.removeAllRanges();sel.addRange(range);document.dispatchEvent(new Event('selectionchange'))
    },{from,to})
  }
  const errors:string[]=[]
  for(const p of [alice,bob])p.on('pageerror',e=>errors.push(e.message))
  let release:(()=>void)|undefined
  try{
    await Promise.all([open(alice,'alice'),open(bob,'bob')])
    for(const p of [alice,bob])await p.goto(uiUrl+'/?locale=zh-CN&doc-id=canvas-accept&node-id='+key)
    await alice.getByRole('button',{name:'编辑文档',exact:true}).click()
    const second=initial.lastIndexOf(phrase)
    await select(alice,second,initial.length)
    const preview=bob.getByRole('article',{name:'Spec 正文预览'}).filter({hasText:initial})
    await expect(preview.locator('[data-spec-peer="alice"]')).toBeVisible()
    await expect(preview.locator('[data-spec-selection="alice"]')).toHaveText(phrase)
    await bob.getByRole('button',{name:'全屏',exact:true}).click()
    await expect(form(bob)).toHaveAttribute('data-full','true')
    await form(bob).getByRole('textbox',{name:'文档标题'}).evaluate(el=>{
      const input=el as HTMLInputElement;input.focus();input.setSelectionRange(0,2);input.dispatchEvent(new Event('select',{bubbles:true}));document.dispatchEvent(new Event('selectionchange'))
    })
    await expect(form(alice).locator('.spec-title-overlay [data-spec-selection="bob"]')).toHaveText('上线')
    await select(bob,0,2)
    await expect(prose(alice).locator('[data-spec-selection="bob"]')).toHaveText('计划')
    await expect(prose(alice).locator('[data-spec-peer="bob"]')).toBeVisible()
    await expect(prose(bob).locator('[data-spec-peer="alice"]')).toBeVisible()
    await expect(prose(bob).locator('[data-spec-selection="alice"]')).toHaveText(phrase)
    await form(alice).getByRole('button',{name:'让全局 AI 改写选句'}).click()
    const input=alice.getByRole('textbox',{name:'Agent 任务',exact:true})
    await expect(input).toHaveValue(/改写/)
    await input.fill('将选中的第二句话改写为秋季上线。')
    const waiting=new Promise<void>(r=>modelWaiting=r)
    const started=alice.waitForResponse(r=>r.url().endsWith('/agent-runs') && r.request().method()==='POST')
    await alice.getByRole('button',{name:'启动 Agent',exact:true}).click()
    const response=await started
    expect(response.status(),await response.text()).toBe(202)
    const grant=response.request().postDataJSON().target.specSentence
    expect(grant).toMatchObject({id,block:0,start:Array.from(initial.slice(0,second)).length,expected:phrase})
    await waiting;modelWaiting=null
    const ai='[data-spec-peer][data-agent="true"]'
    for(const p of [alice,bob]){
      await expect(prose(p).locator(ai)).toBeVisible()
      const name=await prose(p).locator(ai).getAttribute('data-spec-peer')
      expect(name).toBe('墨点')
      const caret=prose(p).locator(ai)
      const synchronized=()=>caret.evaluate(node=>getComputedStyle(node,'::after').translate === getComputedStyle(node.querySelector('.agent-nib')!).translate)
      await expect(caret).toHaveCSS('animation-name','agent-idle-glide')
      await expect.poll(synchronized).toBe(true)
      await p.emulateMedia({reducedMotion:'reduce'})
      await expect(caret).toHaveCSS('animation-name','none')
      await expect(caret.locator('.agent-nib')).toHaveCSS('translate','none')
      await expect.poll(()=>caret.evaluate(node=>getComputedStyle(node,'::after').translate)).toBe('none')
      await p.emulateMedia({reducedMotion:'no-preference'})
      await expect(prose(p).locator('[data-agent="false"] .agent-nib')).toHaveCount(0)
      expect(await prose(p).locator('[data-spec-selection="'+name+'"]').allTextContents().then(t=>t.join(''))).toBe(phrase)
    }
    await alice.screenshot({path:info.outputPath('spec-inline-global-ai.png')})
    await bob.screenshot({path:info.outputPath('spec-full-selection.png')})
    // Insert inside the selected source *after* the model read it.
    await select(bob,second+1);await bob.keyboard.insertText('（甲）')
    await expect.poll(persisted).toBe(initial.slice(0,second+1)+'（甲）'+initial.slice(second+1))
    allowModel?.();allowModel=null
    await expect.poll(persisted).toContain('秋季上线。')
    const merged=await persisted()
    expect(merged).toContain('（甲）')
    expect(merged.startsWith(initial.slice(0,second))).toBe(true)
    for(const p of [alice,bob])await expect(prose(p).locator('p')).toHaveText(merged)
    // The replacement range comes from the committed Yrs items, not a text search.
    for(const p of [alice,bob]){
      await expect(prose(p).locator(ai+' .agent-nib')).toHaveAttribute('data-phase','writing')
      await expect(prose(p).locator(ai)).toHaveCSS('animation-name','none')
      await expect(prose(p).locator(ai+' .agent-nib')).toHaveCSS('translate','none')
      expect(await prose(p).locator(ai).evaluate(node=>getComputedStyle(node,'::after').translate)).toBe('none')
      const aiName=await prose(p).locator(ai).getAttribute('data-spec-peer')
      await expect.poll(async()=>(await prose(p).locator('[data-spec-selection="'+aiName+'"]').allTextContents()).join('')).toBe('秋季上线。')
    }
    const undo=form(alice).getByRole('button',{name:'撤销这次 AI 改写'})
    await expect(undo).toBeVisible()
    await expect(form(bob).getByRole('button',{name:'撤销这次 AI 改写'})).toHaveCount(0)
    const revision=Number((await undo.getAttribute('title'))!.match(/r(\d+)/)![1])
    const deny=await request('/canvas/spec-undo',{method:'POST',body:JSON.stringify({revision,id})},'bob')
    expect(deny.status).toBe(403)
    // A second insertion is inside the AI replacement and deliberately reaches
    // the authoritative server only AFTER Alice's selective undo.
    let signalHeld!:()=>void
    const held=new Promise<void>(resolve=>{signalHeld=resolve})
    await bob.route('**/canvas/patch',async route=>{
      if(route.request().postDataJSON().operations.some((op:any)=>op.op==='spec.update')){
        await new Promise<void>(r=>{release=r;signalHeld()})
      }
      await route.continue()
    },{times:1})
    await select(bob,merged.indexOf('秋季上线。')+1);await bob.keyboard.insertText('（乙）')
    await held
    await undo.click()
    await expect.poll(persisted).not.toContain('秋季上线。')
    release!();release=undefined
    await expect.poll(persisted).toContain('（乙）')
    const restored=await persisted()
    expect(restored.replace('（甲）','').replace('（乙）','')).toBe(initial)
    for(const p of [alice,bob])await expect(prose(p).locator('p')).toHaveText(restored)
    // Retry the same receipt: no duplicate restored characters or new revision.
    const retried=await request('/canvas/spec-undo',{method:'POST',body:JSON.stringify({revision,id})})
    expect((await retried.json()).idempotentReplay).toBe(true)
    await alice.screenshot({path:info.outputPath('spec-selective-undo.png')})
    await bob.reload()
    await expect(bob.getByRole('article',{name:'Spec 正文预览'}).filter({hasText:restored})).toBeVisible()
    writeFileSync(info.outputPath('verified-text.json'),JSON.stringify({initial,grant:{start:grant.start,end:grant.end},merged,restored},null,2))
    await info.attach('verified-text',{body:JSON.stringify({initial,grant:{start:grant.start,end:grant.end},merged,restored},null,2),contentType:'application/json'})
    expect(errors).toEqual([])
  }finally{allowModel?.();allowModel=null;modelWaiting=null;release?.();await Promise.all(contexts.map(c=>c.close()))}
})

test('named Agent board pointers and cursor chat distinguish waiting and writing from a person', async ({ page }) => {
  await open(page)
  await read()
  const actor=randomUUID(), other=randomUUID(), human=randomUUID()
  const publish=async (clientId:string,name:string,phase:'idle'|'writing'|null,x:number)=>{
    const response=await request('/canvas/presence', {
      method:'POST',
      headers:phase?{'X-HCD-Agent-Edit':'true','X-HCD-Agent-Name':Buffer.from(name).toString('base64url')}: {},
      body:JSON.stringify({clientId,pointer:{x,y:82},...(phase&&{agentPhase:phase}),chat:{id:randomUUID(),text:'看看这一处'}}),
    },phase?'delegate':name)
    expect(response.ok,await response.text()).toBe(true)
  }
  await publish(actor,'折线','idle',56)
  await publish(other,'尺规','writing',182)
  await publish(human,'林夏',null,98)
  const pointer=(name:string)=>page.locator('.canvas-peer-agent').filter({hasText:name})
  await expect(pointer('折线')).toHaveCSS('animation-name','agent-idle-glide')
  await expect(pointer('尺规')).toHaveCSS('animation-name','none')
  const tones=await pointer('尺规').locator('svg').evaluate(svg=>{
    const brightness=(color:string)=>{
      const [r,g,b]=color.match(/[\d.]+/g)!.map(Number)
      return .2126*r+.7152*g+.0722*b
    }
    const paint=(selector:string)=>getComputedStyle(svg.querySelector(selector)!)
    return {light:brightness(paint('.agent-arrow-light').stroke),face:brightness(paint('.agent-arrow-face').fill),edge:brightness(paint('.agent-arrow-edge').stroke)}
  })
  expect(tones.light).toBeGreaterThan(tones.face)
  expect(tones.edge).toBeLessThan(tones.face)
  await expect(pointer('折线').locator('svg circle')).toHaveCount(0)
  // Sample a full orbit. The tip and the label retain the same screen-space separation.
  const frames=await pointer('折线').evaluate(el=>{
    const face=el.querySelector<SVGPathElement>('.agent-arrow-face')!
    const label=el.querySelector('.agent-name-chip')!
    const animation=el.getAnimations()[0]
    const duration=Number(animation.effect!.getComputedTiming().duration)
    animation.pause()
    const samples=Array.from({length:8},(_,i)=>{
      animation.currentTime=duration*i/8
      const matrix=face.getScreenCTM()!
      const tip=face.getPointAtLength(0).matrixTransform(matrix)
      const peer=el.getBoundingClientRect(), name=label.getBoundingClientRect()
      return {x:tip.x,y:tip.y, vector:[tip.x-name.x,tip.y-name.y], heading:[matrix.a,matrix.b,matrix.c,matrix.d],
        peer:[peer.x,peer.y],nameX:name.x,nameY:name.y}
    })
    animation.play()
    return samples
  })
  const centerX=(frames[0].x+frames[4].x)/2, centerY=(frames[2].y+frames[6].y)/2
  const rx=frames[0].x-centerX, ry=frames[2].y-centerY
  const labelX=(frames[0].nameX+frames[4].nameX)/2, labelY=(frames[2].nameY+frames[6].nameY)/2
  expect(rx).toBeGreaterThan(ry*1.7)
  expect(ry).toBeGreaterThan(1)
  for (const [i,pose] of frames.entries()) {
    const angle=i*Math.PI/4
    expect(pose.heading).toEqual(frames[0].heading)
    expect(pose.peer).toEqual(frames[0].peer)
    pose.vector.forEach((axis,n)=>expect(axis).toBeCloseTo(frames[0].vector[n],1))
    expect(pose.x-centerX).toBeCloseTo(rx*Math.cos(angle),1)
    expect(pose.y-centerY).toBeCloseTo(ry*Math.sin(angle),1)
    expect(pose.nameX-labelX).toBeCloseTo(rx*Math.cos(angle),1)
    expect(pose.nameY-labelY).toBeCloseTo(ry*Math.sin(angle),1)
  }
  await expect(page.locator('.board-chat-bubble[data-agent=true] b').filter({hasText:'AI · 折线'})).toBeVisible()
  await expect(page.locator('.board-chat-bubble:not([data-agent]) b').filter({hasText:'林夏'})).toBeVisible()
  await expect(pointer('林夏')).toHaveCount(0)
  await publish(actor,'折线','writing',64)
  for (const part of ['.agent-nib','.agent-name-chip']) {
    await expect(pointer('折线').locator(part)).toHaveCSS('animation-name','none')
    await expect(pointer('折线').locator(part)).toHaveCSS('translate','none')
  }
})

test('FigJam notes edit in place, inherit paper color and reopen by ID; comment pins work at board zoom', async ({ page }, info) => {
  await page.setViewportSize({width:891,height:1033})
  await open(page,'林夏')
  const ai = page.getByRole('button',{name:'AI 协作',exact:true})
  if (await ai.count() && await ai.getAttribute('aria-pressed') === 'true') await ai.click()
  const dock = page.getByRole('toolbar',{name:'白板工具栏'})
  const board = page.getByRole('main',{name:'自由画布'}), bounds = (await board.boundingBox())!
  const placement = page.getByLabel('画布放置区')
  const field = page.getByRole('textbox',{name:'便利贴内容'})
  const point = {x:Math.round(bounds.width*.28),y:Math.round(bounds.height*.39)}
  await dock.getByRole('button',{name:'选择',exact:true}).click()
  await page.keyboard.press('s')
  await placement.hover({position:point})
  const ghost = page.locator('.board-sticky-ghost')
  await expect(ghost).toBeVisible()
  const start = (await ghost.boundingBox())!
  await placement.click({position:point})
  await expect(field).toBeFocused()
  const face = (await page.locator('.board-note-face').boundingBox())!
  expect(Math.abs(start.x-face.x)+Math.abs(start.y-face.y)).toBeLessThan(2)
  await field.fill('先让三个试点团队试用')
  await field.press('Escape')
  const namedNote = async (body:string) => {
    const scene=(await read()).scene.elements
    const text=scene.find((item:any)=>!item.isDeleted && item.originalText===body)
    return {text,root:text && scene.find((item:any)=>item.id===text.containerId)}
  }
  await expect.poll(async()=>(await namedNote('先让三个试点团队试用')).root?.width).toBe(192)
  const note=await namedNote('先让三个试点团队试用')
  expect(note.root.height).toBe(192)
  const shadow = page.locator('[data-note-id="'+note.root.id+'"]')
  await expect(shadow).toHaveText('林夏')
  await page.getByLabel('便利贴颜色',{exact:true}).click()
  await page.getByRole('button',{name:'蜜桃橙',exact:true}).click()
  await expect.poll(async()=>(await namedNote('先让三个试点团队试用')).root?.backgroundColor).toBe('#ffcba7')
  await page.getByRole('button',{name:'显示署名'}).click()
  await expect(shadow).toHaveText('')
  await page.getByRole('button',{name:'显示署名'}).click()
  await expect(shadow).toHaveText('林夏')
  const sheet=(await shadow.boundingBox())!
  await page.mouse.dblclick(sheet.x+sheet.width*.5,sheet.y+sheet.height*.45)
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('先让三个试点团队试用')
  await field.fill('先让三个试点团队试用\n记录第一次上手的反馈')
  await field.press('Control+Enter')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('')
  await field.fill('下周回访\n一起核对发布清单')
  await field.press('Escape')
  const firstBody='先让三个试点团队试用\n记录第一次上手的反馈', secondBody='下周回访\n一起核对发布清单'
  await expect.poll(async()=>(await namedNote(secondBody)).root?.backgroundColor).toBe('#ffcba7')
  const first=await namedNote(firstBody), second=await namedNote(secondBody)
  expect(first.text.id).toBe(note.text.id)
  expect(first.root.id).toBe(note.root.id)
  expect([first.root.x,first.root.y]).toEqual([note.root.x,note.root.y])
  expect(second.root.x).toBeGreaterThanOrEqual(first.root.x+first.root.width+15)
  expect(second.root.y).toBe(first.root.y)
  await dock.getByRole('button',{name:'评论',exact:true}).click()
  await placement.click({position:{x:point.x+40,y:point.y-72}})
  await page.getByRole('textbox',{name:'评论内容'}).fill('下周一起看试点反馈')
  await page.getByRole('button',{name:'发送',exact:true}).click()
  const pin=page.getByRole('button',{name:'打开林夏的评论',exact:true})
  await expect(pin).toBeVisible()
  const ratio = await pin.evaluate(el => el.querySelector('svg')!.getBoundingClientRect().width/el.getBoundingClientRect().width)
  expect(ratio).toBeCloseTo(1, 2)
  await pin.click()
  await expect(page.getByRole('form',{name:'评论线程'})).toContainText('下周一起看试点反馈')
  await page.getByRole('button',{name:'关闭编辑'}).click()
  const savedPin = async () => (await read()).scene.elements.find((el:any) => !el.isDeleted && el.customData?.officeComment === '下周一起看试点反馈')
  await expect.poll(savedPin).toBeTruthy()
  const pinBefore = await savedPin()
  const originalPin = (await pin.boundingBox())!
  await pin.hover()
  await page.mouse.down()
  await page.mouse.move(originalPin.x+originalPin.width/2+25,originalPin.y+originalPin.height/2+22,{steps:6})
  await page.mouse.up()
  await expect(page.getByRole('form',{name:'评论线程'})).toHaveCount(0)
  await expect.poll(async()=>Math.round((await pin.boundingBox())!.x-originalPin.x)).toBe(25)
  await expect.poll(async()=>(await savedPin())?.x).toBeGreaterThan(pinBefore.x)
  await page.reload()
  await expect(shadow).toContainText('林夏')
  await expect(pin).toBeVisible()
  // Quick creation pans past occupied space, keeping the new sheet in the viewport.
  const reloaded = (await page.locator('[data-note-id="'+second.root.id+'"]').boundingBox())!
  await page.mouse.click(reloaded.x+reloaded.width/2,reloaded.y+reloaded.height/2)
  await expect(page.getByRole('button',{name:'编辑便利贴'})).toBeVisible()
  await page.screenshot({path:info.outputPath('figjam-paper-comments.png')})
})

test('More inserts working code, links, media, mind-map branches and editable workshop templates', async({page},info)=>{
  await open(page,'builtin-author')
  await page.emulateMedia({reducedMotion:'reduce'})
  const toggle=page.getByRole('button',{name:'AI 协作',exact:true})
  if(await toggle.getAttribute('aria-pressed')==='true')await toggle.click()
  const dock=page.getByRole('toolbar',{name:'白板工具栏'}),picker=page.getByRole('region',{name:'插入素材与模板选项'})
  const plus=dock.getByRole('button',{name:'插入素材与模板',exact:true})
  const go=async(tab:string)=>{await plus.click();await picker.getByRole('button',{name:tab,exact:true}).click()}
  const place=async(name:string,x:number,y:number)=>{
    await go('更多');await picker.getByRole('button',{name,exact:true}).click();await page.getByLabel('画布放置区').click({position:{x,y}})
  }
  await go('更多')
  for(const name of ['思维导图','Spec 文档','代码块','计时器','媒体','链接'])await expect(picker.getByRole('button',{name,exact:true})).toBeVisible()
  await page.screenshot({path:info.outputPath('figjam-more-tools.png')})
  await picker.getByLabel('搜索插入项目').fill('code block')
  await picker.getByLabel('搜索插入项目').press('Enter')
  await page.getByLabel('画布放置区').click({position:{x:130,y:110}})
  let form=page.getByRole('form',{name:'编辑代码块'})
  await form.getByLabel('代码语言').selectOption('Python')
  await form.getByLabel('代码内容').fill('def launch():\n  return "ship"')
  await form.getByRole('button',{name:'完成'}).click()
  const code=page.getByLabel('代码块预览').filter({hasText:'launch'})
  await expect(code.locator('.hljs-keyword').first()).toHaveText('def')
  await place('链接',580,120)
  form=page.getByRole('form',{name:'编辑链接'})
  await form.getByLabel('网页地址').fill('https://example.com/brief')
  await form.getByLabel('链接标题').fill('发布资料')
  await form.getByRole('button',{name:'完成'}).click()
  await expect(page.getByLabel('打开网页')).toHaveAttribute('href','https://example.com/brief')
  await place('思维导图',140,400)
  const name=page.getByLabel('节点名称')
  await name.fill('上市流程');await name.press('Control+Enter')
  await page.getByRole('button',{name:'子节点',exact:true}).click()
  await name.fill('小范围试点');await name.press('Control+Enter')
  await page.getByRole('button',{name:'同级节点',exact:true}).click()
  await name.fill('收集反馈');await name.press('Control+Enter')
  const graph=async()=>(await read()).scene.elements.filter((e:any)=>!e.isDeleted)
  await expect.poll(async()=>(await graph()).filter((e:any)=>e.customData?.officeBuiltin?.kind==='mind').length).toBe(3)
  const roots=(await graph()).filter((e:any)=>e.customData?.officeBuiltin?.kind==='mind')
  expect((await graph()).filter((e:any)=>e.type==='arrow'&&roots.some((n:any)=>n.id===e.startBinding?.elementId)&&roots.some((n:any)=>n.id===e.endBinding?.elementId))).toHaveLength(2)
  await go('更多');await picker.getByRole('button',{name:'媒体',exact:true}).click()
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')
  await picker.getByLabel('选择白板媒体').setInputFiles({name:'board-pixel.png',mimeType:'image/png',buffer:image})
  await page.getByLabel('画布放置区').click({position:{x:650,y:330}})
  await go('更多');await picker.getByRole('button',{name:'媒体',exact:true}).click()
  await picker.getByRole('button',{name:'board-pixel.png',exact:true}).click()
  await page.getByLabel('画布放置区').click({position:{x:670,y:335}})
  await expect.poll(async()=>(await graph()).filter((e:any)=>e.customData?.officeMedia?.name==='board-pixel.png').length).toBe(2)
  await go('模板');await picker.getByLabel('预览SWOT 分析').click()
  await expect(picker.getByRole('region',{name:'模板预览'})).toContainText('机会')
  await page.screenshot({path:info.outputPath('figjam-template-preview.png')})
  await picker.getByRole('button',{name:'使用此模板'}).click()
  await expect.poll(async()=>(await graph()).some((el:any)=>String(el.originalText||'').includes('威胁'))).toBe(true)
  await page.reload()
  await expect(code).toContainText('ship')
  await go('更多');await picker.getByRole('button',{name:'计时器',exact:true}).click()
  const timer=page.getByLabel('共享计时器').first()
  await timer.getByLabel('计时设置').click()
  await timer.getByLabel('分钟',{exact:true}).fill('1');await timer.getByLabel('秒',{exact:true}).fill('24')
  await timer.getByRole('button',{name:'应用'}).click();await expect(timer.getByLabel('剩余时间')).toHaveText('01:24')
  await timer.getByLabel('开始计时').click();await expect(timer.getByLabel('暂停计时')).toBeVisible()
  await go('更多');await picker.getByRole('button',{name:'计时器',exact:true}).click()
  await expect(page.getByLabel('共享计时器')).toHaveCount(1)
  await place('Spec 文档',270,310)
  const spec=page.getByRole('form',{name:'编辑 Spec 文档'})
  await spec.getByRole('textbox',{name:'文档正文'}).fill('插入菜单中的协作文档')
  await spec.getByRole('button',{name:'完成',exact:true}).click()
  await expect(page.getByLabel('Spec 正文预览').filter({hasText:'插入菜单中的协作文档'})).toBeVisible()
})

test('Four hover controls create neighbours and native drags carry Spec objects and prose across two canvases',async({browser},info)=>{
  const alice=await browser.newPage({viewport:{width:1440,height:1050}}),bob=await browser.newPage({viewport:{width:1440,height:1050}})
  try{
    await Promise.all([open(alice,'paper-owner'),open(bob,'paper-peer')])
    for(const p of [alice,bob]){await p.emulateMedia({reducedMotion:'reduce'});const ai=p.getByRole('button',{name:'AI 协作',exact:true});if(await ai.getAttribute('aria-pressed')==='true')await ai.click()}
    const ids={spec:'spec-drop-fixture',note:'sticky-drop-fixture',shape:'shape-drop-fixture',front:'front-drop-fixture',text:'text-drop-fixture'}
    const x=3400,y=2800
    const rect=(id:string,dx:number,dy:number,w:number,h:number,color:string)=>({id,type:'rectangle',x:x+dx,y:y+dy,width:w,height:h,roughness:0,strokeColor:'#444444',backgroundColor:color,fillStyle:'solid'})
    const txt=(id:string,dx:number,dy:number,text:string)=>({id,type:'text',x:x+dx,y:y+dy,width:180,height:25,text,originalText:text,fontSize:19,fontFamily:2,lineHeight:1.25})
    const tag=(kind:string,root:string,part?:string)=>({officeBoard:{kind,root,part}})
    const sx=440,sy=80
    const seed=[rect(ids.shape,54,130,82,62,'#bcd4fc'),rect(ids.front,88,150,80,60,'#ffce99'),
      {...rect(ids.spec,sx,sy,420,335,'#ffffff'),customData:tag('spec',ids.spec,'paper')},
      {...txt(ids.spec+'-title',sx+25,sy+24,'流转测试'),customData:tag('spec',ids.spec,'title')},
      {...txt(ids.spec+'-body',sx+25,sy+82,'可拖出的段落'),customData:tag('spec',ids.spec,'body')},
      {...rect(ids.note,260,265,120,120,'#ffafa3'),customData:{officeBoard:{kind:'sticky',root:ids.note,author:'小雨'}}},
      txt(ids.text,95,420,'从画布进入正文')]
    const before=await read();expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(before.revision,seed.map(element=>({op:'element.add',element}))))})).ok).toBeTruthy()
    const paper=(p:Page)=>p.locator('[data-note-id="'+ids.note+'"]')
    const locate=async(p:Page)=>{await expect(paper(p)).toBeAttached();await p.evaluate(({x,y})=>window.dispatchEvent(new CustomEvent('officecli:canvas-locate',{detail:{documentId:'canvas-accept',region:{x:x+5,y:y+20,width:930,height:510}}})),{x,y});await expect(paper(p)).toBeVisible()}
    await Promise.all([locate(alice),locate(bob)])
    // The paper projection is pointer-transparent. Hover its interactive canvas coordinates.
    await expect.poll(async()=>{const r=await paper(alice).boundingBox();return !!r && r.x>=0 && r.x+r.width<=1440}).toBe(true)
    const noteBox=await paper(alice).boundingBox(),z=noteBox!.width/120
    const coord=(dx:number,dy:number)=>({x:noteBox!.x+(dx-260)*z,y:noteBox!.y+(dy-265)*z})
    const drag=async(ax:number,ay:number,bx:number,by:number)=>{const a=coord(ax,ay),b=coord(bx,by);await alice.mouse.move(a.x,a.y);await alice.mouse.down();await alice.mouse.move(b.x,b.y,{steps:12});await alice.mouse.up()}
    const records=async()=>(await read()).scene.elements
    const get=async(id:string)=>(await records()).find((el:any)=>el.id===id)
    await alice.mouse.move(coord(310,330).x,coord(310,330).y)
    const controls=alice.getByRole('group',{name:'相邻便签'})
    for(const side of ['上','右','下','左'])await expect(controls.getByRole('button',{name:'向'+side+'新增便利贴'})).toBeVisible()
    await alice.screenshot({path:info.outputPath('figjam-sticky-four-sides.png')})
    await controls.getByLabel('向上新增便利贴').click()
    const field=alice.getByRole('textbox',{name:'便利贴内容'})
    await expect(field).toBeFocused();await field.fill('上方新便签');await field.press('Escape')
    await expect.poll(async()=>(await records()).find((e:any)=>e.originalText==='上方新便签')?.containerId).toBeTruthy()
    const note=await get((await records()).find((e:any)=>e.originalText==='上方新便签').containerId)
    expect(note.y+note.height).toBeLessThan(y+265);expect(note.backgroundColor).toBe('#ffafa3')
    // A translation outside the paper preserves both native order and explicit indices.
    const paint=async()=>(await records()).filter((el:any)=>el.id===ids.shape||el.id===ids.front).map((el:any)=>[el.id,el.index??null])
    const beforeOrder=await paint()
    await drag(62,137,78,147)
    await expect.poll(async()=>(await get(ids.shape)).x).toBeGreaterThan(x+59)
    expect(await paint()).toEqual(beforeOrder)
    await drag(78,147,sx+240,sy+220)
    await expect.poll(async()=>(await get(ids.shape)).customData?.officeSpecMember?.root).toBe(ids.spec)
    const beforeMove=await Promise.all([get(ids.spec),get(ids.spec+'-title'),get(ids.spec+'-body'),get(ids.shape)])
    await drag(sx+15,sy+14,sx+55,sy+44)
    await expect.poll(async()=>(await get(ids.spec)).x).toBeGreaterThan(beforeMove[0].x+25)
    for(const [i,id] of [ids.spec,ids.spec+'-title',ids.spec+'-body',ids.shape].entries()){
      const el=await get(id);expect(el.x-beforeMove[i].x).toBeCloseTo(40,0);expect(el.y-beforeMove[i].y).toBeCloseTo(30,0)
    }
    const target=coord(sx+110,sy+120)
    await bob.mouse.dblclick(target.x,target.y)
    const peerForm=bob.getByRole('form',{name:'编辑 Spec 文档'})
    await expect(peerForm).toHaveAttribute('data-full','false')
    await expect(peerForm.getByRole('figure')).toHaveCount(0)
    await peerForm.getByLabel('全屏编辑').click();await expect(peerForm.getByRole('figure').locator('img')).toBeVisible()
    await bob.screenshot({path:info.outputPath('spec-embedded-object.png')})
    await drag(111,430,sx+95,sy+210)
    await expect.poll(async()=>!!(await get(ids.text)).isDeleted).toBe(true)
    await expect(peerForm.getByRole('textbox',{name:'文档正文'})).toContainText('从画布进入正文')
    await bob.reload();await locate(bob);await bob.mouse.dblclick(target.x,target.y)
    await expect(peerForm).toHaveAttribute('data-full','false')
    await peerForm.getByLabel('全屏编辑').click()
    const board=bob.getByRole('main',{name:'自由画布'})
    await peerForm.getByRole('figure').dragTo(board,{targetPosition:{x:80,y:430}})
    await expect.poll(async()=>(await get(ids.shape)).customData?.officeSpecMember??null).toBe(null)
    await bob.mouse.dblclick(target.x,target.y)
    const body=peerForm.getByRole('textbox',{name:'文档正文'})
    await expect(body).toContainText('从画布进入正文')
    await body.getByText('从画布进入正文',{exact:true}).click()
    await peerForm.getByLabel('块样式').selectOption('h2')
    await expect(body.locator('h2')).toHaveText('从画布进入正文')
    await peerForm.getByRole('button',{name:'拖出段落或选区'}).dragTo(board,{targetPosition:{x:150,y:440}})
    await expect.poll(async()=>(await records()).some((el:any)=>!el.isDeleted&&el.customData?.officeSpecExcerpt?.text==='从画布进入正文')).toBe(true)
    await expect(alice.locator('[data-spec-root="'+ids.spec+'"]')).not.toContainText('从画布进入正文')
    const boundary=(await board.boundingBox())!
    await bob.mouse.move(boundary.x+158,boundary.y+449);await bob.mouse.down()
    await bob.mouse.move(target.x+65,target.y+90,{steps:12});await bob.mouse.up()
    await expect(alice.locator('[data-spec-root="'+ids.spec+'"] h2')).toHaveText('从画布进入正文')
    await alice.reload();await locate(alice);await expect(alice.locator('[data-spec-root="'+ids.spec+'"]')).toContainText('可拖出的段落')
    await expect(alice.locator('[data-spec-root="'+ids.spec+'"] h2')).toHaveText('从画布进入正文')
    const ownerBoard=alice.getByRole('main',{name:'自由画布'}), bounds=(await ownerBoard.boundingBox())!
    const region=(await alice.locator('[data-spec-root="'+ids.spec+'"]').boundingBox())!
    const dock=alice.getByRole('toolbar',{name:'白板工具栏'}),picker=alice.getByRole('region',{name:'插入素材与模板选项'})
    await dock.getByRole('button',{name:'插入素材与模板',exact:true}).click()
    await picker.getByLabel('搜索插入项目').fill('OK hand')
    await picker.getByRole('button',{name:'放置收到',exact:true}).dragTo(ownerBoard,{targetPosition:{x:region.x-bounds.x+30,y:region.y-bounds.y+22}})
    await expect.poll(async()=>(await records()).filter((el:any)=>el.customData?.officeSpecMember?.root===ids.spec&&el.customData?.officeSticker?.motif==='fluentOkHand').length).toBe(1)
  } finally {await alice.close();await bob.close()}
})

test('each sticky edge creates one signed note and dragging the plus adds a bound connector',async({page})=>{
  await open(page,'four-edges')
  await page.emulateMedia({reducedMotion:'reduce'})
  const ai=page.getByRole('button',{name:'AI 协作',exact:true})
  if(await ai.getAttribute('aria-pressed')==='true')await ai.click()
  const id='four-edge-paper',x=7100,y=6200
  const root={id,type:'rectangle',x,y,width:130,height:130,roughness:0,strokeColor:'transparent',backgroundColor:'#ffafa3',fillStyle:'solid',customData:{officeBoard:{kind:'sticky',root:id,author:'小雨'}}}
  const base=await read();expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(base.revision,[{op:'element.add',element:root}]))})).ok).toBe(true)
  const shadow=page.locator('[data-note-id="'+id+'"]')
  await expect(shadow).toBeAttached()
  await page.evaluate(root=>window.dispatchEvent(new CustomEvent('officecli:canvas-locate',{detail:{documentId:'canvas-accept',region:root}})),root)
  const field=page.getByRole('textbox',{name:'便利贴内容'})
  for(const side of ['上','右','下','左']){
    const box=(await shadow.boundingBox())!
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
    await page.getByLabel('向'+side+'新增便利贴',{exact:true}).click()
    await expect(field).toBeFocused();await field.fill('四向测试'+side);await field.press('Escape')
    const note=async()=>{const {scene}=await read(),label=scene.elements.find((e:any)=>e.originalText==='四向测试'+side&&!e.isDeleted);return scene.elements.find((el:any)=>el.id===label?.containerId)}
    await expect.poll(async()=>(await note())?.customData?.officeBoard?.author).toBe('four-edges')
    const saved=await note()
    expect(saved.backgroundColor).toBe(root.backgroundColor)
    if(side==='上'||side==='下'){expect(saved.x).toBe(x);expect(Math.sign(saved.y-y)).toBe(side==='上'?-1:1)}
    else{expect(saved.y).toBe(y);expect(Math.sign(saved.x-x)).toBe(side==='左'?-1:1)}
  }
  const box=(await shadow.boundingBox())!
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2)
  const handle=(await page.getByLabel('向右新增便利贴',{exact:true}).boundingBox())!
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down()
  await page.mouse.move(box.x+box.width+160,box.y+box.height+125,{steps:8});await page.mouse.up()
  await expect(field).toBeFocused();await field.fill('带连接的便签');await field.press('Escape')
  await expect.poll(async()=>{const scene=(await read()).scene.elements,child=scene.find((el:any)=>el.originalText==='带连接的便签')
    return !!child && scene.some((el:any)=>el.type==='arrow'&&el.startBinding?.elementId===id&&el.endBinding?.elementId===child.containerId)}).toBe(true)
})

test('intentional layer changes persist when overlapping notes are dragged and reopened by a peer',async({browser})=>{
  const a=await browser.newPage(),b=await browser.newPage()
  try{
    await Promise.all([open(a,'layer-author'),open(b,'layer-reader')])
    for(const p of [a,b]){await p.emulateMedia({reducedMotion:'reduce'});const ai=p.getByRole('button',{name:'AI 协作',exact:true});if(await ai.getAttribute('aria-pressed')==='true')await ai.click()}
    const low='layer-mint',high='layer-peach',x=7200,y=8000
    const rect=(id:string,offset:number,color:string)=>({id,type:'rectangle',x:x+offset,y,width:150,height:150,fillStyle:'solid',backgroundColor:color,strokeColor:'transparent',customData:{officeBoard:{kind:'sticky',root:id,author:id}}})
    const before=await read(),create=[rect(low,0,'#bde5ba'),rect(high,60,'#ffafa3')]
    expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(before.revision,create.map(element=>({op:'element.add',element}))))})).ok).toBe(true)
    const locate=async(p:Page)=>{
      const mint=p.locator('[data-note-id="'+low+'"]')
      await expect(mint).toBeAttached()
      await p.evaluate(({x,y})=>window.dispatchEvent(new CustomEvent('officecli:canvas-locate',{detail:{documentId:'canvas-accept',region:{x:x-5,y:y-5,width:230,height:180}}})),{x,y})
      await expect.poll(async()=>{const q=(await mint.boundingBox())!;return q.x>0&&q.x+q.width<1400}).toBe(true)
      return (await mint.boundingBox())!
    }
    const p=await locate(a);await locate(b)
    await a.mouse.click(p.x+14,p.y+70);await a.keyboard.press('ControlOrMeta+BracketRight')
    const order=async()=>{const scene=(await read()).scene.elements;return [low,high].map(id=>scene.find((e:any)=>e.id===id)?.index)}
    await expect.poll(async()=>{const [l,h]=await order();return !!l&&!!h&&l>h}).toBe(true)
    const changed=await order()
    await a.mouse.move(p.x+14,p.y+70);await a.mouse.down();await a.mouse.move(p.x+24,p.y+85,{steps:8});await a.mouse.up()
    await expect.poll(async()=>(await read()).scene.elements.find((el:any)=>el.id===low)?.x).toBeGreaterThan(x+8)
    expect(await order()).toEqual(changed)
    await b.reload();const overlap=await locate(b);await b.mouse.dblclick(overlap.x+overlap.width*.7,overlap.y+overlap.height*.55)
    await expect(b.getByRole('form',{name:'编辑便利贴'}).locator('.board-note-face')).toHaveCSS('background-color','rgb(189, 229, 186)')
  }finally{await a.close();await b.close()}
})

test('double-click edits the exact glyph on the canvas at narrow zoom without moving a wrapped title, paragraphs or attachments', async ({ browser }, info) => {
  const page = await browser.newPage({viewport:{width:707,height:1033},reducedMotion:'reduce'})
  const id = 'spec-inline-layout', note = id + '-note', x = 16000, y = 19000
  const title = '发布评审与多团队协作的落地安排及迭代清单'
  const lines = ['范围和参与团队', '逐字核对这句正文与编辑位置。', '第三段保留原有排版。']
  const tag = (part: string) => ({officeBoard:{kind:'spec',root:id,part}})
  const part = (name: string, content: string, dy: number, width: number, size: number) => ({
    id:id+'-'+name, type:'text', x:x+32, y:y+dy, width, height:45,
    text:content, originalText:content, fontSize:size, fontFamily:2, lineHeight:1.25, autoResize:false, customData:tag(name),
  })
  const elements = [
    {id,type:'rectangle',x,y,width:860,height:555,backgroundColor:'#ffffff',strokeColor:'#dcdde2',fillStyle:'solid',roughness:0,customData:tag('paper')},
    part('title',title,26,335,30), part('body',lines.join('\n'),165,610,20),
    {id:note,type:'rectangle',x:x+405,y:y+171,width:135,height:135,backgroundColor:'#b9ddbc',fillStyle:'solid',roughness:0,
      customData:{officeBoard:{kind:'sticky',root:note,author:'小雨'},officeSpecMember:{root:id,bundle:note,after:1}}},
  ]
  const snapshot = await read()
  expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(snapshot.revision,elements.map(element=>({op:'element.add',element}))))})).ok).toBe(true)
  const locate = async () => {
    await page.goto(uiUrl+'/?locale=zh-CN&doc-id=canvas-accept&node-id='+id)
    await expect(page.locator('article[data-spec-root="'+id+'"]')).toBeVisible()
    await expect(page.getByRole('button',{name:'编辑文档',exact:true})).toBeVisible()
  }
  const glyph = (el: import('@playwright/test').Locator, offset: number) => el.evaluate((node, skip) => {
    const walker = document.createTreeWalker(node,NodeFilter.SHOW_TEXT)
    let text: Node|null
    while ((text=walker.nextNode())) {
      if(text.parentElement?.closest('[data-spec-peer]'))continue
      const length=text.textContent!.length
      if(skip>=length){skip-=length;continue}
      const range=document.createRange()
      range.setStart(text,skip);range.setEnd(text,skip+1)
      const r=range.getBoundingClientRect()
      return {x:r.x,y:r.y,width:r.width,height:r.height}
    }
    throw Error('Glyph is missing')
  },offset)
  const equalBox = (a: {x:number;y:number;width:number;height:number}, b: typeof a) => {
    for(const k of ['x','y','width','height'] as const)expect(Math.abs(a[k]-b[k]),'screen '+k).toBeLessThan(1)
  }
  const writes: any[] = []
  try {
    await open(page,'inline-proof')
    const ai=page.getByRole('button',{name:'AI 协作',exact:true})
    if(await ai.getAttribute('aria-pressed')==='true')await ai.click()
    await locate()
    page.on('request',req=>{if(req.method()==='POST'&&req.url().endsWith('/canvas/patch'))writes.push(req.postDataJSON())})
    const titlePreview = page.getByLabel('Spec 标题预览').filter({hasText:title}), preview=page.locator('article[data-spec-root="'+id+'"]')
    const form=page.getByRole('form',{name:'编辑 Spec 文档'}), prose=form.getByRole('textbox',{name:'文档正文'})
    const attachment=page.locator('[data-note-id="'+note+'"]')
    const at=await glyph(preview.locator('p').nth(1),5), endTitle=await glyph(titlePreview,title.length-2)
    const firstTitle=await glyph(titlePreview,0), third=await glyph(preview.locator('p').nth(2),2), noteBox=(await attachment.boundingBox())!
    expect(endTitle.y).toBeGreaterThan(firstTitle.y+firstTitle.height)
    await page.mouse.dblclick(at.x+at.width*.2,at.y+at.height/2)
    await expect(prose).toBeFocused()
    await expect(preview).toHaveCount(0)
    await expect(form.getByRole('figure')).toHaveCount(0)
    equalBox(at,await glyph(prose.locator('p').nth(1),5))
    equalBox(third,await glyph(prose.locator('p').nth(2),2))
    equalBox(endTitle,await glyph(form.locator('.spec-title-ink'),title.length-2))
    equalBox(noteBox,(await attachment.boundingBox())!)
    const selection=await prose.evaluate(el=>{
      const s=getSelection()!,r=document.createRange()
      r.selectNodeContents(el.children[1]);r.setEnd(s.focusNode!,s.focusOffset)
      return r.toString()
    })
    expect(selection).toBe(lines[1].slice(0,5))
    await page.screenshot({path:info.outputPath('spec-edit-on-paper.png')})
    await form.getByLabel('全屏编辑').click()
    await expect(form.getByRole('figure')).toBeVisible()
    await form.getByLabel('返回画布').click()
    equalBox(at,await glyph(prose.locator('p').nth(1),5))
    await expect(form.locator('[data-spec-bundle]')).toHaveCount(0)
    await form.getByRole('button',{name:'完成'}).click()
    await expect(form).toHaveCount(0)
    equalBox(at,await glyph(preview.locator('p').nth(1),5))
    expect(writes).toEqual([])

    await page.mouse.dblclick(endTitle.x+endTitle.width*.2,endTitle.y+endTitle.height/2)
    const field=form.getByRole('textbox',{name:'文档标题'})
    await expect(field).toBeFocused()
    expect(await field.evaluate(el=>(el as HTMLTextAreaElement).selectionStart)).toBe(title.length-2)
    await page.keyboard.insertText('新')
    await field.press('Escape')
    await expect(titlePreview.or(page.getByLabel('Spec 标题预览').filter({hasText:'迭代新清单'}))).toBeVisible()
    await page.mouse.dblclick(at.x+at.width*.2,at.y+at.height/2)
    await expect(prose).toBeFocused()
    await page.keyboard.insertText('【核实】')
    await prose.press('Escape')
    await expect(form).toHaveCount(0)
    await locate()
    await expect(preview.locator('p').nth(1)).toHaveText(lines[1].slice(0,5)+'【核实】'+lines[1].slice(5))
    expect(writes.flatMap(b=>b.operations).every(o=>o.op==='spec.update')).toBe(true)
    const point=await glyph(preview.locator('p').first(),1)
    await page.mouse.dblclick(point.x+2,point.y+point.height/2)
    await expect(prose).toBeFocused()
    const oldNote=(await attachment.boundingBox())!
    await page.mouse.wheel(0,72)
    await expect.poll(async()=>Math.abs((await attachment.boundingBox())!.y-oldNote.y)).toBeGreaterThan(15)
    const panned=await glyph(prose.locator('p').first(),1)
    expect(panned.y-point.y).toBeCloseTo((await attachment.boundingBox())!.y-oldNote.y,0)
    await prose.press('Escape')
    await expect(form).toHaveCount(0)
    equalBox(panned,await glyph(preview.locator('p').first(),1))
    await page.mouse.dblclick(panned.x+2,panned.y+panned.height/2)
    await expect(prose).toBeFocused()
    const overText=(await attachment.boundingBox())!
    const dragX=overText.x+9, dragY=overText.y+9
    await page.mouse.move(dragX,dragY);await page.mouse.down()
    await page.mouse.move(dragX+30,dragY+10,{steps:6});await page.mouse.up()
    await expect(form).toHaveCount(0)
    await expect.poll(async()=>(await read()).scene.elements.find((el:any)=>el.id===note).x).toBeGreaterThan(x+425)
  } finally {await page.close()}
})

test('recovering a legacy height-conflicted Spec draft preserves both writers and still protects a deliberate paper resize', async ({browser}) => {
  const page = await browser.newPage(), user='spec-journal-owner', id='spec-journal-fixture', bodyId=id+'-body'
  const {openSpec,toBase64}=await import('../src/canvas/specRichText')
  const Y=await import('yjs')
  const tag=(part:string)=>({officeBoard:{kind:'spec',root:id,part}})
  const paper={id,type:'rectangle',x:21000,y:20000,width:540,height:360,customData:tag('paper')}
  const body={id:bodyId,type:'text',x:21028,y:20100,width:480,height:43,text:'共同审阅',originalText:'共同审阅',fontSize:20,lineHeight:1.25,customData:tag('body')}
  const title={...body,id:id+'-title',y:20028,text:'发布',originalText:'发布',customData:tag('title')}
  const seed=await read()
  expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(seed.revision,[paper,title,body].map(element=>({op:'element.add',element}))))})).ok).toBe(true)
  const base=await read(),model=openSpec(body)
  const vector=Y.encodeStateVector(model)
  const paragraph=model.getXmlFragment('spec').get(0) as import('yjs').XmlElement
  ;(paragraph.get(0) as import('yjs').XmlText).insert(0,'草稿：')
  const delta=toBase64(Y.encodeStateAsUpdate(model,vector))
  model.destroy()
  const auth=await (await request('/auth',{},user)).json()
  const namespace=JSON.stringify(['canvas/1',auth.serviceId,uiUrl,'canvas-accept',user])
  async function seedJournal(flight:ReturnType<typeof batch>) {
    await page.evaluate(async draft=>{
      const db=await new Promise<IDBDatabase>((resolve,reject)=>{
        const req=indexedDB.open('hcd-input-drafts-v1',1)
        req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)
      })
      try {
        await new Promise<void>((resolve,reject)=>{
          const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(draft)
          tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)
        })
      } finally {db.close()}
    },{id:randomUUID(),documentId:'canvas-accept',epoch,namespace,updatedAt:Date.now(),version:1,content:JSON.stringify({flight,pending:[]})})
    await page.reload()
    const recovery = page.getByRole('dialog', {name:'恢复本地草稿'})
    await expect(recovery).toBeVisible()
    await expect(page.locator('.canvas-notice')).toHaveCount(0)
    const board = page.locator('.canvas-surface'), top = (await board.boundingBox())!.y
    await recovery.getByRole('button',{name:'稍后处理'}).click()
    await expect(recovery).toHaveCount(0)
    expect((await board.boundingBox())!.y).toBe(top)
    await page.reload()
    const trigger = page.getByRole('button',{name:'本地草稿',exact:true})
    await expect(trigger).toHaveAttribute('aria-expanded','false')
    await trigger.click()
    await recovery.getByRole('button',{name:/^恢复 \d/}).click()
  }
  const responses:number[]=[]
  page.on('response',r=>{if(r.request().method()==='POST'&&r.url().endsWith('/canvas/patch'))responses.push(r.status())})
  try{
    await open(page,user)
    expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(base.revision,[{op:'spec.splice',id:bodyId,block:0,start:4,end:4,expected:'',insert:'，同事补充。'}]))},'other-writer')).ok).toBe(true)
    await seedJournal(batch(base.revision,[
      {op:'spec.update',id:bodyId,update:delta},
      {op:'element.update',id:bodyId,before:{height:43,x:body.x},changes:{height:50,x:body.x+8}},
    ]))
    await expect.poll(async()=>(await read()).scene.elements.find((el:any)=>el.id===bodyId).originalText).toBe('草稿：共同审阅，同事补充。')
    await expect(page.getByRole('button',{name:'重试保存'})).toHaveCount(0)
    const saved=await read(),current=saved.scene.elements.find((el:any)=>el.id===bodyId)
    expect(current.x).toBe(body.x+8)
    expect(current.height).toBe(25)
    expect(responses).toEqual([412,200])
    expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(saved.revision,[{op:'element.update',id,before:{height:360},changes:{height:422}}]))},'other-writer')).ok).toBe(true)
    await seedJournal(batch(saved.revision,[{op:'element.update',id,before:{height:360},changes:{height:390}}]))
    await expect(page.getByRole('button',{name:'重试保存'})).toBeVisible()
    await expect(page.getByRole('button',{name:'下载草稿'})).toBeVisible()
    expect((await read()).scene.elements.find((el:any)=>el.id===id).height).toBe(422)
    expect(responses).toEqual([412,200,412])
  }finally{await page.close()}
})

test('a long Spec keeps the same visible paragraph when switching between reading, typing and full screen', async ({page}) => {
  const id='spec-fixed-paper', x=24000, y=21000
  const tag=(part:string)=>({officeBoard:{kind:'spec',root:id,part}})
  const content=Array.from({length:36},(_,i)=>'编辑记录 '+(i+1)).join('\n')
  const seed=await read()
  const parts=[
    {id,type:'rectangle',x,y,width:520,height:290,customData:tag('paper')},
    {id:id+'-title',type:'text',x:x+28,y:y+24,width:464,height:35,text:'变更日志',fontSize:28,customData:tag('title')},
    {id:id+'-body',type:'text',x:x+28,y:y+80,width:464,height:764,text:content,originalText:content,fontSize:17,lineHeight:1.25,customData:tag('body')},
  ]
  expect((await request('/canvas/patch',{method:'POST',body:JSON.stringify(batch(seed.revision,parts.map(element=>({op:'element.add',element}))))})).ok).toBe(true)
  await open(page,'long-paper-reader')
  await page.goto(uiUrl+'/?locale=zh-CN&doc-id=canvas-accept&node-id='+id)
  await page.getByRole('button',{name:'编辑文档',exact:true}).click()
  const form=page.getByRole('form',{name:'编辑 Spec 文档'}), col=form.locator('[data-part=body]')
  const box=(await col.boundingBox())!
  await page.mouse.move(box.x+40,box.y+42);await page.mouse.wheel(0,235)
  await expect.poll(async()=>col.evaluate(el=>el.scrollTop)).toBeGreaterThan(150)
  const reading=await col.evaluate(el=>el.scrollTop)
  const line=col.getByText('编辑记录 10',{exact:true}), pos=(await line.boundingBox())!
  await form.getByLabel('全屏编辑').click();await form.getByLabel('返回画布').click()
  expect(await col.evaluate(el=>el.scrollTop)).toBe(reading)
  expect((await line.boundingBox())!.y).toBeCloseTo(pos.y,0)
  await form.getByRole('button',{name:'完成'}).click()
  const preview=page.locator('article[data-spec-root="'+id+'"]')
  await expect.poll(async()=>preview.evaluate(el=>el.scrollTop)).toBe(reading)
  expect((await preview.locator('p').nth(9).boundingBox())!.y).toBeCloseTo(pos.y,0)
  await page.mouse.dblclick(pos.x+12,pos.y+pos.height/2)
  await expect(form.getByRole('textbox',{name:'文档正文'})).toBeFocused()
  expect(await line.evaluate(el=>el.contains(document.getSelection()?.focusNode??null))).toBe(true)
})
