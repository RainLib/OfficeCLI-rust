import { useEffect, useState, type DragEvent } from 'react'
import { exportToSvg, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { noteTextStyle, safeBoardLink } from './StickyToolbar'
import type { BoardTag } from './boardObjects'
import { GripVertical } from 'lucide-react'
import type { CanvasElement } from './model'

export function Attachment({
  items,
  api,
  canWrite,
  start,
  end,
}: {
  items: CanvasElement[]
  api: ExcalidrawImperativeAPI
  canWrite: boolean
  start: (e: DragEvent) => void
  end: () => void
}) {
  const root = items.find((el) => el.type !== 'text') || items[0]
  const tag = (root.customData as { officeBoard?: BoardTag } | undefined)
    ?.officeBoard
  const note = tag?.kind === 'sticky'
  const href = typeof root.link === 'string' ? safeBoardLink(root.link) : ''
  const label = items.find(
    (el) => el.type === 'text' && el.containerId === root.id,
  )
  const [src, setSrc] = useState('')
  const signature = JSON.stringify(items)
  useEffect(() => {
    if (note) return
    let alive = true,
      url = ''
    exportToSvg({
      elements: restoreElements(items as unknown as ExcalidrawElement[], null),
      appState: {
        exportBackground: false,
        exportEmbedScene: false,
        exportWithDarkMode: false,
      },
      files: api.getFiles(),
      exportPadding: 3,
      skipInliningFonts: true,
    })
      .then((svg: SVGSVGElement) => {
        if (!alive) return
        url = URL.createObjectURL(
          new Blob([new XMLSerializer().serializeToString(svg)], {
            type: 'image/svg+xml',
          }),
        )
        setSrc(url)
      })
      .catch(() => {
        if (alive) setSrc('')
      })
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [api, signature, note])
  const name = String(
    items.find((e) => e.type === 'text')?.originalText ||
      (root.customData as { officeMedia?: { name?: string } } | undefined)
        ?.officeMedia?.name ||
      (
        {
          image: '图片',
          freedraw: '笔迹',
          arrow: '连接线',
          line: '线条',
          rectangle: '图形',
          frame: '分区',
        } as Record<string, string>
      )[root.type] ||
      '画布对象',
  )
  return (
    <figure
      className="spec-attachment"
      draggable={canWrite}
      aria-label={'文档内对象 ' + name}
      onDragStart={start}
      onDragEnd={end}
    >
      {note ? (
        <div
          className="spec-note-preview"
          style={{
            width: root.width,
            minHeight: root.height,
            background: String(root.backgroundColor),
            ...noteTextStyle(
              tag?.noteFormat ?? {},
              Number(label?.fontSize) || 19,
            ),
          }}
        >
          <div>
            {String(label?.originalText ?? '')
              .split('\n')
              .map((line, i) => (
                <div key={i}>
                  {tag?.noteFormat?.list && '• '}
                  {line}
                </div>
              ))}
          </div>
          {tag?.showAuthor !== false && <small>{tag?.author}</small>}
        </div>
      ) : src ? (
        <img draggable={false} src={src} alt={name} />
      ) : (
        <span>{name}</span>
      )}
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer">
          打开链接
        </a>
      )}
      {canWrite && (
        <figcaption>
          <GripVertical size={13} />
          拖到画布
        </figcaption>
      )}
    </figure>
  )
}

import { useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type * as Y from 'yjs'
import { memberOf } from './sceneGeometry'
import { memberSlot } from './specTransfers'

const slotKey = new PluginKey<DecorationSet>('officeSpecObjects')
export const attachmentSlots = Extension.create({
  name: 'officeSpecObjects',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: slotKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old) => {
            const slots = tr.getMeta(slotKey) as
              { pos: number; bundle: string }[] | undefined
            if (!slots) return old.map(tr.mapping, tr.doc)
            return DecorationSet.create(
              tr.doc,
              slots.map(({ pos, bundle }) =>
                Decoration.widget(
                  pos,
                  () => {
                    const div = document.createElement('div')
                    div.dataset.specBundle = bundle
                    div.contentEditable = 'false'
                    return div
                  },
                  {
                    key: bundle,
                    side: -1,
                    stopEvent: () => true,
                    ignoreSelection: true,
                  },
                ),
              ),
            )
          },
        },
        props: { decorations: (state) => slotKey.getState(state) },
      }),
    ]
  },
})
export function SpecObjects({
  id,
  body,
  rich,
  elements,
  api,
  canWrite,
  start,
  end,
}: {
  id: string
  body: Y.Doc
  rich: Editor
  elements: readonly CanvasElement[]
  api: ExcalidrawImperativeAPI
  canWrite: boolean
  start: (e: DragEvent, bundle: string) => void
  end: () => void
}) {
  const bundles = new Map<string, CanvasElement[]>()
  for (const el of elements) {
    const member = memberOf(el)
    if (!el.isDeleted && member?.root === id)
      bundles.set(member.bundle, [...(bundles.get(member.bundle) || []), el])
  }
  const offsets = [0]
  if (bundles.size) rich.state.doc.forEach((node, offset) => offsets.push(offset + node.nodeSize))
  const slots = [...bundles].map(([bundle, items]) => ({
    bundle,
    pos: offsets[
      Math.min(offsets.length - 1, memberSlot(body, memberOf(items[0])!))
    ],
  }))
  const key = JSON.stringify(slots),
    [hosts, setHosts] = useState<Map<string, Element>>(new Map())
  useLayoutEffect(() => {
    if (rich.isDestroyed) return
    rich.view.dispatch(
      rich.state.tr
        .setMeta(slotKey, JSON.parse(key))
        .setMeta('addToHistory', false),
    )
    setHosts(
      new Map(
        Array.from(
          rich.view.dom.querySelectorAll<HTMLElement>('[data-spec-bundle]'),
        ).map((el) => [el.dataset.specBundle!, el]),
      ),
    )
  }, [rich, key])
  return (
    <>
      {[...bundles].map(([bundle, items]) => {
        const host = hosts.get(bundle)
        return host
          ? createPortal(
              <Attachment
                api={api}
                items={items}
                canWrite={canWrite}
                start={(e) => start(e, bundle)}
                end={end}
              />,
              host,
              bundle,
            )
          : null
      })}
    </>
  )
}
