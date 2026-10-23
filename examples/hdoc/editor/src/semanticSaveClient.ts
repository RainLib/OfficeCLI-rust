import type { SaveState } from './semanticSaveCoordinator.ts'

export type CoordinatedReply = SaveState
type Transport = { on: (event: string, handler: (data: any) => void) => unknown; off: (event: string, handler: (data: any) => void) => unknown; sendStateless: (payload: string) => void }

/** Acknowledgements are matched to the exact request, not an unrelated
 * autosave broadcast. A timeout never authorizes closing or exporting. */
export function requestCoordinatedSave(provider: Transport, digest: string, signal?: AbortSignal, timeoutMs = 45_000, imageDigest?: string): Promise<CoordinatedReply> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const cleanup = () => { clearTimeout(timer); provider.off('stateless', receive); provider.off('status', status); signal?.removeEventListener('abort', abort) }
    const fail = () => { cleanup(); reject(new Error('coordinatorUnavailable')) }
    const abort = () => fail()
    const status = ({ status }: { status: string }) => { if (status !== 'connected') fail() }
    const receive = ({ payload }: { payload: string }) => {
      let message: CoordinatedReply & { requestId?: string }
      try { message = JSON.parse(payload) } catch { return }
      if (message.requestId !== requestId || message.type !== 'hcd-save-status') return
      cleanup(); resolve(message)
    }
    const timer = setTimeout(fail, timeoutMs)
    provider.on('stateless', receive); provider.on('status', status); signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { fail(); return }
    try { provider.sendStateless(JSON.stringify({ type: 'hcd-save', requestId, digest, imageDigest })) } catch { fail() }
  })
}
