import {
  BooleanNumber,
  createUniver,
  defaultTheme,
  LocaleType,
  type IWorkbookData,
} from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import zhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing';
import { HcdUniverAdapter } from './adapter.ts';
import type { HcdViewerMode } from './adapter.ts';
import { HcdBundleClient, hasStoredBlankMappingLimit } from './hcd.ts';
import { parseStyleCatalog } from './hcd-parser.ts';
import './app.css';

const status = document.querySelector<HTMLElement>('#status')!;
const bundleInput = document.querySelector<HTMLInputElement>('#bundle-url')!;
const loadButton = document.querySelector<HTMLButtonElement>('#load')!;
const modeSelect = document.querySelector<HTMLSelectElement>('#viewer-mode')!;
const params = new URLSearchParams(window.location.search);
bundleInput.value = params.get('bundle') ?? '/hcd/';
const mode: HcdViewerMode = params.get('mode') === 'editable' ? 'editable' : 'readonly';
modeSelect.value = mode;
document.body.dataset.hcdMode = mode;

function setStatus(message: string): void {
  if (message === 'workbookVisibleLoadFailed') message = '当前工作表区域加载失败，请滚动或重新打开以重试。';
  if (message === 'workbookVisibleLoaded') message = '当前工作表区域已加载。';
  if (message === 'workbookCellUnmapped') message = '此单元格尚不支持编辑，或数据还未加载。';
  if (message === 'workbookCellProtected') message = '此单元格受保护或包含公式，当前无法编辑。';
  if (message === 'workbookCellPending') message = '此单元格的修改正在等待确认，请稍后重试。';
  if (message === 'workbookUnsupportedFormula') message = '暂不支持保存公式，本次修改未应用。';
  if (message === 'workbookUnsupportedPaste') message = '选区中有无法编辑的单元格，本次修改未应用。';
  status.textContent = `${mode === 'editable' ? '可编辑' : '只读'} · ${message}`;
}

function reloadWithSelection(): void {
  const next = new URL(window.location.href);
  next.searchParams.set('bundle', bundleInput.value.trim() || '/hcd/');
  next.searchParams.set('mode', modeSelect.value);
  window.location.assign(next);
}

loadButton.addEventListener('click', reloadWithSelection);
modeSelect.addEventListener('change', reloadWithSelection);

async function boot(): Promise<void> {
  const client = new HcdBundleClient(bundleInput.value);
  await client.open();
  if (hasStoredBlankMappingLimit(client.manifest)) {
    const warning = document.createElement('p');
    warning.setAttribute('role', 'status');
    warning.textContent = '工作表过大，部分原有空单元格暂不能编辑；此处理不会修改原文件。';
    status.parentElement?.append(warning);
  }
  const styleCatalog = parseStyleCatalog(await client.readStyles());
  const sheets = client.sheets();
  if (!sheets.length) throw new Error('HCD bundle 不包含工作表');

  const workbookData: Partial<IWorkbookData> = {
    id: client.manifest.documentId,
    name: `HCD revision ${client.manifest.revision}`,
    appVersion: '0.25.1',
    locale: LocaleType.ZH_CN,
    styles: styleCatalog,
    sheetOrder: sheets.map((sheet) => sheet.sheetId),
    sheets: Object.fromEntries(sheets.map((sheet) => {
      const descriptors = client.descriptors.filter(({ grid }) => grid?.sheetId === sheet.sheetId);
      const defaults = client.sheetDefaults(sheet.sheetId);
      const rowCount = Math.min(1_048_576, Math.max(1_000, ...descriptors.map(({ grid }) => grid?.rowEnd ?? 1)));
      const columnCount = Math.min(16_384, Math.max(26, ...descriptors.map(({ grid }) => grid?.columnEnd ?? 1)));
      return [sheet.sheetId, {
        id: sheet.sheetId,
        name: sheet.sheetName,
        hidden: sheet.sheetState === 'visible' ? BooleanNumber.FALSE : BooleanNumber.TRUE,
        rowCount,
        columnCount,
        defaultColumnWidth: defaults.columnWidth,
        defaultRowHeight: defaults.rowHeight,
        freeze: { xSplit: 0, ySplit: 0, startRow: 0, startColumn: 0 },
        cellData: {},
        rowData: {},
        columnData: {},
        mergeData: [],
        showGridlines: BooleanNumber.TRUE,
        rightToLeft: BooleanNumber.FALSE,
      }];
    })),
    custom: {
      hcdDocumentId: client.manifest.documentId,
      hcdRevision: client.manifest.revision,
      hcdRootHash: client.manifest.rootHash,
    },
  };

  const { univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: zhCN },
    theme: defaultTheme,
    presets: [
      UniverSheetsCorePreset({
        container: 'app',
        header: mode === 'editable',
        toolbar: mode === 'editable',
        formulaBar: mode === 'editable',
        contextMenu: mode === 'editable',
        footer: {
          sheetBar: true,
          statisticBar: mode === 'editable',
          menus: mode === 'editable',
          zoomSlider: true,
          addSheetButtonConfig: { show: false },
        },
      }),
      UniverSheetsDrawingPreset(),
    ],
  });
  const workbook = univerAPI.createWorkbook(workbookData);
  const adapter = new HcdUniverAdapter(client, univerAPI, workbook, mode, setStatus);
  await adapter.start();

  window.hcdUniver = adapter;
  window.addEventListener('hcd-patch', ((event: CustomEvent) => {
    // Production integration sends event.detail.patch to the Java revision/CAS
    // endpoint, then calls acknowledgePatch() or rejectPatch().
    console.info('HCD patch ready', event.detail.patch);
  }) as EventListener);
  setStatus(`revision ${client.manifest.revision} · Canvas 虚拟化已启用`);
}

declare global {
  interface Window {
    hcdUniver?: HcdUniverAdapter;
  }
}

boot().catch((error: unknown) => {
  console.error(error);
  setStatus(error instanceof Error ? error.message : String(error));
});
