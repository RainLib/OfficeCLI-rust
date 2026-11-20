/** Real API/browser acceptance against an isolated, fault-injectable host.
 * This test host is a protocol fixture, not the production built-in Workspace.
 * No real credentials, private documents or public model services are used.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const editor = resolve(import.meta.dirname, '..'), repo = resolve(editor, '../../..')
const binary = process.env.OFFICECLI_BIN || resolve(repo, 'target/debug/officecli')
const artifacts = process.env.HCD_PROVIDER_ARTIFACTS || resolve(repo, 'docs/acceptance/hcd-provider-integration-v1')
mkdirSync(artifacts, { recursive: true })
const root = mkdtempSync(resolve(tmpdir(), 'officecli-provider-')), serviceRoot = resolve(root, 'engine')
mkdirSync(serviceRoot, { mode: 0o700 })
const secret = () => randomBytes(32).toString('hex'), jwtSecret = secret(), providerKey = secret(), serviceKey = secret(), eventKey = secret(), objectKey = secret()
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const stamp = () => new Date().toISOString(), until = seconds => new Date(Date.now() + seconds * 1000).toISOString()
const checks = [], children = [], log = createWriteStream(resolve(root, 'services.log'), { mode: 0o600 })
let backend, browser, failCommit = false, failEvent = true, commit202 = false, wrongHash = false, hostileTransfer = false
let verified = 0, signatureErrors = 0, commitCount = 0, eventAttempts = 0
const nonces = new Set(), codes = new Map(), exchanges = new Map(), pubs = new Map(), eventIds = new Set()
const rejectedEvents = new Map(), blockedEvents = new Set()
const files = new Map(['a','b','browser','bad-hash','bad-transfer','async-commit','receipt-only'].map(id => [id, {
  head: 'v1', versions: { v1: Buffer.from(`Original ${id} document.\n\nA public provider acceptance fixture.\n`) },
}]))
const editable = ['document.view','document.edit','document.publish','document.copy','history.view','history.restore']
const acl = new Map([['alice', [...editable]], ['bob',['document.view']]])
const saveHost = () => {
  const temp = resolve(root, 'host-state.tmp'), path = resolve(root, 'host-state.json')
  writeFileSync(temp, JSON.stringify({ files: [...files], publications: [...pubs], events: [...eventIds] }), { mode: 0o600 })
  renameSync(temp, path)
}
const descriptor = (id, version) => {
  const bytes = files.get(id)?.versions[version]
  assert(bytes, 'fixture version exists')
  return { id, version, name: `${id}.${files.get(id).format || 'txt'}`, mediaType: files.get(id).mediaType || 'text/plain', sizeBytes: bytes.length,
    sha256: wrongHash ? '0'.repeat(64) : digest(bytes), createdAt: '2026-11-15T00:00:00Z', modifiedAt: stamp(), creatorId:'alice', modifierId:'alice' }
}
function signature(request, body, key) {
  const timestamp = request.headers['x-hcd-timestamp'], nonce = request.headers['x-hcd-nonce']
  assert(Math.abs(Date.now()/1000 - Number(timestamp)) < 300)
  assert(!nonces.has(nonce), 'transport retries require a new nonce')
  nonces.add(nonce)
  const actual = String(request.headers['x-hcd-signature'] || '').split(';mac=')[1] || ''
  const expected = createHmac('sha256', key).update(`POST\n${request.url}\n${timestamp}\n${nonce}\n${digest(body)}`).digest('hex')
  assert.equal(actual.length, expected.length)
  assert(timingSafeEqual(Buffer.from(actual), Buffer.from(expected)))
  verified++
}
const host = createServer(async (request, response) => {
  const send = (code, value) => { response.writeHead(code, { 'Content-Type':'application/json' }); response.end(JSON.stringify(value)) }
  try {
    const url = new URL(request.url, 'http://fixture')
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    if (url.pathname.startsWith('/objects/')) {
      assert.equal(request.headers['x-object-key'], objectKey)
      const [, , kind, id, version] = url.pathname.split('/')
      if (kind === 'source') { response.writeHead(200); response.end(files.get(id).versions[version]); return }
      assert.equal(kind, 'stage'); assert.equal(request.method,'PUT')
      const publication = pubs.get(id); assert(publication)
      publication.bytes = body; saveHost(); response.writeHead(204); response.end(); return
    }
    const event = url.pathname === '/officecli-events/v1/events'
    try { signature(request, body, event ? eventKey : providerKey) } catch (error) { signatureErrors++; throw error }
    const data = JSON.parse(body)
    if (event) {
      assert.equal(data.tenantId,'acme'); assert.equal(data.appId,'archive')
      eventAttempts++
      if (blockedEvents.has(data.eventId)) { rejectedEvents.set(data.eventId, data); send(403,{error:'injected event authorization failure'}); return }
      if (rejectedEvents.has(data.eventId)) assert.deepEqual(data,rejectedEvents.get(data.eventId))
      if (failEvent) { failEvent = false; send(503,{error:'injected delivery failure'}); return }
      eventIds.add(data.eventId); saveHost(); response.writeHead(204); response.end(); return
    }
    const context = data.context || data
    assert.equal(context.tenantId, 'acme'); assert.equal(context.appId, 'archive')
    if (url.pathname.endsWith('/sessions/resolve')) {
      const serialized = JSON.stringify(data)
      if (exchanges.has(data.exchangeId)) {
        const prior = exchanges.get(data.exchangeId)
        assert.equal(prior.serialized, serialized); send(200,prior.result); return
      }
      const code = codes.get(data.launchCode)
      if (!code || code.used || code.fileId !== data.externalFileId || code.sessionId !== data.sessionId) { send(403,{error:'invalid launch code'}); return }
      code.used = true
      const result = {tenantId:'acme',appId:'archive',externalFileId:code.fileId,sessionId:data.sessionId,
        actor:{id:code.actor,displayName:code.actor},expiresAt:until(3600)}
      exchanges.set(data.exchangeId,{serialized,result}); send(200,result); return
    }
    if (url.pathname.endsWith('/permissions/resolve')) {
      send(200,{granted:data.operations.filter(op => (acl.get(context.actorId)||[]).includes(op)),
        permissionVersion:'acl-current',expiresAt:until(30),constraints:{exportFormats:['hcd','pdf'],modelIds:[]}}); return
    }
    const match = /^\/officecli-provider\/v1\/files\/([^/]+)\/(.*)$/.exec(url.pathname)
    assert(match, 'known callback path')
    const fileId = decodeURIComponent(match[1]), action = match[2], file = files.get(fileId)
    assert(file)
    if (action === 'describe') { send(200,descriptor(fileId,data.version||file.head)); return }
    if (action === 'download') {
      send(200,{file:descriptor(fileId,data.version),transfer:{url:hostUrl+`/objects/source/${fileId}/${data.version}`,method:'GET',headers:{'X-Object-Key':objectKey},expiresAt:until(60)},
        ...(hostileTransfer ? {} : {})})
      return
    }
    if (action === 'publications/status') {
      const p = pubs.get(data.publicationId)
      send(200,{publicationId:data.publicationId,state:p?.receipt?'committed':p?'prepared':'unknown',...(p?.receipt?{receipt:p.receipt}:{})}); return
    }
    if (action === 'publications/prepare') {
      if (!(acl.get(context.actorId)||[]).includes('document.publish')) { send(403,{error:'revoked'}); return }
      if (data.intent.expectedVersion !== file.head) { send(409,{error:'version conflict'}); return }
      const id = data.intent.publicationId, prior = pubs.get(id)
      if (prior?.receipt) { send(409,{error:'already committed'}); return }
      if (prior) assert.deepEqual(prior.intent,data.intent)
      else pubs.set(id,{intent:data.intent,actor:context.actorId,fileId})
      saveHost()
      send(200,{publicationId:id,uploadId:id,transfer:{url:hostileTransfer?'http://127.0.0.1:1/forbidden':hostUrl+`/objects/stage/${id}`,
        method:'PUT',headers:{'X-Object-Key':objectKey},expiresAt:until(60)}}); return
    }
    if (action === 'publications/commit') {
      const p = pubs.get(data.publicationId); assert(p); assert.equal(p.actor,context.actorId)
      if (p.receipt) { send(200,p.receipt); return }
      if (!(acl.get(context.actorId)||[]).includes('document.publish')) { send(403,{error:'revoked'}); return }
      if (p.intent.expectedVersion !== file.head) { send(409,{error:'version conflict'}); return }
      assert.equal(p.bytes.length,p.intent.output.sizeBytes); assert.equal(digest(p.bytes),p.intent.output.sha256)
      const next = `v${Object.keys(file.versions).length+1}`
      file.versions[next]=p.bytes; file.head=next; commitCount++
      p.receipt={publicationId:data.publicationId,externalFileId:fileId,documentId:p.intent.documentId,
        revision:p.intent.revision,externalVersion:next,sha256:digest(p.bytes),committedAt:stamp()}; saveHost()
      if (failCommit) { failCommit=false; response.destroy(); return }
      send(commit202?202:200,p.receipt); return
    }
    throw new Error(`unexpected callback ${action}`)
  } catch (error) { send(500,{error:error.message}) }
})
await new Promise(resolve => host.listen(0,'127.0.0.1',resolve))
const hostUrl = `http://127.0.0.1:${host.address().port}`
const port = async () => { const s=tcpServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p }
const apiPort=await port(),uiPort=await port(),collabPort=await port(),apiUrl=`http://127.0.0.1:${apiPort}`
const configPath=resolve(root,'integration.json')
writeFileSync(configPath,JSON.stringify({schemaVersion:'officecli-integration/1',tenantId:'acme',appId:'archive',providerUrl:hostUrl,keyId:'provider-1',
  providerSecretEnv:'HCD_TEST_PROVIDER_SECRET',serviceSecretEnv:'HCD_TEST_SERVICE_SECRET',transferOrigins:[hostUrl],
  events:{url:hostUrl+'/officecli-events/v1/events',keyId:'event-1',secretEnv:'HCD_TEST_EVENT_SECRET'}}),{mode:0o600})
const env={...process.env,HCD_TOKEN_SECRET:jwtSecret,HCD_TEST_PROVIDER_SECRET:providerKey,HCD_TEST_SERVICE_SECRET:serviceKey,HCD_TEST_EVENT_SECRET:eventKey,
  HCD_API_TARGET:apiUrl,HCD_API_URL:apiUrl,HCD_COLLAB_PORT:String(collabPort),VITE_HCD_COLLAB_URL:`ws://127.0.0.1:${collabPort}`,HCD_VITE_CACHE_DIR:resolve(root,'vite-cache')}
for (const key of ['HCD_DATABASE_URL','HCD_S3_BUCKET','HCD_DEFAULT_THEME','HCD_OPENAI_ENV_FILE','OPENAI_API_KEY','RAINY_OPENAI_API_KEY']) delete env[key]
function start(command,args) { const child=spawn(command,args,{cwd:editor,env,stdio:['ignore','pipe','pipe']}); child.stdout.pipe(log,{end:false}); child.stderr.pipe(log,{end:false}); children.push(child); return child }
async function stop(child,signal='SIGTERM') { if (child && child.exitCode===null && child.signalCode===null) { const ended=new Promise(r=>child.once('exit',r)); child.kill(signal); await ended } }
async function poll(check,timeout=30000) { const end=Date.now()+timeout; let last; do { try { const value=await check(); if(value)return value }catch(error){last=error} await new Promise(r=>setTimeout(r,200)) }while(Date.now()<end); throw last||new Error('acceptance timeout') }
async function startBackend() { backend=start(binary,['hdoc','serve','--root',serviceRoot,'--bind',`127.0.0.1:${apiPort}`,'--integration-config',configPath]); await poll(async()=> (await fetch(apiUrl+'/health')).ok) }
const call=async(path,{token,method='GET',data,headers={}}={}) => { const response=await fetch(apiUrl+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})}); const text=await response.text(); let value; try{value=JSON.parse(text)}catch{value=text} return {status:response.status,value} }
async function open(fileId,actor='alice',sessionId=randomUUID(),refresh=false) {
  const launchCode=secret(),exchangeId=randomUUID(); codes.set(launchCode,{fileId,actor,sessionId,used:false})
  const request={sessionId,exchangeId,externalFileId:fileId,launchCode}
  const response=await call(`/integration/v1/sessions${refresh?`/${sessionId}/refresh`:''}`,{token:serviceKey,method:'POST',data:request})
  assert.equal(response.status,200,JSON.stringify(response.value)); return {...response.value,request}
}
const doc=(s,suffix='')=>`/v1/documents/${s.documentId}${suffix}`
async function edit(s,text) {
  const auth=await call(doc(s,'/auth'),{token:s.token})
  const search=await call(doc(s,'/search?q=Original'),{token:s.token})
  const id=search.value.hits[0].nodeId,node=(await call(doc(s,`/nodes/${id}`),{token:s.token})).value
  const manifest=(await call(doc(s),{token:s.token})).value
  const response=await call(doc(s,'/node-patch'),{token:s.token,method:'POST',headers:{'X-HCD-Collaboration-Epoch':String(auth.value.collaborationEpoch)},data:{schemaVersion:'hcd-patch/1',documentId:s.documentId,patchId:randomUUID(),baseRevision:manifest.revision,
    operations:[{op:'text.splice',nodeId:id,start:0,deleteCount:[...node.text].length,insertText:text,precondition:{nodeHash:node.nodeHash}}]}})
  assert.equal(response.status,200,JSON.stringify(response.value)); return (await call(doc(s),{token:s.token})).value.revision
}
async function publish(s,revision,id=randomUUID(),exportMode='source-backed') {
  const auth=(await call(doc(s,'/auth'),{token:s.token})).value
  return {id,...await call(doc(s,'/publications'),{token:s.token,method:'POST',headers:{'X-HCD-Collaboration-Epoch':String(auth.collaborationEpoch)},data:{publicationId:id,expectedRevision:revision,exportMode}})}
}
try {
  await startBackend()
  assert.equal((await call('/integration/v1/sessions',{method:'POST',data:{sessionId:randomUUID(),exchangeId:randomUUID(),externalFileId:'a',launchCode:'invalid'}})).status,401)
  checks.push('server credential required')
  const a=await open('a'), b=await open('b','bob')
  assert.notEqual(a.documentId,b.documentId); assert.equal((await call(doc(b),{token:a.token})).status,403)
  assert.equal((await call('/v1/catalog/fonts',{token:a.token})).status,403)
  checks.push('document/app boundary and global API denial')
  const duplicate=await call('/integration/v1/sessions',{token:serviceKey,method:'POST',data:a.request})
  assert.equal(duplicate.status,200); assert.equal(duplicate.value.sessionId,a.sessionId)
  assert.equal((await call('/integration/v1/sessions',{token:serviceKey,method:'POST',data:{...a.request,launchCode:'changed'}})).status,409)
  checks.push('idempotent session exchange rejects changed credentials')
  const legacy=spawnSync(binary,['hdoc','issue-token','--document-id',a.documentId,'--scope','write'],{env,encoding:'utf8'})
  assert.equal(legacy.status,0); assert.equal((await call(doc(a),{token:legacy.stdout.trim()})).status,403)
  checks.push('legacy write token cannot bypass host policy')
  assert.equal((await call(doc(b,'/node-patch'),{token:b.token,method:'POST',data:{}})).status,403)
  for (const route of ['/export/txt','/mcp','/agent-runs']) assert.equal((await call(doc(a,route),{token:a.token,method:route==='/mcp'?'POST':'GET',data:route==='/mcp'?{}:undefined})).status,403)
  const plans=(await call(doc(a,'/export-capabilities'),{token:a.token})).value
  assert(plans.formats.every(f=>!f.available)); checks.push('view/edit/download/export/AI/MCP remain separate')
  const revision=await edit(a,'Changed through host-authorized API.')
  failCommit=true
  const uncertain=await publish(a,revision)
  assert.equal(uncertain.status,202,JSON.stringify(uncertain.value)); assert.equal(uncertain.value.state,'retrying'); assert.equal(commitCount,1)
  checks.push('lost commit response is not reported as saved')
  await stop(backend,'SIGKILL'); await startBackend()
  const reopened=await open('a')
  assert.equal((await call(doc(reopened,'/integration'),{token:reopened.token})).value.externalVersion,'v2')
  const recovered=await publish(a,revision,uncertain.id)
  assert.equal(recovered.status,200,JSON.stringify(recovered.value)); assert.equal(recovered.value.state,'committed'); assert.equal(commitCount,1)
  assert.equal(files.get('a').versions.v2.toString(),'Changed through host-authorized API.\n\nA public provider acceptance fixture.\n')
  const status=(await call(doc(a,'/integration'),{token:a.token})).value
  assert.equal(status.importBaseVersion,'v1'); assert.equal(status.externalVersion,'v2'); assert.equal(status.lastPublishedRevision,revision)
  checks.push('SIGKILL/restart and a fresh browser session reconcile one commit and preserve the immutable source baseline')
  assert.equal((await publish(a,revision+1,uncertain.id)).status,409)
  checks.push('publication IDs reject changed revisions')
  const renewed=await open('a','alice',a.sessionId,true)
  assert.equal(renewed.sessionId,a.sessionId); checks.push('refresh requires fresh host credential')
  acl.set('alice',[...editable,'document.download'])
  const ticket=await call(doc(a,'/downloads/txt'),{token:a.token,method:'POST'})
  assert.equal(ticket.status,200,JSON.stringify(ticket.value)); assert.equal((await call(ticket.value.url)).status,200)
  acl.set('alice',[...editable]); assert.equal((await call(ticket.value.url)).status,403)
  checks.push('issued download capabilities recheck revoked policy')
  acl.set('alice',[...editable,'document.download'])
  const historicalTicket=await call(doc(a,'/downloads/txt?revision=0'),{token:a.token,method:'POST'})
  assert.equal(historicalTicket.status,200,JSON.stringify(historicalTicket.value))
  acl.set('alice',[...editable.filter(op=>op!=='history.view'),'document.download'])
  assert.equal((await call(historicalTicket.value.url)).status,403)
  assert.equal((await call(ticket.value.url)).status,200)
  acl.set('alice',[...editable])
  checks.push('historical download tickets also recheck history permission')
  const departed=await open('receipt-only'), departedRevision=await edit(departed,'Receipt recovery after revocation.')
  failCommit=true
  const lost=await publish(departed,departedRevision)
  assert.equal(lost.status,202)
  const beforeReconcile=commitCount, operator=`/integration/v1/publications/${lost.id}`
  assert.equal((await call('/integration/v1/publications',{token:departed.token})).status,401)
  assert.equal((await call(`/integration/v1/sessions/${departed.sessionId}`,{token:serviceKey,method:'DELETE'})).status,204)
  acl.set('alice',editable.filter(op=>op!=='document.publish'))
  const reconciled=await call(operator+'/reconcile',{token:serviceKey,method:'POST'})
  assert.equal(reconciled.status,200,JSON.stringify(reconciled.value))
  assert.equal(reconciled.value.job.receipt.externalVersion,'v2')
  assert.equal((await call(operator+'/reconcile',{token:serviceKey,method:'POST'})).value.job.state,'committed')
  assert.equal(commitCount,beforeReconcile)
  acl.set('alice',[...editable])
  checks.push('application service recovers an original receipt after logout and publication revocation without another write')
  const asyncSession=await open('async-commit'), asyncRevision=await edit(asyncSession,'HTTP 202 cannot confirm a business commit.')
  const eventId=randomUUID(); blockedEvents.add(eventId)
  commit202=true; const asynchronous=await publish(asyncSession,asyncRevision,eventId); commit202=false
  assert.equal(asynchronous.status,202); assert.equal(asynchronous.value.state,'retrying')
  assert.equal((await publish(asyncSession,asyncRevision,asynchronous.id)).value.state,'committed')
  checks.push('HTTP 202 with a receipt body still requires reconciliation')
  const eventPath=`/integration/v1/publications/${eventId}`
  await poll(async()=> (await call(eventPath,{token:serviceKey})).value.eventDelivery?.deadLetter)
  blockedEvents.delete(eventId)
  assert.equal((await call(eventPath+'/event-retry',{token:serviceKey,method:'POST'})).status,200)
  await poll(async()=> (await call(eventPath,{token:serviceKey})).value.eventDelivery?.delivered)
  assert(eventIds.has(eventId)); assert.equal((await call(eventPath+'/event-retry',{token:serviceKey,method:'POST'})).status,409)
  checks.push('manual redelivery preserves the immutable event identity and payload')
  // A host edit while HCD remains dirty must not be overwritten by prepare.
  const c=await open('browser'), cRevision=await edit(c,'Changed while the business file also changed.')
  const cFile=files.get('browser'); cFile.versions.external=Buffer.from('Independent business content.'); cFile.head='external'
  const conflicted=await publish(c,cRevision)
  assert.equal(conflicted.status,409); assert.equal(cFile.head,'external')
  const candidate=await call(`/integration/v1/publications/${conflicted.id}/artifact`,{token:serviceKey})
  assert.equal(candidate.status,200); assert.match(candidate.value,/Changed while the business file also changed/)
  assert.equal(cFile.versions.external.toString(),'Independent business content.')
  checks.push('business CAS conflict preserves both sides')
  wrongHash=true
  const badId=randomUUID(),badCode=secret(); codes.set(badCode,{fileId:'bad-hash',actor:'alice',sessionId:badId,used:false})
  const bad=await call('/integration/v1/sessions',{token:serviceKey,method:'POST',data:{sessionId:badId,exchangeId:randomUUID(),externalFileId:'bad-hash',launchCode:badCode}})
  wrongHash=false; assert.equal(bad.status,400); checks.push('source SHA-256 mismatch is rejected before import')
  const transfer=await open('bad-transfer'), transferRevision=await edit(transfer,'An upload cannot reach an unregistered origin.')
  hostileTransfer=true; const blocked=await publish(transfer,transferRevision); hostileTransfer=false
  assert.equal(blocked.status,403); checks.push('unregistered transfer origin is rejected')
  const closed=await call(`/integration/v1/sessions/${b.sessionId}`,{token:serviceKey,method:'DELETE'})
  assert.equal(closed.status,204); assert.equal((await call(doc(b,'/auth'),{token:b.token})).status,401)
  checks.push('closed sessions revoke already-issued JWTs')
  await poll(()=>eventIds.has(uncertain.id),35000)
  assert(eventAttempts>=2); assert.equal(signatureErrors,0)
  checks.push('signed durable event retries survive API restart')
  // Actual browser flow uses the same V2 editor and real collaboration sidecar.
  if (process.env.HCD_PROVIDER_SKIP_BROWSER!=='1') {
    const browserFile='browser-ui'; files.set(browserFile,{head:'v1',versions:{v1:Buffer.from('Original browser fixture.\n\nThis document is safe to edit.\n')}})
    const session=await open(browserFile)
    const sidecar=start(resolve(editor,'node_modules/.bin/tsx'),['sidecar.ts'])
    start(resolve(editor,'node_modules/.bin/vite'),['--host','127.0.0.1','--port',String(uiPort),'--strictPort'])
    const ui=`http://127.0.0.1:${uiPort}`
    await poll(async()=> (await fetch(ui)).ok)
    browser=await chromium.launch(process.env.HCD_BROWSER_PATH?{executablePath:process.env.HCD_BROWSER_PATH}:{})
    const page=await browser.newPage({viewport:{width:1500,height:1080}})
    const blockedRequests=[]
    await page.route('**/*',route=>{
      const host=new URL(route.request().url()).hostname
      if (['127.0.0.1','localhost'].includes(host)) return route.continue()
      blockedRequests.push(host); return route.abort()
    })
    await page.addInitScript(()=>localStorage.setItem('hcd-editor-locale','zh-CN'))
    await page.goto(ui)
    await page.locator('.manual-access input').first().fill(session.documentId)
    await page.locator('.manual-access textarea').first().fill(session.token)
    await page.getByRole('button',{name:'打开文档',exact:true}).click()
    const editable=page.locator('.tiptap[contenteditable="true"]').first()
    await editable.waitFor({timeout:30000})
    await editable.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Browser change retained and published.')
    await page.locator('.host-publication>summary').click()
    await page.getByLabel('回写方式').selectOption('semantic')
    await page.getByRole('button',{name:'回写业务系统',exact:true}).click()
    await page.locator('.host-publication[data-publication-state="committed"]').waitFor({timeout:60000})
    assert(files.get(browserFile).versions[files.get(browserFile).head].toString().includes('Browser change retained and published.'))
    assert.equal(await page.locator('.collaboration-trigger').count(),0)
    assert.equal(await page.locator('.export-control').count(),0)
    assert.equal(blockedRequests.length,0)
    await page.screenshot({path:resolve(artifacts,'host-publication-desktop.png'),fullPage:true})
    await page.setViewportSize({width:390,height:844})
    await page.waitForFunction(() => document.documentElement.scrollHeight <= innerHeight + 1)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.screenshot({path:resolve(artifacts,'host-publication-mobile.png'),fullPage:true})
    const popover = await page.locator('.host-publication-popover').boundingBox()
    assert(popover && popover.x >= 0 && popover.x + popover.width <= 391, 'mobile save popover stays within the viewport')
    await page.emulateMedia({colorScheme:'dark'})
    await page.waitForFunction(() => document.querySelector('.hcd-surface')?.getAttribute('data-theme') === 'dark')
    await page.screenshot({path:resolve(artifacts,'host-publication-dark.png'),fullPage:true})
    await page.setViewportSize({width:1500,height:1080})
    await page.locator('.host-publication>summary').click()
    checks.push('V2 browser edit/checkpoint/publication with AI/download controls hidden and local resources')
    // A live socket must not keep editing after ACL changes.
    acl.set('alice',['document.view'])
    await editable.click(); await page.keyboard.type('Must not reach HCD after revocation.')
    await poll(async()=> (await call(doc(session,'/auth'),{token:session.token})).value.scope==='read')
    await new Promise(r=>setTimeout(r,1000))
    const search=await call(doc(session,'/search?q=Must%20not%20reach'),{token:session.token})
    assert.equal(search.value.hits.length,0)
    checks.push('live collaboration stops newly revoked edits')
    // The independent image workspace uses the same publication and ACL boundary.
    acl.set('alice',['document.view','document.edit','document.publish'])
    const imageBytes = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#86a69a'; ctx.fillRect(0,0,32,24)
      ctx.fillStyle = '#f4d7b4'; ctx.fillRect(4,4,12,12)
      return canvas.toDataURL('image/png').split(',')[1]
    }), 'base64')
    files.set('image-ui',{head:'v1',format:'png',mediaType:'image/png',versions:{v1:imageBytes}})
    const imageSession = await open('image-ui')
    await page.close()
    const imagePage = await browser.newPage({viewport:{width:1440,height:1000}})
    await imagePage.route('**/*', route => {
      if (['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)) return route.continue()
      blockedRequests.push(new URL(route.request().url()).hostname); return route.abort()
    })
    await imagePage.goto(ui+'?locale=zh-CN')
    await imagePage.locator('.manual-access input').first().fill(imageSession.documentId)
    await imagePage.locator('.manual-access textarea').first().fill(imageSession.token)
    await imagePage.getByRole('button',{name:'打开文档',exact:true}).click()
    await imagePage.locator('.image-workspace canvas').first().waitFor()
    await imagePage.getByRole('button',{name:'开始编辑',exact:true}).click()
    await imagePage.getByLabel('图片宽度',{exact:true}).fill('16')
    await imagePage.getByRole('button',{name:'应用编辑',exact:true}).click()
    await poll(async()=> (await call(doc(imageSession),{token:imageSession.token})).value.revision > 0)
    await imagePage.locator('.host-publication>summary').click()
    await imagePage.getByRole('button',{name:'回写业务系统',exact:true}).click()
    await imagePage.locator('.host-publication[data-publication-state="committed"]').waitFor({timeout:60000})
    assert.equal(files.get('image-ui').head,'v2')
    assert(!files.get('image-ui').versions.v2.equals(imageBytes))
    assert.equal(await imagePage.locator('.im-collaborate,.export-control').count(),0)
    assert.equal(await imagePage.getByRole('button',{name:'版本记录',exact:true}).count(),0)
    assert.equal(await imagePage.getByRole('button',{name:'AI 修图',exact:true}).count(),0)
    assert.equal(blockedRequests.length,0)
    await imagePage.getByText(/本次导出说明/).waitFor()
    await imagePage.screenshot({path:resolve(artifacts,'host-image-publication.png'),fullPage:true})
    checks.push('image edits publish through the same host policy with AI/history/download controls hidden')
    await browser.close(); browser=null; await stop(sidecar)
  }
  await stop(backend)
  const noConfig=spawnSync(binary,['hdoc','serve','--root',serviceRoot,'--bind',`127.0.0.1:${apiPort}`],{env,encoding:'utf8',timeout:10000})
  assert.notEqual(noConfig.status,0); assert(noConfig.stderr.includes('--integration-config'))
  checks.push('managed root cannot restart in unprotected legacy mode')
  const report={status:'passed',scope:'host-integration-phase-a',checks,signatureRequestsVerified:verified,signatureErrors,commitCount,eventAttempts,
    browserVerified:process.env.HCD_PROVIDER_SKIP_BROWSER!=='1',productionProviderVerified:false,offlineReleaseVerified:false}
  writeFileSync(resolve(artifacts,'validation.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
} finally {
  if (browser) await browser.close()
  for (const child of children.reverse()) await stop(child)
  await new Promise(r=>host.close(r)); log.end()
}
