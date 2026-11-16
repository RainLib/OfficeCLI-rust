import type { HocuspocusProvider } from '@hocuspocus/provider'

/** Acknowledge a checkpoint of the shared Y.Doc, including other collaborators,
 * before a source-mapped edit starts a new collaboration epoch. */
export async function collaborationCheckpoint(provider: HocuspocusProvider): Promise<number> {
  const deadline = Date.now() + 15_000
  while (provider.hasUnsyncedChanges && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  if (!provider.isSynced || provider.hasUnsyncedChanges) throw new Error('协同连接未同步，请恢复连接后重试。')
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const cleanup = () => { clearTimeout(timeout); provider.off('stateless', receive) }
    const receive = ({ payload }: { payload: string }) => {
      let message: { type?: string; requestId?: string; revision?: number; error?: string }
      try { message = JSON.parse(payload) } catch { return }
      if (message.type !== 'hcd-checkpoint-result' || message.requestId !== requestId) return
      cleanup()
      if (message.error || !Number.isSafeInteger(message.revision)) reject(new Error('协同保存失败，请重试；修改仍保留在编辑器中。'))
      else resolve(message.revision!)
    }
    const timeout = setTimeout(() => { cleanup(); reject(new Error('协同保存超时，请恢复连接后重试。')) }, 15_000)
    provider.on('stateless', receive)
    provider.sendStateless(JSON.stringify({ type: 'hcd-checkpoint', requestId }))
  })
}
