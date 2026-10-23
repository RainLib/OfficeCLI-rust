import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { api, type Session } from './api.ts'
import { useI18n } from './i18n.tsx'
import type { BlockContent, Projection } from './schema.ts'
import {downloadLocalCopy,type LocalDraftCopy} from './LocalDraftBootstrap.tsx'
import type { SaveState } from './semanticSaveCoordinator.ts'

function base64(bytes: Uint8Array) {
  const chunks: string[] = []
  for (let start = 0; start < bytes.length; start += 8192) chunks.push(String.fromCharCode(...bytes.subarray(start, start + 8192)))
  return btoa(chunks.join(''))
}
function download(session: Session, bytes: Uint8Array, name: string, epoch: number) {
  const backup = { schemaVersion: 'hcd-recovery/1', documentId: session.documentId, collaborationEpoch: epoch, crdt: base64(bytes) }
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = `${session.documentId}-${name}.hcd-draft`; document.body.append(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
function blockText(content: BlockContent): string { return [...content.inlines.map(part => part.text), ...(content.children ?? []).map(blockText)].join(' ') }

export function SemanticRecoveryPanel({ session, document: draft, conflict, onUseLatest, readOnly, onClose, localCopies=[] }: { localCopies?:LocalDraftCopy[];session: Session; document: Y.Doc; conflict: SaveState | null; onClose: () => void; onUseLatest: () => Promise<void>; readOnly: boolean }) {
  const { t, locale } = useI18n()
  const [latest, setLatest] = useState<Projection | null>(null)
  const [copies, setCopies] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [windowStart, setWindowStart] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void api(session, '/collaboration/recovery', { signal: controller.signal }).then(response => response.json()).then((result: { recoveries: string[] }) => {
      if (!controller.signal.aborted) setCopies(result.recoveries)
    }).catch(() => {})
    return () => controller.abort()
  }, [session, conflict?.recoveryId])
  async function inspectLatest() {
    setBusy(true); setError('')
    try { setLatest(await (await api(session, '/editor')).json() as Projection); setWindowStart(0) }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="semantic-recovery-panel" aria-label={t(conflict ? 'saveConflict' : 'recoveryCopies')}>
    <div role={conflict ? 'alert' : undefined}><strong>{t(conflict ? 'saveConflict' : 'recoveryCopies')}</strong>{conflict ? <span>{t('saveConflictHint')}</span> : <button onClick={onClose}>{t('close')}</button>}</div>
    <div className="semantic-recovery-actions">
      <button type="button" onClick={() => { try { download(session, Y.encodeStateAsUpdate(draft), 'draft', session.collaborationEpoch ?? 0) } catch (cause) { setError(String(cause)) } }}>{t('downloadDraft')}</button>
      <button type="button" disabled={busy} onClick={() => void inspectLatest()}>{t('viewLatest')}</button>
      {conflict && <button type="button" disabled={readOnly || busy || !latest} title={t('preserveThenLatestHint')} onClick={() => {
        setBusy(true); setError('')
        void onUseLatest().catch(cause => setError(String(cause))).finally(() => setBusy(false))
      }}>{t('openLatestWithBackup')}</button>}
    </div>
    <p>{t(conflict ? readOnly ? 'recoveryReadOnlyHint' : 'preserveThenLatestHint' : 'recoveryCopiesHint')}</p>
    {!!copies.length && <details><summary>{t('savedDraftCopies', { count: copies.length })}</summary>{copies.map((copy, index) => <button type="button" key={copy} disabled={busy} onClick={() => {
      setBusy(true); setError('')
      void api(session, `/collaboration/recovery/${encodeURIComponent(copy)}`).then(response => response.arrayBuffer()).then(bytes => download(session, new Uint8Array(bytes), `recovery-${index + 1}`, Number(/^e([0-9]+)-/.exec(copy)?.[1] ?? session.collaborationEpoch ?? 0))).catch(cause => setError(String(cause))).finally(() => setBusy(false))
    }}>{t('downloadDraftCopy', { count: index + 1 })}</button>)}</details>}
    {!!localCopies.length && <details><summary>{t('localDraftCopies')} ({localCopies.length})</summary>{localCopies.map(copy=><button key={copy.identity.name} type="button" disabled={busy} onClick={()=>{setBusy(true);setError('');void downloadLocalCopy(session,copy).catch(cause=>setError(String(cause))).finally(()=>setBusy(false))}}>{new Date(copy.updatedAt).toLocaleString(locale)} · {t(copy.identity.epoch===(session.collaborationEpoch??0)?'localDraftCurrentCopy':'localDraftOlderCopy')} · {t('downloadDraft')}</button>)}</details>}
    {latest && <div className="semantic-latest-preview"><strong>{t('latestVersionPreview', { revision: latest.revision })}</strong>{latest.blocks.slice(windowStart, windowStart + 50).map(block => <p key={block.blockId}>{blockText(block.content)}</p>)}<div><button disabled={windowStart === 0} onClick={() => setWindowStart(Math.max(0, windowStart - 50))}>{t('previousTextWindow')}</button><span>{t('textWindowRange', { from: windowStart + 1, to: Math.min(latest.blocks.length, windowStart + 50), total: latest.blocks.length })}</span><button disabled={windowStart + 50 >= latest.blocks.length} onClick={() => setWindowStart(windowStart + 50)}>{t('nextTextWindow')}</button></div></div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
