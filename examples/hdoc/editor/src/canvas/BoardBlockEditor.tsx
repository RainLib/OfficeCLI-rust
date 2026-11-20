import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { ArrowUp, AtSign, Check, ImagePlus, Smile, X } from 'lucide-react'
import { boardTag, insertBoardShapes, insertComment, type BoardPoint } from './boardObjects'
import { usePaintStack } from './paintStack'
import { readBoardMedia, type BoardMedia } from './BoardBuiltins'
import { MentionText, useBoardMentions, type BoardPerson, type BoardMention } from './BoardMentions'

export type BoardDraft = {
  kind: 'sticky' | 'spec' | 'comment' | 'table'
  at: BoardPoint
  id?: string
  width?: number
  height?: number
  format?: import('./StickyToolbar').NoteFormat
  creating?: boolean
  full?: boolean
  clientPoint?: BoardPoint
  focusMessage?: string
}
export function commentTime(value: unknown) {
  const ts = Number(value)
  if (!Number.isFinite(ts) || ts <= 0) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60000))
  return minutes < 1
    ? '刚刚'
    : minutes < 60
      ? minutes + ' 分钟前'
      : minutes < 1440
        ? Math.floor(minutes / 60) + ' 小时前'
        : new Date(ts).toLocaleDateString()
}
export function BoardBlockEditor({
  draft,
  editor,
  author,
  personId,
  people,
  writable,
  onClose,
  onCreate,
}: {
  draft: BoardDraft
  editor: ExcalidrawImperativeAPI
  author: string
  personId?: string
  people: BoardPerson[]
  writable: boolean
  onClose: () => void
  onCreate?: (id: string, point: BoardPoint) => void
}) {
  const scene = usePaintStack(editor),
    root = scene.find((el) => el.id === draft.id)
  const [body, setBody] = useState(''),
    [emoji, setEmoji] = useState(false),
    [photo, setPhoto] = useState<BoardMedia | null>(null)
  const [error, setError] = useState(''),
    [reading, setReading] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null),
    upload = useRef<HTMLInputElement>(null),
    form = useRef<HTMLFormElement>(null),
    linkedMessage = useRef<HTMLElement>(null)
  const mention = useBoardMentions(area, body, setBody, people)
  const app = editor.getAppState(),
    z = app.zoom.value,
    width = Math.min(300, Math.max(150, app.width - 24))
  const x = ((root?.x ?? draft.at.x) + app.scrollX) * z,
    y = ((root?.y ?? draft.at.y) + app.scrollY) * z
  const offset = root ? Math.max(26, Math.min(44, root.width * z)) : 32
  const left = x + offset + 12 + width <= app.width - 8 ? x + offset + 12 : Math.max(8, x - width - 12)
  const [height, setHeight] = useState(104)
  const top = Math.max(8, Math.min(y - 3, app.height - height - 12))
  useEffect(() => {
    const node = form.current
    if (!node) return
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (draft.focusMessage) {
      linkedMessage.current?.scrollIntoView({ block: 'nearest' })
      linkedMessage.current?.focus({ preventScroll: true })
    } else area.current?.focus({ preventScroll: true })
  }, [draft.focusMessage])
  useLayoutEffect(() => {
    const input = area.current
    if (!input) return
    input.style.height = '0px'
    input.style.height = Math.min(176, Math.max(54, input.scrollHeight)) + 'px'
  }, [body, width])
  useEffect(() => {
    if (body || photo) return
    const dismiss = (e: PointerEvent) => {
      if (
        form.current &&
        !form.current.contains(e.target as Node) &&
        !(e.target as Element)?.closest('.board-comment-pin')
      )
        onClose()
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [draft.id, body, photo, onClose])
  const thread = root
    ? [
        root,
        ...scene
          .filter((el) => boardTag(el)?.root === draft.id && boardTag(el)?.part === 'reply')
          .sort((a, b) => Number(a.customData?.createdAt) - Number(b.customData?.createdAt)),
      ]
    : []
  function save() {
    if (!writable || reading || (!body.trim() && !photo)) return
    if (draft.id && !editor.getSceneElements().some((el) => el.id === draft.id)) {
      setError('这条评论已被移除。')
      return
    }
    const start = body.length - body.trimStart().length,
      text = body.trim()
    const mentions = mention.mentions.map((m) => ({ ...m, start: m.start - start, end: m.end - start }))
    const metadata = {
      createdAt: Date.now(),
      authorId: personId,
      mentions,
      ...(photo && { imageFileId: photo.file.id }),
    }
    if (photo) editor.addFiles([photo.file])
    if (!draft.id) {
      const id = insertComment(editor, draft.at, author, text, metadata)
      onCreate?.(id, draft.at)
    } else
      insertBoardShapes(
        editor,
        [
          {
            id: 'reply-' + crypto.randomUUID(),
            type: 'text',
            x: root?.x ?? draft.at.x,
            y: root?.y ?? draft.at.y,
            text: text || ' ',
            fontSize: 12,
            opacity: 0,
            locked: true,
            customData: {
              ...metadata,
              officeBoard: { kind: 'comment', root: draft.id, part: 'reply', author },
            },
          },
        ],
        draft.id,
      )
    onClose()
  }
  function resolve() {
    const target = editor.getSceneElements().find((el) => el.id === draft.id)
    if (!writable || !target) return
    editor.updateScene({
      elements: editor
        .getSceneElementsIncludingDeleted()
        .map((el) =>
          el.id === target.id
            ? newElementWith(el, {
                customData: {
                  ...el.customData,
                  officeBoard: { ...boardTag(el), resolved: !boardTag(el)?.resolved },
                },
              })
            : el,
        ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    onClose()
  }
  return (
    <>
      {!draft.id && (
        <div className="board-comment-anchor" aria-hidden="true" style={{ left: x, top: y }} />
      )}
      <form
        ref={form}
        className="board-comment-composer"
        aria-label="评论线程"
        style={{ left, top, width }}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || mention.key(e)) return
          if (e.key === 'Escape') {
            e.preventDefault()
            if (emoji) setEmoji(false)
            else onClose()
          } else if (e.key === 'Enter' && !e.shiftKey && e.target === area.current) {
            e.preventDefault()
            save()
          }
        }}
      >
        {thread.length > 0 && (
          <div className="board-comment-thread">
            {thread.map((el) => {
              const tag = boardTag(el),
                data = el.customData,
                text = el.type === 'text' ? el.originalText : String(data?.officeComment || '')
              const image = data?.imageFileId && editor.getFiles()[data.imageFileId]
              const focused = el.id === draft.focusMessage
              return (
                <article key={el.id} data-mentioned={focused || undefined} ref={focused ? linkedMessage : undefined} tabIndex={focused ? -1 : undefined}>
                  <span className="board-person-badge">{Array.from(tag?.author || '协')[0]}</span>
                  <div>
                    <b>{tag?.author || '协作者'}</b>{' '}
                    <time>{commentTime(data?.createdAt ?? el.updated)}</time>
                    <p>
                      <MentionText text={text} mentions={data?.mentions as BoardMention[]} />
                    </p>
                    {image && <img src={image.dataURL} alt="评论配图" />}
                  </div>
                </article>
              )
            })}
            <div className="board-thread-actions">
              {writable && (
                <button type="button" onClick={resolve}>
                  <Check size={14} />
                  {boardTag(root)?.resolved ? '重新打开' : '解决评论'}
                </button>
              )}
              <button type="button" aria-label="关闭评论" onClick={onClose}>
                <X size={14} />
              </button>
            </div>
          </div>
        )}
        {writable && (
          <>
            <textarea
              ref={area}
              aria-label="评论内容"
              placeholder={root ? '回复，@ 提及协作者' : '写下备注，@ 提及协作者'}
              rows={2}
              value={body}
              {...mention.inputProps}
              onClick={mention.refresh}
              onChange={(e) => mention.change(e.target.value, e.target.selectionStart)}
            />
            {photo && (
              <div className="board-comment-attachment">
                <img alt={photo.name} src={photo.file.dataURL} />
                <button type="button" aria-label="移除配图" onClick={() => setPhoto(null)}>
                  <X size={14} />
                </button>
              </div>
            )}
            {error && <small role="alert">{error}</small>}
            {mention.menu}
            <footer>
              <button
                type="button"
                aria-label="添加表情"
                aria-expanded={emoji}
                onClick={() => setEmoji((v) => !v)}
              >
                <Smile size={17} />
              </button>
              <button
                type="button"
                aria-label="提及协作者"
                onClick={() => {
                  setEmoji(false)
                  mention.insert('@')
                }}
              >
                <AtSign size={17} />
              </button>
              <button type="button" aria-label="添加图片" onClick={() => upload.current?.click()}>
                <ImagePlus size={17} />
              </button>
              <input
                ref={upload}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={async (e) => {
                  const f = e.currentTarget.files?.[0]
                  e.currentTarget.value = ''
                  if (!f) return
                  setReading(true)
                  try {
                    setPhoto(await readBoardMedia(f))
                    setError('')
                  } catch (err) {
                    setError(String(err))
                  } finally {
                    setReading(false)
                  }
                }}
              />
              <button type="submit" aria-label="发送" disabled={reading || (!body.trim() && !photo)}>
                <ArrowUp size={17} />
              </button>
            </footer>
            {emoji && (
              <div className="board-comment-emoji" role="group" aria-label="选择表情">
                {['👍', '❤️', '🎉', '👀', '💡', '✅'].map((symbol) => (
                  <button
                    type="button"
                    key={symbol}
                    onClick={() => {
                      mention.insert(symbol)
                      setEmoji(false)
                    }}
                  >
                    {symbol}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </form>
    </>
  )
}
