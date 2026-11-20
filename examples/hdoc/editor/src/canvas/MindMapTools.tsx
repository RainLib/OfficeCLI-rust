import { MagneticHandle } from './MagneticHandle'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { FONT_FAMILY, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { Plus, ListPlus } from 'lucide-react'
import type { BuiltinDraft } from './BoardBuiltins'
import { usePaintStack } from './paintStack'
import {
  addMindNode,
  isMindNode,
  mindOwner,
  mindParent,
  mindSide,
  mindFields,
  mindText,
  saveMindText,
  type MindDirection,
  type MindText,
  type MindFields,
} from './mindMap'

type Props = { api: ExcalidrawImperativeAPI; edit: (draft: BuiltinDraft) => void }

function branch({ api, edit }: Props, id: string, sibling = false, direction?: MindDirection) {
  const scene = api.getSceneElements(),
    node = scene.find((el) => el.id === id && isMindNode(el))
  if (!node || node.locked || api.getAppState().viewModeEnabled) return
  const parent = sibling ? mindParent(scene, node) || node : node
  if (parent.locked) return
  const beside = sibling && parent.id !== id ? node : undefined
  const side = direction ?? (beside ? (node.x < parent.x ? -1 : 1) : mindSide(scene, parent))
  const added = addMindNode(api, parent, parent, side, beside)
  edit({ kind: 'mind', id: added, at: parent })
}

type HandleSide = 'left' | 'right' | 'below'
const handleRadius = 23
const fontsById = new Map(Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]))

// The hit circle stays still while only its face travels toward the pointer.
function BranchHandle({
  side,
  label,
  hint,
  add,
}: {
  side: HandleSide
  label: string
  hint: string
  add: () => void
}) {
  return <MagneticHandle className={'mind-branch mind-' + side} aria-label={label} title={hint}
    onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); add() }}>
    {side === 'below' ? <ListPlus size={15} strokeWidth={1.9}/> : <Plus size={15} strokeWidth={2}/>}
  </MagneticHandle>
}

export function MindMapTools({ api, enabled, edit }: Props & { enabled: boolean }) {
  const layer = useRef<HTMLDivElement>(null)
  const scene = usePaintStack(api)
  const [hover, setHover] = useState(''),
    [selected, setSelected] = useState('')
  const currentEdit = useRef(edit)
  currentEdit.current = edit
  useEffect(() => {
    const sync = () => {
      const app = api.getAppState(),
        all = api.getSceneElements(),
        ids = Object.keys(app.selectedElementIds)
      const owners = ids.map((id) =>
        mindOwner(
          all,
          all.find((el) => el.id === id),
        ),
      )
      const first = owners[0]
      setSelected(first && !first.locked && owners.every((el) => el?.id === first.id) ? first.id : '')
    }
    sync()
    return api.onChange(sync)
  }, [api])
  useEffect(() => {
    const board = layer.current?.closest<HTMLElement>('.canvas-surface')
    if (!enabled || !board) {
      setHover('')
      return
    }
    const move = (e: PointerEvent) => {
      const target = e.target
      if (target instanceof Element && target.closest('.mind-quick-tools')) return
      if (e.buttons || !(target instanceof HTMLCanvasElement)) {
        setHover('')
        return
      }
      const state = api.getAppState(),
        p = viewportCoordsToSceneCoords(e, state),
        all = api.getSceneElements()
      const front = [...all].reverse()
      const hit = front.find(
        (el) =>
          el.opacity &&
          el.type !== 'arrow' &&
          el.type !== 'line' &&
          p.x >= el.x &&
          p.y >= el.y &&
          p.x <= el.x + el.width &&
          p.y <= el.y + el.height,
      )
      const owner = mindOwner(all, hit)
      if (hit) {
        setHover(owner && !owner.locked ? owner.id : '')
        return
      }
      // A first approach from the empty canvas can acquire the same circular
      // target as a pointer leaving the card. Overlapping objects keep priority.
      const r = handleRadius / state.zoom.value
      const near = front.find((node) => {
        if (
          !isMindNode(node) ||
          node.locked ||
          p.x < node.x - 2 * r ||
          p.x > node.x + node.width + 2 * r ||
          p.y < node.y ||
          p.y > node.y + node.height + 2 * r
        )
          return false
        const parent = mindParent(all, node)
        const dir = parent && mindSide(all, node)
        const x = node.x + node.width / 2,
          y = node.y + node.height / 2
        return (
          (dir !== 1 && Math.hypot(p.x - node.x + r, p.y - y) < r) ||
          (dir !== -1 && Math.hypot(p.x - node.x - node.width - r, p.y - y) < r) ||
          (!!parent && !parent.locked && Math.hypot(p.x - x, p.y - node.y - node.height - r) < r)
        )
      })
      setHover(near?.id ?? '')
    }
    const leave = () => setHover('')
    const keys = (e: KeyboardEvent) => {
      if (
        !selected ||
        !board.checkVisibility() ||
        board.closest('[inert]') ||
        e.isComposing ||
        e.repeat ||
        e.defaultPrevented ||
        e.altKey ||
        (e.key !== 'Tab' && e.key !== 'Enter') ||
        (e.key === 'Tab' && (e.shiftKey || e.metaKey || e.ctrlKey)) ||
        board.querySelector('.context-menu,.stamp-feedback-layer,.board-tool-popup,.stamp-wheel') ||
        api.getAppState().editingTextElement
      )
        return
      const target = e.target
      if (
        target instanceof Element &&
        (target.closest('input,textarea,select,button,a,form,[contenteditable=true],[role=dialog]') ||
          (target !== document.body && !board.contains(target)))
      )
        return
      e.preventDefault()
      e.stopImmediatePropagation()
      const sibling = e.key === 'Enter' && (!(e.ctrlKey || e.metaKey) || e.shiftKey)
      branch({ api, edit: currentEdit.current }, selected, sibling)
    }
    board.addEventListener('pointermove', move)
    board.addEventListener('pointerleave', leave)
    window.addEventListener('keydown', keys, true)
    return () => {
      board.removeEventListener('pointermove', move)
      board.removeEventListener('pointerleave', leave)
      window.removeEventListener('keydown', keys, true)
    }
  }, [api, enabled, selected])
  const node = enabled
    ? scene.find((el) => el.id === (hover || selected) && isMindNode(el) && !el.locked)
    : undefined
  const app = api.getAppState(),
    z = app.zoom.value
  const parent = node ? mindParent(scene, node) : undefined
  const side = node ? mindSide(scene, node) : 1
  const outward = (dir: MindDirection, primary: boolean) => (
    <BranchHandle
      key={dir}
      side={dir === 1 ? 'right' : 'left'}
      label={primary ? '子节点' : dir === 1 ? '向右添加子节点' : '向左添加子节点'}
      hint={'向' + (dir === 1 ? '右' : '左') + '添加子节点 · Tab'}
      add={() => branch({ api, edit }, node!.id, false, dir)}
    />
  )
  return (
    <div
      ref={layer}
      className="mind-controls-layer"
      style={{ '--mind-hit-size': 2 * handleRadius + 'px' } as CSSProperties}
    >
      {node && (
        <div
          className="mind-quick-tools"
          role="toolbar"
          aria-label="思维导图节点操作"
          data-node={node.id}
          style={{
            left: (node.x + app.scrollX) * z,
            top: (node.y + app.scrollY) * z,
            width: node.width * z,
            height: node.height * z,
          }}
        >
          {outward(side, true)}
          {!parent && outward(side === 1 ? -1 : 1, false)}
          {parent && !parent.locked && (
            <BranchHandle
              side="below"
              label="同级节点"
              hint="添加同级节点 · Enter"
              add={() => branch({ api, edit }, node.id, true)}
            />
          )}
        </div>
      )}
    </div>
  )
}

type EditorProps = Props & {
  id: string
  field?: keyof MindText
  clientPoint?: { x: number; y: number }
  close: (focus: boolean) => void
}
export function MindNodeEditor(props: EditorProps) {
  const scene = usePaintStack(props.api)
  const node = scene.find((el) => el.id === props.id)
  if (!node || node.locked) return null
  return <InlineFields {...props} node={node} fields={mindFields(scene, node)} />
}

function InlineFields({
  api,
  edit,
  id,
  field = 'title',
  clientPoint,
  node,
  fields,
  close,
}: EditorProps & { node: ExcalidrawElement; fields: MindFields }) {
  const initial = useRef(mindText(fields))
  const [value, setValue] = useState(initial.current)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const inputs = useRef<Partial<Record<keyof MindText, HTMLTextAreaElement | null>>>({})
  const finished = useRef(false)
  function save(next?: 'child' | 'sibling', focus = true) {
    if (finished.current) return
    try {
      saveMindText(api, id, initial.current, value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    finished.current = true
    if (next) branch({ api, edit }, id, next === 'sibling')
    else close(focus)
  }
  const saveLatest = useRef(save)
  saveLatest.current = save
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        saveLatest.current(undefined, false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [])
  useLayoutEffect(() => {
    const input = inputs.current[field]
    if (!input) return
    input.focus({ preventScroll: true })
    input.setSelectionRange(input.value.length, input.value.length)
    // Place the caret at the double-click, using the browser's own text hit testing.
    if (clientPoint && input.value) {
      const mirror = document.createElement('span')
      const style = getComputedStyle(input)
      Object.assign(mirror.style, {
        position: 'absolute',
        inset: input.style.top + ' auto auto ' + input.style.left,
        width: input.style.width,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        font: style.font,
        lineHeight: style.lineHeight,
        textAlign: style.textAlign,
        color: 'transparent',
        pointerEvents: 'auto',
      })
      mirror.textContent = input.value
      root.current?.append(mirror)
      const range = document.caretRangeFromPoint?.(clientPoint.x, clientPoint.y)
      if (range && range.startContainer === mirror.firstChild)
        input.setSelectionRange(range.startOffset, range.startOffset)
      mirror.remove()
    }
  }, [field, clientPoint])

  const app = api.getAppState(),
    z = app.zoom.value
  const inset = node.customData?.officeDiagram ? 24 : 16
  const width = Math.max(24, node.width - inset * 2)
  const keys = ['title', 'body'] as const
  // An absent field stays available without displacing the other field's printed baseline.
  const first = fields.title,
    second = fields.body
  const titleTop = first
    ? first.y - node.y
    : second
      ? Math.max(2, second.y - node.y - 27)
      : Math.max(4, (node.height - 48) / 2)
  const bodyTop = second ? second.y - node.y : first ? titleTop + first.height + 7 : titleTop + 29
  return (
    <div
      ref={root}
      role="group"
      aria-label="编辑思维导图节点"
      className="mind-inline-editor"
      data-node={id}
      style={
        {
          left: (node.x + app.scrollX) * z,
          top: (node.y + app.scrollY) * z,
          width: node.width,
          height: node.height,
          transform: `scale(${z}) rotate(${node.angle}rad)`,
          '--mind-zoom': z,
        } as CSSProperties
      }
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) save(undefined, false)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
        if (e.key === 'Escape') {
          e.preventDefault()
          finished.current = true
          close(true)
          return
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          save()
          return
        }
        if (e.target !== inputs.current.title) return
        if (e.key === 'ArrowDown' || (e.key === 'Enter' && e.shiftKey)) {
          e.preventDefault()
          inputs.current.body?.focus()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          save('sibling')
        } else if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault()
          save('child')
        }
      }}
    >
      {keys.map((key) => {
        const el = fields[key],
          size = el?.fontSize ?? (key === 'title' ? 20 : 16)
        const line = el?.lineHeight ?? 1.15
        const top = key === 'title' ? titleTop : bodyTop
        const textColor =
          el?.strokeColor ??
          (node.customData?.officeDiagram?.kind === 'topic'
            ? '#fff'
            : key === 'title'
              ? '#252722'
              : '#61655c')
        return (
          <textarea
            key={key}
            ref={(e) => {
              inputs.current[key] = e
            }}
            rows={1}
            aria-label={key === 'title' ? '节点名称' : '节点描述'}
            placeholder={key === 'title' ? '标题' : '描述'}
            maxLength={key === 'title' ? 80 : 360}
            value={value[key]}
            spellCheck={false}
            style={{
              left: el ? el.x - node.x : inset,
              top,
              width: el?.containerId ? el.width : width,
              minHeight: size * line,
              maxHeight: Math.max(
                size * line,
                key === 'title' ? bodyTop - top - 2 : node.height - top - 2,
              ),
              fontSize: size,
              fontFamily: (fontsById.get(el?.fontFamily ?? 2) ?? 'Helvetica') + ', Arial, sans-serif',
              lineHeight: line,
              textAlign:
                el?.textAlign === 'center' ? 'center' : el?.textAlign === 'right' ? 'right' : 'left',
              color: textColor,
            }}
            onChange={(e) => setValue({ ...value, [key]: e.target.value })}
          />
        )
      })}
      {error && <small role="alert">{error}</small>}
    </div>
  )
}
