import type { RevisionEvent, Session } from './api.ts'

export type RevisionConnectionStatus = 'connected' | 'connecting' | 'expired' | 'unavailable'
export type RevisionTracking = { snapshot: () => string[]; subscribe: (listener: () => void) => () => void }
type WatchOptions = { tracking?: RevisionTracking; afterRevision?: number; baseUrl?: string; createSocket?: (url: string) => WebSocket; retryMs?: number }

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

/** A socket occupies no ordinary HTTP request slot. Credentials are sent only
 * after opening; reconnects request a durable snapshot from the last delivery. */
export async function watchRevisions(session: Session, signal: AbortSignal, onRevision: (event: RevisionEvent) => void, onStatus?: (status: RevisionConnectionStatus) => void, options: WatchOptions = {}) {
  const url = new URL(`${session.apiUrl || '/v1/documents'}/${encodeURIComponent(session.documentId)}/events/ws`, options.baseUrl ?? window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  let afterRevision = options.afterRevision
  while (!signal.aborted) {
    onStatus?.('connecting')
    const code = await new Promise<number>(resolve => {
      let socket: WebSocket
      try { socket = (options.createSocket ?? (address => new WebSocket(address)))(url.href) }
      catch { resolve(1006); return }
      let settled = false
      let unsubscribe: (() => void) | undefined
      let tracked = ''
      const ids = () => [...new Set(options.tracking?.snapshot() ?? [])].sort()
      const finish = (code: number) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        unsubscribe?.()
        signal.removeEventListener('abort', abort)
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
        socket.close()
        resolve(code)
      }
      const abort = () => finish(1000)
      const timeout = setTimeout(() => finish(1006), 10_000)
      signal.addEventListener('abort', abort, { once: true })
      socket.onopen = () => {
        if (signal.aborted) { abort(); return }
        const nodeIds = ids()
        tracked = JSON.stringify(nodeIds)
        socket.send(JSON.stringify({ type: 'auth', token: session.token, afterRevision, nodeIds }))
        unsubscribe = options.tracking?.subscribe(() => {
          const nodeIds = ids()
          const next = JSON.stringify(nodeIds)
          if (next === tracked || socket.readyState !== 1) return
          tracked = next
          socket.send(JSON.stringify({ type: 'track', nodeIds }))
        })
      }
      socket.onmessage = message => {
        try {
          if (typeof message.data !== 'string' || message.data.length > 8 * 1024 * 1024) throw new Error('Invalid revision frame')
          const event = JSON.parse(message.data) as RevisionEvent
          if (!Number.isSafeInteger(event.revision) || event.revision < 0 || !Array.isArray(event.nodes)) throw new Error('Invalid revision')
          if (afterRevision !== undefined && event.revision < afterRevision) throw new Error('Revision moved backwards')
          onRevision(event)
          afterRevision = event.revision
          clearTimeout(timeout)
          onStatus?.('connected')
        } catch { finish(1006) }
      }
      socket.onerror = () => finish(1006)
      socket.onclose = event => finish(event.code)
      if (signal.aborted) abort()
    })
    if (signal.aborted) return
    if (code === 4401 || code === 4403) { onStatus?.('expired'); return }
    if (code === 4400) { onStatus?.('unavailable'); return }
    onStatus?.('connecting')
    await delay(options.retryMs ?? 2000, signal)
  }
}
