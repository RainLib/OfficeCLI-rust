import { keepHistory } from './editHistory.ts'
import { AppearanceSelect } from './Appearance.tsx'
import { WorkspaceDrawers } from './WorkspaceDrawers.tsx'
import { useDocumentViewState } from './DocumentViewState.tsx'
import { CanvasViewport, useCanvasZoom } from './CanvasZoom.tsx'
import type { PagePreview } from './PageThumbnail.tsx'
import { SlideNavigator, type NavigationPage } from './SlideNavigator.tsx'
import { PptxProperties } from './PptxProperties.tsx'
import './document-panels.css'
import { AgentPanel, AgentProductionCanvas, useAgentWorkspace } from './AgentActivityLayer.tsx'
import { LocaleSelect, useI18n } from './i18n.tsx'
import { LocalText, localizeDynamic, localizeSource } from './sourceLocale.tsx'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { redo, redoDepth, undo, undoDepth } from '@tiptap/pm/history'
import { api, type Session } from './api.ts'
import { hasThemeRegion, loadTheme, themeFontOptions, themeFontPatch, type ThemeFontOption } from './themeCss.ts'
import { FixedTextBoxEditor } from './FixedTextBoxEditor.tsx'
import { FixedPreviewFrame } from './FixedPreviewFrame.tsx'
import { EditorHeader, EditorStatusbar, ContentToolbar, CollapseOutlineIcon, CollapseSidebarIcon } from './EditorChrome.tsx'
import { DocumentSearch, type SearchHit, type SearchResult } from './DocumentSearch.tsx'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { useFixedCollaboration } from './fixedCollaboration.tsx'
import { ErrorToast } from './ErrorToast.tsx'
import { ContextMenu } from './ContextMenu.tsx'
import { InputDraftRecovery, useInputDraft } from './useInputDraft.tsx'
import type { InputDraft } from './inputDraftJournal.ts'

type Manifest = { chunkCount: number; indexPageCount: number; revision: number; source: { format: string } }
type Descriptor = { sequence: number; chunkId: string; region: string; continuation: boolean; htmlHash: string; mapHash: string }
export type PptxGeometry = { xEmu: number; yEmu: number; widthEmu: number; heightEmu: number }
type PdfGeometry = { xPt: number; yPt: number; widthPt: number; heightPt: number }
export type TextNode = { nodeId: string; nodeHash: string; text: string; editable: boolean; createdInHcd?: boolean; left?: string; top?: string; width?: string; height?: string; geometry?: PptxGeometry; pdfGeometry?: PdfGeometry; fontSize?: string; fontFamily?: string; fontWeight?: string; fontStyle?: string; color?: string; lineHeight?: string; runBold?: boolean; runItalic?: boolean; runUnderline?: boolean; runFontSizePt?: number; runColor?: string; shapeHorizontal?: PptxHorizontalAlign; shapeVertical?: PptxVerticalAlign; pinnedFont?: string; fontPinned?: boolean }
export type PptxRunFormat = { bold?: boolean; italic?: boolean; underline?: boolean; fontSizePt?: number; color?: string }
type PptxHorizontalAlign = 'left' | 'center' | 'right' | 'justify' | 'distributed'
type PptxVerticalAlign = 'top' | 'center' | 'bottom'
export type PptxShapeAlign = { horizontal?: PptxHorizontalAlign; vertical?: PptxVerticalAlign }
type ShapeDrag = { pointerId: number; mode: 'move' | 'resize'; startX: number; startY: number; initial: PptxGeometry; current: PptxGeometry; shape: HTMLElement }
type PdfDrag = { pointerId: number; mode: 'move' | 'resize'; startX: number; startY: number; initial: PdfGeometry; current: PdfGeometry; shape: HTMLElement; pointsPerPixel: number }
function cssDeclaration(style: string, property: string): string | undefined {
  for (const part of style.split(';')) {
    const splitAt = part.indexOf(':')
    if (splitAt < 0) continue
    if (part.slice(0, splitAt).trim().toLowerCase() === property) return part.slice(splitAt + 1).trim()
  }
  return undefined
}
function pptxRunStyle(element: Element | undefined): Pick<TextNode, 'runBold' | 'runItalic' | 'runUnderline' | 'runFontSizePt' | 'runColor'> {
  const run = element?.closest('.hcd-ppt-run, .hcd-slide-text')
  const style = run?.getAttribute('style') || ''
  const flag = (name: string, fallback: boolean) => {
    const value = element?.getAttribute(name)
    return value === '1' ? true : value === '0' ? false : fallback
  }
  const sizeText = element?.getAttribute('data-hcd-font-size-pt') || cssDeclaration(style, 'font-size')?.replace(/pt$/, '')
  const size = Number(sizeText)
  const storedColor = element?.getAttribute('data-hcd-color')
  const cssColor = cssDeclaration(style, 'color')
  const color = storedColor ? `#${storedColor}` : cssColor?.startsWith('#') ? cssColor : undefined
  return {
    runBold: flag('data-hcd-bold', ['700', 'bold'].includes(cssDeclaration(style, 'font-weight') || '')),
    runItalic: flag('data-hcd-italic', cssDeclaration(style, 'font-style') === 'italic'),
    runUnderline: flag('data-hcd-underline', (cssDeclaration(style, 'text-decoration') || '').includes('underline')),
    runFontSizePt: Number.isFinite(size) && size >= 1 && size <= 256 ? size : undefined,
    runColor: color,
  }
}
const pptxHorizontalTokens: PptxHorizontalAlign[] = ['left', 'center', 'right', 'justify', 'distributed']
const pptxVerticalTokens: PptxVerticalAlign[] = ['top', 'center', 'bottom']
const cssToPptxHorizontal: Record<string, PptxHorizontalAlign> = { left: 'left', center: 'center', right: 'right', justify: 'justify' }
const cssToPptxVertical: Record<string, PptxVerticalAlign> = { 'flex-start': 'top', center: 'center', 'flex-end': 'bottom' }
function pptxShapeAlign(element: Element | undefined): Pick<TextNode, 'shapeHorizontal' | 'shapeVertical'> {
  const shape = element?.closest('.hcd-slide-shape')
  if (!shape) return {}
  // Alignment lives on the frame, not on the run under the cursor, so the box names
  // its own axes once this editor touched it.
  const token = <T extends string>(name: string, allowed: T[]): T | undefined =>
    allowed.find(value => value === shape.getAttribute(name))
  if (shape.getAttribute('data-hcd-align-edited') === 'true') {
    return { shapeHorizontal: token('data-hcd-horizontal', pptxHorizontalTokens), shapeVertical: token('data-hcd-vertical', pptxVerticalTokens) }
  }
  // Before that the only record is the CSS the importer drew from the source shape,
  // which folds distributed into justify and shows nothing when one box holds
  // paragraphs that disagree.
  const paragraphs = new Set(Array.from(shape.querySelectorAll('.hcd-slide-text'),
    paragraph => cssDeclaration(paragraph.getAttribute('style') || '', 'text-align')))
  const horizontal = paragraphs.size === 1 ? Array.from(paragraphs)[0] : undefined
  return {
    shapeHorizontal: horizontal ? cssToPptxHorizontal[horizontal] : undefined,
    shapeVertical: cssToPptxVertical[cssDeclaration(shape.getAttribute('style') || '', 'justify-content') || ''],
  }
}
function pptxGeometry(element: Element | null): PptxGeometry | undefined {
  if (!element?.classList.contains('hcd-slide-shape')) return undefined
  const values = ['data-hcd-x-emu', 'data-hcd-y-emu', 'data-hcd-width-emu', 'data-hcd-height-emu'].map(name => Number(element.getAttribute(name)))
  if (!values.every(Number.isSafeInteger) || values[0] < 0 || values[1] < 0 || values[2] <= 0 || values[3] <= 0) return undefined
  return { xEmu: values[0], yEmu: values[1], widthEmu: values[2], heightEmu: values[3] }
}
function pdfGeometry(element: Element | null): PdfGeometry | undefined {
  if (element?.getAttribute('data-hcd-mapping') !== 'hcd-overlay' || !element.classList.contains('hcd-pdf-text')) return undefined
  const values = ['data-hcd-x', 'data-hcd-y', 'data-hcd-width', 'data-hcd-height'].map(name => Number(element.getAttribute(name)))
  if (!values.every(Number.isFinite) || values[0] < 0 || values[1] < 0 || values[2] < 1 || values[3] < 1) return undefined
  return { xPt: values[0], yPt: values[1], widthPt: values[2], heightPt: values[3] }
}
type Selection = { node: TextNode; page: number }
type NewTextBox = (
  | { format: 'pdf'; page: number; xPt: number; yPt: number; widthPt: number; heightPt: number; fontSizePt: number }
  | { format: 'pptx'; chunkId: string; slidePart: string; xEmu: number; yEmu: number; widthEmu: number; heightEmu: number; fontSizePt: number }
) & { sequence: number; left: string; top: string; width: string; height: string }
type FixedInput = { schemaVersion: 'hcd-fixed-input/1'; format: string; baseRevision: number; text: string } & (
  | { kind: 'text'; page: number; nodeId: string; nodeHash: string; originalText: string }
  | { kind: 'insert'; box: NewTextBox }
)
function parseFixedInput(draft: InputDraft, format: string): FixedInput {
  const value = JSON.parse(draft.content) as FixedInput
  const positive = (n: number) => Number.isFinite(n) && n > 0
  const page = (n: number) => Number.isSafeInteger(n) && n >= 0
  let valid = value && value.schemaVersion === 'hcd-fixed-input/1' && value.format === format
    && page(value.baseRevision) && typeof value.text === 'string' && value.text.length <= 10_000
  if (value?.kind === 'text') valid &&= page(value.page) && typeof value.nodeId === 'string' && !!value.nodeId
    && typeof value.nodeHash === 'string' && !!value.nodeHash && typeof value.originalText === 'string'
  else if (value?.kind === 'insert' && value.box) {
    const box = value.box
    valid &&= page(box.sequence) && box.format === format && positive(box.fontSizePt) && box.fontSizePt <= 256
      && [box.left, box.top, box.width, box.height].every(css => typeof css === 'string' && /^\d+(\.\d+)?(px|pt)$/.test(css))
      && (box.format === 'pdf'
        ? page(box.page) && box.page > 0 && Number.isFinite(box.xPt) && box.xPt >= 0 && Number.isFinite(box.yPt) && box.yPt >= 0 && positive(box.widthPt) && positive(box.heightPt)
        : typeof box.chunkId === 'string' && typeof box.slidePart === 'string' && page(box.xEmu) && page(box.yEmu) && positive(box.widthEmu) && positive(box.heightEmu))
  } else valid = false
  if (!valid) throw new Error('这份输入无法安全恢复，请下载草稿保留')
  return value
}
type Revision = { revision: number; patchId?: string; authorName?: string; createdAtEpochMs?: number }
type EditStep = { revision: number; label: string }
type EditHistory = { head: number | null; past: EditStep[]; future: EditStep[] }

function mergeDescriptors(previous: Descriptor[], incoming: Descriptor[]): Descriptor[] {
  return Array.from(new Map([...previous, ...incoming].map(item => [item.sequence, item])).values())
    .sort((left, right) => left.sequence - right.sequence)
}

function PptxRunFormatBar({ node, disabled, onApply }: { node: TextNode; disabled: boolean; onApply: (format: PptxRunFormat) => void }) {
  const { locale } = useI18n()
  const [size, setSize] = useState(node.runFontSizePt ? String(node.runFontSizePt) : '18')
  const [color, setColor] = useState(node.runColor || '#112233')
  useEffect(() => {
    setSize(node.runFontSizePt ? String(node.runFontSizePt) : '18')
    setColor(node.runColor || '#112233')
  }, [node.nodeId, node.nodeHash, node.runFontSizePt, node.runColor])
  const parsedSize = Number(size)
  const sizeValid = Number.isFinite(parsedSize) && parsedSize >= 1 && parsedSize <= 256
  return <div className="tool-group" aria-label={localizeSource(locale, "文字格式")}>
    <button className={node.runBold ? 'primary' : ''} disabled={disabled || !node.editable} aria-pressed={!!node.runBold} onClick={() => onApply({ bold: !node.runBold })}><LocalText source={"加粗"} /></button>
    <button className={node.runItalic ? 'primary' : ''} disabled={disabled || !node.editable} aria-pressed={!!node.runItalic} onClick={() => onApply({ italic: !node.runItalic })}><LocalText source={"斜体"} /></button>
    <button className={node.runUnderline ? 'primary' : ''} disabled={disabled || !node.editable} aria-pressed={!!node.runUnderline} onClick={() => onApply({ underline: !node.runUnderline })}><LocalText source={"下划线"} /></button>
    <label><LocalText source={"字号"} /><input aria-label={localizeSource(locale, "字号")} type="number" min="1" max="256" step="0.5" value={size} disabled={disabled || !node.editable} onChange={event => setSize(event.target.value)} style={{ width: 68 }} /></label>
    <button disabled={disabled || !node.editable || !sizeValid || parsedSize === node.runFontSizePt} onClick={() => onApply({ fontSizePt: parsedSize })}><LocalText source={"应用字号"} /></button>
    <label><LocalText source={"颜色"} /><input aria-label={localizeSource(locale, "文字颜色")} type="color" value={color} disabled={disabled || !node.editable} onChange={event => setColor(event.target.value)} /></label>
    <button disabled={disabled || !node.editable || color.toLowerCase() === (node.runColor || '').toLowerCase()} onClick={() => onApply({ color })}><LocalText source={"应用颜色"} /></button>
  </div>
}

function PptxShapeAlignBar({ node, disabled, onApply }: { node: TextNode; disabled: boolean; onApply: (align: PptxShapeAlign) => void }) {
  const { locale } = useI18n()
  // The whole box moves, so the button that already reads this value is greyed out
  // rather than left to be refused by the patch.
  const keys: Array<{ axis: 'horizontal' | 'vertical'; value: string; label: string }> = [
    { axis: 'horizontal', value: 'left', label: '左对齐' },
    { axis: 'horizontal', value: 'center', label: '居中' },
    { axis: 'horizontal', value: 'right', label: '右对齐' },
    { axis: 'horizontal', value: 'justify', label: '两端对齐' },
    { axis: 'horizontal', value: 'distributed', label: '分散对齐' },
    { axis: 'vertical', value: 'top', label: '顶端对齐' },
    { axis: 'vertical', value: 'center', label: '垂直居中' },
    { axis: 'vertical', value: 'bottom', label: '底端对齐' },
  ]
  const active = (key: { axis: 'horizontal' | 'vertical'; value: string }) =>
    (key.axis === 'horizontal' ? node.shapeHorizontal : node.shapeVertical) === key.value
  return <div className="tool-group" aria-label={localizeSource(locale, '形状对齐')}>
    {keys.map(key => <button key={`${key.axis}-${key.value}`} className={active(key) ? 'primary' : ''}
      disabled={disabled || !node.editable || active(key)} aria-pressed={active(key)}
      onClick={() => onApply(key.axis === 'horizontal'
        ? { horizontal: key.value as PptxHorizontalAlign }
        : { vertical: key.value as PptxVerticalAlign })}><LocalText source={key.label} /></button>)}
  </div>
}

export function FixedViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const { locale } = useI18n()
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [editHistory, setEditHistory] = useState<EditHistory>({ head: null, past: [], future: [] })
  const [historyBusy, setHistoryBusy] = useState(false)
  const [collaborationEpoch, setCollaborationEpoch] = useState(session.collaborationEpoch)
  const inputProtection = useInputDraft(session, collaborationEpoch)
  const pendingInput = useRef<FixedInput | null>(null)
  const pageNodes = useRef(new Map<number, TextNode[]>())
  const [descriptors, setDescriptors] = useState<Descriptor[]>([])
  const [style, setStyle] = useState('')
  const [loadedPages, setLoadedPages] = useState(0)
  const [slideHeight, setSlideHeight] = useState(720)
  const [stageWidth, setStageWidth] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const { preview, setPreview: setReadOnly, focused, setFocused, rightPanel, setRightPanel, activeTab, setActiveTab, selectedRevision: viewRevision, setSelectedRevision: setViewRevision } = useDocumentViewState()
  const readOnly = session.scope === 'read' || preview
  const [refresh, setRefresh] = useState(0)
  const [previews, setPreviews] = useState<Record<number, PagePreview>>({})
  const recordPreview = useCallback((sequence: number, preview: PagePreview) => {
    setPreviews(previous => previous[sequence]?.html === preview.html ? previous : { ...Object.fromEntries(Object.entries(previous).filter(([key]) => Number(key) !== sequence).slice(-23)), [sequence]: preview })
  }, [])
  const [selected, setSelected] = useState<Selection | null>(null)
  const pendingPropertySelection = useRef<Selection | null>(null)
  const restorePropertySelection = useCallback((page: number, nodes: TextNode[]) => {
    pageNodes.current.set(page, nodes)
    if (pageNodes.current.size > 24) pageNodes.current.delete(pageNodes.current.keys().next().value!)
    const input = pendingInput.current
    if (input?.kind === 'text' && input.page === page) {
      pendingInput.current = null
      const node = nodes.find(node => node.nodeId === input.nodeId && node.nodeHash === input.nodeHash && node.text === input.originalText && node.editable)
      if (!node) { setError('目标文字已变化，草稿仍在本地保留，请重新打开后下载核对'); return }
      setSelected({ page, node }); setDraft(input.text)
      return
    }
    const pending = pendingPropertySelection.current
    if (!pending || pending.page !== page) return
    // Formatting/geometry can preserve the text hash. This callback only runs
    // after canonical nodes have been rendered again, so bind that fresh node.
    const node = nodes.find(node => node.nodeId === pending.node.nodeId)
    if (!node) return
    pendingPropertySelection.current = null
    setSelected({ page, node }); setDraft(node.text)
  }, [])
  const [draft, setDraft] = useState('')
  const [thumbnailPages, setThumbnailPages] = useState<Set<string>>(new Set())
  const previewVisiblePage = useCallback((id: string) => setThumbnailPages(previous => previous.has(id) ? previous : new Set([...previous].slice(-23)).add(id)), [])
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [organizing, setOrganizing] = useState(false)
  const topologyBusy = useRef(false)
  const [newBox, setNewBox] = useState<NewTextBox | null>(null)
  const [newDraft, setNewDraft] = useState('')
  const [placingText, setPlacingText] = useState(false)
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null)
  const { panelOpen, setPanelOpen } = useAgentWorkspace()
  const layoutScope = session.documentId
  const [layout, setLayout] = useState<LayoutPreferences>(() => readLayout(layoutScope))
  function showRightPanel(panel: 'settings' | 'revisions' | 'properties') { setFocused(false); setPanelOpen(false); setRightPanel(panel) }
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [snapshot, setSnapshot] = useState<{ revision: number; manifest: Manifest; style: string } | null>(null)
  const [snapshotError, setSnapshotError] = useState('')
  const [snapshotReload, setSnapshotReload] = useState(0)
  const [switchingRevision, setSwitchingRevision] = useState(false)
  const revisionTransition = useRef(false)
  const [themeCss, setThemeCss] = useState('')
  const [themeFonts, setThemeFonts] = useState<ThemeFontOption[]>([])
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTarget, setSearchTarget] = useState<SearchHit | null>(null)
  const tail = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLElement>(null)
  const collaborationSession = useMemo(() => ({ ...session, collaborationEpoch }), [session, collaborationEpoch])
  function changeText(value: string) {
    setDraft(value)
    if (!selected || !manifest) return
    inputProtection.write(value === selected.node.text ? null : {
      schemaVersion: 'hcd-fixed-input/1', format: session.format, baseRevision: manifest.revision, kind: 'text',
      page: selected.page, nodeId: selected.node.nodeId, nodeHash: selected.node.nodeHash, originalText: selected.node.text, text: value,
    } satisfies FixedInput)
  }
  function changeNewText(value: string) {
    setNewDraft(value)
    if (!newBox || !manifest) return
    inputProtection.write(!value.trim() ? null : { schemaVersion: 'hcd-fixed-input/1', format: session.format,
      baseRevision: manifest.revision, kind: 'insert', box: newBox, text: value } satisfies FixedInput)
  }
  function cancelInput() {
    pendingInput.current = null
    inputProtection.write(null)
    setSelected(null); setNewBox(null); setNewDraft('')
  }
  async function restoreInput(record: InputDraft) {
    if (selected || newBox || saving || historyBusy || readOnly || viewRevision !== null) throw new Error('请先保存或取消当前输入')
    setSaving(true)
    try {
      const input = parseFixedInput(record, session.format)
      const receipt = await inputProtection.validate(record)
      const current = await (await api(session, '')).json() as Manifest
      if (current.revision !== input.baseRevision || current.revision !== manifest?.revision) throw new Error('文档版本已变化；草稿已保留，请下载核对')
      const sequence = input.kind === 'text' ? input.page : input.box.sequence
      const indexPage = Math.floor(sequence / 128)
      if (indexPage >= current.indexPageCount) throw new Error('目标页面已变化；草稿已保留，请下载核对')
      const indexes = await Promise.all(Array.from({ length: indexPage + 1 }, (_, index) =>
        api(session, `/index/${index}?revision=${current.revision}`).then(response => response.json() as Promise<{ chunks: Descriptor[] }>)))
      const chunks = indexes.flatMap(index => index.chunks), chunk = chunks.find(chunk => chunk.sequence === sequence)
      if (!chunk || input.kind === 'insert' && input.box.format === 'pptx' && input.box.chunkId !== chunk.chunkId) throw new Error('目标页面已变化；草稿已保留，请下载核对')
      if (input.kind === 'text') {
        const node = await (await api(session, `/nodes/${encodeURIComponent(input.nodeId)}`)).json() as { nodeHash: string; text: string }
        if (node.nodeHash !== input.nodeHash || node.text !== input.originalText) throw new Error('目标文字已变化；草稿已保留，请下载核对')
      }
      if (!inputProtection.unchanged(receipt)) throw new Error('当前输入已变化；请先保存或取消')
      await inputProtection.adopt(record)
      setDescriptors(previous => mergeDescriptors(previous, chunks)); setLoadedPages(previous => Math.max(previous, indexPage + 1))
      setThumbnailPages(previous => new Set(previous).add(chunk.chunkId))
      if (input.kind === 'text') {
        pendingInput.current = input
        const nodes = pageNodes.current.get(sequence)
        if (nodes) restorePropertySelection(sequence, nodes)
      } else { setNewBox(input.box); setNewDraft(input.text) }
      requestAnimationFrame(() => pagesRef.current?.querySelector(`[id="hcd-page-${sequence}"]`)?.scrollIntoView({ block: 'center' }))
    } finally { setSaving(false) }
  }
  function recordEdit(nextRevision: number, label: string) {
    setEditHistory(previous => ({ head: nextRevision,
      past: keepHistory([...(previous.head === nextRevision - 1 ? previous.past : []), { revision: nextRevision - 1, label }]),
      future: [] }))
  }
  function resetEditHistory(nextRevision: number) {
    setEditHistory({ head: nextRevision, past: [], future: [] })
  }
  useEffect(() => {
    const pages = pagesRef.current
    if (!pages) return
    const measure = () => setStageWidth(pages.clientWidth)
    const observer = new ResizeObserver(measure)
    observer.observe(pages)
    measure()
    return () => observer.disconnect()
  }, [])
  function showRemoteRevision(next: number) {
    if (next <= (manifest?.revision ?? -1)) return
    if (saving || historyBusy || selected || newBox || pendingInput.current || viewRevision !== null) {
      setRemoteRevision(previous => Math.max(previous ?? 0, next))
      return
    }
    resetEditHistory(next)
    setManifest(previous => previous && ({ ...previous, revision: next }))
    setRefresh(previous => previous + 1)
  }
  const collaboration = useFixedCollaboration(collaborationSession, manifest?.revision ?? null, showRemoteRevision)
  useEffect(() => {
    if (remoteRevision === null || saving || historyBusy || selected || newBox || viewRevision !== null) return
    if (remoteRevision > (manifest?.revision ?? -1)) showRemoteRevision(remoteRevision)
    setRemoteRevision(null)
  }, [remoteRevision, saving, historyBusy, selected, newBox, viewRevision, manifest?.revision])
  useEffect(() => { saveLayout(layout, layoutScope) }, [layout, layoutScope])
  const displayedRevision = viewRevision ?? manifest?.revision ?? null
  useEffect(() => { setPreviews({}) }, [viewRevision])
  const historical = viewRevision !== null
  const visibleManifest = historical ? snapshot?.revision === viewRevision ? snapshot.manifest : null : manifest
  const visibleStyle = historical ? snapshot?.revision === viewRevision ? snapshot.style : '' : style
  const snapshotLoading = historical && !visibleManifest && !snapshotError
  const selectedMetadata = revisions.find(item => item.revision === viewRevision)
  const revisionMetadata = [selectedMetadata?.authorName || localizeSource(locale, viewRevision === 0 ? '初始导入' : '作者未记录'),
    selectedMetadata?.createdAtEpochMs ? new Date(selectedMetadata.createdAtEpochMs).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ')
  const draftDirty = (selected && draft !== selected.node.text) || (newBox && !!newDraft.trim())
  const status = saving || historyBusy ? '保存中' : historical ? '历史只读' : remoteRevision ? '有新修订' : readOnly ? '只读' : draftDirty ? '编辑中' : '已保存'
  const canUndoDraft = !!activeEditor && undoDepth(activeEditor.state) > 0
  const canRedoDraft = !!activeEditor && redoDepth(activeEditor.state) > 0
  const canUndoSaved = !draftDirty && editHistory.head === manifest?.revision && editHistory.past.length > 0
  const canRedoSaved = !draftDirty && editHistory.head === manifest?.revision && editHistory.future.length > 0
  const historyLocked = readOnly || historical || saving || historyBusy
  // A pinned face that is not one of the theme's families stays out of the list,
  // so the select never claims a value it cannot offer.
  const selectedFamily = selected && themeFonts.some(item => item.family === selected.node.pinnedFont) ? selected.node.pinnedFont : null
  async function travelHistory(direction: 'undo' | 'redo') {
    const steps = direction === 'undo' ? editHistory.past : editHistory.future
    const head = manifest?.revision
    if (historyLocked || draftDirty || head === undefined || !steps.length) return
    if (editHistory.head !== head) {
      resetEditHistory(head)
      setError('其他协作者已更新文档，请重新操作')
      return
    }
    const target = steps[steps.length - 1]
    setHistoryBusy(true)
    setError('')
    try {
      const response = await api(session, `/restore/${target.revision}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: head }),
      })
      const saved = await response.json() as { revision: number }
      setEditHistory(previous => direction === 'undo'
        ? { head: saved.revision, past: previous.past.slice(0, -1),
          future: keepHistory([...previous.future, { revision: head, label: target.label }]) }
        : { head: saved.revision, past: keepHistory([...previous.past, { revision: head, label: target.label }]),
          future: previous.future.slice(0, -1) })
      setManifest(previous => previous && ({ ...previous, revision: saved.revision }))
      setSelected(null)
      setNewBox(null)
      setRefresh(previous => previous + 1)
      setRemoteRevision(null)
      collaboration.announceRevision(saved.revision)
      const auth = await (await api(session, '/auth')).json() as { collaborationEpoch: number }
      setCollaborationEpoch(auth.collaborationEpoch)
    } catch (cause) {
      setError(`${direction === 'undo' ? '撤销' : '重做'}失败：${String(cause)}`)
      try {
        const current = await (await api(session, '')).json() as Manifest
        if (current.revision !== head) {
          setManifest(current)
          resetEditHistory(current.revision)
          setRefresh(previous => previous + 1)
        }
      } catch { /* The next collaboration poll will retry. */ }
    } finally { setHistoryBusy(false) }
  }
  function travel(direction: 'undo' | 'redo') {
    if (historyLocked) return
    if (direction === 'undo' && canUndoDraft) { undo(activeEditor!.state, activeEditor!.view.dispatch); return }
    if (direction === 'redo' && canRedoDraft) { redo(activeEditor!.state, activeEditor!.view.dispatch); return }
    void travelHistory(direction)
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pagesRef.current?.getClientRects().length) return
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
      const key = event.key.toLowerCase()
      const direction = key === 'z' ? (event.shiftKey ? 'redo' : 'undo')
        : key === 'y' && !event.shiftKey ? 'redo' : null
      if (!direction) return
      event.preventDefault()
      travel(direction)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
  function setLayoutOption(key: keyof LayoutPreferences, value: boolean) {
    setLayout(previous => ({ ...previous, [key]: value }))
  }
  async function select(selection: Selection) {
    if (saving || historyBusy || pendingInput.current) return
    if (selected?.node.nodeId === selection.node.nodeId) return
    if (newBox && newDraft.trim()) {
      const revision = await saveNewBox(newBox, newDraft)
      if (revision === null) return
    }
    if (selected && draft !== selected.node.text) {
      const revision = await saveText(selected.node, draft)
      if (revision === null) return
    }
    pendingPropertySelection.current = null
    setSelected(selection)
    setDraft(selection.node.text)
    setNewBox(null)
    setPlacingText(false)
    if (session.format === 'pptx') showRightPanel('properties')
    else setRightPanel(null)
  }
  const loadedPagesRef = useRef(loadedPages)
  loadedPagesRef.current = loadedPages
  useEffect(() => {
    pageNodes.current.clear()
    let live = true
    Promise.all([api(session, '').then(response => response.json()), api(session, '/styles').then(response => response.text())])
      .then(async ([info, css]) => {
        const manifest = info as Manifest
        if (refresh > 0 && viewRevision === null) {
          // Keep the last complete pages on screen while resolving the new
          // topology. Clearing the list unmounts every iframe and flashes white.
          const count = Math.min(Math.max(1, loadedPagesRef.current), manifest.indexPageCount)
          const indexes = await Promise.all(Array.from({ length: count }, (_, page) => api(session, `/index/${page}?revision=${manifest.revision}`).then(response => response.json() as Promise<{ chunks: Descriptor[] }>)))
          if (!live) return
          setDescriptors(indexes.flatMap(index => index.chunks)); setLoadedPages(count)
        }
        if (live) { setManifest(manifest); setEditHistory(previous => previous.head === manifest.revision ? previous : { head: manifest.revision, past: [], future: [] }); setStyle(css) }
      })
      .catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session, refresh, viewRevision])
  useEffect(() => {
    if (viewRevision === null) return
    const request = new AbortController()
    setSnapshot(null)
    setSnapshotError('')
    void Promise.all([
      api(session, `?revision=${viewRevision}`, { signal: request.signal }).then(response => response.json() as Promise<Manifest>),
      api(session, `/styles?revision=${viewRevision}`, { signal: request.signal }).then(response => response.text()),
    ]).then(([info, css]) => {
      if (!request.signal.aborted) setSnapshot({ revision: viewRevision, manifest: info, style: css })
    }).catch(cause => { if (!request.signal.aborted) setSnapshotError(String(cause)) })
    return () => request.abort()
  }, [session, viewRevision, snapshotReload])
  // The pages render `${style}\n${themeCss}`, so the pair has to be decided
  // together: when the document's own stylesheet already carries the pinned
  // theme, the request asks for the font bytes alone instead of getting the
  // same variables and family rules a second time.
  useEffect(() => {
    let live = true
    loadTheme(session, viewRevision, { facesOnly: hasThemeRegion(visibleStyle) })
      .then(theme => {
        if (!live) return
        setThemeCss(theme.css)
        setThemeFonts(themeFontOptions(theme.faces))
      })
      .catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session, viewRevision, visibleStyle])
  useEffect(() => {
    let live = true
    api(session, '/revisions').then(response => response.json())
      .then((result: { revisions: Revision[] }) => { if (live) setRevisions(result.revisions) })
      .catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session, manifest?.revision])
  useEffect(() => {
    setDescriptors([])
    setLoadedPages(0)
    setSearchTarget(null)
    setSelected(null)
    setNewBox(null)
    setPlacingText(false)
  }, [viewRevision])
  useEffect(() => {
    if (!visibleManifest || loadedPages >= visibleManifest.indexPageCount) return
    const marker = tail.current
    if (!marker) return
    let live = true
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return
      observer.disconnect()
      const page = loadedPages
      void api(session, `/index/${page}${viewRevision === null ? '' : `?revision=${viewRevision}`}`).then(response => response.json())
        .then((index: { chunks: Descriptor[] }) => {
          if (!live) return
          setDescriptors(previous => mergeDescriptors(previous, index.chunks))
          setLoadedPages(previous => Math.max(previous, page + 1))
        }).catch(cause => { if (live) setError(String(cause)) })
    }, { rootMargin: '1600px' })
    observer.observe(marker)
    return () => { live = false; observer.disconnect() }
  }, [session, visibleManifest, loadedPages, descriptors, viewRevision])
  useEffect(() => {
    if (!searchTarget || !descriptors.some(item => item.sequence === searchTarget.chunkSequence)) return
    requestAnimationFrame(() => pagesRef.current?.querySelector(`[id="hcd-page-${searchTarget.chunkSequence}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }, [searchTarget, descriptors])
  async function searchContent(query: string): Promise<SearchResult> {
    const params = new URLSearchParams({ q: query })
    if (viewRevision !== null) params.set('revision', String(viewRevision))
    return (await api(session, `/search?${params}`)).json() as Promise<SearchResult>
  }
  async function navigateSearch(hit: SearchHit) {
    if (!manifest) return
    if (await saveBeforeExport() === null) throw new Error('请先保存当前文字修改')
    setSelected(null)
    setSearchTarget(hit)
    const targetPage = Math.floor(hit.chunkSequence / 128)
    if (descriptors.some(item => item.sequence === hit.chunkSequence)) return
    for (let start = loadedPages; start <= targetPage; start += 8) {
      const pages = await Promise.all(Array.from({ length: Math.min(8, targetPage + 1 - start) }, (_, offset) =>
        api(session, `/index/${start + offset}${viewRevision === null ? '' : `?revision=${viewRevision}`}`)
          .then(response => response.json() as Promise<{ chunks: Descriptor[] }>)))
      setDescriptors(previous => mergeDescriptors(previous, pages.flatMap(page => page.chunks)))
      setLoadedPages(previous => Math.max(previous, start + pages.length))
    }
  }
  async function saveText(node: TextNode, value: string): Promise<number | null> {
    if (readOnly || historical || !node.editable || saving || historyBusy) return null
    setSaving(true)
    setError('')
    const inputReceipt = inputProtection.capture()
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/1', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'text.splice', nodeId: node.nodeId, start: 0,
            deleteCount: [...node.text].length, insertText: value,
            precondition: { nodeHash: node.nodeHash } }] }),
      })
      const result = await response.json() as { revision: number }
      inputProtection.acknowledge(inputReceipt)
      recordEdit(result.revision, '编辑文字')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setRefresh(previous => previous + 1)
      setSelected(null)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。如文档已被其他人修改，请重新打开。`); return null }
    finally { setSaving(false) }
  }
  async function saveFont(node: TextNode, option: ThemeFontOption): Promise<number | null> {
    if (readOnly || historical || !node.editable || saving || historyBusy) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/37', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'text.font', nodeId: node.nodeId, font: themeFontPatch(option),
            precondition: { nodeHash: node.nodeHash } }] }),
      })
      const result = await response.json() as { revision: number }
      recordEdit(result.revision, `设置字体 ${option.family}`)
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setRefresh(previous => previous + 1)
      // The reloaded node carries a new hash, so the old selection cannot patch again.
      pendingPropertySelection.current = selected
      setSelected(null)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字后重试。`); return null }
    finally { setSaving(false) }
  }
  async function clearFont(node: TextNode): Promise<number | null> {
    if (readOnly || historical || !node.editable || saving || historyBusy) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/37', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'text.font.clear', nodeId: node.nodeId,
            precondition: { nodeHash: node.nodeHash } }] }),
      })
      const result = await response.json() as { revision: number }
      recordEdit(result.revision, '清除钉住字体')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setRefresh(previous => previous + 1)
      setSelected(null)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字后重试。`); return null }
    finally { setSaving(false) }
  }
  async function saveGeometry(node: TextNode, geometry: PptxGeometry): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || historyBusy || !node.geometry || draft !== node.text) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/17', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pptx.shape.geometry', nodeId: node.nodeId, geometry,
            precondition: { nodeHash: node.nodeHash, geometry: node.geometry } }] }),
      })
      const result = await response.json() as { revision: number }
      recordEdit(result.revision, '调整文字框位置')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      pendingPropertySelection.current = selected
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function saveRunFormat(node: TextNode, format: PptxRunFormat): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || historyBusy || !node.editable || draft !== node.text) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/30', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pptx.run.format', nodeId: node.nodeId, format,
            precondition: { nodeHash: node.nodeHash } }] }),
      })
      const result = await response.json() as { revision: number }
      recordEdit(result.revision, '设置文字格式')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      pendingPropertySelection.current = selected
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字后重试。`); return null }
    finally { setSaving(false) }
  }
  async function saveShapeAlign(node: TextNode, align: PptxShapeAlign): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || historyBusy || !node.editable || draft !== node.text) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/46', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pptx.shape.align', nodeId: node.nodeId, align,
            precondition: { nodeHash: node.nodeHash } }] }),
      })
      const result = await response.json() as { revision: number }
      recordEdit(result.revision, '设置形状对齐')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      pendingPropertySelection.current = selected
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function savePdfGeometry(node: TextNode, geometry: PdfGeometry): Promise<number | null> {
    if (session.format !== 'pdf' || readOnly || historical || saving || historyBusy || !node.pdfGeometry || draft !== node.text) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/23', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pdf.text.geometry', nodeId: node.nodeId, geometry,
            precondition: { nodeHash: node.nodeHash, geometry: node.pdfGeometry } }] }),
      })
      const result = await response.json() as { revision: number }
      recordEdit(result.revision, '调整 PDF 文字框位置')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function deletePdfText(node: TextNode): Promise<number | null> {
    if (session.format !== 'pdf' || readOnly || historical || saving || historyBusy || !node.pdfGeometry || draft !== node.text) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/24', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pdf.text.delete', nodeId: node.nodeId,
            precondition: { nodeHash: node.nodeHash } }] }),
      })
      const result = await response.json() as { revision: number }
      recordEdit(result.revision, '删除 PDF 文字框')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function deletePptxText(node: TextNode): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || historyBusy || !node.createdInHcd || draft !== node.text) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/27', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pptx.text.delete', nodeId: node.nodeId,
            precondition: { nodeHash: node.nodeHash } }] }),
      })
      const result = await response.json() as { revision: number }
      recordEdit(result.revision, '删除 PPTX 文字框')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function saveBeforeExport(): Promise<number | null> {
    if (saving || historyBusy) return null
    if (pendingInput.current) { setError('正在恢复目标页面，请稍后再试'); return null }
    if (selected && draft !== selected.node.text && !readOnly && !historical) return saveText(selected.node, draft)
    if (newBox && newDraft.trim() && !readOnly && !historical) return saveNewBox(newBox, newDraft)
    return displayedRevision
  }
  async function showRevision(number: number | null) {
    if (revisionTransition.current || saving || historyBusy) return
    revisionTransition.current = true
    setSwitchingRevision(true)
    try {
      // Persist a fixed-layout text draft before unmounting its inline editor.
      // A failed save leaves the current canvas and draft available for retry.
      if (await saveBeforeExport() === null) return
      setSnapshotError('')
      setViewRevision(number)
      if (number !== null && window.matchMedia('(max-width: 900px)').matches) {
        setRightPanel(null)
        setLayoutOption('showOutline', false)
      }
    } finally { revisionTransition.current = false; setSwitchingRevision(false) }
  }
  async function closeEditor() {
    if (((selected && draft !== selected.node.text) || (newBox && newDraft.trim())) && await saveBeforeExport() === null) return
    onClose()
  }
  async function saveNewBox(box: NewTextBox, value: string): Promise<number | null> {
    if (!['pdf', 'pptx'].includes(session.format) || readOnly || historical || saving || historyBusy || !value.trim()) return null
    setSaving(true)
    setError('')
    const inputReceipt = inputProtection.capture()
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: box.format === 'pdf' ? 'hcd-patch/5' : 'hcd-patch/16', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [box.format === 'pdf'
            ? { op: 'pdf.text.insert', page: box.page, xPt: box.xPt, yPt: box.yPt,
              widthPt: box.widthPt, heightPt: box.heightPt, fontSizePt: box.fontSizePt, text: value }
            : { op: 'pptx.text.insert', chunkId: box.chunkId, slidePart: box.slidePart, xEmu: box.xEmu,
              yEmu: box.yEmu, widthEmu: box.widthEmu, heightEmu: box.heightEmu, fontSizePt: box.fontSizePt, text: value }] }),
      })
      const result = await response.json() as { revision: number }
      inputProtection.acknowledge(inputReceipt)
      recordEdit(result.revision, '新增文字框')
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setRefresh(previous => previous + 1)
      setNewBox(null)
      setNewDraft('')
      return result.revision
    } catch (cause) { setError(String(cause)); return null }
    finally { setSaving(false) }
  }
  async function addSlide(): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || historyBusy || topologyBusy.current) return null
    // A new page reshuffles what the editor has loaded, so text that is still
    // being typed is committed first and its revision becomes the patch base.
    topologyBusy.current = true; setOrganizing(true)
    const base = await saveBeforeExport()
    if (base === null) { topologyBusy.current = false; setOrganizing(false); return null }
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/41', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: base,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pptx.slide.add' }] }),
      })
      const result = await response.json() as { revision: number }
      // A new slide is a page the editor never fetched, so the manifest and the
      // last index page are read again instead of only bumping the revision.
      const info = await api(session, '').then(current => current.json() as Promise<Manifest>)
      // The new page always sits on the last index page, whether it joins the one
      // that was already there or starts a page of its own.
      const last = Math.max(0, info.indexPageCount - 1)
      const index = await api(session, `/index/${last}${viewRevision === null ? '' : `?revision=${viewRevision}`}`)
        .then(current => current.json() as Promise<{ chunks: Descriptor[] }>)
      recordEdit(result.revision, '新增幻灯片')
      setManifest(info)
      collaboration.announceRevision(result.revision)
      setDescriptors(previous => mergeDescriptors(previous, index.chunks))
      // Pages load in order, so the count only moves when the page just read is
      // the next one in line; a deck still being scrolled keeps its own frontier.
      setLoadedPages(previous => (last === previous ? previous + 1 : previous))
      setSelected(null)
      setNewBox(null)
      setNewDraft('')
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(String(cause)); return null }
    finally { setSaving(false); topologyBusy.current = false; setOrganizing(false) }
  }
  async function deleteSlide(chunkId: string): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || historyBusy || topologyBusy.current) return null
    // The page a deletion takes out is whichever one the row names, so text still
    // being typed has to reach a revision before the patch asks for its base.
    topologyBusy.current = true; setOrganizing(true)
    const base = await saveBeforeExport()
    if (base === null) { topologyBusy.current = false; setOrganizing(false); return null }
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/42', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: base,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pptx.slide.delete', chunkId }] }),
      })
      const result = await response.json() as { revision: number }
      // Every page after the one that left moves up by a chunk, so the index the
      // editor holds is wrong as a whole rather than at one row: the pages it had
      // loaded are read again and replace the list. The deck can also lose an
      // index page, so the frontier is capped by what the manifest still has.
      const info = await api(session, '').then(current => current.json() as Promise<Manifest>)
      const pages = Math.min(loadedPages, info.indexPageCount)
      const indexes = await Promise.all(Array.from({ length: pages }, (_, page) =>
        api(session, `/index/${page}${viewRevision === null ? '' : `?revision=${viewRevision}`}`)
          .then(current => current.json() as Promise<{ chunks: Descriptor[] }>)))
      recordEdit(result.revision, '删除幻灯片')
      setManifest(info)
      collaboration.announceRevision(result.revision)
      setDescriptors(indexes.flatMap(index => index.chunks))
      setLoadedPages(pages)
      setSelected(null)
      setNewBox(null)
      setNewDraft('')
      setPlacingText(false)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`删除幻灯片失败：${String(cause)}`); return null }
    finally { setSaving(false); topologyBusy.current = false; setOrganizing(false) }
  }
  async function moveSlide(chunkId: string, targetIndex: number): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || historyBusy || topologyBusy.current) return null
    // The page that moves is whichever one the row names, so text still being
    // typed has to reach a revision before the patch asks for its base.
    topologyBusy.current = true; setOrganizing(true)
    const base = await saveBeforeExport()
    if (base === null) { topologyBusy.current = false; setOrganizing(false); return null }
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/48', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: base,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pptx.slide.reorder', chunkId, targetIndex }] }),
      })
      const result = await response.json() as { revision: number }
      // Moving one page shifts the intervening rows. Reload the existing index
      // frontier so the canvas and navigator share the server's new sequences.
      // The chunk count and index page count remain unchanged.
      const info = await api(session, '').then(current => current.json() as Promise<Manifest>)
      const pages = Math.min(loadedPages, info.indexPageCount)
      const indexes = await Promise.all(Array.from({ length: pages }, (_, page) =>
        api(session, `/index/${page}${viewRevision === null ? '' : `?revision=${viewRevision}`}`)
          .then(current => current.json() as Promise<{ chunks: Descriptor[] }>)))
      recordEdit(result.revision, '拖动排序幻灯片')
      setManifest(info)
      collaboration.announceRevision(result.revision)
      const next = indexes.flatMap(index => index.chunks)
      setPreviews(previous => Object.fromEntries(next.flatMap(chunk => { const original = descriptors.find(item => item.chunkId === chunk.chunkId); return original && previous[original.sequence] ? [[chunk.sequence, previous[original.sequence]]] : [] })))
      setDescriptors(next)
      setActivePageId(chunkId)
      const destination = next.find(page => page.chunkId === chunkId)
      if (destination) requestAnimationFrame(() => pagesRef.current?.querySelector(`[id="hcd-page-${destination.sequence}"]`)?.scrollIntoView({ block: 'start' }))
      setLoadedPages(pages)
      setSelected(null)
      setNewBox(null)
      setNewDraft('')
      setPlacingText(false)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`幻灯片排序失败，未覆盖其他修改：${String(cause)}`); return null }
    finally { setSaving(false); topologyBusy.current = false; setOrganizing(false) }
  }
  async function duplicateSlide(chunkId: string): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || historyBusy || topologyBusy.current) return null
    // The page that is duplicated is whichever one the row names, so text still
    // being typed has to reach a revision before the patch asks for its base.
    topologyBusy.current = true; setOrganizing(true)
    const base = await saveBeforeExport()
    if (base === null) { topologyBusy.current = false; setOrganizing(false); return null }
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/44', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: base,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pptx.slide.copy', chunkId }] }),
      })
      const result = await response.json() as { revision: number }
      // The copy is inserted right behind the page it came from, so every row
      // after it is numbered wrong rather than only the one that was copied: the
      // pages the editor had loaded are read again and replace the list. A copied
      // page can also start an index page of its own, so a deck whose every chunk
      // had arrived reads the whole of the new list, and one still being scrolled
      // keeps its own frontier.
      const info = await api(session, '').then(current => current.json() as Promise<Manifest>)
      const pages = deckFullyLoaded ? info.indexPageCount : Math.min(loadedPages, info.indexPageCount)
      const indexes = await Promise.all(Array.from({ length: pages }, (_, page) =>
        api(session, `/index/${page}${viewRevision === null ? '' : `?revision=${viewRevision}`}`)
          .then(current => current.json() as Promise<{ chunks: Descriptor[] }>)))
      recordEdit(result.revision, '复制幻灯片')
      setManifest(info)
      collaboration.announceRevision(result.revision)
      setDescriptors(indexes.flatMap(index => index.chunks))
      setLoadedPages(pages)
      setSelected(null)
      setNewBox(null)
      setNewDraft('')
      setPlacingText(false)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`复制幻灯片失败：${String(cause)}`); return null }
    finally { setSaving(false); topologyBusy.current = false; setOrganizing(false) }
  }
  function placeText(box: NewTextBox) {
    setSelected(null)
    setNewBox(box)
    setNewDraft('')
    setPlacingText(false)
  }
  async function togglePlacement() {
    if (newBox && newDraft.trim() && await saveNewBox(newBox, newDraft) === null) return
    if (selected && draft !== selected.node.text && await saveText(selected.node, draft) === null) return
    setPlacingText(previous => !previous)
    setSelected(null)
    setNewBox(null)
    setNewDraft('')
  }
  useEffect(() => {
    const pages = pagesRef.current, viewport = pages?.closest('.document-scroll')
    if (!pages || !viewport) return
    const visible = new Map<Element, number>()
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.set(entry.target, Math.abs(entry.boundingClientRect.top - viewport.getBoundingClientRect().top))
        else visible.delete(entry.target)
      }
      const nearest = [...visible].sort((a, b) => a[1] - b[1])[0]?.[0]
      const sequence = Number(nearest?.id.replace('hcd-page-', ''))
      const page = descriptors.find(item => item.sequence === sequence)
      if (page) setActivePageId(page.chunkId)
    }, { root: viewport, threshold: [0, .25, .5, .75, 1] })
    pages.querySelectorAll('.fixed-page').forEach(page => observer.observe(page))
    return () => observer.disconnect()
  }, [descriptors])
  async function navigatePage(page: NavigationPage) {
    if (saving || historyBusy || topologyBusy.current) return
    if (await saveBeforeExport() === null) return
    setActivePageId(page.chunkId)
    pagesRef.current?.querySelector(`[id="hcd-page-${page.sequence}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    if (window.innerWidth <= 900) setLayoutOption('showOutline', false)
  }
  async function loadMorePages() {
    if (!visibleManifest || loadedPages >= visibleManifest.indexPageCount || saving || historyBusy) return
    try {
      const index = await (await api(session, `/index/${loadedPages}${viewRevision === null ? '' : `?revision=${viewRevision}`}`)).json() as { chunks: Descriptor[] }
      setDescriptors(previous => mergeDescriptors(previous, index.chunks))
      setLoadedPages(previous => previous === loadedPages ? previous + 1 : previous)
    } catch (cause) { setError(String(cause)) }
  }
  // The rows a page can move from are its head: a slide whose table split repeats
  // its section in a continuation, and a continuation is the same page, not a
  // second one the deck could put somewhere else.
  const slidePages = useMemo(() => descriptors.filter(chunk => chunk.region === 'slide' && !chunk.continuation), [descriptors])
  // Loading walks index pages in order, so the first row is the deck's first page
  // however far the reader got; the last row is its last page only once every
  // chunk has arrived, which is what puts a downward move out of reach.
  const deckFullyLoaded = descriptors.length >= (manifest?.chunkCount ?? descriptors.length)
  return <div data-format={session.format} data-hcd-history={historical ? 'true' : undefined} className={`workspace semantic-workspace fixed-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline && !focused ? '' : 'outline-hidden'} ${(rightPanel || panelOpen) && !focused ? '' : 'right-hidden'} ${focused ? 'focus-mode' : ''}`}>
    {layout.showHeader && <EditorHeader outlineOpen={layout.showOutline && !focused} onToggleOutline={() => { setFocused(false); setLayoutOption('showOutline', !layout.showOutline || focused) }} session={session} revision={displayedRevision} status={status} activeTab={activeTab}
      onTab={tab => { setActiveTab(tab); setPlacingText(false); if (tab === 'revisions') { setPanelOpen(false); showRightPanel('revisions') } }} onClose={() => void closeEditor()}
      onSettings={() => setRightPanel(previous => previous === 'settings' ? null : 'settings')} onSearch={() => setSearchOpen(true)} settingsOpen={rightPanel === 'settings' && !panelOpen && !focused} focused={focused} onFocus={() => setFocused(value => !value)} readOnly={readOnly || historical} onReadOnly={value => { if (value && !readOnly) void saveBeforeExport().then(saved => { if (saved !== null) { setPlacingText(false); setReadOnly(true) } }); else if (session.scope === 'write') { if (historical) void showRevision(null); setReadOnly(value) } }} beforeExport={saveBeforeExport} presence={layout.showCollaborators ? collaboration.avatars : null} />}
    {!layout.showHeader && <button className="floating-settings" aria-label={localizeSource(locale, "界面设置")} onClick={() => showRightPanel('settings')}><LocalText source={"⚙ 界面设置"} /></button>}
    <DocumentSearch open={searchOpen} onOpen={() => setSearchOpen(true)} onClose={() => setSearchOpen(false)} search={searchContent} onSelect={navigateSearch} refreshKey={displayedRevision} />
    <div className="layout editor-layout">
      <WorkspaceDrawers leftOpen={layout.showOutline && !focused} rightOpen={!focused && (panelOpen || !!rightPanel)} onCloseLeft={() => setLayoutOption('showOutline', false)} onCloseRight={() => { setPanelOpen(false); setRightPanel(null) }} />
      <SlideNavigator session={session} onSearch={() => setSearchOpen(true)} onWorkspace={() => void closeEditor()} onSettings={() => showRightPanel('settings')} pages={session.format === 'pptx' ? slidePages : descriptors} previews={previews} format={session.format} hidden={!layout.showOutline || focused}
        busy={saving || historyBusy || organizing} writable={!readOnly && !historical} revision={displayedRevision} activeId={activePageId || descriptors[0]?.chunkId || null}
        hasMore={loadedPages < (visibleManifest?.indexPageCount || 0)} onMore={() => void loadMorePages()} onClose={() => setLayoutOption('showOutline', false)}
        onVisible={previewVisiblePage} onSelect={page => void navigatePage(page)} onMove={(id, index) => void moveSlide(id, index)} onCopy={id => void duplicateSlide(id)} onDelete={id => void deleteSlide(id)} onAdd={() => void addSlide()} />
      <section className="content-shell" aria-label={localizeSource(locale, '文档内容')}>
        {!focused && <ContentToolbar onSearch={() => setSearchOpen(true)} activeTab={activeTab} onTab={tab => { setPlacingText(false); setActiveTab(tab); if (tab === 'revisions') { setPanelOpen(false); showRightPanel('revisions') } }} expanded={layout.showToolbar} onToggle={() => setLayoutOption('showToolbar', !layout.showToolbar)} readOnly={readOnly || !!historical} format={session.format} />}
    {layout.showToolbar && !focused && !readOnly && !historical && <nav className="toolbar ribbon" aria-label={localizeSource(locale, "编辑工具栏")}>
      {activeTab === 'home' && <><div className="tool-group"><button title={localizeSource(locale, "撤销（⌘/Ctrl+Z）")} disabled={historyLocked || !(canUndoDraft || canUndoSaved)} onClick={() => travel('undo')}><LocalText source={"↶ 撤销"} /></button><button title={localizeSource(locale, "重做（⌘/Ctrl+Shift+Z 或 Ctrl+Y）")} disabled={historyLocked || !(canRedoDraft || canRedoSaved)} onClick={() => travel('redo')}><LocalText source={"↷ 重做"} /></button></div>{session.format === 'pptx' && selected && <PptxRunFormatBar node={selected.node} disabled={readOnly || historical || saving || historyBusy || draft !== selected.node.text} onApply={format => void saveRunFormat(selected.node, format)} />}{session.format === 'pptx' && selected && <PptxShapeAlignBar node={selected.node} disabled={readOnly || historical || saving || historyBusy || draft !== selected.node.text} onApply={align => void saveShapeAlign(selected.node, align)} />}<span className="ribbon-note">{localizeDynamic(locale, session.format === 'pptx' ? '点击文字原位编辑 · 选中后可设置加粗、斜体、下划线、字号、颜色和整个文字框的对齐，并拖动调整位置' : session.format === 'pdf' ? '点击文字原位编辑 · 新增文字框可拖动和调整尺寸 · ⌘/Ctrl + Enter 保存' : '点击页面文字即可原位编辑 · ⌘/Ctrl + Enter 保存 · Esc 取消')}</span></>}
      {activeTab === 'insert' && <><button className={placingText ? 'primary' : ''} disabled={!['pdf', 'pptx'].includes(session.format) || readOnly || historical || saving || historyBusy} onClick={() => void togglePlacement()}>{placingText ? '取消放置' : '新增文字框'}</button>{session.format === 'pptx' && <button disabled={readOnly || historical || saving || historyBusy} onClick={() => void addSlide()}><LocalText source={"新增幻灯片"} /></button>}<span className="ribbon-note">{placingText ? '点击页面空白处放置文字框' : session.format === 'pptx' ? '新增幻灯片排在最后，放好后可以直接在上面新增文字框' : '新增文字框保留页面布局'}</span></>}
      {activeTab === 'view' && <><label className="mode"><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /><LocalText source={"显示页面目录"} /></label><label className="mode"><input type="checkbox" checked={readOnly || historical} disabled={session.scope === 'read' || historical} onChange={event => setReadOnly(event.target.checked)} /><LocalText source={"只读模式"} /></label><button onClick={() => showRightPanel('settings')}><LocalText source={"界面设置"} /></button></>}
      {activeTab === 'revisions' && <><button onClick={() => showRightPanel('revisions')}><LocalText source={"查看修订历史"} /></button><button disabled={historyLocked || !canUndoSaved} onClick={() => travel('undo')}><LocalText source={"撤销 "} />{editHistory.past.length} <LocalText source={" 步"} /></button><button disabled={historyLocked || !canRedoSaved} onClick={() => travel('redo')}><LocalText source={"重做 "} />{editHistory.future.length} <LocalText source={" 步"} /></button><span className="ribbon-note"><LocalText source={"当前版本 r"} />{manifest?.revision ?? '…'} · {editHistory.past.length ? `下一步可撤销：${editHistory.past.at(-1)?.label}` : '当前会话无已保存的可撤销步骤'}</span></>}
      {selected && !readOnly && !historical && <label className="tool-group font-group" title={localizeSource(locale, themeFonts.length ? '把选中文字改成钉住主题的字体' : '文档没有钉住主题字体，先在管理后台钉住主题')}><LocalText source={"字体"} /><select value={selectedFamily ?? ''} disabled={saving || historyBusy || !selected.node.editable || themeFonts.length === 0} onChange={event => {
        const option = themeFonts.find(item => item.family === event.target.value)
        if (option) void saveFont(selected.node, option)
      }}><option value="">{localizeSource(locale, themeFonts.length ? '选择主题字体' : '无钉住字体')}</option>{themeFonts.map(option => <option key={option.family} value={option.family}>{option.family}</option>)}</select></label>}
      {selected && !readOnly && !historical && selected.node.fontPinned && <button disabled={saving || historyBusy || !selected.node.editable} title={localizeSource(locale, '去掉钉在选中文字上的主题字体，回到文档原来的字体')} onClick={() => void clearFont(selected.node)}><LocalText source={"清除字体"} /></button>}
      {selected && !readOnly && !historical && session.format === 'pdf' && themeFonts.length > 0 && <span className="ribbon-note">{localizeSource(locale, '字体改动会进入预览、HTML 和语义导出；保留源 PDF 的导出仍拒绝带字体的修订')}</span>}
      {selected && !readOnly && !historical && <button className="primary save-trigger" disabled={saving || draft === selected.node.text} onClick={() => void saveText(selected.node, draft)}><LocalText source={"保存修改"} /></button>}
      {selected?.node.pdfGeometry && !readOnly && !historical && <button disabled={saving || draft !== selected.node.text} onClick={() => void deletePdfText(selected.node)}><LocalText source={"删除文字框"} /></button>}
      {session.format === 'pptx' && selected?.node.createdInHcd && !readOnly && !historical && <button disabled={saving || draft !== selected.node.text} onClick={() => void deletePptxText(selected.node)}><LocalText source={"删除文字框"} /></button>}
      {newBox && !readOnly && !historical && <button className="primary save-trigger" disabled={saving || !newDraft.trim()} onClick={() => void saveNewBox(newBox, newDraft)}><LocalText source={"保存新增文字"} /></button>}
    </nav>}
      {historical && <section className="revision-preview-bar" aria-label={localizeSource(locale, '历史版本预览')}>
        <div className="revision-preview-title"><div><strong><LocalText source="历史版本预览" /> · r{viewRevision}</strong><small>{revisionMetadata} · <LocalText source="只读" /></small></div></div>
        <button className="return-current" disabled={switchingRevision} onClick={() => void showRevision(null)}><LocalText source="返回当前" /></button>
      </section>}
      {snapshotLoading && <div className="revision-empty" role="status"><LocalText source="正在加载历史版本…" /></div>}
      <InputDraftRecovery protection={inputProtection} disabled={readOnly || historical || saving || historyBusy || !!selected || !!newBox} onRestore={restoreInput} onError={setError} />
      {historical && snapshotError && <div className="revision-empty" role="alert"><p>{snapshotError}</p><button onClick={() => { setSnapshotError(''); setSnapshotReload(value => value + 1) }}><LocalText source="重试" /></button></div>}
      <CanvasViewport hidden={!visibleManifest || !!snapshotError}>{!historical && session.format === 'pptx' && <AgentProductionCanvas />}<main ref={pagesRef} className={`fixed-pages ${session.format === 'pptx' ? 'pptx-pages' : ''}`}>{visibleManifest && descriptors.map(chunk => <LazyChunk key={`${viewRevision ?? 'head'}:${chunk.chunkId}`} session={session} descriptor={chunk} preload={thumbnailPages.has(chunk.chunkId)} onNodesReady={restorePropertySelection} onPreview={recordPreview} revision={viewRevision} stylesheet={`${visibleStyle}\n${themeCss}`} readOnly={readOnly || historical} selected={selected?.page === chunk.sequence ? selected.node : null} highlightNodeId={searchTarget?.chunkSequence === chunk.sequence ? searchTarget.nodeId : null} draft={draft} newBox={newBox} newDraft={newDraft} placingText={placingText} saving={saving} placeholderHeight={session.format === 'pptx' ? slideHeight : 900} availableWidth={stageWidth} onMeasureHeight={setSlideHeight} onSelect={node => void select({ node, page: chunk.sequence })} onDraft={changeText} onEditorReady={setActiveEditor} onSave={(node, value) => void saveText(node, value)} onGeometry={saveGeometry} onPptxDelete={node => void deletePptxText(node)} onPdfGeometry={savePdfGeometry} onPdfDelete={node => void deletePdfText(node)} onCancel={cancelInput} onPlace={placeText} onNewDraft={changeNewText} onSaveNew={(box, value) => void saveNewBox(box, value)} onCancelNew={cancelInput} />)}<div ref={tail} className="load-tail" /></main></CanvasViewport>
      </section>
      {session.format === 'pptx' && <PptxProperties node={selected?.node || null} fonts={themeFonts} hidden={panelOpen || focused || rightPanel !== 'properties'} disabled={readOnly || historical || saving || historyBusy || organizing}
        dirty={!!selected && draft !== selected.node.text} onClose={() => setRightPanel(null)} onAgents={() => setPanelOpen(true)}
        onFormat={format => { if (selected) void saveRunFormat(selected.node, format) }} onAlign={align => { if (selected) void saveShapeAlign(selected.node, align) }}
        onFont={font => { if (selected) void saveFont(selected.node, font) }} onGeometry={geometry => { if (selected) void saveGeometry(selected.node, geometry) }} />}
      <AgentPanel beforeRun={async () => { if (await saveBeforeExport() === null) throw new Error('请先保存当前文字修改。') }} />
      {!panelOpen && !focused && rightPanel && rightPanel !== 'properties' && <aside className="workspace-sidebar" aria-label={localizeSource(locale, rightPanel === 'settings' ? '界面设置' : '修订历史')}>
        {rightPanel === 'settings' && <section className="appearance-panel"><div className="panel-head"><h2><LocalText source={"界面设置"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setRightPanel(null)}><CollapseSidebarIcon /></button></div><LocaleSelect /><AppearanceSelect /><label><LocalText source={"显示顶部栏"} /><input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label><LocalText source={"显示操作栏"} /><input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label><LocalText source={"显示协作者"} /><input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><label><LocalText source={"显示页面目录"} /><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /></label><fieldset><legend><LocalText source={"头部布局"} /></legend><label><input type="radio" name="fixed-header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} /><LocalText source={"紧凑"} /></label><label><input type="radio" name="fixed-header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} /><LocalText source={"标准"} /></label></fieldset><button className="open-revisions" onClick={() => showRightPanel('revisions')}><LocalText source={"查看修订历史"} /></button></section>}
        {rightPanel === 'revisions' && <section className="revision-panel"><div className="panel-head"><h2><LocalText source={"◷ 修订历史"} /></h2><button className="panel-close" aria-label={localizeSource(locale, "隐藏右侧栏")} onClick={() => setRightPanel(null)}><CollapseSidebarIcon /></button></div>
          {historical && <button onClick={() => void showRevision(null)}><LocalText source={"返回当前版本"} /></button>}
          <h3><LocalText source={"本次编辑步骤"} /></h3><p><LocalText source={"保存后的撤销和重做会生成新的修订。协作者更新后，本地步骤会清空。"} /></p>
          {editHistory.past.length ? <ol className="fixed-edit-steps">{editHistory.past.map((step, index) => <li key={`${step.revision}-${index}`}><strong>{index + 1}. {localizeDynamic(locale, step.label)}</strong><small><LocalText source={"保存前 r"} />{step.revision}</small></li>).reverse()}</ol> : <p><LocalText source={"暂无可撤销步骤"} /></p>}
          {editHistory.future.length > 0 && <><h3><LocalText source={"可重做"} /></h3><ol className="fixed-edit-steps">{editHistory.future.slice().reverse().map((step, index) => <li key={`${step.revision}-${index}`}>{localizeDynamic(locale, step.label)}</li>)}</ol></>}
          <h3><LocalText source={"全部修订"} /></h3><div className="history">{revisions.slice().reverse().map(item => <button key={item.revision} data-revision={item.revision} aria-pressed={viewRevision === item.revision} disabled={saving || historyBusy || switchingRevision} onClick={() => void showRevision(item.revision)}><span className="revision-avatar">{item.authorName?.slice(0, 1) || (item.revision === 0 ? localizeSource(locale, '导入').slice(0, 1) : '?')}</span><span className="revision-detail"><strong>r{item.revision} <small>{item.createdAtEpochMs ? new Date(item.createdAtEpochMs).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</small></strong><small>{item.authorName || (localizeSource(locale, item.revision === 0 ? '初始导入' : '作者未记录'))}</small><span><LocalText source={"查看版本"} /></span></span></button>)}</div></section>}
      </aside>}
    </div>
    <EditorStatusbar mode={localizeSource(locale, "页面视图")} format={session.format} revision={displayedRevision} readOnly={readOnly || historical} status={status} draftProtection={session.scope === 'write' ? inputProtection.status : undefined} />
    {error && <ErrorToast message={error} onClose={() => setError('')} />}
  </div>
}

type LazyChunkProps = {
  onNodesReady: (page: number, nodes: TextNode[]) => void
  preload: boolean
  onPreview: (sequence: number, preview: PagePreview) => void
  session: Session; descriptor: Descriptor; revision: number | null; stylesheet: string; readOnly: boolean
  selected: TextNode | null; highlightNodeId: string | null; draft: string; newBox: NewTextBox | null; newDraft: string; placingText: boolean
  saving: boolean; placeholderHeight: number; availableWidth: number; onMeasureHeight: (height: number) => void
  onSelect: (node: TextNode) => void; onDraft: (value: string) => void
  onEditorReady: (editor: Editor | null) => void; onSave: (node: TextNode, value: string) => void
  onGeometry: (node: TextNode, geometry: PptxGeometry) => Promise<number | null>
  onPptxDelete: (node: TextNode) => void
  onPdfGeometry: (node: TextNode, geometry: PdfGeometry) => Promise<number | null>
  onPdfDelete: (node: TextNode) => void
  onCancel: () => void; onPlace: (box: NewTextBox) => void; onNewDraft: (value: string) => void
  onSaveNew: (box: NewTextBox, value: string) => void; onCancelNew: () => void
}

function LazyChunk({ onNodesReady, preload, session, descriptor, onPreview, revision, stylesheet, readOnly, selected, highlightNodeId, draft, newBox, newDraft, placingText, saving, placeholderHeight, availableWidth, onMeasureHeight, onSelect, onDraft, onEditorReady, onSave, onGeometry, onPptxDelete, onPdfGeometry, onPdfDelete, onCancel, onPlace, onNewDraft, onSaveNew, onCancelNew }: LazyChunkProps) {
  const { requestTask } = useAgentWorkspace()
  const [agentMenu, setAgentMenu] = useState<{ x: number; y: number; node: TextNode } | null>(null)
  const { zoom: canvasZoom } = useCanvasZoom()
  const { locale } = useI18n()
  const [active, setActive] = useState(false)
  const [srcDoc, setSrcDoc] = useState('')
  const [chunkError, setChunkError] = useState('')
  const installedContent = useRef('')
  const [frameHeight, setFrameHeight] = useState(940)
  const [canvasWidth, setCanvasWidth] = useState('100%')
  const [pageNumber, setPageNumber] = useState(0)
  const [pageHeightPt, setPageHeightPt] = useState(0)
  const [primaryPage, setPrimaryPage] = useState(false)
  const [slidePart, setSlidePart] = useState('')
  const [slideWidthEmu, setSlideWidthEmu] = useState(0)
  const [slideHeightEmu, setSlideHeightEmu] = useState(0)
  const [nodes, setNodes] = useState<TextNode[]>([])
  const [directTarget, setDirectTarget] = useState<HTMLElement | null>(null)
  const [newTarget, setNewTarget] = useState<HTMLElement | null>(null)
  const [previewGeometry, setPreviewGeometry] = useState<PptxGeometry | null>(null)
  const [previewPdfGeometry, setPreviewPdfGeometry] = useState<PdfGeometry | null>(null)
  const marker = useRef<HTMLDivElement>(null)
  const assetCache = useRef(new Map<string, Promise<string>>())
  const frame = useRef<HTMLIFrameElement>(null)
  function setFrameLocale() {
    try { if (frame.current?.contentDocument) frame.current.contentDocument.documentElement.lang = locale }
    catch { /* A sandboxed frame may not expose its document. */ }
  }
  useEffect(() => { setFrameLocale() }, [locale, srcDoc])
  const drag = useRef<ShapeDrag | null>(null)
  const pdfDrag = useRef<PdfDrag | null>(null)
  const sourceWidth = Number.parseFloat(canvasWidth)
  const zoom = session.format === 'pptx' && sourceWidth > 0 && availableWidth > 0
    ? Math.min(1, availableWidth / sourceWidth) : 1
  useEffect(() => {
    if (session.format === 'pptx' && srcDoc) onMeasureHeight(Math.ceil(frameHeight * zoom))
  }, [session.format, srcDoc, frameHeight, zoom, onMeasureHeight])
  useEffect(() => { setPreviewGeometry(null); setPreviewPdfGeometry(null); drag.current = null; pdfDrag.current = null }, [selected?.nodeId, descriptor.htmlHash])
  function findDirectTarget() {
    if (!['pdf', 'pptx'].includes(session.format) || !selected) { setDirectTarget(null); return }
    const selector = session.format === 'pdf' ? `.hcd-pdf-text[data-hcd-text-node="${selected.nodeId}"]` : `.hcd-slide [data-hcd-id="${selected.nodeId}"]`
    const target = frame.current?.contentDocument?.querySelector<HTMLElement>(selector)
    if (target && session.format === 'pptx') {
      const style = target.ownerDocument.defaultView?.getComputedStyle(target)
      if (style) {
        target.style.setProperty('--hcd-edit-font-size', style.fontSize)
        target.style.setProperty('--hcd-edit-line-height', style.lineHeight)
        target.style.setProperty('--hcd-edit-color', style.color)
      }
    }
    setDirectTarget(target || null)
  }
  useEffect(() => { findDirectTarget() }, [selected?.nodeId, session.format, srcDoc])
  const lastSearchTarget = useRef<string | null>(null)
  function highlightSearchTarget() {
    const doc = frame.current?.contentDocument
    if (!doc) return
    for (const element of doc.querySelectorAll<HTMLElement>('[data-hcd-id]')) {
      element.classList.toggle('hcd-search-hit', element.getAttribute('data-hcd-id') === highlightNodeId)
    }
    const target = doc.querySelector<HTMLElement>('.hcd-search-hit')
    if (target && lastSearchTarget.current !== highlightNodeId) target.scrollIntoView({ block: 'center', inline: 'center' })
    if (target || !highlightNodeId) lastSearchTarget.current = highlightNodeId
  }
  useEffect(() => { highlightSearchTarget() }, [highlightNodeId, srcDoc])
  useEffect(() => {
    const matches = newBox?.format === 'pdf'
      ? session.format === 'pdf' && primaryPage && newBox.page === pageNumber
      : newBox?.format === 'pptx' && session.format === 'pptx' && newBox.chunkId === descriptor.chunkId
    if (!matches || !newBox) {
      setNewTarget(null)
      return
    }
    const page = frame.current?.contentDocument?.querySelector<HTMLElement>(newBox.format === 'pdf' ? '.hcd-pdf-page[data-hcd-continuation="false"]' : '.hcd-slide')
    if (!page) return
    const target = page.ownerDocument.createElement(newBox.format === 'pdf' ? 'p' : 'div')
    target.className = newBox.format === 'pdf' ? 'hcd-pdf-text hcd-draft-text' : 'hcd-slide-shape hcd-draft-text'
    Object.assign(target.style, {
      position: 'absolute', left: newBox.left, top: newBox.top, width: newBox.width,
      height: newBox.height, fontSize: `${newBox.fontSizePt}pt`,
      fontFamily: 'Arial, Helvetica, sans-serif', lineHeight: newBox.format === 'pdf' ? newBox.height : '1.2',
      background: '#fff', zIndex: '4', outline: '1px solid #1769e8',
    })
    page.append(target)
    setNewTarget(target)
    return () => target.remove()
  }, [session.format, descriptor.chunkId, newBox, primaryPage, pageNumber, srcDoc])
  useEffect(() => {
    const node = marker.current
    if (!node) return
    const observer = new IntersectionObserver(entries => setActive(entries[0].isIntersecting), { rootMargin: '1400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active && !preload) return // Retain the mounted page and its measured height offscreen.
    const contentKey = JSON.stringify([descriptor.chunkId, descriptor.htmlHash, descriptor.mapHash, revision, stylesheet])
    if (installedContent.current === contentKey) return
    let live = true
    const request = new AbortController()
    const render = async () => {
      const chunk = await (await api(session, `/chunks/${descriptor.sequence}${revision === null ? '' : `?revision=${revision}`}`, { signal: request.signal })).json() as { html: string; map: { entries: Array<{ nodeId: string; nodeHash: string; source: { nodeKind: string; editable: boolean; createdInHcd: boolean } }> } }
      const parsed = new DOMParser().parseFromString(chunk.html, 'text/html')
      const canvas = parsed.querySelector('.hcd-pdf-page,.hcd-slide') as HTMLElement | null
      const mapped = new Map(Array.from(parsed.querySelectorAll('[data-hcd-id]'), element => [element.getAttribute('data-hcd-id'), element]))
      const textNodes = chunk.map.entries.filter(entry => entry.source.nodeKind !== 'image').map(entry => {
        const element = mapped.get(entry.nodeId)
        const anchor = element?.closest('[data-hcd-text-node],.hcd-slide-shape') as HTMLElement | null
        const position = anchor?.style.position === 'absolute' ? anchor.style : null
        let width = position?.width
        if (session.format === 'pdf' && element?.getAttribute('data-hcd-patched') === 'true' && position?.width?.endsWith('pt')) {
          const size = Number.parseFloat(position.fontSize)
          const estimated = Array.from(element.textContent || '').reduce((total, character) => total + (character.charCodeAt(0) < 128 ? size * 0.6 : size), 0)
          const original = Number.parseFloat(position.width)
          const remaining = Number.parseFloat(canvas?.style.width || '0') - Number.parseFloat(position.left)
          if (Number.isFinite(estimated) && Number.isFinite(remaining) && remaining > 0) width = `${Math.min(Math.max(original, estimated), remaining)}pt`
        }
        return {
          nodeId: entry.nodeId, nodeHash: entry.nodeHash,
          text: element?.textContent || '', editable: entry.source.editable, createdInHcd: entry.source.createdInHcd,
          left: position?.left, top: position?.top, width, height: position?.height,
          geometry: session.format === 'pptx' ? pptxGeometry(anchor) : undefined,
          pdfGeometry: session.format === 'pdf' ? pdfGeometry(anchor) : undefined,
          fontSize: position?.fontSize, fontFamily: position?.fontFamily, fontWeight: position?.fontWeight,
          fontStyle: position?.fontStyle, color: position?.color, lineHeight: position?.lineHeight,
          ...(session.format === 'pptx' ? { ...pptxRunStyle(element), ...pptxShapeAlign(element) } : {}),
          pinnedFont: element?.getAttribute('data-hcd-font') || anchor?.getAttribute('data-hcd-font') || undefined,
          // Only a patch writes this marker, so a face the source document carried
          // never shows a clear button it could not honour.
          fontPinned: element?.getAttribute('data-hcd-font-patched') === 'true'
            || anchor?.getAttribute('data-hcd-font-patched') === 'true',
        }
      })
      const hashes = Array.from(new Set(Array.from(chunk.html.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g), match => match[1])))
      if (hashes.length > 64) throw new Error(`分片 ${descriptor.sequence} 引用过多资产`)
      const assets = await Promise.all(hashes.map(async hash => {
        let cached = assetCache.current.get(hash)
        if (!cached) {
          cached = (async () => {
        const blob = await (await api(session, `/assets/${hash}`)).blob()
        if (blob.size > 64 * 1024 * 1024) throw new Error('预览资产超过 64 MiB')
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        return dataUrl
          })()
          assetCache.current.set(hash, cached)
          void cached.catch(() => assetCache.current.delete(hash))
        }
        return [hash, await cached] as const
      }))
      const replacements = new Map(assets)
      const html = chunk.html.replace(/asset:\/\/sha256\/([0-9a-f]{64})/g, (_, hash: string) => replacements.get(hash) || '')
      const safeCss = stylesheet.replace(/<\/style/gi, '<\\/style')
      if (live) {
        setNodes(textNodes)
        setCanvasWidth(canvas?.style.width || '100%')
        setPageNumber(Number(canvas?.getAttribute('data-hcd-page') || 0))
        setPageHeightPt(Number.parseFloat(canvas?.style.height || '0'))
        setPrimaryPage(session.format === 'pptx' ? !descriptor.continuation : canvas?.getAttribute('data-hcd-continuation') === 'false')
        setSlidePart(canvas?.getAttribute('data-hcd-source-part') || '')
        setSlideWidthEmu(Number(canvas?.getAttribute('data-hcd-width-emu') || 0))
        setSlideHeightEmu(Number(canvas?.getAttribute('data-hcd-height-emu') || 0))
        const canvasHeight = canvas?.style.height || ''
        if (canvasHeight.endsWith('pt')) setFrameHeight(Math.max(200, Math.ceil(Number.parseFloat(canvasHeight) * 4 / 3) + 4))
        if (canvasHeight.endsWith('px')) {
          const height = Math.max(200, Math.ceil(Number.parseFloat(canvasHeight)) + 4)
          setFrameHeight(height)
        }
        const directCss = session.format === 'pdf' ? `.hcd-pdf-page[data-hcd-source-raster="true"] .hcd-pdf-text:has(>.hcd-direct-editor),.hcd-draft-text{background:#fff!important;color:#111!important;z-index:4;outline:1px solid #1769e8;outline-offset:1px}.hcd-pdf-text:has(>.hcd-direct-editor)>span[data-hcd-id]{display:none}.hcd-direct-editor{display:block;width:100%;min-width:max-content;font:inherit;line-height:inherit;color:inherit;white-space:nowrap}.hcd-direct-editor .fixed-tiptap-text{outline:0;min-height:inherit;padding:0;margin:0;font:inherit;line-height:inherit;color:inherit;white-space:nowrap}.hcd-direct-editor .fixed-tiptap-text p{position:static!important;margin:0;padding:0;font:inherit;line-height:inherit;color:inherit;white-space:nowrap}` : session.format === 'pptx' ? `.hcd-slide [data-hcd-id]:has(>.hcd-direct-editor){font-size:0!important;line-height:0!important;outline:1px solid #1769e8;outline-offset:2px}.hcd-slide .hcd-direct-editor{display:inline-block;vertical-align:baseline;font-size:var(--hcd-edit-font-size)!important;line-height:var(--hcd-edit-line-height)!important;color:var(--hcd-edit-color)!important;white-space:pre-wrap}.hcd-slide .hcd-direct-editor .fixed-tiptap-text,.hcd-slide .hcd-direct-editor .fixed-tiptap-text p{display:inline;margin:0;padding:0;min-height:0;outline:0;font:inherit;line-height:inherit;color:inherit;white-space:pre-wrap}.hcd-slide .hcd-draft-text .hcd-direct-editor,.hcd-slide .hcd-draft-text .fixed-tiptap-text,.hcd-slide .hcd-draft-text .fixed-tiptap-text p{display:block;min-width:100%;min-height:1.2em}.hcd-slide .hcd-draft-text .fixed-tiptap-text{width:100%}` : ''
        const searchCss = session.format === 'pdf'
          ? '.hcd-search-hit{outline:3px solid #f0a500!important;outline-offset:2px}'
          : '.hcd-search-hit{outline:3px solid #f0a500!important;background:#ffdb6180!important;color:#111!important}'
        const previewHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}${safeCss}${directCss}${searchCss}</style></head><body data-hcd-image-hitboxes="off" data-hcd-text-hitboxes="off">${html}</body></html>`
        setSrcDoc(previewHtml)
        installedContent.current = contentKey
        setChunkError('')
        const pixels = (length: string | undefined) => Number.parseFloat(length || '0') * (length?.endsWith('pt') ? 4 / 3 : 1)
        const width = pixels(canvas?.style.width), height = pixels(canvas?.style.height)
        if (width > 0 && height > 0) onPreview(descriptor.sequence, { html: previewHtml, width, height })
      }
    }
    void render().catch(cause => { if (live) setChunkError(String(cause)) })
    return () => { live = false; request.abort() }
  }, [active, preload, session, descriptor.sequence, descriptor.continuation, descriptor.htmlHash, descriptor.mapHash, revision, stylesheet, onMeasureHeight, onPreview])
  const emuToPx = (value: number) => `${(value * 96 / 914_400).toFixed(2)}px`
  function showShapeGeometry(shape: HTMLElement, geometry: PptxGeometry) {
    shape.style.left = emuToPx(geometry.xEmu)
    shape.style.top = emuToPx(geometry.yEmu)
    shape.style.width = emuToPx(geometry.widthEmu)
    shape.style.height = emuToPx(geometry.heightEmu)
  }
  function beginShapeDrag(mode: ShapeDrag['mode'], event: ReactPointerEvent<HTMLButtonElement>) {
    if (!selected?.geometry || draft !== selected.text || saving || !slideWidthEmu || !slideHeightEmu || !sourceWidth) return
    if (selected.geometry.xEmu + selected.geometry.widthEmu > slideWidthEmu
      || selected.geometry.yEmu + selected.geometry.heightEmu > slideHeightEmu) return
    const shape = directTarget?.closest<HTMLElement>('.hcd-slide-shape')
    if (!shape) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, mode, startX: event.clientX, startY: event.clientY,
      initial: selected.geometry, current: selected.geometry, shape }
  }
  function moveShapeDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId || !sourceWidth || !zoom) return
    event.preventDefault()
    const scale = slideWidthEmu / sourceWidth / zoom / canvasZoom
    const dx = Math.round((event.clientX - current.startX) * scale)
    const dy = Math.round((event.clientY - current.startY) * scale)
    const initial = current.initial
    const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)
    const geometry = current.mode === 'move'
      ? { ...initial, xEmu: clamp(initial.xEmu + dx, 0, slideWidthEmu - initial.widthEmu),
        yEmu: clamp(initial.yEmu + dy, 0, slideHeightEmu - initial.heightEmu) }
      : { ...initial, widthEmu: clamp(initial.widthEmu + dx, Math.min(190_500, slideWidthEmu - initial.xEmu), slideWidthEmu - initial.xEmu),
        heightEmu: clamp(initial.heightEmu + dy, Math.min(190_500, slideHeightEmu - initial.yEmu), slideHeightEmu - initial.yEmu) }
    current.current = geometry
    showShapeGeometry(current.shape, geometry)
    setPreviewGeometry(geometry)
  }
  function finishShapeDrag(event: ReactPointerEvent<HTMLButtonElement>, canceled = false) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    drag.current = null
    if (canceled || !selected || JSON.stringify(current.current) === JSON.stringify(current.initial)) {
      showShapeGeometry(current.shape, current.initial)
      setPreviewGeometry(null)
      return
    }
    void onGeometry(selected, current.current).then(revision => {
      if (revision === null) {
        showShapeGeometry(current.shape, current.initial)
        setPreviewGeometry(null)
      }
    })
  }
  function showPdfGeometry(shape: HTMLElement, geometry: PdfGeometry) {
    shape.style.left = `${geometry.xPt}pt`
    shape.style.top = `${pageHeightPt - geometry.yPt - geometry.heightPt}pt`
    shape.style.width = `${geometry.widthPt}pt`
    shape.style.height = `${geometry.heightPt}pt`
  }
  function beginPdfDrag(mode: PdfDrag['mode'], event: ReactPointerEvent<HTMLButtonElement>) {
    if (!selected?.pdfGeometry || draft !== selected.text || saving || !pageHeightPt) return
    const shape = directTarget?.closest<HTMLElement>('.hcd-pdf-text[data-hcd-mapping="hcd-overlay"]')
    const controls = event.currentTarget.parentElement
    const rect = controls?.parentElement?.getBoundingClientRect()
    const pageWidthPt = Number.parseFloat(canvasWidth)
    if (!shape || !rect?.width || !pageWidthPt) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    pdfDrag.current = { pointerId: event.pointerId, mode, startX: event.clientX, startY: event.clientY,
      initial: selected.pdfGeometry, current: selected.pdfGeometry, shape, pointsPerPixel: pageWidthPt / rect.width }
  }
  function movePdfDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = pdfDrag.current
    if (!current || current.pointerId !== event.pointerId) return
    event.preventDefault()
    const pageWidthPt = Number.parseFloat(canvasWidth)
    const dx = (event.clientX - current.startX) * current.pointsPerPixel
    const dy = (event.clientY - current.startY) * current.pointsPerPixel
    const initial = current.initial
    const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)
    const round = (value: number) => Math.round(value * 100) / 100
    const geometry = current.mode === 'move'
      ? { ...initial, xPt: round(clamp(initial.xPt + dx, 0, pageWidthPt - initial.widthPt)),
        yPt: round(clamp(initial.yPt - dy, 0, pageHeightPt - initial.heightPt)) }
      : (() => {
        const widthPt = round(clamp(initial.widthPt + dx, 1, pageWidthPt - initial.xPt))
        const heightPt = round(clamp(initial.heightPt + dy, 1, initial.heightPt + initial.yPt))
        return { ...initial, widthPt, heightPt, yPt: round(initial.yPt + initial.heightPt - heightPt) }
      })()
    current.current = geometry
    showPdfGeometry(current.shape, geometry)
    setPreviewPdfGeometry(geometry)
  }
  function finishPdfDrag(event: ReactPointerEvent<HTMLButtonElement>, canceled = false) {
    const current = pdfDrag.current
    if (!current || current.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    pdfDrag.current = null
    if (canceled || !selected || JSON.stringify(current.current) === JSON.stringify(current.initial)) {
      showPdfGeometry(current.shape, current.initial)
      setPreviewPdfGeometry(null)
      return
    }
    void onPdfGeometry(selected, current.current).then(revision => {
      if (revision === null) {
        showPdfGeometry(current.shape, current.initial)
        setPreviewPdfGeometry(null)
      }
    })
  }
  function place(event: MouseEvent<HTMLButtonElement>) {
    const pageWidthPt = Number.parseFloat(canvasWidth)
    if (session.format === 'pptx') {
      if (!slidePart || !slideWidthEmu || !slideHeightEmu || !pageWidthPt) return
      const rect = event.currentTarget.getBoundingClientRect()
      const scale = slideWidthEmu / pageWidthPt
      const pointerScale = pageWidthPt / rect.width
      const x = Math.min(Math.max(0, (event.clientX - rect.left) * pointerScale), pageWidthPt - 80)
      const y = Math.min(Math.max(0, (event.clientY - rect.top) * pointerScale), slideHeightEmu / scale - 30)
      const width = Math.min(260, pageWidthPt - x)
      const height = Math.min(42, slideHeightEmu / scale - y)
      onPlace({ format: 'pptx', sequence: descriptor.sequence, chunkId: descriptor.chunkId, slidePart,
        xEmu: Math.round(x * scale), yEmu: Math.round(y * scale),
        widthEmu: Math.round(width * scale), heightEmu: Math.round(height * scale), fontSizePt: 18,
        left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` })
      return
    }
    if (!pageNumber || !pageWidthPt || !pageHeightPt) return
    const rect = event.currentTarget.getBoundingClientRect()
    const xPt = Math.min(Math.max(0, (event.clientX - rect.left) * pageWidthPt / rect.width), pageWidthPt - 60)
    const topPt = Math.min(Math.max(0, (event.clientY - rect.top) * pageWidthPt / rect.width), pageHeightPt - 24)
    const widthPt = Math.min(240, pageWidthPt - xPt)
    const heightPt = 18
    onPlace({ format: 'pdf', sequence: descriptor.sequence, page: pageNumber, xPt, yPt: pageHeightPt - topPt - heightPt, widthPt, heightPt,
      fontSizePt: 12, left: `${xPt}pt`, top: `${topPt}pt`, width: `${widthPt}pt`, height: `${heightPt}pt` })
  }
  // Fixed-page editors need same-origin DOM access for the portal; scripts stay disabled.
  const frameSandbox = ['pdf', 'pptx'].includes(session.format) ? 'allow-same-origin' : ''
  const scaledWidth = session.format === 'pptx' && sourceWidth > 0 ? Math.ceil(sourceWidth * zoom) : undefined
  const scaledHeight = session.format === 'pptx' ? Math.ceil(frameHeight * zoom) : frameHeight
  function effectiveNode(node: TextNode): TextNode {
    const doc = frame.current?.contentDocument
    const element = doc?.querySelector<HTMLElement>(`[data-hcd-id="${CSS.escape(node.nodeId)}"]`)
    if (!element || !doc?.defaultView) return node
    const computed = doc.defaultView.getComputedStyle(element)
    const rgb = computed.color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    const color = rgb ? `#${rgb.slice(1, 4).map(value => Number(value).toString(16).padStart(2, '0')).join('')}` : undefined
    return { ...node, fontFamily: computed.fontFamily || node.fontFamily, runFontSizePt: node.runFontSizePt || Number.parseFloat(computed.fontSize) * 3 / 4,
      runColor: node.runColor || color, shapeHorizontal: node.shapeHorizontal || (computed.textAlign === 'start' ? 'left' : computed.textAlign === 'end' ? 'right' : computed.textAlign) as PptxHorizontalAlign }
  }
  useEffect(() => { if (srcDoc) onNodesReady(descriptor.sequence, nodes.map(effectiveNode)) }, [nodes, srcDoc, descriptor.sequence, onNodesReady])
  return <div ref={marker} id={`hcd-page-${descriptor.sequence}`} className="fixed-page" style={{ minHeight: srcDoc ? scaledHeight : placeholderHeight, width: session.format === 'pptx' && srcDoc ? scaledWidth : session.format === 'pdf' && srcDoc ? canvasWidth : undefined }}>
    {chunkError && <p role="alert">{chunkError}</p>}
    <div className="fixed-canvas-slot" style={{ height: srcDoc ? scaledHeight : placeholderHeight }}>
    <div className="fixed-canvas-layer" style={{ width: session.format === 'pptx' && srcDoc ? canvasWidth : '100%', height: srcDoc ? frameHeight : placeholderHeight, transform: session.format === 'pptx' && srcDoc ? `scale(${zoom})` : undefined }}>
    {srcDoc ? <FixedPreviewFrame frame={frame} sandbox={frameSandbox} title={localizeDynamic(locale, `HCD 分片 ${descriptor.sequence + 1}`)} source={srcDoc} height={frameHeight} width={session.format === 'pptx' ? canvasWidth : undefined} onReady={() => { setFrameLocale(); findDirectTarget(); highlightSearchTarget() }} />
      : <div className="skeleton" style={{ minHeight: placeholderHeight }}>{localizeDynamic(locale, session.format === 'pptx' ? `幻灯片 ${descriptor.sequence + 1}` : `第 ${descriptor.sequence + 1} 个分片`)}</div>}
    {!readOnly && ['pdf', 'pptx'].includes(session.format) && selected && directTarget && createPortal(<div className="hcd-direct-editor"><FixedTextBoxEditor key={selected.nodeId} text={draft} disabled={saving} onChange={onDraft} onReady={onEditorReady} autoFocus={session.format === 'pptx' ? 'start' : true} onSave={value => onSave(selected, value)} onCancel={onCancel} /></div>, directTarget)}
    {!readOnly && newBox && newTarget && createPortal(<div className="hcd-direct-editor"><FixedTextBoxEditor text={newDraft} disabled={saving} onChange={onNewDraft} onReady={onEditorReady} autoFocus onSave={value => onSaveNew(newBox, value)} onCancel={onCancelNew} /></div>, newTarget)}
    {!readOnly && srcDoc && <div className={`fixed-page-hitboxes ${session.format === 'pdf' ? 'centered' : ''}`} style={{ width: canvasWidth }}>{nodes.filter(node => node.editable && node.left && node.top && node.width && node.height).map(node => selected?.nodeId === node.nodeId ? null : <button key={node.nodeId} className="fixed-page-hitbox" style={{ left: node.left, top: node.top, width: node.width, height: node.height }} aria-label={`${localizeDynamic(locale, "编辑文字：")}${node.text.slice(0, 48) || localizeDynamic(locale, "空文字框")}`} title={node.text || localizeDynamic(locale, '空文字框')} onClick={() => onSelect(effectiveNode(node))} onContextMenu={event => { event.preventDefault(); setAgentMenu({ x: event.clientX, y: event.clientY, node }) }} />)}
      {session.format === 'pptx' && selected?.geometry && directTarget && (() => {
        const geometry = previewGeometry || selected.geometry
        return <div className="pptx-shape-controls" style={{ left: emuToPx(geometry.xEmu), top: emuToPx(geometry.yEmu), width: emuToPx(geometry.widthEmu), height: emuToPx(geometry.heightEmu) }}>
          <button className="pptx-shape-move" aria-label={localizeSource(locale, "移动文字框")} title={localizeDynamic(locale, draft === selected.text ? '拖动文字框' : '请先保存文字修改')} disabled={saving || draft !== selected.text} onPointerDown={event => beginShapeDrag('move', event)} onPointerMove={moveShapeDrag} onPointerUp={event => finishShapeDrag(event)} onPointerCancel={event => finishShapeDrag(event, true)}>✥</button>
          <button className="pptx-shape-resize" aria-label={localizeSource(locale, "调整文字框大小")} title={localizeDynamic(locale, draft === selected.text ? '拖动以调整尺寸' : '请先保存文字修改')} disabled={saving || draft !== selected.text} onPointerDown={event => beginShapeDrag('resize', event)} onPointerMove={moveShapeDrag} onPointerUp={event => finishShapeDrag(event)} onPointerCancel={event => finishShapeDrag(event, true)} />
          {selected.createdInHcd && <button className="pptx-shape-delete" aria-label={localizeSource(locale, "删除 PPTX 文字框")} title={localizeDynamic(locale, draft === selected.text ? '删除文字框，可从修订历史查看旧版' : '请先保存文字修改')} disabled={saving || draft !== selected.text} onClick={event => { event.stopPropagation(); onPptxDelete(selected) }}>×</button>}
        </div>
      })()}
      {session.format === 'pdf' && selected?.pdfGeometry && directTarget && (() => {
        const geometry = previewPdfGeometry || selected.pdfGeometry!
        return <div className="pdf-text-controls" style={{ left: `${geometry.xPt}pt`, top: `${pageHeightPt - geometry.yPt - geometry.heightPt}pt`, width: `${geometry.widthPt}pt`, height: `${geometry.heightPt}pt` }}>
          <button className="pdf-text-move" aria-label={localizeSource(locale, "移动 PDF 文字框")} title={localizeDynamic(locale, draft === selected.text ? '拖动文字框' : '请先保存文字修改')} disabled={saving || draft !== selected.text} onPointerDown={event => beginPdfDrag('move', event)} onPointerMove={movePdfDrag} onPointerUp={event => finishPdfDrag(event)} onPointerCancel={event => finishPdfDrag(event, true)}>✥</button>
          <button className="pdf-text-resize" aria-label={localizeSource(locale, "调整 PDF 文字框大小")} title={localizeDynamic(locale, draft === selected.text ? '拖动以调整尺寸' : '请先保存文字修改')} disabled={saving || draft !== selected.text} onPointerDown={event => beginPdfDrag('resize', event)} onPointerMove={movePdfDrag} onPointerUp={event => finishPdfDrag(event)} onPointerCancel={event => finishPdfDrag(event, true)} />
          <button className="pdf-text-delete" aria-label={localizeSource(locale, "删除 PDF 文字框")} title={localizeDynamic(locale, draft === selected.text ? '删除文字框，可从修订历史查看旧版' : '请先保存文字修改')} disabled={saving || draft !== selected.text} onClick={event => { event.stopPropagation(); onPdfDelete(selected) }}>×</button>
        </div>
      })()}
      {placingText && primaryPage && <button className="fixed-placement-layer" aria-label={`在第 ${session.format === 'pdf' ? pageNumber : descriptor.sequence + 1} 页放置新文字框`} onClick={place} />}
    </div>}
    </div>
    </div>
    {!readOnly && nodes.some(node => node.editable && (!node.left || !node.top || !node.width || !node.height)) && <div className="fixed-text-panel"><strong><LocalText source={"第 "} />{descriptor.sequence + 1} <LocalText source={" 页未定位文字"} /></strong><div className="fixed-text-list">{nodes.filter(node => node.editable && (!node.left || !node.top || !node.width || !node.height)).map(node => <button key={node.nodeId} className={selected?.nodeId === node.nodeId ? 'selected' : ''} onClick={() => onSelect(effectiveNode(node))} title={node.nodeId}>{node.text || localizeDynamic(locale, '（空文字框）')}</button>)}</div>{selected && (!selected.left || !selected.top || !selected.width || !selected.height) && <div className="fixed-text-form"><FixedTextBoxEditor key={selected.nodeId} text={draft} disabled={saving} onChange={onDraft} onReady={onEditorReady} autoFocus onSave={value => onSave(selected, value)} onCancel={onCancel} /><div><button onClick={() => onSave(selected, draft)} disabled={saving || draft === selected.text}><LocalText source={"保存"} /></button><button onClick={onCancel}><LocalText source={"取消"} /></button></div></div>}</div>}
    {!readOnly && srcDoc && nodes.length === 0 && session.format === 'pdf' && <div className="fixed-text-panel"><LocalText source={"本页没有可映射的文字节点；扫描图像里的文字需要 OCR 后才能编辑。"} /></div>}
    {agentMenu && marker.current?.closest('.workspace') && createPortal(<ContextMenu title={session.format === 'pptx' ? '幻灯片内容' : '页面内容'} x={agentMenu.x} y={agentMenu.y} onClose={() => setAgentMenu(null)} actions={[
      { label: '用 Agent 修改文字…', accent: true, disabled: readOnly || saving, action: () => requestTask('只修改当前文字节点，保留其他对象与原有格式：', { nodeId: agentMenu.node.nodeId, chunkSequence: descriptor.sequence, format: session.format }) },
      { label: '润色选中文字框', disabled: readOnly || saving, action: () => requestTask('润色当前文字节点，保留原意、数字、日期和格式。仅修改此节点。', { nodeId: agentMenu.node.nodeId, chunkSequence: descriptor.sequence, format: session.format }) },
      { label: '编辑文字', disabled: readOnly || saving, action: () => onSelect(effectiveNode(agentMenu.node)) },
    ]} />, marker.current.closest('.workspace')!)}
  </div>
}
