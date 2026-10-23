import { useEffect, useState } from 'react'
import { api, type Session } from './api.ts'
import { useI18n } from './i18n.tsx'
import type { CommentNote, TrackedChange } from './schema.ts'

export function ReviewPanel({ session, revision, readOnly, onRevised }: {
  session: Session
  revision: number | null
  readOnly: boolean
  onRevised: (revision: number) => void
}) {
  const { t } = useI18n()
  const [tracked, setTracked] = useState<TrackedChange[]>([])
  const [comments, setComments] = useState<CommentNote[]>([])
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    let alive = true
    void api(session, '/editor').then(response => response.json()).then((projection: { trackedChanges?: TrackedChange[]; comments?: CommentNote[] }) => {
      if (!alive) return
      setTracked(projection.trackedChanges ?? [])
      setComments(projection.comments ?? [])
    }).catch(cause => { if (alive) setNote(String(cause)) })
    return () => { alive = false }
  }, [session, revision])

  async function resolve(changeId: string, action: 'accept' | 'reject') {
    if (revision === null || readOnly) return
    setBusy(true)
    setNote('')
    try {
      const result = await (await api(session, '/tracked-changes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: revision,
          changeId,
          action,
          patchId: `tracked-${action}-${changeId}-${revision}`,
        }),
      })).json() as { revision: number }
      onRevised(result.revision)
      setNote(t('trackedChangeResolved'))
    } catch (cause) {
      setNote(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function sendReply() {
    if (revision === null || readOnly || !reply.trim()) return
    setBusy(true)
    setNote('')
    try {
      const result = await (await api(session, '/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: revision,
          text: reply.trim(),
          patchId: `comment-${revision}-${crypto.randomUUID()}`,
        }),
      })).json() as { revision: number }
      setReply('')
      onRevised(result.revision)
      setNote(t('commentReplySaved'))
    } catch (cause) {
      setNote(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return <section className="review-panel">
    <h3>{t('trackedChanges')}</h3>
    {tracked.length === 0 ? <p>{t('noTrackedChanges')}</p> : <ul className="review-list">{tracked.map(change => <li key={`${change.kind}:${change.changeId}`}>
      <strong>{change.kind}</strong> {change.author ? <span>{change.author}</span> : null}
      <p>{change.text}</p>
      <button disabled={readOnly || busy || revision === null} onClick={() => void resolve(change.changeId, 'accept')}>{t('acceptChange')}</button>
      <button disabled={readOnly || busy || revision === null} onClick={() => void resolve(change.changeId, 'reject')}>{t('rejectChange')}</button>
    </li>)}</ul>}
    <h3>{t('comments')}</h3>
    {comments.length === 0 ? <p>{t('noComments')}</p> : <ul className="review-list">{comments.map(comment => <li key={comment.blockId}><p>{comment.text}</p></li>)}</ul>}
    {comments.length > 0 && <label>{t('commentReply')}<textarea value={reply} disabled={readOnly || busy} onChange={event => setReply(event.target.value)} /></label>}
    {comments.length > 0 && <button disabled={readOnly || busy || revision === null || !reply.trim()} onClick={() => void sendReply()}>{t('sendReply')}</button>}
    {note && <p>{note}</p>}
  </section>
}
