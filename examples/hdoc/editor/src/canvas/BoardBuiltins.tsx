import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getDataURL,
  newElementWith,
} from '@excalidraw/excalidraw'
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import {
  Braces,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Pencil,
  X,
} from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import { insertBoardShapes, stickyLabel, type BoardPoint } from './boardObjects'
import { PaintMask, usePaintStack } from './paintStack'
import { safeBoardLink } from './StickyToolbar'

const languages = {
  TypeScript: typescript,
  JavaScript: javascript,
  Python: python,
  JSON: json,
  CSS: css,
  HTML: xml,
  Rust: rust,
}
for (const [name, grammar] of Object.entries(languages))
  hljs.registerLanguage(name.toLowerCase(), grammar)
export type BuiltinKind = 'mind' | 'code' | 'link'
type Builtin = { kind: BuiltinKind; language?: string; parent?: string }
export type BuiltinDraft = {
  field?: 'title' | 'body'
  clientPoint?: BoardPoint
  kind: BuiltinKind
  at: BoardPoint
  id?: string
  language?: string
}
export const builtinOf = (el?: ExcalidrawElement): Builtin | undefined =>
  el?.customData?.officeBuiltin
export type BoardMedia = {
  file: BinaryFileData
  width: number
  height: number
  name: string
}
export async function readBoardMedia(input: File): Promise<BoardMedia> {
  if (
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(input.type)
  )
    throw Error('请选择 PNG、JPEG、WebP 或 GIF 图片。')
  if (input.size > 12 * 1024 * 1024 - 128)
    throw Error('图片超过画布单个文件的 12 MiB 上限。')
  const dataURL = await getDataURL(input)
  const image = new Image()
  image.src = dataURL
  await image.decode()
  return {
    file: {
      id: crypto.randomUUID() as BinaryFileData['id'],
      mimeType: input.type as BinaryFileData['mimeType'],
      dataURL,
      created: Date.now(),
    },
    width: image.naturalWidth,
    height: image.naturalHeight,
    name: input.name,
  }
}
export function placeBoardMedia(
  api: ExcalidrawImperativeAPI,
  media: BoardMedia,
  point: BoardPoint,
) {
  const id = 'media-' + crypto.randomUUID(),
    scale = Math.min(1, 440 / media.width, 320 / media.height)
  api.addFiles([media.file])
  insertBoardShapes(
    api,
    [
      {
        id,
        type: 'image',
        fileId: media.file.id,
        ...point,
        width: media.width * scale,
        height: media.height * scale,
        customData: { officeMedia: { name: media.name } },
      },
    ],
    id,
  )
  return id
}
export function mediaShelf(api: ExcalidrawImperativeAPI) {
  const seen = new Set<string>()
  return api.getSceneElements().flatMap((el) => {
    if (
      el.type !== 'image' ||
      !el.fileId ||
      el.customData?.officeStamp ||
      seen.has(el.fileId)
    )
      return []
    const file = api.getFiles()[el.fileId]
    if (!file) return []
    seen.add(el.fileId)
    return [
      {
        file,
        width: el.width,
        height: el.height,
        name: String(el.customData?.officeMedia?.name || '画布图片'),
      },
    ]
  })
}

export function BuiltinEditor({
  api,
  draft,
  close,
  onCreate,
}: {
  api: ExcalidrawImperativeAPI
  draft: BuiltinDraft
  onCreate: (id: string, point: BoardPoint) => void
  close: () => void
}) {
  const scene = api.getSceneElements(),
    root = scene.find((el) => el.id === draft.id),
    label = stickyLabel(scene, draft.id)
  const initial = useRef({
    text: label?.originalText ?? '',
    url: root?.link || '',
    language: builtinOf(root)?.language || draft.language || 'TypeScript',
  })
  const [value, setValue] = useState(initial.current.text),
    [url, setURL] = useState(initial.current.url),
    [language, setLang] = useState(initial.current.language)
  const [error, setError] = useState('')
  const code = draft.kind === 'code',
    link = draft.kind === 'link'
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    field.current?.focus()
  }, [draft])
  function save() {
    const all = api.getSceneElementsIncludingDeleted(),
      old = all.find((el) => el.id === draft.id && !el.isDeleted),
      before = stickyLabel(all, draft.id)
    if (
      draft.id &&
      (!old ||
        old.locked ||
        before?.originalText !== initial.current.text ||
        (old.link || '') !== initial.current.url ||
        (code && builtinOf(old)?.language !== initial.current.language))
    ) {
      setError('此对象已变更，请复制草稿后重新打开。')
      return
    }
    const href = link ? safeBoardLink(url.trim()) : ''
    if (link && !/^https?:\/\//i.test(href)) {
      setError('请输入以 https:// 或 http:// 开头的网址。')
      return
    }
    const id = draft.id || draft.kind + '-' + crypto.randomUUID(),
      text = value || (link ? new URL(href).hostname : ' ')
    const tag: Builtin = {
      ...builtinOf(old),
      kind: draft.kind,
      ...(code && { language }),
    }
    const [sheet, measured] = convertToExcalidrawElements(
      [
        {
          id,
          type: 'rectangle',
          x: old?.x ?? draft.at.x,
          y: old?.y ?? draft.at.y,
          width: old?.width ?? (code ? 376 : 270),
          height: code
            ? Math.max(124, 48 + text.split('\n').length * 20)
            : (old?.height ?? 78),
          fillStyle: 'solid',
          roughness: 0,
          strokeWidth: 1,
          roundness: { type: 3 },
          strokeColor: '#d6d8df',
          backgroundColor: old?.backgroundColor || '#fafbfc',
          link: href || null,
          customData: { officeBuiltin: tag },
          label: {
            text,
            strokeColor: '#30343d',
            fontFamily: code ? 3 : 2,
            fontSize: code ? 15 : 19,
            textAlign: code ? 'left' : 'center',
            verticalAlign: code ? 'top' : 'middle',
          },
        },
      ],
      { regenerateIds: false },
    )
    if (measured.type !== 'text') return
    const updated =
      old && before
        ? all.map((el) =>
            el.id === id
              ? newElementWith(el, {
                  height: sheet.height,
                  link: href || null,
                  customData: { ...el.customData, officeBuiltin: tag },
                })
              : el.id === before.id
                ? newElementWith(before, {
                    text: measured.text,
                    originalText: text,
                    x: measured.x,
                    y: measured.y,
                    width: measured.width,
                    height: measured.height,
                  })
                : el,
          )
        : [...all, sheet, measured]
    api.updateScene({
      elements: updated,
      appState: { selectedElementIds: { [id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    })
    if (!old) onCreate(id, draft.at)
    close()
  }
  const name = code ? '代码块' : '链接'
  const app = api.getAppState(),
    point = root || draft.at
  const width = Math.min(390, app.width - 24),
    left = Math.max(
      8,
      Math.min((point.x + app.scrollX) * app.zoom.value, app.width - width - 8),
    )
  const top = Math.max(
    8,
    Math.min(
      (point.y + app.scrollY) * app.zoom.value,
      app.height - (code ? 298 : 205),
    ),
  )
  return (
    <form
      className="builtin-editor"
      style={{ left, top, width, transform: 'none' }}
      aria-label={'编辑' + name}
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault()
          save()
        }
      }}
    >
      <header>
        {code ? (
          <Braces size={18} />
        ) : (
          <Link2 size={18} />
        )}
        <strong>{name}</strong>
        <button type="button" aria-label="关闭对象编辑" onClick={close}>
          <X size={16} />
        </button>
      </header>
      {code && (
        <label>
          语言
          <select
            aria-label="代码语言"
            value={language}
            onChange={(e) => setLang(e.target.value)}
          >
            {[...Object.keys(languages), '纯文本'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      )}
      {link && (
        <label>
          网址
          <input
            autoFocus
            type="url"
            required
            aria-label="网页地址"
            placeholder="https://"
            value={url}
            onChange={(e) => setURL(e.target.value)}
          />
        </label>
      )}
      <textarea
        ref={link ? undefined : field}
        aria-label={code ? '代码内容' : '链接标题'}
        value={value}
        rows={code ? 7 : 2}
        placeholder={
          code ? '输入或粘贴代码' : '链接标题（可选）'
        }
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (code && e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault()
            const el = e.currentTarget,
              a = el.selectionStart
            setValue(value.slice(0, a) + '  ' + value.slice(el.selectionEnd))
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
          }
        }}
      />
      {error && <small role="alert">{error}</small>}
      <footer>
        <button type="submit">
          <Check size={15} />
          完成
        </button>
      </footer>
    </form>
  )
}

function Highlight({ source, language }: { source: string; language: string }) {
  const html = useMemo(
    () =>
      hljs.getLanguage(language.toLowerCase())
        ? hljs.highlight(source, { language: language.toLowerCase() }).value
        : null,
    [source, language],
  )
  return html === null ? (
    <code>{source}</code>
  ) : (
    <code dangerouslySetInnerHTML={{ __html: html }} />
  )
}
export function BuiltinLayer({
  api,
  edit,
  writable,
  copyAllowed,
  showTools,
}: {
  copyAllowed: boolean
  api: ExcalidrawImperativeAPI
  edit: (d: BuiltinDraft) => void
  writable: boolean
  showTools: boolean
}) {
  const [, refresh] = useState(0),
    [copied, setCopied] = useState<{ id: string; message: string } | null>(null)
  useEffect(() => {
    let last = ''
    return api.onChange((els, app) => {
      const stamp = JSON.stringify([
        app.scrollX,
        app.scrollY,
        app.zoom.value,
        app.selectedElementIds,
        els
          .filter(
            (el) => builtinOf(el) || (el.type === 'text' && el.containerId),
          )
          .map((el) => [el.id, el.version, el.versionNonce, el.isDeleted]),
      ])
      if (last !== stamp) {
        last = stamp
        refresh((v) => v + 1)
      }
    })
  }, [api])
  const app = api.getAppState(),
    z = app.zoom.value,
    all = api.getSceneElements()
  const stack = usePaintStack(api)
  const roots = all.filter((el) => builtinOf(el) && builtinOf(el)?.kind !== 'mind')
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (
        !showTools ||
        !writable ||
        e.defaultPrevented ||
        e.isComposing ||
        !(e.ctrlKey || e.metaKey) ||
        e.key !== 'Enter' ||
        (e.target as Element)?.closest(
          'textarea,input,[contenteditable=true],form',
        )
      )
        return
      const node = roots.find(
        (el) => app.selectedElementIds[el.id] && !el.locked,
      )
      if (!node) return
      if (builtinOf(node)?.kind === 'code') {
        e.preventDefault()
        e.stopImmediatePropagation()
        edit({
          kind: 'code',
          language: builtinOf(node)?.language,
          at: { x: node.x + node.width + 20, y: node.y },
        })
      }
    }
    document.addEventListener('keydown', keys, true)
    return () => document.removeEventListener('keydown', keys, true)
  })
  return (
    <div className="builtin-layer">
      {roots.map((el) => {
        const tag = builtinOf(el)!,
          text = stickyLabel(all, el.id)?.originalText || '',
          active = showTools && !!app.selectedElementIds[el.id]
        const x = (el.x + app.scrollX) * z,
          y = (el.y + app.scrollY) * z
        return (
          <div
            key={el.id}
            className="builtin-anchor"
            style={{ left: x, top: y }}
          >
            {tag.kind === 'code' && (
              <PaintMask
                api={api}
                scene={stack}
                id={el.id}
                x={el.x}
                y={el.y}
                width={el.width}
                height={el.height}
                angle={el.angle}
              >
                {(maskImage) => (
                  <div
                    className="builtin-code"
                    aria-label="代码块预览"
                    style={{
                      maskImage,
                      width: el.width,
                      height: el.height,
                      transform: 'scale(' + z + ') rotate(' + el.angle + 'rad)',
                    }}
                  >
                    <small>
                      <Braces size={13} />
                      {tag.language}
                    </small>
                    <pre>
                      <Highlight
                        source={text}
                        language={tag.language || 'TypeScript'}
                      />
                    </pre>
                  </div>
                )}
              </PaintMask>
            )}
            {tag.kind === 'link' && safeBoardLink(el.link || '') && (
              <PaintMask
                api={api}
                scene={stack}
                id={el.id}
                x={el.x}
                y={el.y}
                width={el.width}
                height={el.height}
                angle={el.angle}
              >
                {(maskImage) => (
                  <div
                    className="builtin-link-card"
                    aria-label="网页链接预览"
                    style={{
                      maskImage,
                      width: el.width,
                      height: el.height,
                      transform: 'scale(' + z + ') rotate(' + el.angle + 'rad)',
                    }}
                  >
                    <i>
                      <Link2 size={19} />
                    </i>
                    <div>
                      <strong>{text}</strong>
                      <small>{new URL(el.link!).hostname}</small>
                    </div>
                  </div>
                )}
              </PaintMask>
            )}
            {active && (
              <div
                className="builtin-tools"
                role="toolbar"
                aria-label="对象操作"
              >
                {writable && !el.locked && (
                  <button
                    aria-label={
                      '编辑' +
                      (tag.kind === 'code'
                        ? '代码块'
                        : tag.kind === 'link'
                          ? '链接'
                          : '节点')
                    }
                    onClick={() => edit({ kind: tag.kind, id: el.id, at: el })}
                  >
                    <Pencil />
                  </button>
                )}
                {tag.kind === 'code' && copyAllowed && (
                  <button
                    aria-label="复制代码"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(text)
                        setCopied({ id: el.id, message: '已复制' })
                      } catch {
                        setCopied({ id: el.id, message: '浏览器未允许复制' })
                      }
                    }}
                  >
                    <Copy />
                  </button>
                )}
                {copied?.id === el.id && (
                  <small role="status">{copied.message}</small>
                )}
                {tag.kind === 'link' && safeBoardLink(el.link || '') && (
                  <a
                    aria-label="打开网页"
                    href={safeBoardLink(el.link!)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={16} />
                  </a>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
