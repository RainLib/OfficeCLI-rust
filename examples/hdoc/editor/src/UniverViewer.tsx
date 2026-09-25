import { useEffect, useRef, useState } from 'react'
import { BooleanNumber, createUniver, defaultTheme, LocaleType, type IWorkbookData } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { HcdUniverAdapter, type HcdPatchEventDetail } from '../../xlsx-univer-viewer/src/adapter.ts'
import { parseStyleCatalog } from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import { ServiceGridClient } from './ServiceGridClient.ts'
import { EditorHeader, EditorStatusbar, type EditorTab } from './EditorChrome.tsx'
import { readLayout, saveLayout, type LayoutPreferences } from './editorLayout.ts'
import { useFixedCollaboration } from './fixedCollaboration.tsx'
import { api, type Session } from './api.ts'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'

export function UniverViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const [status, setStatus] = useState('正在加载工作簿')
  const [revision, setRevision] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(session.scope === 'write')
  const [layout, setLayout] = useState<LayoutPreferences>(() => readLayout('xlsx'))
  const [activeTab, setActiveTab] = useState<EditorTab>('home')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [remoteRevision, setRemoteRevision] = useState<number | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const runtime = useRef<{ client: ServiceGridClient; adapter: HcdUniverAdapter } | null>(null)
  const syncing = useRef(false)
  const collaboration = useFixedCollaboration(session, revision, next => setRemoteRevision(previous => Math.max(previous ?? 0, next)))
  useEffect(() => { saveLayout(layout, 'xlsx') }, [layout])
  function setLayoutOption(key: keyof LayoutPreferences, value: boolean) {
    setLayout(previous => ({ ...previous, [key]: value }))
  }
  useEffect(() => {
    const current = runtime.current
    if (!current || remoteRevision === null || syncing.current) return
    if (remoteRevision <= current.client.manifest.revision) { setRemoteRevision(null); return }
    if (current.adapter.hasPendingPatch()) return
    syncing.current = true
    void current.adapter.refreshFromServer().then(refreshed => {
      if (!refreshed || runtime.current !== current) return
      setRevision(current.client.manifest.revision)
      setRemoteRevision(null)
      setError('')
    }).catch(cause => setError(`协作修订同步失败：${String(cause)}`)).finally(() => { syncing.current = false })
  }, [remoteRevision, revision, status])

  useEffect(() => {
    let alive = true
    const client = new ServiceGridClient(session)
    let disposeUniver: (() => void) | undefined
    let removePatchListener: (() => void) | undefined
    const boot = async () => {
      await client.open()
      const styleCatalog = parseStyleCatalog(await client.readStyles())
      const sheets = client.sheets()
      if (!sheets.length || !host.current || !alive) throw new Error('工作簿没有可显示的工作表')
      const workbookData: Partial<IWorkbookData> = {
        id: client.manifest.documentId,
        name: `HCD revision ${client.manifest.revision}`,
        appVersion: '0.25.1', locale: LocaleType.ZH_CN, styles: styleCatalog,
        sheetOrder: sheets.map(sheet => sheet.sheetId),
        sheets: Object.fromEntries(sheets.map(sheet => {
          const descriptors = client.descriptors.filter(({ grid }) => grid?.sheetId === sheet.sheetId)
          const defaults = client.sheetDefaults(sheet.sheetId)
          return [sheet.sheetId, {
            id: sheet.sheetId, name: sheet.sheetName,
            hidden: sheet.sheetState === 'visible' ? BooleanNumber.FALSE : BooleanNumber.TRUE,
            rowCount: Math.min(1_048_576, Math.max(1_000, ...descriptors.map(({ grid }) => grid?.rowEnd ?? 1))),
            columnCount: Math.min(16_384, Math.max(26, ...descriptors.map(({ grid }) => grid?.columnEnd ?? 1))),
            defaultColumnWidth: defaults.columnWidth, defaultRowHeight: defaults.rowHeight,
            freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
            cellData: {}, rowData: {}, columnData: {}, mergeData: [],
            showGridlines: BooleanNumber.TRUE, rightToLeft: BooleanNumber.FALSE,
          }]
        })),
        custom: { hcdDocumentId: client.manifest.documentId,
          hcdRevision: client.manifest.revision, hcdRootHash: client.manifest.rootHash },
      }
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: zhCN }, theme: defaultTheme,
        presets: [UniverSheetsCorePreset({
          container: host.current,
          header: false, toolbar: false, formulaBar: true, contextMenu: false,
          footer: { sheetBar: true, statisticBar: false, menus: false, zoomSlider: true,
            addSheetButtonConfig: { show: false } },
        }), UniverSheetsDrawingPreset()],
      })
      disposeUniver = () => univer.dispose()
      const workbook = univerAPI.createWorkbook(workbookData)
      const adapter = new HcdUniverAdapter(client, univerAPI, workbook, editing ? 'editable' : 'readonly', message => {
        if (alive) setStatus(message)
      })
      let saveQueue = Promise.resolve()
      const onPatch = (event: Event) => {
        const detail = (event as CustomEvent<HcdPatchEventDetail>).detail
        if (!detail || detail.patch.documentId !== session.documentId) return
        saveQueue = saveQueue.catch(() => {}).then(async () => {
          const patch = { ...detail.patch, baseRevision: client.manifest.revision }
          try {
            if (alive) setStatus('保存中…')
            const response = await api(session, '/node-patch', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...patch, operations: patch.operations.map(({ type, ...operation }) => ({ op: type, ...operation })) }),
            })
            const result = await response.json() as { revision: number }
            const hashes: Record<string, string> = {}
            for (let index = 0; index < patch.operations.length; index += 1) {
              const bytes = new TextEncoder().encode(detail.changes[index].newText)
              const digest = await crypto.subtle.digest('SHA-256', bytes)
              hashes[patch.operations[index].nodeId] = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
            }
            adapter.acknowledgePatch(patch.patchId, result.revision, hashes)
            collaboration.announceRevision(result.revision)
            if (alive) { setRevision(result.revision); setError('') }
            try { await client.open() } catch (cause) { if (alive) setError(`修订已保存，但索引刷新失败：${String(cause)}`) }
          } catch (cause) {
            adapter.rejectPatch(patch.patchId, '保存失败，已恢复单元格原值')
            if (alive) setError(`${String(cause)}。如其他人已更新，请重新打开文档。`)
          }
        })
      }
      window.addEventListener('hcd-patch', onPatch)
      removePatchListener = () => window.removeEventListener('hcd-patch', onPatch)
      await adapter.start()
      runtime.current = { client, adapter }
      if (alive) { setRevision(client.manifest.revision); setStatus(`revision ${client.manifest.revision} · Canvas 按视口加载`) }
    }
    void boot().catch(cause => { if (alive) setError(String(cause)) })
    return () => { alive = false; runtime.current = null; removePatchListener?.(); disposeUniver?.(); client.dispose() }
  }, [session, editing, collaboration.announceRevision])

  const headerStatus = error ? '保存失败' : status === '保存中…' ? '保存中' : revision === null ? '加载中' : editing ? '已保存' : '只读'
  return <div className={`workspace semantic-workspace univer-workspace ${embedded ? 'embedded' : ''} ${layout.compact ? 'compact-header' : ''}`}>
    {layout.showHeader && <EditorHeader session={session} revision={revision} status={headerStatus} activeTab={activeTab}
      onTab={setActiveTab} onClose={onClose} onSettings={() => setSettingsOpen(previous => !previous)} settingsOpen={settingsOpen} presence={layout.showCollaborators ? collaboration.avatars : null} />}
    {!layout.showHeader && <button className="floating-settings" aria-label="界面设置" onClick={() => setSettingsOpen(true)}>⚙ 界面设置</button>}
    {layout.showToolbar && <nav className="toolbar ribbon" aria-label="工作簿工具栏">
      {activeTab === 'home' && <><span className="ribbon-note">双击单元格或按 F2 编辑 · 支持现有单元格内容</span><span className="ribbon-note">{status}</span></>}
      {activeTab === 'insert' && <span className="ribbon-note">当前工作簿支持编辑已有单元格；插入行列与合并单元格尚未接入 HCD 修订。</span>}
      {activeTab === 'view' && <><label className="mode"><input type="checkbox" checked={!editing} disabled={session.scope === 'read'} onChange={event => setEditing(!event.target.checked)} />只读模式</label><button onClick={() => setSettingsOpen(true)}>界面设置</button></>}
      {activeTab === 'revisions' && <span className="ribbon-note">当前修订 r{revision ?? '…'} · 每次单元格保存生成 HCD 修订</span>}
    </nav>}
    <div className="univer-editor-area"><div ref={host} className="hcd-univer-host" />
      {settingsOpen && <aside className="workspace-sidebar" aria-label="界面设置"><section className="appearance-panel"><div className="panel-head"><h2>界面设置</h2><button className="panel-close" aria-label="隐藏右侧栏" onClick={() => setSettingsOpen(false)}>×</button></div><label>显示顶部栏<input type="checkbox" checked={layout.showHeader} onChange={event => setLayoutOption('showHeader', event.target.checked)} /></label><label>显示操作栏<input type="checkbox" checked={layout.showToolbar} onChange={event => setLayoutOption('showToolbar', event.target.checked)} /></label><label>显示协作者<input type="checkbox" checked={layout.showCollaborators} onChange={event => setLayoutOption('showCollaborators', event.target.checked)} /></label><fieldset><legend>头部布局</legend><label><input type="radio" name="xlsx-header-density" checked={layout.compact} onChange={() => setLayoutOption('compact', true)} />紧凑</label><label><input type="radio" name="xlsx-header-density" checked={!layout.compact} onChange={() => setLayoutOption('compact', false)} />标准</label></fieldset></section></aside>}
    </div>
    <EditorStatusbar mode="工作簿视图" format="xlsx" revision={revision} readOnly={!editing} status={editing ? headerStatus : '已同步'} />
    {error && <div className="toast error">{error}</div>}
  </div>
}
