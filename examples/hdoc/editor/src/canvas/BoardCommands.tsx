import { useEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import {
  ArrowLeft,
  ArrowRight,
  CheckSquare2,
  Focus,
  Keyboard,
  LayoutTemplate,
  MousePointer2,
  PanelBottomClose,
  Redo2,
  Replace,
  Scan,
  Search,
  Sparkles,
  Undo2,
  UserRound,
} from 'lucide-react'

type Props = {
  editor: ExcalidrawImperativeAPI
  writable: boolean
  author: string
  close: () => void
  minimized: boolean
  toggleMin: () => void
  focused: boolean
  toggleFocus: () => void
  cursors: boolean
  toggleCursors: () => void
  paused: boolean
  toggleMotion: () => void
  undo: (redo: boolean) => void
  ask?: () => void
  compose?: () => void
  region?: () => void
}
const mac = /Mac|iPhone|iPad/.test(navigator.platform)
const mod = mac ? '⌘' : 'Ctrl+'
type Page = 'commands' | 'find' | 'keys' | 'account'
export function BoardCommands(p: Props) {
  const [page, setPage] = useState<Page>('commands'),
    [query, setQuery] = useState(''),
    [index, setIndex] = useState(0)
  const [needle, setNeedle] = useState(''),
    [replacement, setReplacement] = useState(''),
    [matchIndex, setMatchIndex] = useState(0)
  const [, refresh] = useState(0),
    [message, setMessage] = useState('')
  const located = useRef<string | null>(null)
  const root = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ;(search.current || root.current)?.focus({ preventScroll: true })
  }, [page])
  useEffect(() => {
    if (page !== 'find') return
    let last = ''
    return p.editor.onChange((els) => {
      const next = els
        .filter((e) => e.type === 'text')
        .map((e) => e.id + ':' + e.versionNonce)
        .join(',')
      if (last !== next) {
        last = next
        refresh((v) => v + 1)
      }
    })
  }, [p.editor, page])
  const found = p.editor
    .getSceneElements()
    .filter(
      (e) =>
        e.type === 'text' &&
        needle &&
        e.originalText.toLocaleLowerCase().includes(needle.toLocaleLowerCase()),
    )
  const matched = found[matchIndex % Math.max(1, found.length)]
  function locate(step: number) {
    if (!found.length) return
    const ix = (matchIndex + step + found.length) % found.length,
      target = found[ix]
    located.current = target.id
    setMatchIndex(ix)
    p.editor.updateScene({
      appState: {
        selectedElementIds: {
          [(target.type === 'text' && target.containerId) || target.id]: true,
        },
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    p.editor.scrollToContent(target, {
      animate: !matchMedia('(prefers-reduced-motion: reduce)').matches,
      duration: 200,
    })
  }
  function replace() {
    if (!p.writable || !matched || matched.type !== 'text' || matched.locked)
      return
    const all = p.editor.getSceneElementsIncludingDeleted(),
      live = all.find((e) => e.id === matched.id && !e.isDeleted)
    if (
      !live ||
      live.type !== 'text' ||
      live.locked ||
      live.originalText !== matched.originalText
    ) {
      setMessage('文字已更新，请重新查找。')
      return
    }
    if (
      live.containerId &&
      all.some((e) => e.id === live.containerId && e.locked)
    )
      return
    const pos = live.originalText
      .toLocaleLowerCase()
      .indexOf(needle.toLocaleLowerCase())
    if (pos < 0) return
    const text =
      live.originalText.slice(0, pos) +
      replacement +
      live.originalText.slice(pos + needle.length)
    p.editor.updateScene({
      elements: all.map((e) =>
        e.id === live.id
          ? newElementWith(live, {
              text,
              originalText: text,
              height:
                Math.max(1, text.split('\n').length) *
                live.fontSize *
                live.lineHeight,
            })
          : e,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    setMessage('已替换一处')
  }
  const actions = [
    {
      label: '查找与替换…',
      words: 'find replace 搜索',
      key: '',
      icon: Replace,
      run: () => setPage('find'),
    },
    {
      label: '全选',
      words: 'select all',
      key: mod + 'A',
      icon: CheckSquare2,
      run: () => {
        p.editor.setActiveTool({ type: 'selection' })
        p.editor.updateScene({
          appState: {
            selectedElementIds: Object.fromEntries(
              p.editor
                .getSceneElements()
                .filter(
                  (e) => !e.locked && !(e.type === 'text' && e.containerId),
                )
                .map((e) => [e.id, true]),
            ),
          },
          captureUpdate: CaptureUpdateAction.NEVER,
        })
        p.close()
      },
    },
    {
      label: '撤销',
      words: 'undo',
      key: mod + 'Z',
      icon: Undo2,
      run: () => {
        p.close()
        p.undo(false)
      },
      disabled: !p.writable,
    },
    {
      label: p.minimized ? '展开工具栏' : '最小化工具栏',
      words: 'minimize ui',
      key: '',
      icon: PanelBottomClose,
      run: () => {
        p.close()
        p.toggleMin()
      },
    },
    {
      label: p.focused ? '退出专注模式' : '隐藏界面',
      words: 'show hide ui focus',
      key: '',
      icon: Focus,
      run: () => {
        p.close()
        p.toggleFocus()
      },
    },
    {
      label: p.cursors ? '隐藏协作者光标' : '显示协作者光标',
      words: 'multiplayer cursors',
      key: '',
      icon: MousePointer2,
      run: () => {
        p.close()
        p.toggleCursors()
      },
    },
    {
      label: '键盘快捷键',
      words: 'keyboard shortcuts',
      key: '',
      icon: Keyboard,
      run: () => setPage('keys'),
    },
    {
      label: '个人设置',
      words: 'account settings 账户',
      key: '',
      icon: UserRound,
      run: () => setPage('account'),
    },
    {
      label: '重做',
      words: 'redo',
      key: mod + '⇧Z',
      icon: Redo2,
      run: () => {
        p.close()
        p.undo(true)
      },
      disabled: !p.writable,
    },
    ...(p.ask
      ? [
          {
            label: '与 AI 一起创作',
            words: 'agent ai',
            key: '',
            icon: Sparkles,
            run: () => {
              p.close()
              p.ask?.()
            },
          },
        ]
      : []),
    ...(p.compose
      ? [
          {
            label: '创作与自动排版',
            words: 'layout ai',
            key: '',
            icon: LayoutTemplate,
            run: () => {
              p.close()
              p.compose?.()
            },
          },
        ]
      : []),
    ...(p.region
      ? [
          {
            label: '框选区域',
            words: 'region ai',
            key: '',
            icon: Scan,
            run: () => {
              p.close()
              p.region?.()
            },
          },
        ]
      : []),
  ].filter((a) =>
    (a.label + ' ' + a.words)
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  return (
    <div
      className="board-commands"
      ref={root}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (
          e.key === 'Escape' ||
          ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')
        ) {
          e.preventDefault()
          e.stopPropagation()
          p.close()
          return
        }
        if (page !== 'commands') return
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const next =
            (index + (e.key === 'ArrowDown' ? 1 : -1) + actions.length) %
            Math.max(1, actions.length)
          setIndex(next)
          root.current
            ?.querySelector('[data-command-index="' + next + '"]')
            ?.scrollIntoView({ block: 'nearest' })
        }
        if (e.key === 'Enter' && e.target === search.current) {
          e.preventDefault()
          const action = actions[index]
          if (action && !action.disabled) action.run()
        }
      }}
    >
      {page === 'commands' ? (
        <>
          <label className="board-command-search">
            <Search />
            <input
              ref={search}
              aria-label="搜索白板操作"
              placeholder="搜索操作…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setIndex(0)
              }}
            />
            <kbd>{mod}K</kbd>
          </label>
          <div className="board-command-list">
            {actions.map((a, i) => (
              <button
                type="button"
                key={a.label}
                data-command-index={i}
                data-current={i === index}
                disabled={a.disabled}
                onPointerMove={() => setIndex(i)}
                onClick={a.run}
              >
                <a.icon />
                <span>{a.label}</span>
                {a.key && <kbd>{a.key}</kbd>}
              </button>
            ))}
            {!actions.length && <p>没有匹配的操作</p>}
          </div>
        </>
      ) : (
        <>
          <header>
            <button
              type="button"
              aria-label="返回操作"
              onClick={() => setPage('commands')}
            >
              <ArrowLeft />
            </button>
            <strong>
              {
                { find: '查找与替换', keys: '键盘快捷键', account: '个人设置' }[
                  page
                ]
              }
            </strong>
          </header>
          {page === 'find' && (
            <div className="board-find">
              <input
                ref={search}
                aria-label="查找文字"
                placeholder="查找文字"
                value={needle}
                onChange={(e) => {
                  setNeedle(e.target.value)
                  located.current = null
                  setMatchIndex(0)
                  setMessage('')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    locate(
                      e.shiftKey ? -1 : located.current === matched?.id ? 1 : 0,
                    )
                  }
                }}
              />
              <div>
                <small aria-live="polite">
                  {found.length
                    ? (matchIndex % found.length) + 1 + ' / ' + found.length
                    : '0 处'}
                </small>
                <button
                  disabled={!found.length}
                  aria-label="上一个匹配"
                  onClick={() => locate(-1)}
                >
                  <ArrowLeft />
                </button>
                <button
                  disabled={!found.length}
                  aria-label="下一个匹配"
                  onClick={() => locate(1)}
                >
                  <ArrowRight />
                </button>
              </div>
              {p.writable && (
                <>
                  <input
                    aria-label="替换为"
                    placeholder="替换为"
                    value={replacement}
                    onChange={(e) => setReplacement(e.target.value)}
                  />
                  <button
                    disabled={!matched || matched.locked}
                    onClick={replace}
                  >
                    替换一处
                  </button>
                </>
              )}
              <small role="status">{message}</small>
            </div>
          )}
          {page === 'keys' && (
            <dl className="board-command-keys">
              {[
                ['操作', mod + 'K'],
                ['选择 / 手形', 'V / H'],
                ['画笔 / 胶带', 'M / W'],
                ['便利贴 / 分区', 'S / ⇧S'],
                ['连线 / 折线', 'L / X'],
                ['印章 / 光标聊天', 'E / /'],
                ['评论 / 文字', 'C / T'],
                ['插入', '+'],
                ['退出工具', 'Esc'],
              ].map(([name, key]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>
                    <kbd>{key}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {page === 'account' && (
            <div className="board-person-settings">
              <strong>{p.author}</strong>
              <button aria-pressed={p.cursors} onClick={p.toggleCursors}>
                显示协作者光标
              </button>
              <button aria-pressed={!p.paused} onClick={p.toggleMotion}>
                播放贴纸动画
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
