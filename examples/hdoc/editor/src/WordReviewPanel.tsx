import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import type { Editor } from '@tiptap/react'
import { Check, ChevronDown, ChevronUp, LocateFixed, MessageSquare, PenLine, RotateCcw, X } from 'lucide-react'
import { api, type Session } from './api.ts'
import type { TextSpan } from './selectionTransfer.ts'
import { useI18n } from './i18n.tsx'
import { LocalText, localizeSource } from './sourceLocale.tsx'
import { createWordReviewAnchors, wordReviewAnchors, type WordReviewAnchor } from './wordReviewAnchors'
import { useWordReviewMargin } from './useWordReviewMargin'
import './word-review.css'

export type ReviewLocation = Pick<TextSpan, 'blockId' | 'start' | 'end'>
export type CommentDraft = TextSpan & { quote: string }
type TrackedChange = { id: number; kind: 'insert' | 'delete' }
export type ReviewAction =
  | ({ kind: 'comment'; text: string } & TextSpan)
  | { kind: 'reply'; threadId: number; text: string }
  | { kind: 'resolve'; threadId: number; resolved: boolean }
  | { kind: 'decide'; change: TrackedChange; accept: boolean }

type Comment = {
  id: number
  parentId: number | null
  author: string | null
  date: string | null
  text: string
  resolved: boolean
  location: ReviewLocation | null
  quote: string | null
  originalRangeChanged: boolean
}
type TrackedKind = 'insert' | 'delete' | 'moveFrom' | 'moveTo' | 'format' | 'table' | 'paragraphMark'
type Revision = {
  change: TrackedChange | null
  kind: TrackedKind
  author: string | null
  date: string | null
  text: string
  location: ReviewLocation | null
}
type Snapshot = { revision: number; comments: Comment[]; tracked: Revision[] }
const trackedLabel: Record<TrackedKind, string> = {
  insert: '插入文字', delete: '删除文字', moveFrom: '移动来源', moveTo: '移动目标',
  format: '格式修改', table: '表格结构', paragraphMark: '段落标记',
}

export function WordReviewPanel({ session, revision, historical, writable, draft, editor, margin = false, onClose, onCancelDraft, onLocate, onWrite }: {
  session: Session; revision: number | null; historical: number | null; writable: boolean
  draft: CommentDraft | null; onClose: () => void; onCancelDraft: () => void
  editor?: Editor | null; margin?: boolean
  onLocate: (location: ReviewLocation, anchorId?: string) => void
  onWrite: (action: ReviewAction, observedRevision?: number) => Promise<void>
}) {
  const { locale } = useI18n()
  const currentSession = useRef(session)
  currentSession.current = session
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [reload, setReload] = useState(0)
  const [commentText, setCommentText] = useState('')
  const [reply, setReply] = useState<{ id: number; text: string } | null>(null)
  const [working, setWorking] = useState(false)
  const [section, setSection] = useState<'comments' | 'tracked'>('comments')
  const [active, setActive] = useState<string | null>(null)
  const root = useRef<HTMLElement>(null)
  const replyInput = useRef<HTMLTextAreaElement>(null)
  const pendingComment = useRef<Set<number> | null>(null)
  const showTracked = section === 'tracked' && !draft
  const writing = useRef(false)
  const composer = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (draft && historical === null) composer.current?.focus()
  }, [draft, historical])
  useEffect(() => { if (reply) replyInput.current?.focus() }, [reply?.id])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    const endpoint = historical === null ? '/word-review' : '/word-review?revision=' + historical
    void api(currentSession.current, endpoint, { signal: controller.signal }).then(response => response.json()).then(result => {
      if (!controller.signal.aborted) setSnapshot(result)
    }).catch(cause => {
      if (!controller.signal.aborted) setLoadError(String(cause))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [session.documentId, revision, historical, reload])

  async function submit(action: ReviewAction, done?: () => void) {
    if (!writable || writing.current) return
    writing.current = true
    setWorking(true)
    setActionError('')
    try {
      await onWrite(action, action.kind === 'comment' ? undefined : snapshot?.revision)
      done?.()
    } catch (cause) {
      setActionError(String(cause))
    } finally {
      setReload(value => value + 1)
      writing.current = false
      setWorking(false)
    }
  }

  function sendComment(event: FormEvent) {
    event.preventDefault()
    if (!draft || !commentText.trim()) return
    const { blockId, start, end, textHash } = draft
    pendingComment.current = new Set(snapshot?.comments.map(comment => comment.id))
    void submit({ kind: 'comment', blockId, start, end, textHash, text: commentText }, () => {
      setCommentText('')
      onCancelDraft()
    })
  }

  const comments = snapshot?.comments ?? []
  const roots = comments.filter(comment => comment.parentId === null)
  const anchors = useMemo<WordReviewAnchor[]>(() => showTracked ? [] : [
    ...(snapshot?.comments ?? []).filter(comment => comment.parentId === null && comment.location)
      .map(comment => ({ id: 'comment-' + comment.id, location: comment.location! })),
    ...(draft ? [{ id: 'draft', location: draft }] : []),
  ], [snapshot, draft, showTracked])
  const layout = useWordReviewMargin(root, editor, anchors, active, margin)
  useEffect(() => {
    if (draft) { setActive('draft'); return }
    const roots = snapshot?.comments.filter(comment => comment.parentId === null) ?? []
    const posted = pendingComment.current && roots.find(comment => !pendingComment.current!.has(comment.id))
    if (posted) { pendingComment.current = null; setActive('comment-' + posted.id) }
    else setActive(previous => roots.some(comment => 'comment-' + comment.id === previous) ? previous : roots[0] ? 'comment-' + roots[0].id : null)
  }, [snapshot, draft])
  useEffect(() => {
    if (!margin || !editor) return
    editor.registerPlugin(createWordReviewAnchors())
    const activate = (event: MouseEvent) => {
      const mark = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-word-comment-id]') : null
      if (mark && editor.state.selection.empty) setActive(mark.dataset.wordCommentId ?? null)
    }
    editor.view.dom.addEventListener('click', activate)
    const dom = editor.view.dom
    return () => { dom.removeEventListener('click', activate); if (!editor.isDestroyed) editor.unregisterPlugin(wordReviewAnchors) }
  }, [editor, margin])
  useEffect(() => {
    if (margin && editor && !editor.isDestroyed && wordReviewAnchors.getState(editor.state)) {
      editor.view.dispatch(editor.state.tr.setMeta(wordReviewAnchors, { anchors }).setMeta('addToHistory', false))
    }
  }, [editor, margin, anchors])
  useEffect(() => {
    if (margin && editor && !editor.isDestroyed && wordReviewAnchors.getState(editor.state)) {
      editor.view.dispatch(editor.state.tr.setMeta(wordReviewAnchors, { active }).setMeta('addToHistory', false))
    }
  }, [editor, margin, active])
  function locate(comment: Comment) {
    setActive('comment-' + comment.id)
    if (comment.location) onLocate(comment.location, 'comment-' + comment.id)
  }
  function nextComment(delta: number) {
    if (!roots.length) return
    const ordered = [...roots].sort((a, b) => (layout.positions['comment-' + a.id] ?? 0) - (layout.positions['comment-' + b.id] ?? 0))
    const index = ordered.findIndex(comment => 'comment-' + comment.id === active)
    locate(ordered[(Math.max(0, index) + delta + ordered.length) % ordered.length])
  }
  const cardStyle = (id: string): CSSProperties | undefined => margin && !showTracked ? {
    top: layout.positions[id] ?? 72, visibility: layout.positions[id] === undefined ? 'hidden' : undefined,
  } : undefined
  const replies = new Map<number, Comment[]>()
  for (const comment of comments) {
    if (comment.parentId === null) continue
    const list = replies.get(comment.parentId)
    if (list) list.push(comment)
    else replies.set(comment.parentId, [comment])
  }
  const usable = writable && historical === null && !working && !loading && !loadError
  const renderMessage = (comment: Comment) => <div className="word-review-message" key={comment.id}>
    <div className="word-review-avatar" aria-hidden="true">{Array.from(comment.author || '?')[0]}</div>
    <div><header><strong>{comment.author || localizeSource(locale, '作者未记录')}</strong>
      {comment.date && Number.isFinite(Date.parse(comment.date)) && <time dateTime={comment.date}>{new Date(comment.date).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</time>}
    </header><p>{comment.text}</p></div>
  </div>
  return <section ref={root} className={'word-review-panel' + (margin ? ' word-review-in-margin' : '')}
    data-compact={layout.compact} data-mode={showTracked ? 'tracked' : 'comments'}
    style={margin && !showTracked ? { minHeight: layout.compact ? undefined : layout.height,
      '--word-review-card-max-height': layout.maxCardHeight + 'px' } as CSSProperties : undefined}>
    {margin && !showTracked && layout.path && <svg className="word-review-tethers" aria-hidden="true"
      width={layout.width} height={layout.height} style={{ left: -layout.left }}><path d={layout.path} /></svg>}
    <div className="word-review-heading">{showTracked ? <PenLine size={16} /> : <MessageSquare size={16} />}<h2><LocalText source={showTracked ? '原生修订' : '批注'} /></h2>
      {margin && !showTracked && <><span className="word-review-count">{roots.length}</span>
        <button className="word-review-step" aria-label={localizeSource(locale, '上一条批注')} disabled={!roots.length} onClick={() => nextComment(-1)}><ChevronUp size={15} /></button>
        <button className="word-review-step" aria-label={localizeSource(locale, '下一条批注')} disabled={!roots.length} onClick={() => nextComment(1)}><ChevronDown size={15} /></button></>}
      <button type="button" className="panel-close" aria-label={localizeSource(locale, '关闭审阅')} onClick={onClose}><X size={17} /></button>
    </div>
    <nav className="word-review-sections" aria-label={localizeSource(locale, '审阅内容')}>
      <button type="button" aria-pressed={!showTracked} onClick={() => setSection('comments')}><LocalText source="批注" /></button>
      <button type="button" aria-pressed={showTracked} disabled={!!draft || working} onClick={() => setSection('tracked')}><LocalText source="原生修订" /></button>
    </nav>
    {draft && historical === null && <form className="word-review-compose word-review-draft" data-review-card="draft" data-active={active === 'draft'} style={cardStyle('draft')} onSubmit={sendComment}>
      <blockquote>{draft.quote}</blockquote>
      <textarea ref={composer} aria-label={localizeSource(locale, '批注内容')} placeholder={localizeSource(locale, '写下批注…')} value={commentText} onChange={event => setCommentText(event.target.value)} rows={3} maxLength={4096} readOnly={working || !writable} />
      <div className="word-review-actions"><button type="button" disabled={working} onClick={() => { setCommentText(''); onCancelDraft() }}><LocalText source="取消" /></button>
        <button className="primary" disabled={!usable || !commentText.trim()}><LocalText source="发布批注" /></button></div>
    </form>}
    {actionError && <p role="alert" className="word-review-error">{actionError}</p>}
    {loadError ? <div className="word-review-error" role="alert"><p>{loadError}</p><button type="button" onClick={() => setReload(value => value + 1)}><LocalText source="重试" /></button></div>
      : loading && !snapshot ? <p role="status"><LocalText source="正在读取审阅内容…" /></p>
      : !showTracked && roots.length === 0 && !draft ? <p><LocalText source="暂无批注" /></p>
      : showTracked && !snapshot?.tracked.length ? <p><LocalText source="没有待审的原生修订" /></p> : null}
    {showTracked && snapshot?.tracked.map((revision, index) => <article className="word-review-thread word-review-revision"
      key={revision.change ? revision.change.kind + ':' + revision.change.id : index} data-kind={revision.kind}>
      <div className="word-review-revision-byline">
        <strong><LocalText source={trackedLabel[revision.kind]} /></strong>
        {revision.author && <span>{revision.author}</span>}
        {revision.date && Number.isFinite(Date.parse(revision.date)) && <time dateTime={revision.date}>{new Date(revision.date).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</time>}
      </div>
      {revision.text && <p className="word-review-snippet">{revision.text}</p>}
      {revision.location && <button className="word-review-anchor" type="button" disabled={loading} onClick={() => { if (revision.location) onLocate(revision.location) }}>
        <LocateFixed size={14}/><LocalText source="定位修订" />
      </button>}
      {!revision.change ? <small className="word-review-range-status"><LocalText source="此类型暂不可在工作台处理" /></small>
        : writable && historical === null && <div className="word-review-actions">
          <button type="button" disabled={!usable} onClick={() => { if (revision.change) void submit({ kind: 'decide', change: revision.change, accept: false }) }}><X size={13}/><LocalText source="拒绝修订" /></button>
          <button type="button" className="primary" disabled={!usable} onClick={() => { if (revision.change) void submit({ kind: 'decide', change: revision.change, accept: true }) }}><Check size={13}/><LocalText source="接受修订" /></button>
        </div>}
    </article>)}
    {!showTracked && roots.map(comment => <article className="word-review-thread" key={comment.id}
      data-review-card={'comment-' + comment.id} data-active={active === 'comment-' + comment.id} data-resolved={comment.resolved}
      style={cardStyle('comment-' + comment.id)} tabIndex={margin ? 0 : undefined}
      onFocusCapture={() => setActive('comment-' + comment.id)} onClick={() => setActive('comment-' + comment.id)}
      onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); locate(comment) } }}>
      {comment.location && <button className="word-review-anchor" type="button" disabled={loading}
        onMouseDown={event => event.preventDefault()} onClick={() => locate(comment)}><LocateFixed size={14} />
        <span>{comment.quote && !comment.originalRangeChanged ? comment.quote : localizeSource(locale, '定位原文')}</span></button>}
      {comment.originalRangeChanged && <small className="word-review-range-status">{localizeSource(locale, comment.location ? '原选区已变化' : '原段落已删除')}</small>}
      {renderMessage(comment)}
      {(!margin || active === 'comment-' + comment.id) ? replies.get(comment.id)?.map(renderMessage)
        : !!replies.get(comment.id)?.length && <span className="word-review-reply-count">{replies.get(comment.id)!.length} <LocalText source="条回复" /></span>}
      {comment.resolved && <span className="word-review-resolved"><Check size={13} /><LocalText source="已解决" /></span>}
      {writable && historical === null && (!margin || active === 'comment-' + comment.id) && <div className="word-review-actions">
        {!comment.resolved && reply?.id !== comment.id && <button type="button" disabled={!usable} onClick={() => setReply({ id: comment.id, text: '' })}><LocalText source="回复" /></button>}
        <button type="button" disabled={!usable} onClick={() => void submit({ kind: 'resolve', threadId: comment.id, resolved: !comment.resolved })}>
          {comment.resolved ? <RotateCcw size={13} /> : <Check size={13} />}<LocalText source={comment.resolved ? '重新打开批注' : '解决批注'} />
        </button>
      </div>}
      {reply?.id === comment.id && (!margin || active === 'comment-' + comment.id) && !comment.resolved && historical === null && writable && <form className="word-review-compose" onSubmit={event => {
        event.preventDefault()
        if (reply.text.trim()) void submit({ kind: 'reply', threadId: comment.id, text: reply.text }, () => setReply(null))
      }}>
        <textarea ref={replyInput} aria-label={localizeSource(locale, '回复内容')} value={reply.text} onChange={event => setReply({ id: comment.id, text: event.target.value })} readOnly={working} maxLength={4096} rows={2} />
        <div className="word-review-actions"><button type="button" disabled={working} onClick={() => setReply(null)}><LocalText source="取消" /></button><button className="primary" disabled={!usable || !reply.text.trim()}><LocalText source="发送回复" /></button></div>
      </form>}
    </article>)}
  </section>
}
