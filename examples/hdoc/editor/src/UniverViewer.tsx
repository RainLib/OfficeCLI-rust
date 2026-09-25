import { useEffect, useRef, useState } from 'react'
import { BooleanNumber, createUniver, defaultTheme, LocaleType, type IWorkbookData } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { HcdUniverAdapter, type HcdPatchEventDetail } from '../../xlsx-univer-viewer/src/adapter.ts'
import { parseStyleCatalog } from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import { ServiceGridClient } from './ServiceGridClient.ts'
import { ExportControl } from './ExportControl.tsx'
import { api, type Session } from './api.ts'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'

export function UniverViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const [status, setStatus] = useState('正在加载工作簿')
  const [revision, setRevision] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(session.scope === 'write')
  const host = useRef<HTMLDivElement>(null)

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
          header: false, toolbar: false, formulaBar: false, contextMenu: false,
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
      if (alive) { setRevision(client.manifest.revision); setStatus(`revision ${client.manifest.revision} · Canvas 按视口加载`) }
    }
    void boot().catch(cause => { if (alive) setError(String(cause)) })
    return () => { alive = false; removePatchListener?.(); disposeUniver?.(); client.dispose() }
  }, [session, editing])

  return <div className={`workspace ${embedded ? 'embedded' : ''}`}>
    <header><div><span className="eyebrow">OfficeCLI / HCD / XLSX</span><h1>工作簿编辑器</h1><small>{status}</small></div>
      <div className="header-actions"><ExportControl session={session} revision={revision} /><button className="ghost" onClick={onClose}>关闭</button></div></header>
    <div className="viewer-controls"><span>Univer Canvas · {editing ? '可编辑' : '只读'} · 仅现有单元格内容</span><span>按工作表与可见行窗口加载</span>{session.scope === 'write' && <label><input type="checkbox" checked={!editing} onChange={event => setEditing(!event.target.checked)} />只读模式</label>}</div>
    <div ref={host} className="hcd-univer-host" />
    {error && <div className="toast error">{error}</div>}
  </div>
}
