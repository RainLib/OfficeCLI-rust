import { useEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Check, X } from 'lucide-react'
import {
  boardTag,
  insertBoardShapes,
  insertComment,
  type BoardPoint,
} from './boardObjects'

export type BoardDraft = {
  kind: 'sticky' | 'spec' | 'comment' | 'table'
  at: BoardPoint
  id?: string
  width?: number
  format?: import('./StickyToolbar').NoteFormat
  height?: number
  creating?: boolean
  full?: boolean
  clientPoint?: BoardPoint
}
type Props = {
  draft: BoardDraft
  editor: ExcalidrawImperativeAPI
  author: string
  writable: boolean
  onClose: () => void
  onCreate?:(id:string,point:BoardPoint)=>void
  onCell?: (id: string) => void
}
export function BoardBlockEditor({
  draft,
  editor,
  author,
  writable,
  onClose,
  onCell,onCreate,
}: Props) {
  const all = () => editor.getSceneElements(),
    initial = all(),
    root = initial.find((e) => e.id === draft.id)
  const line = (part: string) =>
    initial.find(
      (e) => boardTag(e)?.root === draft.id && boardTag(e)?.part === part,
    )
  const label = (id: string | undefined) =>
    initial.find((e) => e.type === 'text' && e.containerId === id)
  const textOf = (e: ReturnType<typeof line>) =>
    e?.type === 'text' ? e.originalText : ''
  const [body,setBody]=useState(draft.kind==='table'?textOf(label(draft.id)).trim():'')
  const [error,setError]=useState('')
  const [, refresh] = useState(0),
    closed = useRef(false)
  const wrap = useRef<HTMLFormElement>(null),
    area = useRef<HTMLTextAreaElement>(null)
  const base = useRef(body)
  const app = editor.getAppState(),
    zoom = app.zoom.value
  const width = Math.min(320, app.width - 24)
  const left = Math.max(
    8,
    Math.min((draft.at.x + app.scrollX) * zoom, app.width - width - 8),
  )
  const top = Math.max(
    8,
    Math.min(
      (draft.at.y + app.scrollY) * zoom,
      app.height - 175,
    ),
  )
  useEffect(() => {
    area.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    let last = ''
    return editor.onChange((elements, state) => {
      const versions = draft.id
        ? elements
            .filter((e) => e.id === draft.id || boardTag(e)?.root === draft.id)
            .map((e) => e.versionNonce)
            .join(',')
        : ''
      const next = [
        state.zoom.value,
        state.scrollX,
        state.scrollY,
        state.width,
        state.height,
        versions,
      ].join('/')
      if (next !== last) {
        last = next
        refresh((n) => n + 1)
      }
    })
  }, [editor, draft.id])
  const liveRoot = all().find((e) => e.id === draft.id)
  function close() {
    if (!closed.current) {
      closed.current = true
      onClose()
    }
  }
  function save() {
    if (closed.current) return
    if (!writable) {
      close()
      return
    }
    if (draft.id && !liveRoot) {
      setError('此对象已被协作者移除。')
      return
    }
    if (!draft.id && !body.trim()) {
      close()
      return
    }
    if (draft.kind === 'comment') {
      if (!draft.id) {const id=insertComment(editor,draft.at,author,body.trim());onCreate?.(id,draft.at)}
      else if (body.trim()) {
        const id = 'reply-' + crypto.randomUUID()
        // Each reply owns a different record, so two simultaneous replies can merge.
        insertBoardShapes(
          editor,
          [
            {
              id,
              type: 'text',
              ...draft.at,
              text: body.trim(),
              fontSize: 12,
              opacity: 0,
              locked: true,
              customData: {
                officeBoard: {
                  kind: 'comment',
                  root: draft.id,
                  part: 'reply',
                  author,
                },
                createdAt: Date.now(),
              },
            },
          ],
          draft.id,
        )
      }
    }
    if (draft.id && draft.kind==='table') {
      const wanted=new Map<string,{before:string;after:string}>()
      const cell=label(draft.id)
      if(cell)wanted.set(cell.id,{before:base.current,after:body})
      const changes = new Map(
        [...wanted].filter(([, v]) => v.before !== v.after),
      )
      const elements = editor.getSceneElementsIncludingDeleted()
      for (const [id, v] of changes) {
        const found = elements.find((e) => e.id === id && !e.isDeleted)
        if (
          !found ||
          found.type !== 'text' ||
          found.originalText.trimEnd() !== v.before.trimEnd()
        ) {
          setError(
            '这段内容刚被另一位协作者修改。草稿已保留，请复制后重新打开。',
          )
          return
        }
      }
      if (changes.size)
        editor.updateScene({
          elements: elements.map((el) => {
            const v = changes.get(el.id)
            if (!v || el.type !== 'text') return el
            const text = v.after || ' '
            return newElementWith(el, {
              text,
              originalText: text,
              height: Math.max(
                el.fontSize * el.lineHeight,
                text.split('\n').length * el.fontSize * el.lineHeight,
              ),
            })
          }),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        })
    }
    close()
  }
  const latestSave = useRef(save)
  latestSave.current = save
  useEffect(() => {
    if (draft.kind === 'comment') return
    const outside = (event: PointerEvent) => {
      if (!wrap.current || wrap.current.contains(event.target as Node)) return
      latestSave.current()
      if (!closed.current) {
        event.preventDefault()
        event.stopImmediatePropagation()
        area.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [draft.kind])
  function advanceCell(back: boolean) {
    const rootId = boardTag(root)?.root
    const cells = all()
      .filter((e) => rootId && boardTag(e)?.root === rootId)
      .sort(
        (a, b) =>
          boardTag(a)!.row! - boardTag(b)!.row! ||
          boardTag(a)!.col! - boardTag(b)!.col!,
      )
    const next =
      cells[cells.findIndex((e) => e.id === draft.id) + (back ? -1 : 1)]
    save()
    if (closed.current && next) onCell?.(next.id)
  }
  function resolve() {
    if (!liveRoot || !writable) return
    editor.updateScene({
      elements: editor.getSceneElementsIncludingDeleted().map((el) =>
        el.id === liveRoot.id
          ? newElementWith(el, {
              customData: {
                ...el.customData,
                officeBoard: {
                  ...boardTag(el),
                  resolved: !boardTag(el)?.resolved,
                },
              },
            })
          : el,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    close()
  }
  const replies =
    draft.kind === 'comment' && draft.id
      ? all()
          .filter(
            (e) =>
              boardTag(e)?.root === draft.id &&
              boardTag(e)?.part === 'reply' &&
              e.type === 'text',
          )
          .sort(
            (a, b) =>
              Number(a.customData?.createdAt) - Number(b.customData?.createdAt),
          )
      : []
  return (
    <form
      ref={wrap}
      className={'board-block-editor board-block-' + draft.kind}
      aria-label={
        {
          sticky: '编辑便利贴',
          spec: '编辑 Spec 文档',
          table: '编辑单元格',
          comment: '评论线程',
        }[draft.kind]
      }
      style={{ left, top, width }}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (
          e.key === 'Tab' &&
          draft.kind === 'table' &&
          e.target === area.current
        ) {
          e.preventDefault()
          e.stopPropagation()
          advanceCell(e.shiftKey)
          return
        }
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          save()
        }
      }}
    >
      <header>
        <strong>
          {
            {
              sticky: '便利贴',
              spec: 'Spec 文档',
              table: '单元格',
              comment: '评论',
            }[draft.kind]
          }
        </strong>
        <button
          type="button"
          aria-label="关闭编辑"
          onClick={draft.kind === 'comment' ? close : save}
        >
          <X size={15} />
        </button>
      </header>
      {draft.kind === 'comment' && root && (
        <div className="board-comment-list">
          <p>
            <b>{boardTag(root)?.author}</b>
            {String(root.customData?.officeComment || '')}
          </p>
          {replies.map((r) => (
            <p key={r.id}>
              <b>{boardTag(r)?.author}</b>
              {textOf(r)}
            </p>
          ))}
        </div>
      )}
      {writable && (
        <textarea
          ref={area}
          aria-label={
            draft.kind === 'comment'
                ? '评论内容'
                : draft.kind === 'table'
                  ? '单元格内容'
                  : '便利贴内容'
          }
          placeholder={
            draft.kind === 'comment'
              ? draft.id
                ? '回复…'
                : '写下评论…'
              : '写点什么…'
          }
          readOnly={!writable}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      )}
      {error && <p role="alert">{error}</p>}
      <footer>
        {draft.kind === 'comment' && draft.id && writable && (
          <button type="button" onClick={resolve}>
            {boardTag(liveRoot)?.resolved ? '重新打开' : '解决评论'}
          </button>
        )}
        <button type="submit">
          <Check size={13} />
          {writable ? (draft.kind === 'comment' ? '发送' : '完成') : '关闭'}
        </button>
      </footer>
    </form>
  )
}
