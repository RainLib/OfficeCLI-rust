import { api, type Session } from '../api.ts'
import type { CanvasEvent } from './model.ts'

/** Fetch streaming keeps bearer credentials out of URLs and supports token
 * rotation, unlike native EventSource. Each reconnect obtains a fresh snapshot. */
export async function receiveEvents(session: Session, signal: AbortSignal, receive: (event: CanvasEvent) => void) {
  const response = await api(session, '/canvas/events', { signal, cache: 'no-store' })
  if (!response.body) throw new Error('协作连接未返回数据流')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      if (buffer.length > 48 * 1024 * 1024) throw new Error('协作消息超过限制')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const message = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const data = message.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (data) receive(JSON.parse(data) as CanvasEvent)
      }
    }
  } finally { reader.releaseLock() }
}
