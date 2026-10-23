import { useEffect, useRef, useState } from 'react'
import { BooleanNumber, createUniver, defaultTheme, LocaleType, type IWorkbookData } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { HcdUniverAdapter } from '../../xlsx-univer-viewer/src/adapter.ts'
import { parseStyleCatalog } from '../../xlsx-univer-viewer/src/hcd-parser.ts'
import { ServiceGridClient } from './ServiceGridClient.ts'
import { ExportControl } from './ExportControl.tsx'
import { api, watchRevisions, type Session } from './api.ts'
import { LocaleSelect, useI18n, type EditorLocale } from './i18n.tsx'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'

function univerLocale(locale: EditorLocale): LocaleType {
  if (locale === 'zh-CN') return LocaleType.ZH_CN
  if (locale === 'zh-TW') return LocaleType.ZH_TW
  if (locale === 'zh-HK') return LocaleType.ZH_HK
  return LocaleType.EN_US
}

async function loadUniverMessages(locale: EditorLocale) {
  if (locale === 'zh-CN') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-CN'), import('@univerjs/preset-sheets-drawing/locales/zh-CN')])
    return { ...core.default, ...drawing.default }
  }
  if (locale === 'zh-TW') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-TW'), import('@univerjs/preset-sheets-drawing/locales/zh-TW')])
    return { ...core.default, ...drawing.default }
  }
  if (locale === 'zh-HK') {
    const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/zh-HK'), import('@univerjs/preset-sheets-drawing/locales/zh-HK')])
    return { ...core.default, ...drawing.default }
  }
  const [core, drawing] = await Promise.all([import('@univerjs/preset-sheets-core/locales/en-US'), import('@univerjs/preset-sheets-drawing/locales/en-US')])
  return { ...core.default, ...drawing.default }
}

export function UniverViewer({ session, onClose, embedded }: { session: Session; onClose: () => void; embedded: boolean }) {
  const { locale, t } = useI18n()
  const [revision, setRevision] = useState<number | null>(null)
  const [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const localPatches = useRef(new Set<string>())
  const [generation, setGeneration] = useState(0)
  const editable = session.scope === 'write'

  useEffect(() => {
    let alive = true
    const client = new ServiceGridClient(session, locale)
    let disposeUniver: (() => void) | undefined
    let onPatch: ((event: Event) => void) | undefined
    const stopWatch = new AbortController()
    let pendingSaves = 0
    let refreshPending = false
    const refreshWhenSaved = () => {
      if (alive && refreshPending && pendingSaves === 0) { refreshPending = false; setGeneration(value => value + 1) }
    }
    const boot = async () => {
      await client.open()
      const styleCatalog = parseStyleCatalog(await client.readStyles())
      const sheets = client.sheets()
      if (!sheets.length || !host.current || !alive) throw new Error(t('workbookNoSheets'))
      const localeType = univerLocale(locale)
      const localeMessages = await loadUniverMessages(locale)
      if (!alive || !host.current) return
      const workbookData: Partial<IWorkbookData> = {
        id: client.manifest.documentId,
        name: `HCD revision ${client.manifest.revision}`,
        appVersion: '0.25.1', locale: localeType, styles: styleCatalog,
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
        locale: localeType, locales: { [localeType]: localeMessages }, theme: defaultTheme,
        presets: [UniverSheetsCorePreset({
          container: host.current,
          header: false, toolbar: false, formulaBar: editable, contextMenu: false,
          footer: { sheetBar: true, statisticBar: false, menus: false, zoomSlider: true,
            addSheetButtonConfig: { show: false } },
        }), UniverSheetsDrawingPreset()],
      })
      disposeUniver = () => univer.dispose()
      const workbook = univerAPI.createWorkbook(workbookData)
      const adapter = new HcdUniverAdapter(client, univerAPI, workbook, editable ? 'editable' : 'readonly', () => {})
      onPatch = (event: Event) => {
        const patch = (event as CustomEvent<{ patch?: { patchId: string; baseRevision: number; operations: Array<{ nodeId: string; start: number; deleteCount: number; insertText: string; precondition: { nodeHash: string } }> } }>).detail?.patch
        if (!patch || !editable) return
        localPatches.current.add(patch.patchId)
        pendingSaves += 1
        void api(session, '/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: 'hcd-patch/1',
            documentId: session.documentId,
            patchId: patch.patchId,
            baseRevision: patch.baseRevision,
            operations: patch.operations.map(operation => ({
              op: 'text.splice',
              nodeId: operation.nodeId,
              start: operation.start,
              deleteCount: operation.deleteCount,
              insertText: operation.insertText,
              precondition: operation.precondition,
            })),
          }),
        }).then(response => response.json()).then((result: { revision: number; nodeHashes?: Record<string, string> }) => {
          if (!alive) return
          adapter.acknowledgePatch(patch.patchId, result.revision, result.nodeHashes ?? {})
          if (alive) setRevision(result.revision)
        }).catch(cause => { if (!alive) return; adapter.rejectPatch(patch.patchId, String(cause)); if (alive) setError(String(cause)) })
          .finally(() => { pendingSaves -= 1; localPatches.current.delete(patch.patchId); refreshWhenSaved() })
      }
      window.addEventListener('hcd-patch', onPatch)
      await adapter.start()
      if (!alive) return
      setRevision(client.manifest.revision)
      void watchRevisions(session, stopWatch.signal, event => {
        if (!alive || (event.patchId && localPatches.current.has(event.patchId))) return
        if (event.revision < client.manifest.revision) return
        if (event.reset || pendingSaves > 0) { refreshPending = true; refreshWhenSaved(); return }
        if (event.nodes.length) {
          for (const node of event.nodes) adapter.applyRemoteText(node.nodeId, node.text, node.nodeHash, event.revision)
          setRevision(event.revision)
          return
        }
        if (event.revision > client.manifest.revision) setGeneration(value => value + 1)
      }, status => { if (alive && (status === 'expired' || status === 'unavailable')) setError(t(status === 'expired' ? 'revisionSessionExpired' : 'revisionConnectionUnavailable')) }, { afterRevision: client.manifest.revision })
    }
    void boot().catch(cause => { if (alive) setError(String(cause)) })
    return () => {
      alive = false
      stopWatch.abort()
      if (onPatch) window.removeEventListener('hcd-patch', onPatch)
      disposeUniver?.()
      client.dispose()
    }
  }, [session, locale, t, editable, generation])

  return <div className={`workspace ${embedded ? 'embedded' : ''}`}>
    <header><div><span className="eyebrow">OfficeCLI / HCD / XLSX</span><h1>{t('workbookPreview')}</h1><small>{revision === null ? t('loadingWorkbook') : `r${revision} · ${t('canvasLoading')}`}</small></div>
      <div className="header-actions"><LocaleSelect /><ExportControl session={session} revision={revision} /><button className="ghost" onClick={onClose}>{t('close')}</button></div></header>
    <div className="viewer-controls"><span>Univer Canvas · {editable ? t('editable') : t('readOnly')}</span><span>{editable ? t('cellEdits') : t('sheetWindowLoading')}</span></div>
    <div ref={host} className="hcd-univer-host" />
    {error && <div className="toast error">{error}</div>}
  </div>
}
