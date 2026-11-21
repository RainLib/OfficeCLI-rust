import { createElement, memo, useMemo, useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { PaintMask,usePaintStack } from './paintStack'
import * as Y from 'yjs'
import { openSpec, isTextBlock, isSpecText, specTag } from './specRichText'
import type { SpecPeer } from './specCoordinates'
import { markersFor, projectRuns } from './specProjection'
import { SpecCollaboration } from './specCollaboration'
import type { CanvasElement } from './model'

const blocks: Record<string, string> = {
  paragraph: 'p',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  blockquote: 'blockquote',
  codeBlock: 'pre',
}
const Contents = memo(function Contents({
  element,
  peers,
}: {
  element: CanvasElement
  peers: SpecPeer[]
}) {
  return useMemo(() => {
    const doc = openSpec(element)
    try {
      const markers = markersFor(doc, element.id, peers)
      let block = 0
      const render = (
        node: Y.XmlElement | Y.XmlText | Y.XmlHook,
        i: number,
      ): ReactNode => {
        if (!(node instanceof Y.XmlElement)) return null
        const tag =
          node.nodeName === 'heading'
            ? Number(node.getAttribute('level')) === 3
              ? 'h3'
              : 'h2'
            : blocks[node.nodeName]
        if (!tag) return null
        return createElement(
          tag,
          {
            key: i,
            ...(tag === 'ol'
              ? { start: Number(node.getAttribute('start')) || 1 }
              : {}),
          },
          isTextBlock(node.nodeName)
            ? projectRuns(
                node
                  .toArray()
                  .flatMap((n) => (n instanceof Y.XmlText ? n.toDelta() : [])),
                block++,
                markers,
              )
            : node.toArray().map(render),
        )
      }
      return doc.getXmlFragment('spec').toArray().map(render)
    } finally {
      doc.destroy()
    }
  }, [element, peers])
})
const noPeers: SpecPeer[] = []
export function hasSpecPreview(e: CanvasElement) {
  return !e.isDeleted && isSpecText(e)
}

// A fixed-height sheet can show only part of a long text column. Keep its
// reading position across mode changes without recording a document edit.
const scrollPositions = new WeakMap<ExcalidrawImperativeAPI, Map<string, number>>()

/** Both the projected text and the live editor occupy this same scene rectangle. */
export function SpecPaperPart({ element, paper, editor, camera, stack, editing, full, children }: {
  element: CanvasElement
  paper?: CanvasElement
  editor: ExcalidrawImperativeAPI | null
  camera: { x: number; y: number; zoom: number }
  stack: ReturnType<typeof usePaintStack>
  editing?: boolean
  full?: boolean
  children: ReactNode
}) {
  const live = stack.find(e => e.id === element.id) ?? element
  const sheet = (paper && stack.find(e => e.id === paper.id)) ?? paper
  const width = sheet && live.width < Number(element.fontSize)
    ? Math.max(1, sheet.width - 2 * (live.x - sheet.x)) : live.width
  // Leave room for collaborator name tags above the first line.
  const inset = 15, top = live.y - inset, angle = Number(live.angle) || 0
  const height = sheet ? Math.max(inset, sheet.y + sheet.height - top - 5) : undefined
  const part = specTag(element)!.part
  const Tag = editing ? 'div' : 'article'
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (editor && !full && ref.current) ref.current.scrollTop = scrollPositions.get(editor)?.get(element.id) ?? 0
  }, [editor, full, editing, element.id])
  return <PaintMask scene={stack} api={full ? null : editor} id={element.id} x={live.x} y={top}
    width={width} height={height ?? live.height + inset} angle={angle}>{maskImage =>
    <Tag ref={ref} className={editing ? 'spec-edit-part' : 'spec-paper-prose spec-prose'}
      data-part={part} data-spec-root={!editing && part === 'body' ? specTag(element)!.root : undefined}
      aria-label={editing ? undefined : part === 'title' ? 'Spec 标题预览' : 'Spec 正文预览'}
      onScroll={e => {
        if (!editor || full) return
        let positions = scrollPositions.get(editor)
        if (!positions) { positions = new Map(); scrollPositions.set(editor, positions) }
        if (e.currentTarget.scrollTop) positions.set(element.id, e.currentTarget.scrollTop)
        else positions.delete(element.id)
      }}
      style={full ? undefined : {
        maskImage, left: (live.x + camera.x) * camera.zoom, top: (top + camera.y) * camera.zoom,
        paddingTop: inset, width, maxHeight: height, boxSizing: 'border-box',
        overflow: 'hidden', transformOrigin: '0 0', transform: `scale(${camera.zoom}) rotate(${angle}rad)`,
        fontSize: Number(element.fontSize) || 17, color: String(element.strokeColor || '#28272b'),
        opacity: Number(element.opacity ?? 100) / 100,
      }}>{children}</Tag>
  }</PaintMask>
}
export function SpecPreview({
  elements,
  camera,
  editor,
  editing,
}: {
  editor: ExcalidrawImperativeAPI | null
  elements: readonly CanvasElement[]
  camera: { x: number; y: number; zoom: number }
  editing: string | null
}) {
  const peers = useContext(SpecCollaboration)?.peers || noPeers
  const papers = useMemo(
    () =>
      new Map(
        elements
          .filter((e) => !e.isDeleted && specTag(e)?.part === 'paper')
          .map((e) => [e.id, e]),
      ),
    [elements],
  )
  const stack=usePaintStack(editor)
  return (
    <div className="canvas-spec-previews">
      {elements.filter(el => hasSpecPreview(el) && specTag(el)!.root !== editing).map(el =>
        <SpecPaperPart key={el.id} element={el} paper={papers.get(specTag(el)!.root)}
          stack={stack} camera={camera} editor={editor}>
          <Contents element={el} peers={peers.some(p => p.cursor.id === el.id) ? peers : noPeers} />
        </SpecPaperPart>
      )}
    </div>
  )
}
