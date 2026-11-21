import { useId, useSyncExternalStore } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'

const empty: readonly ExcalidrawElement[] = []
const inertStore = {
  subscribe: (_listener: () => void) => () => {},
  get: () => empty,
}
function watchOrder(api: ExcalidrawImperativeAPI) {
  const listeners = new Set<() => void>()
  let snapshot: readonly ExcalidrawElement[] = empty,
    signature = '',
    off: (() => void) | undefined
  const sync = () => {
    const elements = api.getSceneElements()
    const key = elements
      .map((el) => el.id + '/' + el.versionNonce + '/' + el.version)
      .join('|')
    if (key === signature) return
    signature = key
    snapshot = [...elements]
    listeners.forEach((fn) => fn())
  }
  return {
    get: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      if (!off) {
        off = api.onChange(sync)
        sync()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          off?.()
          off = undefined
        }
      }
    },
  }
}
const stacks = new WeakMap<
  ExcalidrawImperativeAPI,
  ReturnType<typeof watchOrder>
>()
export function usePaintStack(api: ExcalidrawImperativeAPI | null) {
  if (api && !stacks.has(api)) stacks.set(api, watchOrder(api))
  const store = api ? stacks.get(api)! : inertStore
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
function silhouette(el: ExcalidrawElement, api: ExcalidrawImperativeAPI) {
  const fill = el.backgroundColor === 'transparent' ? 'none' : 'black'
  const stroke = el.strokeColor === 'transparent' ? 'none' : 'black'
  const common = { stroke, fill, strokeWidth: el.strokeWidth }
  if (el.type === 'image' && el.fileId) {
    const file = api.getFiles()[el.fileId]
    return file ? (
      <image
        href={file.dataURL}
        width={el.width}
        height={el.height}
        preserveAspectRatio="none"
        style={{ filter: 'brightness(0)' }}
      />
    ) : null
  }
  if (el.type === 'ellipse')
    return (
      <ellipse
        cx={el.width / 2}
        cy={el.height / 2}
        rx={el.width / 2}
        ry={el.height / 2}
        {...common}
      />
    )
  if (el.type === 'diamond')
    return (
      <polygon
        points={[
          [el.width / 2, 0],
          [el.width, el.height / 2],
          [el.width / 2, el.height],
          [0, el.height / 2],
        ].join(' ')}
        {...common}
      />
    )
  if (
    el.type === 'rectangle' ||
    el.type === 'embeddable' ||
    el.type === 'iframe'
  )
    return (
      <rect
        width={el.width}
        height={el.height}
        rx={el.roundness ? Math.min(el.width, el.height) * 0.1 : 0}
        {...common}
      />
    )
  if (el.type === 'arrow' || el.type === 'line' || el.type === 'freedraw')
    return (
      <polyline
        points={el.points.map((p) => p.join(',')).join(' ')}
        {...common}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  if (el.type === 'text')
    return (
      <text fill="black" fontSize={el.fontSize} fontFamily="Arial,sans-serif">
        {el.text.split('\n').map((line, i) => (
          <tspan key={i} x="0" y={el.fontSize * (0.86 + i * el.lineHeight)}>
            {line}
          </tspan>
        ))}
      </text>
    )
  return null
}
export function PaintMask({
  scene,
  api,
  id,
  x,
  y,
  width,
  height,
  angle = 0,
  scale = 1,
  ignoreGroup,
  children,
}: {
  scene: readonly ExcalidrawElement[]
  api: ExcalidrawImperativeAPI | null
  id: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  scale?: number
  ignoreGroup?: string
  children: (maskImage?: string) => React.ReactNode
}) {
  const mask = 'paint-' + useId().replace(/\W/g, '')
  const index = scene.findIndex((el) => el.id === id)
  const r = Math.hypot(width, height) / 2
  const covers = !api || index < 0 ? [] : scene.slice(index + 1).filter((el) => {
    if (
      !el.opacity ||
      (el.type === 'text' && el.containerId === id) ||
      (ignoreGroup && el.groupIds.includes(ignoreGroup))
    )
      return false
    const a = Math.abs(Math.cos(el.angle)),
      b = Math.abs(Math.sin(el.angle))
    const dx = Math.abs(el.x + el.width / 2 - x - width / 2),
      dy = Math.abs(el.y + el.height / 2 - y - height / 2)
    return (
      dx < (angle ? r : width / 2) + (a * el.width + b * el.height) / 2 + 3 &&
      dy < (angle ? r : height / 2) + (b * el.width + a * el.height) / 2 + 3
    )
  })
  return (
    <>
      {api && covers.length > 0 && <svg
        width="0"
        height="0"
        style={{ position: 'absolute' }}
        aria-hidden="true"
      >
        <defs>
          <mask
            id={mask}
            x="-5%"
            y="-5%"
            width="110%"
            height="110%"
            maskContentUnits="userSpaceOnUse"
          >
            <rect
              x={-5 * scale}
              y={-5 * scale}
              width={(width + 10) * scale}
              height={(height + 10) * scale}
              fill="white"
            />
            <g
              transform={`scale(${scale}) rotate(${(-angle * 180) / Math.PI}) translate(${-x} ${-y})`}
            >
              {covers.map((el) => (
                <g
                  key={el.id}
                  transform={`translate(${el.x} ${el.y}) rotate(${(el.angle * 180) / Math.PI} ${el.width / 2} ${el.height / 2})`}
                  opacity={el.opacity / 100}
                >
                  {silhouette(el, api)}
                </g>
              ))}
            </g>
          </mask>
        </defs>
      </svg>}
      {children(covers.length ? 'url(#' + mask + ')' : undefined)}
    </>
  )
}
