import assert from 'node:assert/strict'
import { test } from 'node:test'
import { watchRevisions } from './revisionWatch.ts'
import type { Session } from './api.ts'

class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: Array<Record<string, unknown>> = []
  closed = false
  open() { this.readyState = 1; this.onopen?.() }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  receive(revision: number) { this.onmessage?.({ data: JSON.stringify({ revision, patchId: '', nodes: [] }) }) }
  disconnect(code: number) { this.onclose?.({ code }) }
  close() { this.closed = true; this.readyState = 3 }
}
const session: Session = { documentId: 'doc', token: 'private-token', scope: 'write', format: 'pptx' }
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

test('socket keeps credentials out of URLs and resumes delivered revisions with draft tracking', {timeout:5000}, async context => {
  const stop = new AbortController()
  context.after(()=>stop.abort())
  let reconnected!:()=>void
  const connection=new Promise<void>(resolve=>{reconnected=resolve})
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const revisions: number[] = []
  let listener: (() => void) | undefined
  let ids = ['n_b', 'n_a', 'n_a']
  const pending = watchRevisions(session, stop.signal, event => revisions.push(event.revision), undefined, {
    baseUrl: 'https://editor.example/workspace', retryMs: 0,
    createSocket: url => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); if(sockets.length===2)reconnected(); return socket as unknown as WebSocket },
    tracking: { snapshot: () => ids, subscribe: update => { listener = update; return () => { listener = undefined } } },
  })
  sockets[0].open()
  assert.equal(urls[0], 'wss://editor.example/v1/documents/doc/events/ws')
  assert.deepEqual(sockets[0].sent[0], { type: 'auth', token: session.token, nodeIds: ['n_a', 'n_b'] })
  listener?.()
  assert.equal(sockets[0].sent.length, 1)
  ids = ['n_b']; listener?.()
  assert.deepEqual(sockets[0].sent[1], { type: 'track', nodeIds: ['n_b'] })
  sockets[0].receive(7)
  sockets[0].disconnect(1006)
  await connection
  assert.equal(sockets.length, 2)
  sockets[1].open()
  assert.equal(sockets[1].sent[0].afterRevision, 7)
  sockets[1].receive(8)
  stop.abort()
  await pending
  assert.deepEqual(revisions, [7, 8])
  assert.equal(listener, undefined)
  assert.ok(sockets.every(socket => socket.closed))
})

test('expired authorization stops reconnection while preserving caller drafts', async () => {
  const stop = new AbortController()
  const statuses: string[] = []
  const socket = new FakeSocket()
  let connections = 0
  const pending = watchRevisions(session, stop.signal, () => {}, status => statuses.push(status), {
    baseUrl: 'http://localhost/', retryMs: 0,
    createSocket: () => { connections += 1; return socket as unknown as WebSocket },
  })
  socket.open(); socket.disconnect(4401)
  await pending
  assert.equal(connections, 1)
  assert.equal(statuses.at(-1), 'expired')
})

test('aborting retry sleep releases listeners without opening another connection', async () => {
  const stop = new AbortController()
  const socket = new FakeSocket()
  let connections = 0
  const pending = watchRevisions(session, stop.signal, () => {}, undefined, {
    baseUrl: 'http://localhost/', retryMs: 60_000,
    createSocket: () => { connections += 1; return socket as unknown as WebSocket },
  })
  socket.disconnect(1006)
  await tick()
  stop.abort()
  await pending
  assert.equal(connections, 1)
})
