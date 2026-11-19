import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArchiveRestore, X } from 'lucide-react'
import type { InputDraft } from '../inputDraftJournal'

type Props = {
  drafts: InputDraft[]
  epoch?: number
  writable: boolean
  busy: boolean
  visible: boolean
  restore: (draft: InputDraft) => Promise<void>
}

export function CanvasDraftRecovery({ drafts, epoch, writable, busy, visible, restore }: Props) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  const key = 'officecli:draft-reminder:' + drafts[0].namespace
  const versions = JSON.stringify(drafts.map((draft) => [draft.id, draft.version]))
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(key) !== versions
    } catch {
      return true
    }
  })
  const [restoring, setRestoring] = useState('')
  const [error, setError] = useState('')
  const [surface, setSurface] = useState<Element | null>(null)
  useEffect(() => {
    setSurface(trigger.current?.closest('.canvas-workspace')?.querySelector('.canvas-surface') ?? null)
  }, [])

  function later(focus: boolean) {
    setOpen(false)
    try {
      sessionStorage.setItem(key, versions)
    } catch {
      /* Optional preference. */
    }
    if (focus) trigger.current?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!open || !visible) return
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        later(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const focused = panel.current?.contains(document.activeElement) ?? false
      if (focused) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      later(focused)
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [open, visible, key, versions])

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="canvas-draft-trigger"
        aria-label="本地草稿"
        aria-haspopup="dialog"
        aria-expanded={visible && open}
        aria-controls={open ? titleId + '-panel' : undefined}
        onClick={() => {
          if (open) later(false)
          else {
            setOpen(true)
            requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }))
          }
        }}
      >
        <ArchiveRestore size={13} />
        本地草稿{drafts.length > 1 ? ' · ' + drafts.length : ''}
      </button>
      {visible &&
        open &&
        surface &&
        createPortal(
          <section
            ref={panel}
            role="dialog"
            tabIndex={-1}
            className="canvas-draft-panel"
            id={titleId + '-panel'}
            aria-labelledby={titleId}
          >
            <header>
              <ArchiveRestore size={17} />
              <strong id={titleId}>恢复本地草稿</strong>
              <button aria-label="稍后处理" title="稍后处理" onClick={() => later(true)}>
                <X size={16} />
              </button>
            </header>
            <p>上次离开时，有修改只保存在此浏览器。</p>
            <ul>
              {drafts.map((draft) => (
                <li key={draft.id}>
                  <time dateTime={new Date(draft.updatedAt).toISOString()}>
                    {new Date(draft.updatedAt).toLocaleString(undefined, {
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                  {draft.epoch !== epoch ? (
                    <small>历史版本草稿</small>
                  ) : !writable ? (
                    <small>需要编辑权限</small>
                  ) : (
                    <button
                      disabled={busy || !!restoring}
                      aria-label={'恢复 ' + new Date(draft.updatedAt).toLocaleTimeString()}
                      onClick={async () => {
                        setRestoring(draft.id)
                        setError('')
                        try {
                          await restore(draft)
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : String(cause))
                        } finally {
                          setRestoring('')
                        }
                      }}
                    >
                      {restoring === draft.id ? '恢复中…' : '恢复草稿'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {error && <p role="alert">{error}</p>}
          </section>,
          surface,
        )}
    </>
  )
}
