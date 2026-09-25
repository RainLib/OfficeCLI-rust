import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'
import { redo, undo } from '@tiptap/pm/history'
import { api, type Session } from './api.ts'
import { FixedTextBoxEditor } from './FixedTextBoxEditor.tsx'
import { EditorHeader, EditorStatusbar, type EditorTab } from './EditorChrome.tsx'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { useFixedCollaboration } from './fixedCollaboration.tsx'

type Manifest = { chunkCount: number; indexPageCount: number; revision: number; source: { format: string } }
type Descriptor = { sequence: number; region: string }
type TextNode = { nodeId: string; nodeHash: string; text: string; editable: boolean; left?: string; top?: string; width?: string; height?: string; fontSize?: string; fontFamily?: string; fontWeight?: string; fontStyle?: string; color?: string; lineHeight?: string }
type Selection = { node: TextNode; page: number }
type NewTextBox = { page: number; xPt: number; yPt: number; widthPt: number; heightPt: number; fontSizePt: number; left: string; top: string; width: string; height: string }
type Revision = { revision: number; patchId?: string; authorName?: string; createdAtEpochMs?: number }

export function FixedViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [descriptors, setDescriptors] = useState<Descriptor[]>([])
  const [style, setStyle] = useState('')
  const [loadedPages, setLoadedPages] = useState(0)
  const [slideHeight, setSlideHeight] = useState(720)
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
    if (session.format !== 'pdf' || readOnly || historical || saving || !value.trim()) return null
    setSaving(true)
    setError('')
    try {
      const response = await api(session, '/node-patch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 'hcd-patch/5', documentId: session.documentId,
          patchId: crypto.randomUUID(), baseRevision: manifest?.revision,
          actor: { client: 'officecli-hcd-fixed-editor' }, metadata: {},
          operations: [{ op: 'pdf.text.insert', page: box.page, xPt: box.xPt, yPt: box.yPt,
            widthPt: box.widthPt, heightPt: box.heightPt, fontSizePt: box.fontSizePt, text: value }] }),
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
      {activeTab === 'home' && <><div className="tool-group"><button disabled={!activeEditor || readOnly || historical} onClick={() => activeEditor && undo(activeEditor.state, activeEditor.view.dispatch)}>↶ 撤销</button><button disabled={!activeEditor || readOnly || historical} onClick={() => activeEditor && redo(activeEditor.state, activeEditor.view.dispatch)}>↷ 重做</button></div><span className="ribbon-note">点击页面文字即可原位编辑 · ⌘/Ctrl + Enter 保存 · Esc 取消</span></>}
      {activeTab === 'insert' && <><button className={placingText ? 'primary' : ''} disabled={session.format !== 'pdf' || readOnly || historical || saving} onClick={() => void togglePlacement()}>{placingText ? '取消放置' : '新增文字框'}</button><span className="ribbon-note">{placingText ? '点击 PDF 页面的空白处放置文字框' : '新增文字框保留固定页布局'}</span></>}
      {activeTab === 'view' && <><label className="mode"><input type="checkbox" checked={layout.showOutline} onChange={event => setLayoutOption('showOutline', event.target.checked)} />显示页面目录</label><label className="mode"><input type="checkbox" checked={readOnly || historical} disabled={session.scope === 'read' || historical} onChange={event => setReadOnly(event.target.checked)} />只读模式</label><button onClick={() => setRightPanel('settings')}>界面设置</button></>}
      {activeTab === 'revisions' && <><button onClick={() => setRightPanel('revisions')}>查看修订历史</button><span className="ribbon-note">当前版本 r{manifest?.revision ?? '…'}</span></>}
      {selected && !readOnly && !historical && <button className="primary save-trigger" disabled={saving || draft === selected.node.text} onClick={() => void saveText(selected.node, draft)}>保存修改</button>}
      {newBox && !readOnly && !historical && <button className="primary save-trigger" disabled={saving || !newDraft.trim()} onClick={() => void saveNewBox(newBox, newDraft)}>保存新增文字</button>}
    </nav>}
    <div className="layout editor-layout">
      {layout.showOutline && <aside className="outline-panel" aria-label={session.format === 'pptx' ? '幻灯片目录' : '页面目录'}><div className="panel-head"><h2>☷ {session.format === 'pptx' ? '幻灯片目录' : '页面目录'}</h2><button className="panel-close" aria-label="隐藏页面目录" onClick={() => setLayoutOption('showOutline', false)}>×</button></div><nav>{descriptors.map(chunk => <button key={chunk.sequence} onClick={() => document.getElementById(`hcd-page-${chunk.sequence}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>{session.format === 'pptx' ? `幻灯片 ${chunk.sequence + 1}` : `第 ${chunk.sequence + 1} 页`}</button>)}</nav><small>已索引 {descriptors.length} / {manifest?.chunkCount ?? '…'} 个分片</small></aside>}
      <div className="document-scroll"><main className="fixed-pages">{descriptors.map(chunk => <LazyChunk key={`${viewRevision ?? 'head'}:${chunk.sequence}`} session={session} descriptor={chunk} revision={viewRevision} stylesheet={style} readOnly={readOnly || historical} selected={selected?.page === chunk.sequence ? selected.node : null} draft={draft} newBox={newBox} newDraft={newDraft} placingText={placingText} saving={saving} refresh={refresh} placeholderHeight={session.format === 'pptx' ? slideHeight : 900} onMeasureHeight={setSlideHeight} onSelect={node => void select({ node, page: chunk.sequence })} onDraft={setDraft} onEditorReady={setActiveEditor} onSave={(node, value) => void saveText(node, value)} onCancel={() => setSelected(null)} onPlace={placeText} onNewDraft={setNewDraft} onSaveNew={(box, value) => void saveNewBox(box, value)} onCancelNew={() => setNewBox(null)} />)}<div ref={tail} className="load-tail" /></main></div>
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
  saving: boolean; refresh: number; placeholderHeight: number; onMeasureHeight: (height: number) => void
  onSelect: (node: TextNode) => void; onDraft: (value: string) => void
  onEditorReady: (editor: Editor | null) => void; onSave: (node: TextNode, value: string) => void
  onCancel: () => void; onPlace: (box: NewTextBox) => void; onNewDraft: (value: string) => void
  onSaveNew: (box: NewTextBox, value: string) => void; onCancelNew: () => void
}

function LazyChunk({ session, descriptor, revision, stylesheet, readOnly, selected, draft, newBox, newDraft, placingText, saving, refresh, placeholderHeight, onMeasureHeight, onSelect, onDraft, onEditorReady, onSave, onCancel, onPlace, onNewDraft, onSaveNew, onCancelNew }: LazyChunkProps) {
  const [active, setActive] = useState(false)
  const [srcDoc, setSrcDoc] = useState('')
  const [frameHeight, setFrameHeight] = useState(940)
  const [canvasWidth, setCanvasWidth] = useState('100%')
  const [pageNumber, setPageNumber] = useState(0)
  const [pageHeightPt, setPageHeightPt] = useState(0)
  const [primaryPage, setPrimaryPage] = useState(false)
  const [nodes, setNodes] = useState<TextNode[]>([])
  const [directTarget, setDirectTarget] = useState<HTMLElement | null>(null)
  const [newTarget, setNewTarget] = useState<HTMLElement | null>(null)
  const marker = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
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
    if (session.format !== 'pdf' || !newBox || !primaryPage || newBox.page !== pageNumber) {
      setNewTarget(null)
      return
    }
    const page = frame.current?.contentDocument?.querySelector<HTMLElement>('.hcd-pdf-page[data-hcd-continuation="false"]')
    if (!page) return
    const target = page.ownerDocument.createElement('p')
    target.className = 'hcd-pdf-text hcd-draft-text'
    Object.assign(target.style, {
      position: 'absolute', left: newBox.left, top: newBox.top, width: newBox.width,
      height: newBox.height, fontSize: `${newBox.fontSizePt}pt`,
      fontFamily: 'Arial, Helvetica, sans-serif', lineHeight: newBox.height,
    })
    page.append(target)
    setNewTarget(target)
    return () => target.remove()
  }, [session.format, newBox, primaryPage, pageNumber, srcDoc])
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
      const chunk = await (await api(session, `/chunks/${descriptor.sequence}${revision === null ? '' : `?revision=${revision}`}`)).json() as { html: string; map: { entries: Array<{ nodeId: string; nodeHash: string; source: { nodeKind: string; editable: boolean } }> } }
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
          text: element?.textContent || '', editable: entry.source.editable,
          left: position?.left, top: position?.top, width, height: position?.height,
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
        setPrimaryPage(canvas?.getAttribute('data-hcd-continuation') === 'false')
        const canvasHeight = canvas?.style.height || ''
        if (canvasHeight.endsWith('pt')) setFrameHeight(Math.max(200, Math.ceil(Number.parseFloat(canvasHeight) * 4 / 3) + 4))
        if (canvasHeight.endsWith('px')) {
          const height = Math.max(200, Math.ceil(Number.parseFloat(canvasHeight)) + 4)
          setFrameHeight(height)
          if (session.format === 'pptx') onMeasureHeight(height)
        }
        const directCss = session.format === 'pdf' ? `.hcd-pdf-page[data-hcd-source-raster="true"] .hcd-pdf-text:has(>.hcd-direct-editor),.hcd-draft-text{background:#fff!important;color:#111!important;z-index:4;outline:1px solid #1769e8;outline-offset:1px}.hcd-pdf-text:has(>.hcd-direct-editor)>span[data-hcd-id]{display:none}.hcd-direct-editor{display:block;width:100%;min-width:max-content;font:inherit;line-height:inherit;color:inherit;white-space:nowrap}.hcd-direct-editor .fixed-tiptap-text{outline:0;min-height:inherit;padding:0;margin:0;font:inherit;line-height:inherit;color:inherit;white-space:nowrap}.hcd-direct-editor .fixed-tiptap-text p{position:static!important;margin:0;padding:0;font:inherit;line-height:inherit;color:inherit;white-space:nowrap}` : session.format === 'pptx' ? `.hcd-slide [data-hcd-id]:has(>.hcd-direct-editor){font-size:0!important;line-height:0!important;outline:1px solid #1769e8;outline-offset:2px}.hcd-slide .hcd-direct-editor{display:inline-block;vertical-align:baseline;font-size:var(--hcd-edit-font-size)!important;line-height:var(--hcd-edit-line-height)!important;color:var(--hcd-edit-color)!important;white-space:pre-wrap}.hcd-slide .hcd-direct-editor .fixed-tiptap-text,.hcd-slide .hcd-direct-editor .fixed-tiptap-text p{display:inline;margin:0;padding:0;min-height:0;outline:0;font:inherit;line-height:inherit;color:inherit;white-space:pre-wrap}` : ''
        setSrcDoc(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}${safeCss}${directCss}</style></head><body data-hcd-image-hitboxes="off" data-hcd-text-hitboxes="off">${html}</body></html>`)
      }
    }
    void render().catch(cause => { if (live) setSrcDoc(`<p style="padding:24px;color:#b33">${String(cause).replaceAll('<', '&lt;')}</p>`) })
    return () => { live = false }
  }, [active, session, descriptor.sequence, revision, stylesheet, refresh, onMeasureHeight])
  function place(event: MouseEvent<HTMLButtonElement>) {
    const pageWidthPt = Number.parseFloat(canvasWidth)
    if (!pageNumber || !pageWidthPt || !pageHeightPt) return
    const rect = event.currentTarget.getBoundingClientRect()
    const xPt = Math.min(Math.max(0, (event.clientX - rect.left) * 0.75), pageWidthPt - 60)
    const topPt = Math.min(Math.max(0, (event.clientY - rect.top) * 0.75), pageHeightPt - 24)
    const widthPt = Math.min(240, pageWidthPt - xPt)
    const heightPt = 18
    onPlace({ page: pageNumber, xPt, yPt: pageHeightPt - topPt - heightPt, widthPt, heightPt,
      fontSizePt: 12, left: `${xPt}pt`, top: `${topPt}pt`, width: `${widthPt}pt`, height: `${heightPt}pt` })
  }
  // Fixed-page editors need same-origin DOM access for the portal; scripts stay disabled.
  const frameSandbox = ['pdf', 'pptx'].includes(session.format) ? 'allow-same-origin' : ''
  return <div ref={marker} id={`hcd-page-${descriptor.sequence}`} className="fixed-page" style={{ minHeight: srcDoc ? frameHeight : placeholderHeight, width: session.format === 'pdf' && srcDoc ? canvasWidth : undefined }}>
    {srcDoc ? <iframe ref={frame} sandbox={frameSandbox} title={`HCD 分片 ${descriptor.sequence + 1}`} srcDoc={srcDoc} loading="lazy" referrerPolicy="no-referrer" style={{ height: frameHeight }} onLoad={findDirectTarget} />
      : <div className="skeleton" style={{ minHeight: placeholderHeight }}>{session.format === 'pptx' ? `幻灯片 ${descriptor.sequence + 1}` : `第 ${descriptor.sequence + 1} 个分片`}</div>}
    {!readOnly && ['pdf', 'pptx'].includes(session.format) && selected && directTarget && createPortal(<div className="hcd-direct-editor"><FixedTextBoxEditor key={selected.nodeId} text={draft} disabled={saving} onChange={onDraft} onReady={onEditorReady} autoFocus={session.format === 'pptx' ? 'start' : true} onSave={value => onSave(selected, value)} onCancel={onCancel} /></div>, directTarget)}
    {!readOnly && session.format === 'pdf' && newBox && newTarget && createPortal(<div className="hcd-direct-editor"><FixedTextBoxEditor text={newDraft} disabled={saving} onChange={onNewDraft} onReady={onEditorReady} autoFocus onSave={value => onSaveNew(newBox, value)} onCancel={onCancelNew} /></div>, newTarget)}
    {!readOnly && srcDoc && <div className={`fixed-page-hitboxes ${session.format === 'pdf' ? 'centered' : ''}`} style={{ width: canvasWidth }}>{nodes.filter(node => node.editable && node.left && node.top && node.width && node.height).map(node => selected?.nodeId === node.nodeId ? null : <button key={node.nodeId} className="fixed-page-hitbox" style={{ left: node.left, top: node.top, width: node.width, height: node.height }} aria-label={`编辑文字：${node.text.slice(0, 48) || '空文字框'}`} title={node.text || '空文字框'} onClick={() => onSelect(node)} />)}
      {placingText && session.format === 'pdf' && primaryPage && <button className="fixed-placement-layer" aria-label={`在第 ${pageNumber} 页放置新文字框`} onClick={place} />}
    </div>}
    {!readOnly && nodes.some(node => node.editable && (!node.left || !node.top || !node.width || !node.height)) && <div className="fixed-text-panel"><strong>第 {descriptor.sequence + 1} 页未定位文字</strong><div className="fixed-text-list">{nodes.filter(node => node.editable && (!node.left || !node.top || !node.width || !node.height)).map(node => <button key={node.nodeId} className={selected?.nodeId === node.nodeId ? 'selected' : ''} onClick={() => onSelect(node)} title={node.nodeId}>{node.text || '（空文字框）'}</button>)}</div>{selected && (!selected.left || !selected.top || !selected.width || !selected.height) && <div className="fixed-text-form"><FixedTextBoxEditor key={selected.nodeId} text={draft} disabled={saving} onChange={onDraft} onReady={onEditorReady} autoFocus onSave={value => onSave(selected, value)} onCancel={onCancel} /><div><button onClick={() => onSave(selected, draft)} disabled={saving || draft === selected.text}>保存</button><button onClick={onCancel}>取消</button></div></div>}</div>}
    {!readOnly && srcDoc && nodes.length === 0 && session.format === 'pdf' && <div className="fixed-text-panel">本页没有可映射的文字节点；扫描图像里的文字需要 OCR 后才能编辑。</div>}
  </div>
}
