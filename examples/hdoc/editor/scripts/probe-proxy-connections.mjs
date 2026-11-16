import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// An isolated upstream and Vite instance verify that polling shares upstream
// sockets instead of spending one ephemeral port per request. No daily service
// or real document is involved.
const editor = fileURLToPath(new URL('..', import.meta.url))
const cache = mkdtempSync(resolve(tmpdir(), 'hcd-proxy-probe-'))
let upstreamConnections = 0
const upstream = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ path: request.url }))
})
upstream.on('connection', () => upstreamConnections++)
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const previousTarget = process.env.HCD_API_TARGET
process.env.HCD_API_TARGET = `http://127.0.0.1:${upstream.address().port}`
const caller = new http.Agent({ keepAlive: true })
let vite
try {
  vite = await createServer({ root: editor, cacheDir: cache, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0 },
  })
  await vite.listen()
  const port = vite.httpServer.address().port
  for (let index = 0; index < 20; index++) {
    const path = index % 2 ? '/health' : '/v1/proxy-connection-probe'
    const result = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path, agent: caller }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      }).on('error', reject)
    })
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).path, path)
  }
  assert.equal(upstreamConnections, 1, 'the two API proxy routes must share their keep-alive agent')
  console.log(JSON.stringify({ requests: 20, upstreamConnections, passed: true }))
} finally {
  caller.destroy()
  await vite?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  if (previousTarget === undefined) delete process.env.HCD_API_TARGET
  else process.env.HCD_API_TARGET = previousTarget
  rmSync(cache, { recursive: true, force: true })
}
