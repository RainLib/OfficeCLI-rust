import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import { api, type Session } from './api.ts'
import { FixedTextBoxEditor } from './FixedTextBoxEditor.tsx'
import { EditorHeader, EditorStatusbar, type EditorTab } from './EditorChrome.tsx'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { useFixedCollaboration } from './fixedCollaboration.tsx'

type Manifest = { chunkCount: number; indexPageCount: number; revision: number; source: { format: string } }
type Descriptor = { sequence: number; chunkId: string; region: string; continuation: boolean }
type PptxGeometry = { xEmu: number; yEmu: number; widthEmu: number; heightEmu: number }
type PdfGeometry = { xPt: number; yPt: number; widthPt: number; heightPt: number }
type TextNode = { nodeId: string; nodeHash: string; text: string; editable: boolean; createdInHcd?: boolean; left?: string; top?: string; width?: string; height?: string; geometry?: PptxGeometry; pdfGeometry?: PdfGeometry; fontSize?: string; fontFamily?: string; fontWeight?: string; fontStyle?: string; color?: string; lineHeight?: string }
type ShapeDrag = { pointerId: number; mode: 'move' | 'resize'; startX: number; startY: number; initial: PptxGeometry; current: PptxGeometry; shape: HTMLElement }
type PdfDrag = { pointerId: number; mode: 'move' | 'resize'; startX: number; startY: number; initial: PdfGeometry; current: PdfGeometry; shape: HTMLElement; pointsPerPixel: number }
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
) & { left: string; top: string; width: string; height: string }
type Revision = { revision: number; patchId?: string; authorName?: string; createdAtEpochMs?: number }

export function FixedViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [descriptors, setDescriptors] = useState<Descriptor[]>([])
  const [style, setStyle] = useState('')
  const [loadedPages, setLoadedPages] = useState(0)
  const [slideHeight, setSlideHeight] = useState(720)
  const [stageWidth, setStageWidth] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [readOnly, setReadOnly] = useState(session.scope === 'read')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [draft, setDraft] = useState('')
  const [newBox, setNewBox] = useState<NewTextBox | null>(null)
  const [newDraft, setNewDraft] = useState('')
  const [placingText, setPlacingText] = useState(false)
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null)
  const layoutScope = session.format === 'pptx' ? 'pptx' : ''
  const [layout, setLayout] = useState<LayoutPreferences>(() => readLayout(layoutScope))
  const [activeTab, setActiveTab] = useState<EditorTab>('home')
  const [rightPanel, setRightPanel] = useState<'settings' | 'revisions' | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [viewRevision, setViewRevision] = useState<number | null>(null)
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null)
  const tail = useRef<HTMLDivElement>(null)
  const pagesRef = useRef<HTMLElement>(null)
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
    if (saving || selected || newBox || viewRevision !== null) {
      setRemoteRevision(previous => Math.max(previous ?? 0, next))
      return
    }
    setManifest(previous => previous && ({ ...previous, revision: next }))
    setRefresh(previous => previous + 1)
  }
  const collaboration = useFixedCollaboration(session, manifest?.revision ?? null, showRemoteRevision)
  useEffect(() => {
    if (remoteRevision === null || saving || selected || newBox || viewRevision !== null) return
    if (remoteRevision > (manifest?.revision ?? -1)) showRemoteRevision(remoteRevision)
    setRemoteRevision(null)
  }, [remoteRevision, saving, selected, newBox, viewRevision, manifest?.revision])
  useEffect(() => { saveLayout(layout, layoutScope) }, [layout, layoutScope])
  const displayedRevision = viewRevision ?? manifest?.revision ?? null
  const historical = viewRevision !== null && viewRevision !== manifest?.revision
  const status = saving ? '保存中' : historical ? '历史只读' : remoteRevision ? '有新修订' : readOnly ? '只读' : (selected && draft !== selected.node.text) || (newBox && newDraft) ? '编辑中' : '已保存'
  function setLayoutOption(key: keyof LayoutPreferences, value: boolean) {
    setLayout(previous => ({ ...previous, [key]: value }))
  }
  async function select(selection: Selection) {
    if (selected?.node.nodeId === selection.node.nodeId) return
    if (newBox && newDraft.trim()) {
      const revision = await saveNewBox(newBox, newDraft)
      if (revision === null) return
    }
    if (selected && draft !== selected.node.text) {
      const revision = await saveText(selected.node, draft)
      if (revision === null) return
    }
    setSelected(selection)
    setDraft(selection.node.text)
    setNewBox(null)
    setPlacingText(false)
    setRightPanel(null)
  }
  useEffect(() => {
    let live = true
    Promise.all([api(session, '').then(response => response.json()), api(session, '/styles').then(response => response.text())])
      .then(([info, css]) => { if (live) { setManifest(info as Manifest); setStyle(css) } })
      .catch(cause => { if (live) setError(String(cause)) })
    return () => { live = false }
  }, [session])
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
    setSelected(null)
    setNewBox(null)
    setPlacingText(false)
  }, [viewRevision])
  useEffect(() => {
    if (!manifest || loadedPages >= manifest.indexPageCount) return
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
          setDescriptors(previous => [...previous, ...index.chunks])
          setLoadedPages(page + 1)
        }).catch(cause => { if (live) setError(String(cause)) })
    }, { rootMargin: '1600px' })
    observer.observe(marker)
    return () => { live = false; observer.disconnect() }
  }, [session, manifest, loadedPages, descriptors, viewRevision])
  async function saveText(node: TextNode, value: string): Promise<number | null> {
    if (readOnly || historical || !node.editable || saving) return null
    setSaving(true)
    setError('')
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
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setRefresh(previous => previous + 1)
      setSelected(null)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。如文档已被其他人修改，请重新打开。`); return null }
    finally { setSaving(false) }
  }
  async function saveGeometry(node: TextNode, geometry: PptxGeometry): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || !node.geometry || draft !== node.text) return null
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
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function savePdfGeometry(node: TextNode, geometry: PdfGeometry): Promise<number | null> {
    if (session.format !== 'pdf' || readOnly || historical || saving || !node.pdfGeometry || draft !== node.text) return null
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
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function deletePdfText(node: TextNode): Promise<number | null> {
    if (session.format !== 'pdf' || readOnly || historical || saving || !node.pdfGeometry || draft !== node.text) return null
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
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function deletePptxText(node: TextNode): Promise<number | null> {
    if (session.format !== 'pptx' || readOnly || historical || saving || !node.createdInHcd || draft !== node.text) return null
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
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setSelected(null)
      setRefresh(previous => previous + 1)
      return result.revision
    } catch (cause) { setError(`${String(cause)}。请重新选择文字框后重试。`); return null }
    finally { setSaving(false) }
  }
  async function saveBeforeExport(): Promise<number | null> {
    if (selected && draft !== selected.node.text && !readOnly && !historical) return saveText(selected.node, draft)
    if (newBox && newDraft.trim() && !readOnly && !historical) return saveNewBox(newBox, newDraft)
    return displayedRevision
  }
  async function closeEditor() {
    if (((selected && draft !== selected.node.text) || (newBox && newDraft.trim())) && await saveBeforeExport() === null) return
    onClose()
  }
  async function saveNewBox(box: NewTextBox, value: string): Promise<number | null> {
    if (!['pdf', 'pptx'].includes(session.format) || readOnly || historical || saving || !value.trim()) return null
    setSaving(true)
    setError('')
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
      setManifest(previous => previous && ({ ...previous, revision: result.revision }))
      collaboration.announceRevision(result.revision)
      setRefresh(previous => previous + 1)
      setNewBox(null)
      setNewDraft('')
      return result.revision
    } catch (cause) { setError(String(cause)); return null }
    finally { setSaving(false) }
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
  return <div className={`workspace semantic-workspace fixed-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''} ${layout.showOutline ? '' : 'outline-hidden'} ${rightPanel ? '' : 'right-hidden'}`}>
    {layout.showHeader && <EditorHeader session={session} revision={displayedRevision} status={status} activeTab={activeTab}
      onTab={tab => { setActiveTab(tab); setPlacingText(false); if (tab === 'revisions') setRightPanel('revisions') }} onClose={() => void closeEditor()}
      onSettings={() => setRightPanel(previous => previous === 'settings' ? null : 'settings')} settingsOpen={rightPanel === 'settings'} beforeExport={saveBeforeExport} presence={layout.showCollaborators ? collaboration.avatars : null} />}
    {!layout.showHeader && <button className="floating-settings" aria-label="界面设置" onClick={() => setRightPanel('settings')}>⚙ 界面设置</button>}
    {layout.showToolbar && <nav className="toolbar ribbon" aria-label="编辑工具栏">
      {activeTab === 'home' && <><div className="tool-group"><button disabled={!activeEditor || readOnly || historical} onClick={() => activeEditor && undo(activeEditor.state, activeEditor.view.dispatch)}>↶ 撤销</button><button disabled={!activeEditor || readOnly || historical} onClick={() => activeEditor && redo(activeEditor.state, activeEditor.view.dispatch)}>↷ 重做</button></div><span className="ribbon-note">{session.format === 'pptx' ? '点击文字原位编辑 · 选中后拖动顶部把手移动、右下角调整尺寸' : session.format === 'pdf' ? '点击文字原位编辑 · 新增文字框可拖动和调整尺寸 · ⌘/Ctrl + Enter 保存' : '点击页面文字即可原位编辑 · ⌘/Ctrl + Enter 保存 · Esc 取消'}</span></>}
      {activeTab === 'insert' && <><button className={placingText ? 'primary' : ''} disabled={!['pdf', 'pptx'].includes(session.format) || readOnly || historical || saving} onClick={() => void togglePlacement()}>{placingText ? '取消放置' : '新增文字框'}</button><span className="ribbon-note">{placingText ? '点击页面空白处放置文字框' : '新增文字框保留页面布局'}</span></>}
      {activeTab === 'view' && <><label className="mode"><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} />显示页面目录</label><label className="mode"><input type="checkbox" checked={readOnly || historical} disabled={session.scope === 'read' || historical} onChange={event => setReadOnly(event.target.checked)} />只读模式</label><button onClick={() => setRightPanel('settings')}>界面设置</button></>}
      {activeTab === 'revisions' && <><button onClick={() => setRightPanel('revisions')}>查看修订历史</button><span className="ribbon-note">当前版本 r{manifest?.revision ?? '…'}</span></>}
      {selected && !readOnly && !historical && <button className="primary save-trigger" disabled={saving || draft === selected.node.text} onClick={() => void saveText(selected.node, draft)}>保存修改</button>}
      {selected?.node.pdfGeometry && !readOnly && !historical && <button disabled={saving || draft !== selected.node.text} onClick={() => void deletePdfText(selected.node)}>删除文字框</button>}
      {session.format === 'pptx' && selected?.node.createdInHcd && !readOnly && !historical && <button disabled={saving || draft !== selected.node.text} onClick={() => void deletePptxText(selected.node)}>删除文字框</button>}
      {newBox && !readOnly && !historical && <button className="primary save-trigger" disabled={saving || !newDraft.trim()} onClick={() => void saveNewBox(newBox, newDraft)}>保存新增文字</button>}
    </nav>}
    <div className="layout editor-layout">
      {layout.showOutline && <aside className="outline-panel" aria-label={session.format === 'pptx' ? '幻灯片目录' : '页面目录'}><div className="panel-head"><h2>☷ {session.format === 'pptx' ? '幻灯片目录' : '页面目录'}</h2><button className="panel-close" aria-label="隐藏页面目录" onClick={() => setLayoutOption('showOutline', false)}>×</button></div><nav>{descriptors.map(chunk => <button key={chunk.sequence} onClick={() => document.getElementById(`hcd-page-${chunk.sequence}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>{session.format === 'pptx' ? `幻灯片 ${chunk.sequence + 1}` : `第 ${chunk.sequence + 1} 页`}</button>)}</nav><small>已索引 {descriptors.length} / {manifest?.chunkCount ?? '…'} 个分片</small></aside>}
      <div className="document-scroll"><main ref={pagesRef} className={`fixed-pages ${session.format === 'pptx' ? 'pptx-pages' : ''}`}>{descriptors.map(chunk => <LazyChunk key={`${viewRevision ?? 'head'}:${chunk.sequence}`} session={session} descriptor={chunk} revision={viewRevision} stylesheet={style} readOnly={readOnly || historical} selected={selected?.page === chunk.sequence ? selected.node : null} draft={draft} newBox={newBox} newDraft={newDraft} placingText={placingText} saving={saving} refresh={refresh} placeholderHeight={session.format === 'pptx' ? slideHeight : 900} availableWidth={stageWidth} onMeasureHeight={setSlideHeight} onSelect={node => void select({ node, page: chunk.sequence })} onDraft={setDraft} onEditorReady={setActiveEditor} onSave={(node, value) => void saveText(node, value)} onGeometry={saveGeometry} onPptxDelete={node => void deletePptxText(node)} onPdfGeometry={savePdfGeometry} onPdfDelete={node => void deletePdfText(node)} onCancel={() => setSelected(null)} onPlace={placeText} onNewDraft={setNewDraft} onSaveNew={(box, value) => void saveNewBox(box, value)} onCancelNew={() => setNewBox(null)} />)}<div ref={tail} className="load-tail" /></main></div>
      {rightPanel && <aside className="workspace-sidebar" aria-label={rightPanel === 'settings' ? '界面设置' : '修订历史'}>
        {rightPanel === 'settings' && <section className="appearance-panel"><div className="panel-head"><h2>界面设置</h2><button className="panel-close" aria-label="隐藏右侧栏" onClick={() => setRightPanel(null)}>×</button></div><label>显示顶部栏<input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label>显示操作栏<input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label>显示协作者<input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><label>显示页面目录<input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} /></label><fieldset><legend>头部布局</legend><label><input type="radio" name="fixed-header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} />紧凑</label><label><input type="radio" name="fixed-header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} />标准</label></fieldset><button className="open-revisions" onClick={() => setRightPanel('revisions')}>查看修订历史</button></section>}
        {rightPanel === 'revisions' && <section className="revision-panel"><div className="panel-head"><h2>◷ 修订历史</h2><button className="panel-close" aria-label="隐藏右侧栏" onClick={() => setRightPanel(null)}>×</button></div>{historical && <button onClick={() => setViewRevision(null)}>返回当前版本</button>}<div className="history">{revisions.slice().reverse().map(item => <button key={item.revision} onClick={() => setViewRevision(item.revision)}><span className="revision-avatar">{item.authorName?.slice(0, 1) || (item.revision === 0 ? '导' : '?')}</span><span className="revision-detail"><strong>r{item.revision}</strong><small>{item.authorName || (item.revision === 0 ? '初始导入' : '作者未记录')}</small><span>查看版本</span></span></button>)}</div></section>}
      </aside>}
    </div>
    <EditorStatusbar mode="页面视图" format={session.format} revision={displayedRevision} readOnly={readOnly || historical} status={status} />
    {error && <div className="toast error">{error}</div>}
  </div>
}

type LazyChunkProps = {
  session: Session; descriptor: Descriptor; revision: number | null; stylesheet: string; readOnly: boolean
  selected: TextNode | null; draft: string; newBox: NewTextBox | null; newDraft: string; placingText: boolean
  saving: boolean; refresh: number; placeholderHeight: number; availableWidth: number; onMeasureHeight: (height: number) => void
  onSelect: (node: TextNode) => void; onDraft: (value: string) => void
  onEditorReady: (editor: Editor | null) => void; onSave: (node: TextNode, value: string) => void
  onGeometry: (node: TextNode, geometry: PptxGeometry) => Promise<number | null>
  onPptxDelete: (node: TextNode) => void
  onPdfGeometry: (node: TextNode, geometry: PdfGeometry) => Promise<number | null>
  onPdfDelete: (node: TextNode) => void
  onCancel: () => void; onPlace: (box: NewTextBox) => void; onNewDraft: (value: string) => void
  onSaveNew: (box: NewTextBox, value: string) => void; onCancelNew: () => void
}

function LazyChunk({ session, descriptor, revision, stylesheet, readOnly, selected, draft, newBox, newDraft, placingText, saving, refresh, placeholderHeight, availableWidth, onMeasureHeight, onSelect, onDraft, onEditorReady, onSave, onGeometry, onPptxDelete, onPdfGeometry, onPdfDelete, onCancel, onPlace, onNewDraft, onSaveNew, onCancelNew }: LazyChunkProps) {
  const [active, setActive] = useState(false)
  const [srcDoc, setSrcDoc] = useState('')
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
  const frame = useRef<HTMLIFrameElement>(null)
  const drag = useRef<ShapeDrag | null>(null)
  const pdfDrag = useRef<PdfDrag | null>(null)
  const sourceWidth = Number.parseFloat(canvasWidth)
  const zoom = session.format === 'pptx' && sourceWidth > 0 && availableWidth > 0
    ? Math.min(1, availableWidth / sourceWidth) : 1
  useEffect(() => {
    if (session.format === 'pptx' && srcDoc) onMeasureHeight(Math.ceil(frameHeight * zoom))
  }, [session.format, srcDoc, frameHeight, zoom, onMeasureHeight])
  useEffect(() => { setPreviewGeometry(null); setPreviewPdfGeometry(null); drag.current = null; pdfDrag.current = null }, [selected?.nodeId, refresh])
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
    if (!active) { setSrcDoc(''); setNodes([]); return }
    let live = true
    const render = async () => {
      const chunk = await (await api(session, `/chunks/${descriptor.sequence}${revision === null ? '' : `?revision=${revision}`}`)).json() as { html: string; map: { entries: Array<{ nodeId: string; nodeHash: string; source: { nodeKind: string; editable: boolean; createdInHcd: boolean } }> } }
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
        }
      })
      const hashes = Array.from(new Set(Array.from(chunk.html.matchAll(/asset:\/\/sha256\/([0-9a-f]{64})/g), match => match[1])))
      if (hashes.length > 64) throw new Error(`分片 ${descriptor.sequence} 引用过多资产`)
      const assets = await Promise.all(hashes.map(async hash => {
        const blob = await (await api(session, `/assets/${hash}`)).blob()
        if (blob.size > 64 * 1024 * 1024) throw new Error('预览资产超过 64 MiB')
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(blob)
        })
        return [hash, dataUrl] as const
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
        setSrcDoc(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}${safeCss}${directCss}</style></head><body data-hcd-image-hitboxes="off" data-hcd-text-hitboxes="off">${html}</body></html>`)
      }
    }
    void render().catch(cause => { if (live) setSrcDoc(`<p style="padding:24px;color:#b33">${String(cause).replaceAll('<', '&lt;')}</p>`) })
    return () => { live = false }
  }, [active, session, descriptor.sequence, descriptor.continuation, revision, stylesheet, refresh, onMeasureHeight])
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
    const scale = slideWidthEmu / sourceWidth / zoom
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
      onPlace({ format: 'pptx', chunkId: descriptor.chunkId, slidePart,
        xEmu: Math.round(x * scale), yEmu: Math.round(y * scale),
        widthEmu: Math.round(width * scale), heightEmu: Math.round(height * scale), fontSizePt: 18,
        left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` })
      return
    }
    if (!pageNumber || !pageWidthPt || !pageHeightPt) return
    const rect = event.currentTarget.getBoundingClientRect()
    const xPt = Math.min(Math.max(0, (event.clientX - rect.left) * 0.75), pageWidthPt - 60)
    const topPt = Math.min(Math.max(0, (event.clientY - rect.top) * 0.75), pageHeightPt - 24)
    const widthPt = Math.min(240, pageWidthPt - xPt)
    const heightPt = 18
    onPlace({ format: 'pdf', page: pageNumber, xPt, yPt: pageHeightPt - topPt - heightPt, widthPt, heightPt,
      fontSizePt: 12, left: `${xPt}pt`, top: `${topPt}pt`, width: `${widthPt}pt`, height: `${heightPt}pt` })
  }
  // Fixed-page editors need same-origin DOM access for the portal; scripts stay disabled.
  const frameSandbox = ['pdf', 'pptx'].includes(session.format) ? 'allow-same-origin' : ''
  const scaledWidth = session.format === 'pptx' && sourceWidth > 0 ? Math.ceil(sourceWidth * zoom) : undefined
  const scaledHeight = session.format === 'pptx' ? Math.ceil(frameHeight * zoom) : frameHeight
  return <div ref={marker} id={`hcd-page-${descriptor.sequence}`} className="fixed-page" style={{ minHeight: srcDoc ? scaledHeight : placeholderHeight, width: session.format === 'pptx' && srcDoc ? scaledWidth : session.format === 'pdf' && srcDoc ? canvasWidth : undefined }}>
    <div className="fixed-canvas-slot" style={{ height: srcDoc ? scaledHeight : placeholderHeight }}>
    <div className="fixed-canvas-layer" style={{ width: session.format === 'pptx' && srcDoc ? canvasWidth : '100%', height: srcDoc ? frameHeight : placeholderHeight, transform: session.format === 'pptx' && srcDoc ? `scale(${zoom})` : undefined }}>
    {srcDoc ? <iframe ref={frame} sandbox={frameSandbox} title={`HCD 分片 ${descriptor.sequence + 1}`} srcDoc={srcDoc} loading="lazy" referrerPolicy="no-referrer" style={{ height: frameHeight, width: session.format === 'pptx' ? canvasWidth : undefined }} onLoad={findDirectTarget} />
      : <div className="skeleton" style={{ minHeight: placeholderHeight }}>{session.format === 'pptx' ? `幻灯片 ${descriptor.sequence + 1}` : `第 ${descriptor.sequence + 1} 个分片`}</div>}
    {!readOnly && ['pdf', 'pptx'].includes(session.format) && selected && directTarget && createPortal(<div className="hcd-direct-editor"><FixedTextBoxEditor key={selected.nodeId} text={draft} disabled={saving} onChange={onDraft} onReady={onEditorReady} autoFocus={session.format === 'pptx' ? 'start' : true} onSave={value => onSave(selected, value)} onCancel={onCancel} /></div>, directTarget)}
    {!readOnly && newBox && newTarget && createPortal(<div className="hcd-direct-editor"><FixedTextBoxEditor text={newDraft} disabled={saving} onChange={onNewDraft} onReady={onEditorReady} autoFocus onSave={value => onSaveNew(newBox, value)} onCancel={onCancelNew} /></div>, newTarget)}
    {!readOnly && srcDoc && <div className={`fixed-page-hitboxes ${session.format === 'pdf' ? 'centered' : ''}`} style={{ width: canvasWidth }}>{nodes.filter(node => node.editable && node.left && node.top && node.width && node.height).map(node => selected?.nodeId === node.nodeId ? null : <button key={node.nodeId} className="fixed-page-hitbox" style={{ left: node.left, top: node.top, width: node.width, height: node.height }} aria-label={`编辑文字：${node.text.slice(0, 48) || '空文字框'}`} title={node.text || '空文字框'} onClick={() => onSelect(node)} />)}
      {session.format === 'pptx' && selected?.geometry && directTarget && (() => {
        const geometry = previewGeometry || selected.geometry
        return <div className="pptx-shape-controls" style={{ left: emuToPx(geometry.xEmu), top: emuToPx(geometry.yEmu), width: emuToPx(geometry.widthEmu), height: emuToPx(geometry.heightEmu) }}>
          <button className="pptx-shape-move" aria-label="移动文字框" title={draft === selected.text ? '拖动文字框' : '请先保存文字修改'} disabled={saving || draft !== selected.text} onPointerDown={event => beginShapeDrag('move', event)} onPointerMove={moveShapeDrag} onPointerUp={event => finishShapeDrag(event)} onPointerCancel={event => finishShapeDrag(event, true)}>✥</button>
          <button className="pptx-shape-resize" aria-label="调整文字框大小" title={draft === selected.text ? '拖动以调整尺寸' : '请先保存文字修改'} disabled={saving || draft !== selected.text} onPointerDown={event => beginShapeDrag('resize', event)} onPointerMove={moveShapeDrag} onPointerUp={event => finishShapeDrag(event)} onPointerCancel={event => finishShapeDrag(event, true)} />
          {selected.createdInHcd && <button className="pptx-shape-delete" aria-label="删除 PPTX 文字框" title={draft === selected.text ? '删除文字框，可从修订历史查看旧版' : '请先保存文字修改'} disabled={saving || draft !== selected.text} onClick={event => { event.stopPropagation(); onPptxDelete(selected) }}>×</button>}
        </div>
      })()}
      {session.format === 'pdf' && selected?.pdfGeometry && directTarget && (() => {
        const geometry = previewPdfGeometry || selected.pdfGeometry!
        return <div className="pdf-text-controls" style={{ left: `${geometry.xPt}pt`, top: `${pageHeightPt - geometry.yPt - geometry.heightPt}pt`, width: `${geometry.widthPt}pt`, height: `${geometry.heightPt}pt` }}>
          <button className="pdf-text-move" aria-label="移动 PDF 文字框" title={draft === selected.text ? '拖动文字框' : '请先保存文字修改'} disabled={saving || draft !== selected.text} onPointerDown={event => beginPdfDrag('move', event)} onPointerMove={movePdfDrag} onPointerUp={event => finishPdfDrag(event)} onPointerCancel={event => finishPdfDrag(event, true)}>✥</button>
          <button className="pdf-text-resize" aria-label="调整 PDF 文字框大小" title={draft === selected.text ? '拖动以调整尺寸' : '请先保存文字修改'} disabled={saving || draft !== selected.text} onPointerDown={event => beginPdfDrag('resize', event)} onPointerMove={movePdfDrag} onPointerUp={event => finishPdfDrag(event)} onPointerCancel={event => finishPdfDrag(event, true)} />
          <button className="pdf-text-delete" aria-label="删除 PDF 文字框" title={draft === selected.text ? '删除文字框，可从修订历史查看旧版' : '请先保存文字修改'} disabled={saving || draft !== selected.text} onClick={event => { event.stopPropagation(); onPdfDelete(selected) }}>×</button>
        </div>
      })()}
      {placingText && primaryPage && <button className="fixed-placement-layer" aria-label={`在第 ${session.format === 'pdf' ? pageNumber : descriptor.sequence + 1} 页放置新文字框`} onClick={place} />}
    </div>}
    </div>
    </div>
    {!readOnly && nodes.some(node => node.editable && (!node.left || !node.top || !node.width || !node.height)) && <div className="fixed-text-panel"><strong>第 {descriptor.sequence + 1} 页未定位文字</strong><div className="fixed-text-list">{nodes.filter(node => node.editable && (!node.left || !node.top || !node.width || !node.height)).map(node => <button key={node.nodeId} className={selected?.nodeId === node.nodeId ? 'selected' : ''} onClick={() => onSelect(node)} title={node.nodeId}>{node.text || '（空文字框）'}</button>)}</div>{selected && (!selected.left || !selected.top || !selected.width || !selected.height) && <div className="fixed-text-form"><FixedTextBoxEditor key={selected.nodeId} text={draft} disabled={saving} onChange={onDraft} onReady={onEditorReady} autoFocus onSave={value => onSave(selected, value)} onCancel={onCancel} /><div><button onClick={() => onSave(selected, draft)} disabled={saving || draft === selected.text}>保存</button><button onClick={onCancel}>取消</button></div></div>}</div>}
    {!readOnly && srcDoc && nodes.length === 0 && session.format === 'pdf' && <div className="fixed-text-panel">本页没有可映射的文字节点；扫描图像里的文字需要 OCR 后才能编辑。</div>}
  </div>
}
