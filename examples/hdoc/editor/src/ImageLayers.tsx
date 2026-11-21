import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, GripVertical, ImageIcon, ImagePlus, Replace, Trash2 } from 'lucide-react'
import { api, type Session } from './api'
import './image-layers.css'

export type ImageLayer = {
  id: string
  name: string
  assetHash: string
  x: number
  y: number
  width: number
  height: number
  opacity: number
  visible: boolean
  blend: 'normal' | 'replace'
}
export type ImageLayerStack = { width: number; height: number; layers: ImageLayer[] }
export type ImageLayersSnapshot = { nodeId: string; visualHash: string; persisted: boolean; stack: ImageLayerStack }
const offset = (value: number) => Math.max(-32768, Math.min(32768, Math.round(value)))
const size = (value: number) => Math.max(1, Math.min(8192, Math.round(value)))

export function updateLayer(stack: ImageLayerStack, id: string, update: Partial<ImageLayer>): ImageLayerStack {
  return { ...stack, layers: stack.layers.map(layer => layer.id === id ? { ...layer, ...update } : layer) }
}

function LayerThumb({ session, layer }: { session: Session; layer: ImageLayer }) {
  const element = useRef<HTMLDivElement>(null), liveSession = useRef(session)
  liveSession.current = session
  const [active, setActive] = useState(false), [url, setUrl] = useState('')
  useEffect(() => {
    if (active || !element.current) return
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setActive(true) })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [active])
  useEffect(() => {
    if (!active) return
    const request = new AbortController()
    let objectUrl = ''
    setUrl('')
    void api(liveSession.current, `/image/layer-thumbnail/${layer.assetHash}`, { signal: request.signal })
      .then(response => response.blob()).then(blob => {
        if (request.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      }).catch(() => undefined)
    return () => { request.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [active, layer.assetHash, session.documentId, session.apiUrl])
  return <div className="image-layer-thumb" ref={element} aria-hidden="true">
    {url ? <img src={url} alt="" draggable={false} /> : <ImageIcon size={17} />}
  </div>
}

function Property({ label, value, disabled, min, max, update }: {
  label: string; value: number; disabled: boolean; min: number; max: number; update: (value: number) => void
}) {
  return <label>{label}<input type="number" aria-label={label} defaultValue={value} min={min} max={max} step={1} disabled={disabled}
    onBlur={event => {
      const input = event.currentTarget, next = input.valueAsNumber
      if (!Number.isInteger(next) || next < min || next > max) { input.value = String(value); return }
      if (next !== value) update(next)
    }} onKeyDown={event => {
      if (event.key === 'Escape') event.currentTarget.value = String(value)
      if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
    }} /></label>
}

export function ImageLayersPanel({ session, stack, selected, revision, disabled, onSelect, onSave, onUpload }: {
  session: Session; stack: ImageLayerStack; selected?: ImageLayer; revision: number; disabled: boolean
  onSelect: (id: string) => void; onSave: (stack: ImageLayerStack, select?: string) => void
  onUpload: (file: File, replace?: string) => void
}) {
  const input = useRef<HTMLInputElement>(null), replace = useRef<string | undefined>(undefined)
  const [dragging, setDragging] = useState(''), [over, setOver] = useState('')
  const edit = (id: string, change: Partial<ImageLayer>) => onSave(updateLayer(stack, id, change), id)
  const position = selected ? stack.layers.findIndex(layer => layer.id === selected.id) : -1
  const addDisabled = disabled || stack.layers.length >= 64
  function filePicker(replaceId?: string) {
    replace.current = replaceId
    input.current?.click()
  }
  function reorder(id: string, to: number) {
    const from = stack.layers.findIndex(layer => layer.id === id)
    if (disabled || from < 0 || from === to || to < 0 || to >= stack.layers.length) return
    const layers = [...stack.layers]
    const [layer] = layers.splice(from, 1)
    layers.splice(to, 0, layer)
    onSave({ ...stack, layers }, id)
  }
  function duplicate(layer: ImageLayer) {
    const id = crypto.randomUUID()
    const next = { ...layer, id, name: Array.from(`${layer.name} 副本`).slice(0, 120).join(''), x: offset(layer.x + 12), y: offset(layer.y + 12) }
    const layers = [...stack.layers]
    layers.splice(position + 1, 0, next)
    onSave({ ...stack, layers }, id)
  }
  return <div className="image-layers">
    <div className="image-layer-toolbar">
      <button type="button" className="im-soft" disabled={addDisabled} onClick={() => filePicker()}><ImagePlus size={16} />导入图层</button>
      <div className="image-layer-order" aria-label="图层顺序">
        <button type="button" className="im-icon" aria-label="上移图层" title="上移图层" disabled={disabled || position < 0 || position >= stack.layers.length - 1} onClick={() => selected && reorder(selected.id, position + 1)}><ArrowUp size={15} /></button>
        <button type="button" className="im-icon" aria-label="下移图层" title="下移图层" disabled={disabled || position <= 0} onClick={() => selected && reorder(selected.id, position - 1)}><ArrowDown size={15} /></button>
      </div>
      <input type="file" hidden ref={input} accept="image/png,image/jpeg,image/webp" aria-label="图层图片文件" onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) onUpload(file, replace.current)
      }} />
    </div>
    <ol className="image-layer-list" aria-label="图层列表">
      {[...stack.layers].reverse().map(layer => <li key={layer.id} className="image-layer-row" data-layer-id={layer.id}
        data-selected={selected?.id === layer.id || undefined} data-drop={over === layer.id || undefined}
        draggable={!disabled} onDragStart={event => {
          event.dataTransfer.setData('application/x-officecli-image-layer', layer.id)
          event.dataTransfer.effectAllowed = 'move'
          setDragging(layer.id)
        }} onDragOver={event => {
          if (!dragging || dragging === layer.id) return
          event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(layer.id)
        }} onDragLeave={() => setOver(value => value === layer.id ? '' : value)} onDragEnd={() => { setDragging(''); setOver('') }}
        onDrop={event => {
          event.preventDefault()
          const id = event.dataTransfer.getData('application/x-officecli-image-layer')
          if (id && id === dragging) reorder(id, stack.layers.indexOf(layer))
          setDragging(''); setOver('')
        }}>
        <GripVertical className="image-layer-grip" size={14} aria-hidden="true" />
        <button type="button" className="image-layer-select" aria-pressed={selected?.id === layer.id} onClick={() => onSelect(layer.id)}>
          <LayerThumb session={session} layer={layer} /><span><strong>{layer.name}</strong><small>{layer.width} × {layer.height} · {layer.opacity}%</small></span>
        </button>
        <button type="button" className="im-icon" disabled={disabled} aria-label={`${layer.visible ? '隐藏图层' : '显示图层'} ${layer.name}`} title={layer.visible ? '隐藏图层' : '显示图层'}
          onClick={() => edit(layer.id, { visible: !layer.visible })}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</button>
      </li>)}
      {!stack.layers.length && <li className="image-layer-empty">还没有图层</li>}
    </ol>
    {selected && <section className="image-layer-properties" aria-label="图层属性" key={`${selected.id}:${revision}`}>
      <div className="image-layer-properties-head">
        <h3>图层属性</h3>
        <div>
          <button type="button" className="im-icon" aria-label="更换图层图片" title="更换图层图片" disabled={disabled} onClick={() => filePicker(selected.id)}><Replace size={15} /></button>
          <button type="button" className="im-icon" aria-label="复制图层" title="复制图层" disabled={addDisabled} onClick={() => duplicate(selected)}><Copy size={15} /></button>
          <button type="button" className="im-icon" aria-label="删除图层" title="删除图层" disabled={disabled} onClick={() => onSave({ ...stack, layers: stack.layers.filter(layer => layer.id !== selected.id) })}><Trash2 size={15} /></button>
        </div>
      </div>
      <label>名称<input aria-label="图层名称" defaultValue={selected.name} maxLength={120} disabled={disabled}
        onBlur={event => {
          const input = event.currentTarget, name = input.value.trim()
          if (!name) input.value = selected.name
          else if (name !== selected.name) edit(selected.id, { name })
        }} onKeyDown={event => {
          if (event.key === 'Escape') event.currentTarget.value = selected.name
          if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
        }} /></label>
      <div className="image-layer-fields">
        <Property label="横向位置" value={selected.x} min={-32768} max={32768} disabled={disabled} update={x => edit(selected.id, { x })} />
        <Property label="纵向位置" value={selected.y} min={-32768} max={32768} disabled={disabled} update={y => edit(selected.id, { y })} />
        <Property label="图层宽度" value={selected.width} min={1} max={8192} disabled={disabled} update={width => edit(selected.id, { width })} />
        <Property label="图层高度" value={selected.height} min={1} max={8192} disabled={disabled} update={height => edit(selected.id, { height })} />
        <Property label="不透明度 %" value={selected.opacity} min={0} max={100} disabled={disabled} update={opacity => edit(selected.id, { opacity })} />
      </div>
    </section>}
    <details className="image-layer-artboard" aria-label="图片画布尺寸">
      <summary>画布尺寸 <span>{stack.width} × {stack.height}</span></summary>
      <div className="image-layer-fields" key={revision}>
        <Property label="画布宽度" value={stack.width} min={1} max={8192} disabled={disabled} update={width => onSave({ ...stack, width })} />
        <Property label="画布高度" value={stack.height} min={1} max={8192} disabled={disabled} update={height => onSave({ ...stack, height })} />
      </div>
    </details>
  </div>
}

type LayerRect = Pick<ImageLayer, 'x' | 'y' | 'width' | 'height'>

export function ImageLayerHandles({ layer, scale, disabled, panning, onChange }: {
  layer: ImageLayer; scale: number; disabled: boolean; panning: () => boolean; onChange: (rect: LayerRect) => void
}) {
  const drag = useRef<{ id: number; x: number; y: number; resize: boolean; start: LayerRect; current: LayerRect } | null>(null)
  const [preview, setPreview] = useState<LayerRect | null>(null)
  const rect = preview || layer
  function begin(event: PointerEvent<HTMLElement>, resize: boolean) {
    if (event.button !== 0 || disabled || panning()) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y, width, height } = layer
    const start = { x, y, width, height }
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, resize, start, current: start }
  }
  function move(event: PointerEvent<HTMLElement>) {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    event.stopPropagation()
    const dx = (event.clientX - active.x) / scale, dy = (event.clientY - active.y) / scale
    const { x, y, width, height } = active.start
    active.current = active.resize ? { x, y, width: size(width + dx), height: size(height + dy) }
      : { x: offset(x + dx), y: offset(y + dy), width, height }
    setPreview(active.current)
  }
  function finish(event: PointerEvent<HTMLElement>) {
    const active = drag.current
    if (!active || active.id !== event.pointerId) return
    event.stopPropagation()
    drag.current = null
    setPreview(null)
    const { start, current } = active
    if (!disabled && event.type === 'pointerup' && (current.x !== start.x || current.y !== start.y || current.width !== start.width || current.height !== start.height)) onChange(current)
  }
  function nudge(event: KeyboardEvent<HTMLElement>) {
    if (disabled || !event.key.startsWith('Arrow')) return
    const step = event.shiftKey ? 10 : 1
    const x = offset(layer.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0))
    const y = offset(layer.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0))
    event.preventDefault()
    event.stopPropagation()
    onChange({ x, y, width: layer.width, height: layer.height })
  }
  return <div className="image-layer-outline" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, borderWidth: 1.5 / scale }}
    tabIndex={disabled ? -1 : 0} role="group" aria-label={`移动图层 ${layer.name}`} onKeyDown={nudge}
    onPointerDown={event => begin(event, false)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
    {!disabled && <button type="button" aria-label={`调整图层大小 ${layer.name}`} className="image-layer-resize"
      style={{ transform: `translate(50%, 50%) scale(${1 / scale})` }}
      onPointerDown={event => begin(event, true)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} />}
  </div>
}
