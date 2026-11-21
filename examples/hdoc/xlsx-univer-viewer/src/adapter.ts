import type { LoadedChunk } from './hcd';
import type { FUniver, ICellData, IObjectMatrixPrimitiveType, IRange, IStyleData } from '@univerjs/presets';
import { CellValueType, LifecycleStages } from '@univerjs/presets';
import type { FWorkbook, FWorksheet, IScrollState } from '@univerjs/preset-sheets-core';
import { ScrollToRangeOperation, SetFormulaCalculationResultMutation, SetRangeValuesMutation, SetScrollOperation } from '@univerjs/preset-sheets-core';
import { HcdBundleClient, pivotContains, pivotRange, type ChunkDescriptor } from './hcd.ts';
import { PivotProjection } from './pivot-projection.ts';
import { parseGridChunk, type NodeLink, type ParsedGridChunk, type ParsedVisual } from './hcd-parser.ts';
import { documentFromInlineRuns, editedInlineRuns, validateInlineRuns, type XlsxInlineRun } from './rich-text.ts';

export interface HcdXlsxRichTextSet {
  type: 'xlsx.richText.set';
  nodeId: string;
  runs: XlsxInlineRun[];
  precondition: { nodeHash: string };
}

export interface HcdXlsxRichTextCreate {
  type: 'xlsx.richText.create'; sheetId: string; row: number; column: number; runs: XlsxInlineRun[];
}

export interface HcdTextSplice {
  type: 'text.splice';
  nodeId: string;
  start: number;
  deleteCount: number;
  insertText: string;
  precondition: { nodeHash: string };
}

export interface HcdXlsxCellSet {
  type: 'xlsx.cell.set';
  sheetId: string;
  row: number;
  column: number;
  text: string;
}

export interface HcdXlsxFormulaSet {
  type: 'xlsx.formula.set';
  nodeId: string;
  sheetId: string;
  formula: string;
  precondition: { nodeHash: string };
}

export interface HcdXlsxFormulaToValue {
  type: 'xlsx.formula.to-value';
  nodeId: string;
  sheetId: string;
  text: string;
  precondition: { nodeHash: string };
}

export interface HcdXlsxFormulaToNumber {
  type: 'xlsx.formula.to-number';
  nodeId: string;
  sheetId: string;
  value: string;
  precondition: { nodeHash: string };
}

export interface HcdXlsxNumberSet {
  type: 'xlsx.number.set';
  nodeId: string;
  sheetId: string;
  value: string;
  precondition: { nodeHash: string };
}

export interface HcdXlsxFormulaCreate {
  type: 'xlsx.formula.create';
  sheetId: string;
  row: number;
  column: number;
  formula: string;
}

export interface HcdPatchBatch {
  schemaVersion: 'hcd-patch/1' | 'hcd-patch/7' | 'hcd-patch/19' | 'hcd-patch/20' | 'hcd-patch/21' | 'hcd-patch/22' | 'hcd-patch/28' | 'hcd-patch/29' | 'hcd-patch/49' | 'hcd-patch/50';
  documentId: string;
  patchId: string;
  baseRevision: number;
  actor: Record<string, string>;
  operations: Array<HcdTextSplice | HcdXlsxRichTextSet | HcdXlsxRichTextCreate | HcdXlsxCellSet | HcdXlsxFormulaSet | HcdXlsxFormulaCreate | HcdXlsxFormulaToValue | HcdXlsxFormulaToNumber | HcdXlsxNumberSet>;
  metadata: Record<string, string>;
}

export interface HcdPatchEventDetail {
  patch: HcdPatchBatch;
  changes: Array<{ sheetId: string; row: number; column: number; oldText: string; newText: string; nodeId?: string }>;
}

export type HcdViewerMode = 'readonly' | 'editable';

interface PendingPatch {
  links: NodeLink[];
  previous: Array<string | number>;
  blanks: Array<{ sheetId: string; row: number; column: number }>;
  convertedFormulaIds: Set<string>;
  convertedNumberValues: Map<string, string>;
  formulaUpdates: Map<string, string>;
  richUpdates: Map<string, XlsxInlineRun[]>;
}

interface ChunkRuntime {
  sheetId: string;
  kind: 'cells' | 'picture' | 'chart';
  cells: Array<{ row: number; column: number; link?: NodeLink; blank: boolean }>;
  rows: number[];
  visualIds: string[];
}

interface SheetDimensions {
  defaultColumnWidth: number;
  defaultRowHeight: number;
  columns: Map<number, number>;
  rows: Map<number, number>;
}

function cellKey(sheetId: string, row: number, column: number): string {
  return `${sheetId}:${row}:${column}`;
}

function restoredLiteral(link: NodeLink, fallback: string | number): ICellData {
  if (link.valueType === 'boolean' && (link.text === 'TRUE' || link.text === 'FALSE')) {
    return { v: link.text === 'TRUE' ? 1 : 0, t: CellValueType.BOOLEAN };
  }
  if (link.rawValue !== undefined) return { v: link.rawValue, t: CellValueType.NUMBER };
  return { v: fallback, t: CellValueType.STRING, ...(link.richText ? { p: structuredClone(link.richText) } : {}) };
}

function diffText(oldText: string, newText: string): Pick<HcdTextSplice, 'start' | 'deleteCount' | 'insertText'> {
  const before = [...oldText];
  const after = [...newText];
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) suffix += 1;
  return {
    start: prefix,
    deleteCount: before.length - prefix - suffix,
    insertText: after.slice(prefix, after.length - suffix).join(''),
  };
}

function numericLiteral(source: string): string | undefined {
  let text = source.trim();
  const percent = text.endsWith('%');
  if (percent) text = text.slice(0, -1).trim();
  if (!/^[-+]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return undefined;
  const value = text.replaceAll(',', '');
  const number = Number(value) / (percent ? 100 : 1);
  return Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number))
    ? percent ? String(number) : value : undefined;
}

function displayedNumber(source: string): number | undefined {
  let text = source.trim();
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/^([+-]?)[$€£¥￥]\s*/, '$1').replace(/\s*[$€£¥￥]$/, '');
  const percent = text.endsWith('%');
  if (percent) text = text.slice(0, -1).trim();
  const literal = numericLiteral(text);
  if (literal === undefined) return undefined;
  const value = Number(literal) * (negative ? -1 : 1) / (percent ? 100 : 1);
  return Number.isFinite(value) ? value : undefined;
}

export class HcdUniverAdapter {
  private readonly loaded = new Set<string>();
  private readonly loadedVersions = new Map<string, string>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly appliedDimensions = new Set<string>();
  private readonly linksByCell = new Map<string, NodeLink>();
  private readonly linksByNode = new Map<string, NodeLink>();
  private readonly blankCells = new Set<string>();
  private readonly loadedRowCeilings = new Map<string, number>();
  private readonly pending = new Map<string, PendingPatch>();
  private readonly runtimes = new Map<string, ChunkRuntime>();
  private readonly rangeGeneration = new Map<string, number>();
  private readonly dimensions = new Map<string, SheetDimensions>();
  private readonly recalculatedFormulas = new Set<string>();
  private readonly editInputs = new Map<string, string>();
  private readonly editDocuments = new Map<string, ICellData['p']>();
  private readonly pivotProjection = new PivotProjection();
  private applying = 0;
  private inputBlocked = false;
  private disposed = false;
  private calculationListener?: { dispose: () => void };

  dispose(): void {
    this.disposed = true;
    this.calculationListener?.dispose();
    this.calculationListener = undefined;
  }

  setInputBlocked(blocked: boolean): void { this.inputBlocked = blocked; }
  private readonly delimitedFields: boolean;

  constructor(
    readonly client: HcdBundleClient,
    readonly univerAPI: FUniver,
    readonly workbook: FWorkbook,
    private currentMode: HcdViewerMode,
    private readonly onStatus: (message: string) => void,
    private readonly styleCatalog: Record<string, IStyleData> = {},
    private readonly onError: (message: string) => void = () => {},
  ) {
    const sourceFormat = client.manifest.source?.format;
    this.delimitedFields = sourceFormat === 'csv' || sourceFormat === 'tsv';
    for (const sheet of client.sheets()) {
      const defaults = client.sheetDefaults(sheet.sheetId);
      this.dimensions.set(sheet.sheetId, {
        defaultColumnWidth: defaults.columnWidth,
        defaultRowHeight: defaults.rowHeight,
        columns: new Map(),
        rows: new Map(),
      });
    }
  }

  get mode(): HcdViewerMode { return this.currentMode; }

  updatePresentation(operation: () => void): void {
    this.withApplying(operation);
  }

  setMode(mode: HcdViewerMode): void {
    if (this.hasPendingPatch()) throw new Error('请等待当前单元格保存完成');
    this.currentMode = mode;
  }

  isPivotCell(sheet: string, row: number, column: number): boolean {
    return this.client.worksheetPivots(sheet).some(pivot =>
      pivotContains(pivotRange(pivot), row, column) || pivotContains(pivot.origin?.range, row, column));
  }

  async start(): Promise<void> {
    for (const address of this.client.sheets()) {
      const sheet = this.workbook.getSheetBySheetId(address.sheetId);
      if (!sheet) continue;
      sheet.onScroll(() => this.scheduleVisible(sheet));
    }
    this.univerAPI.addEvent(this.univerAPI.Event.ActiveSheetChanged, ({ activeSheet }) => {
      this.scheduleVisible(activeSheet);
    });
    this.univerAPI.addEvent(this.univerAPI.Event.BeforeSheetEditStart, (event) => {
      if (this.mode === 'readonly' || this.inputBlocked
        || this.isPivotCell(event.worksheet.getSheetId(), event.row, event.column)) {
        event.cancel = true;
        return;
      }
      const key = cellKey(event.worksheet.getSheetId(), event.row, event.column);
      const link = this.linksByCell.get(key);
      const blank = !link && this.canEditBlankCell(event.worksheet.getSheetId(), event.row, event.column);
      const pending = [...this.pending.values()].some(({ links, blanks }) =>
        (link && links.includes(link)) || blanks.some(blank => cellKey(blank.sheetId, blank.row, blank.column) === key));
      if ((!link?.editable && !link?.formulaEditable && !blank) || pending) {
        event.cancel = true;
      }
    });
    this.univerAPI.addEvent(this.univerAPI.Event.BeforeSheetEditEnd, (event) => {
      const key = cellKey(event.worksheet.getSheetId(), event.row, event.column);
      if (event.isConfirm) {
        this.editInputs.set(key, event.value.toPlainText());
        this.editDocuments.set(key, structuredClone(event.value.getData()));
      } else { this.editInputs.delete(key); this.editDocuments.delete(key); }
    });
    this.univerAPI.addEvent(this.univerAPI.Event.BeforeCommandExecute, (event) => {
      // Formula calculation is also dispatched as mutations. Cancelling its
      // notifications leaves the formula engine waiting for its own result.
      const calculation = event.id.startsWith('formula.mutation.')
        || event.options?.fromFormula === true
        || event.options?.applyFormulaCalculationResult === true;
      if (!this.applying && !calculation && event.id === SetRangeValuesMutation.id) {
        const data = event.params as { unitId?: string; subUnitId?: string; cellValue?: IObjectMatrixPrimitiveType<ICellData> } | undefined;
        if (data?.unitId === this.workbook.getId() && data.subUnitId && data.cellValue
          && this.client.worksheetPivots(data.subUnitId).length
          && Object.entries(data.cellValue).some(([row, cells]) => Object.keys(cells)
            .some(column => this.isPivotCell(data.subUnitId!, Number(row), Number(column))))) {
          event.cancel = true;
          this.onError('请修改透视表源数据，或在透视表中调整字段。');
          return;
        }
      }
      if (
        (this.mode === 'readonly' || this.inputBlocked)
        && !this.applying
        && !calculation
        && event.type === this.univerAPI.Enum.CommandType.MUTATION
      ) {
        event.cancel = true;
      }
    });
    this.univerAPI.addEvent(this.univerAPI.Event.SheetValueChanged, (event) => {
      if (this.applying || this.mode === 'readonly' || this.inputBlocked) return;
      void this.captureChanges(event.effectedRanges);
    });
    // A compatibility calculation can complete after a service result. Reapply
    // only the changed caches, never a formula edit or a document transaction.
    this.calculationListener = this.univerAPI.getFormula().calculationResultApplied(() => {
      if (!this.applying) void this.refreshFormulaResults();
    });
    await this.ensureVisible(this.workbook.getActiveSheet());
  }

  getNodeAt(sheetId: string, row: number, column: number): NodeLink | undefined {
    return this.isPivotCell(sheetId, row, column) ? undefined : this.linksByCell.get(cellKey(sheetId, row, column));
  }

  applyRichCellInput(sheetId: string, row: number, column: number, runs: XlsxInlineRun[]): void {
    if (this.mode !== 'editable' || this.hasPendingPatch() || this.workbook.isCellEditing()) throw new Error('请先结束单元格编辑或等待保存');
    const sheet = this.workbook.getSheetBySheetId(sheetId), link = this.getNodeAt(sheetId, row, column);
    if (!sheet || !(link?.editable || link?.formulaEditable || (!link && this.canEditBlankCell(sheetId, row, column)))) {
      throw new Error('当前单元格不能应用文字格式');
    }
    const text = runs.map(run => run.text).join('');
    validateInlineRuns(runs, text);
    const doc = documentFromInlineRuns(runs, link?.nodeId ?? `${sheetId}-${row}-${column}`, link?.baseStyle);
    const key = cellKey(sheetId, row, column);
    this.editInputs.set(key, text); this.editDocuments.set(key, doc);
    sheet.getRange(row, column).setValue({ v: text, t: CellValueType.STRING, p: doc });
  }

  private parseChunk(chunk: LoadedChunk): ParsedGridChunk {
    return parseGridChunk(chunk, href => this.client.resolve(href).toString(), this.styleCatalog, this.delimitedFields);
  }

  applyCellInput(sheetId: string, row: number, column: number, input: string): void {
    if (this.mode !== 'editable' || this.inputBlocked || this.hasPendingPatch()) {
      throw new Error('当前单元格不可编辑或仍在保存');
    }
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    if (!sheet) throw new Error('工作表不存在');
    const link = this.getNodeAt(sheetId, row, column);
    if (!(link?.editable || link?.formulaEditable || (!link && this.canEditBlankCell(sheetId, row, column)))) {
      throw new Error('当前单元格不可编辑');
    }
    const range = sheet.getRange(row, column);
    const formula = input.trim();
    const existingFormula = String(range.getFormulas?.()[0]?.[0] ?? '');
    if (formula.startsWith('=')) {
      if (formula.length < 2) throw new Error('公式必须包含 = 后面的表达式');
      if (formula !== existingFormula) range.setFormula(formula);
      return;
    }
    if (!existingFormula && String(range.getValue() ?? '') === input) return;
    if (this.delimitedFields && !link?.formulaEditable && link?.rawValue === undefined) {
      this.editInputs.set(cellKey(sheetId, row, column), input);
      range.setValue({ v: input, t: CellValueType.FORCE_STRING });
      return;
    }
    const literal = numericLiteral(input);
    const formatted = (link?.rawValue !== undefined || link?.formulaEditable)
      ? displayedNumber(input) : undefined;
    const numericText = literal ?? (formatted === undefined ? undefined : String(formatted));
    if (numericText === undefined && /^[-+]?(?:\d|\.\d)/.test(formula)
      && (link?.rawValue !== undefined || link?.formulaEditable)) {
      throw new Error('请输入有效的数字');
    }
    // Programmatic writes do not emit BeforeSheetEditEnd. Preserve the raw
    // formula-bar text so captureChanges can distinguish a literal from a
    // formatted display value and create the correct HCD operation.
    this.editInputs.set(cellKey(sheetId, row, column), numericText ?? input);
    range.setValue(numericText === undefined ? input : Number(numericText));
  }

  async waitForRendered(): Promise<void> {
    if (this.univerAPI.getCurrentLifecycleStage() < LifecycleStages.Rendered) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { listener.dispose(); reject(new Error('工作表画布尚未就绪，请稍后重试')); }, 10_000);
        const listener = this.univerAPI.addEvent(this.univerAPI.Event.LifeCycleChanged, ({ stage }) => {
          if (stage < LifecycleStages.Rendered) return;
          // The lifecycle notification precedes some plugin callbacks. Let
          // those register the scrolling controller before addressing it.
          queueMicrotask(() => { clearTimeout(timer); listener.dispose(); resolve(); });
        });
      });
    }
  }

  async restoreViewport(sheet: FWorksheet, scroll: IScrollState, range: IRange | null, zoom: number): Promise<void> {
    await this.waitForRendered();
    this.workbook.setActiveSheet(sheet);
    sheet.zoom(zoom);
    const row = scroll.sheetViewStartRow;
    const sheetId = sheet.getSheetId(), unitId = this.workbook.getId();
    await this.loadRange(sheetId, Math.max(0, row - 128), Math.min(sheet.getMaxRows() - 1, row + 128));
    if (range) sheet.setActiveRange(sheet.getRange({ ...range, sheetId, unitId }));
    await this.univerAPI.executeCommand(SetScrollOperation.id, { ...scroll, unitId, sheetId });
    await this.ensureVisible(sheet);
  }

  async scrollCell(sheetId: string, row: number, column: number): Promise<void> {
    await this.waitForRendered();
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    if (!sheet) throw new Error('工作表不存在');
    this.workbook.setActiveSheet(sheet);
    const range = sheet.getRange(row, column);
    // Scroll through the registered UI operation without changing selection.
    await this.univerAPI.executeCommand(ScrollToRangeOperation.id, { range: range.getRange() });
    await this.ensureVisible(sheet);
  }

  async focusCell(sheetId: string, row: number, column: number): Promise<void> {
    await this.scrollCell(sheetId, row, column);
    const sheet = this.workbook.getSheetBySheetId(sheetId)!;
    const range = sheet.getRange(row, column);
    sheet.setActiveRange(range);
    await this.ensureVisible(sheet);
  }

  async focusNode(nodeId: string): Promise<boolean> {
    const link = this.linksByNode.get(nodeId);
    if (!link) return false;
    if (!this.workbook.getSheetBySheetId(link.sheetId)) return false;
    await this.focusCell(link.sheetId, link.row, link.column);
    return true;
  }

  /** A remote cursor must not change the local user's active cell. */
  nodeAddress(nodeId: string): { sheetId: string; row: number; column: number } | undefined {
    const link = this.linksByNode.get(nodeId);
    return link ? { sheetId: link.sheetId, row: link.row, column: link.column } : undefined;
  }

  async loadRange(sheetId: string, startRow: number, endRow: number): Promise<void> {
    const generation = (this.rangeGeneration.get(sheetId) ?? 0) + 1;
    this.rangeGeneration.set(sheetId, generation);
    const cellDescriptors = this.client.cellWindows(sheetId, startRow + 1, endRow + 1);
    const visualDescriptors = this.client.visuals(sheetId).filter(({ grid }) => grid?.rowStart === undefined
      || grid.rowEnd === undefined
      || (grid.rowEnd >= startRow + 1 && grid.rowStart <= endRow + 1));
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    const pivots = this.client.worksheetPivots(sheetId);
    if (sheet && (cellDescriptors.some(descriptor => this.loadedVersions.get(descriptor.chunkId) !== this.descriptorVersion(descriptor))
      || !this.pivotProjection.isCurrent(sheetId, pivots))) {
      this.withApplying(() => this.pivotProjection.restore(sheet));
    }
    // Cell chunks establish the real row/column geometry. Drawings must be
    // inserted afterwards or their two-cell anchors are measured against the
    // temporary default grid.
    await Promise.all(cellDescriptors.map((descriptor) => this.loadChunk(descriptor)));
    if (this.rangeGeneration.get(sheetId) !== generation) return;
    this.recalculateEditedFormulas(sheetId, cellDescriptors);
    await Promise.all(visualDescriptors.map((descriptor) => this.loadChunk(descriptor)));
    if (this.rangeGeneration.get(sheetId) !== generation) return;
    const descriptors = [...cellDescriptors, ...visualDescriptors];
    const keep = new Set(descriptors.map(({ chunkId }) => chunkId));
    this.evictOutsideWindow(sheetId, keep);
    if (sheet && !this.pivotProjection.isCurrent(sheetId, pivots)) {
      this.withApplying(() => this.pivotProjection.paint(sheet, pivots));
    }
    await this.refreshFormulaResults();
  }

  /** Update real cell caches from the same checked results used by CLI/Agents.
   * Keep formulas, formatting, selection, scroll and the renderer untouched. */
  private async refreshFormulaResults(): Promise<void> {
    if (this.disposed || this.hasPendingPatch() || this.workbook.isCellEditing()) return;
    const revision = this.client.manifest.revision;
    const sheetIds = new Set([...this.linksByNode.values()].filter(link => link.formula).map(link => link.sheetId));
    try {
      const results = await Promise.all([...sheetIds].map(async sheetId => [sheetId, await this.client.readCalculations(sheetId)] as const));
      if (this.disposed || this.client.manifest.revision !== revision || this.hasPendingPatch() || this.workbook.isCellEditing()) return;
      const unitData: Record<string, Record<string, Record<number, Record<number, ICellData>>>> = {};
      for (const [sheetId, cells] of results) {
        if (!cells) continue;
        const sheet = this.workbook.getSheetBySheetId(sheetId);
        if (!sheet) continue;
        for (const link of this.linksByNode.values()) {
          if (link.sheetId !== sheetId || !link.formula) continue;
          const range = sheet.getRange(link.row, link.column);
          if (String(range.getFormulas()?.[0]?.[0] ?? '') !== link.formula) continue;
          const cell = cells.get(range.getA1Notation());
          if (cell?.formula !== link.formula) continue;
          const result = cell.calculation;
          let data: ICellData;
          if (result.status === 'unavailable') {
            // A native Excel error must also replace a stale numeric cache.
            // Unsupported functions/limits retain their compatibility preview.
            if (!result.error || !/^#(?:N\/A|VALUE!|REF!|DIV\/0!|NUM!|NAME\?|NULL!)$/.test(result.error)) continue;
            data = { v: result.error, t: CellValueType.STRING };
          } else if (result.valueType === 'number' && result.value !== null && Number.isFinite(Number(result.value))) {
            data = { v: Number(result.value), t: CellValueType.NUMBER };
          } else if (result.valueType === 'boolean') {
            data = { v: result.value === 'TRUE' ? 1 : 0, t: CellValueType.BOOLEAN };
          } else if (result.valueType === 'string' || result.valueType === 'blank') {
            data = { v: result.value ?? '', t: CellValueType.STRING };
          } else continue; // An old service or array result has no scalar contract.
          if (range.getValue() === data.v) continue;
          const sheets = unitData[this.client.manifest.documentId] ??= {};
          ((sheets[sheetId] ??= {})[link.row] ??= {})[link.column] = data;
        }
      }
      if (!Object.keys(unitData).length) return;
      this.withApplying(() => this.univerAPI.syncExecuteCommand(SetFormulaCalculationResultMutation.id, { unitData, unitOtherData: {} }));
    } catch {
      // Loading/reading a workbook must remain possible on a service without
      // verified calculation. The selected-cell status reports unavailability.
    }
  }

  acknowledgePatch(patchId: string, revision: number, nodeHashes: Record<string, string>): void {
    const pending = this.pending.get(patchId);
    if (!pending) return;
    for (const link of pending.links) {
      const nextHash = nodeHashes[link.nodeId];
      if (nextHash) link.nodeHash = nextHash;
      const sheet = this.workbook.getSheetBySheetId(link.sheetId);
      const data = sheet?.getRange(link.row, link.column).getCellData();
      const currentText = data?.v ?? (data?.p ? this.univerAPI.newRichTextValue(data.p).toPlainText() : '');
      const rich = pending.richUpdates.get(link.nodeId);
      if (rich) {
        link.formulaEditable = false; link.formula = undefined; link.rawValue = undefined; link.valueType = 'string'; link.editable = true;
        link.inlineRuns = structuredClone(rich);
        link.richText = structuredClone(sheet?.getRange(link.row, link.column).getCellData()?.p);
      }
      if (pending.convertedFormulaIds.has(link.nodeId)) {
        link.formulaEditable = false;
        link.editable = true;
        link.formula = undefined;
        const numberValue = pending.convertedNumberValues.get(link.nodeId);
        link.text = numberValue ?? String(currentText);
        link.rawValue = numberValue === undefined ? undefined : Number(numberValue);
        link.valueType = numberValue === undefined ? 'string' : 'number';
      } else if (pending.formulaUpdates.has(link.nodeId)) {
        link.formulaEditable = true;
        link.formulaEdited = true;
        link.editable = false;
        link.formula = pending.formulaUpdates.get(link.nodeId);
        link.text = link.formula ?? '';
        link.rawValue = undefined;
        link.valueType = undefined;
      } else if (link.formulaEditable) {
        link.formula = String(sheet?.getRange(link.row, link.column).getFormulas?.()[0]?.[0] ?? link.formula ?? '');
        link.text = link.formula;
      } else {
        const numberValue = pending.convertedNumberValues.get(link.nodeId);
        link.text = numberValue ?? String(currentText);
        link.rawValue = numberValue === undefined ? undefined : Number(numberValue);
        link.valueType = numberValue === undefined ? 'string' : 'number';
      }
    }
    this.client.manifest.revision = revision;
    this.pending.delete(patchId);
    this.onStatus(`revision ${revision} · ${this.loaded.size} 个分片已加载`);
  }

  rejectPatch(patchId: string, reason = 'patch rejected'): void {
    const pending = this.pending.get(patchId);
    if (!pending) return;
    this.withApplying(() => {
      pending.links.forEach((link, index) => {
        const range = this.workbook.getSheetBySheetId(link.sheetId)?.getRange(link.row, link.column);
        if (link.formulaEditable && link.formula) range?.setFormula(link.formula);
        else range?.setValue(restoredLiteral(link, pending.previous[index]));
      });
      for (const { sheetId, row, column } of pending.blanks) {
        this.workbook.getSheetBySheetId(sheetId)?.getRange(row, column).setValue('');
      }
    });
    this.pending.delete(patchId);
    this.onStatus(reason);
    // Restoring the expression clears Univer's scalar cache. Reuse checked
    // results for this revision so a rejected paste does not blank formulas.
    void this.refreshFormulaResults();
  }

  hasPendingPatch(): boolean { return this.pending.size > 0; }

  lockCellWrites(locked: boolean): void { this.inputBlocked = locked; }

  private rowFilter?: { sheet: FWorksheet; hiddenRuns: Array<{ start: number; count: number }> };

  async filterRows(sheetId: string, startRow: number, endRow: number, criteria: readonly { column: number; query: string }[]): Promise<{ matched: number; total: number }> {
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    const needles = new Map(criteria.map(({ column, query }) => [column, query.trim().toLowerCase()]));
    if (!sheet || startRow > endRow || endRow - startRow >= 500 || !needles.size
      || needles.size !== criteria.length || [...needles.values()].some(needle => !needle)) {
      throw new Error('请在最多 500 行的选区中填写筛选关键词');
    }
    const revision = this.client.manifest.revision;
    const descriptors = this.client.cellWindows(sheetId, startRow + 1, endRow + 1);
    if (descriptors.reduce((bytes, descriptor) => bytes + descriptor.byteLength, 0) > 32 * 1024 * 1024) {
      throw new Error('筛选范围内的数据过多，请缩小选区');
    }
    const originalHidden = new Set<number>();
    const matches = new Map<number, Set<number>>();
    for (const descriptor of descriptors) {
      const parsed = this.parseChunk(await this.client.readChunk(descriptor));
      for (const row of parsed.rowHeights) if (row.hidden) originalHidden.add(row.row);
      for (const { row, column: cellColumn, link } of parsed.cells) {
        const needle = needles.get(cellColumn);
        if (row < startRow || row > endRow || !needle || !link?.text.toLowerCase().includes(needle)) continue;
        const columns = matches.get(row) ?? new Set<number>();
        columns.add(cellColumn);
        matches.set(row, columns);
      }
    }
    if (revision !== this.client.manifest.revision || this.hasPendingPatch()
      || this.workbook.getActiveSheet().getSheetId() !== sheetId) {
      throw new Error('工作表已变化，请重新筛选');
    }
    this.clearRowFilter();
    const hiddenRows: number[] = [];
    let total = 0;
    let matched = 0;
    for (let row = startRow; row <= endRow; row += 1) {
      if (originalHidden.has(row) || !sheet.getSheet().getRowVisible(row)) continue;
      total += 1;
      if (matches.get(row)?.size === needles.size) { matched += 1; continue; }
      hiddenRows.push(row);
    }
    this.hideFilteredRows(sheet, hiddenRows);
    return { matched, total };
  }

  applySavedFilter(sheetId: string, hiddenRows: number[]): void {
    const sheet = this.workbook.getActiveSheet();
    if (sheet.getSheetId() !== sheetId) return;
    this.clearRowFilter();
    this.hideFilteredRows(sheet, hiddenRows.map(row => row - 1));
  }

  private hideFilteredRows(sheet: FWorksheet, hiddenRows: number[]): void {
    const selection = sheet.getActiveRange();
    const hiddenRuns: Array<{ start: number; count: number }> = [];
    for (const row of hiddenRows) {
      if (!sheet.getSheet().getRowVisible(row)) continue;
      const last = hiddenRuns.at(-1);
      if (last && last.start + last.count === row) last.count += 1;
      else hiddenRuns.push({ start: row, count: 1 });
    }
    this.withApplying(() => {
      for (const { start, count } of hiddenRuns) sheet.hideRows(start, count);
      if (!selection || selection.getSheetId() !== sheet.getSheetId() || !hiddenRuns.length) return;
      const row = selection.getRow();
      if (sheet.getSheet().getRowVisible(row)) {
        sheet.setActiveRange(sheet.getRange(row, selection.getColumn(), selection.getHeight(), selection.getWidth()));
        return;
      }
      const visibleRows = sheet.getSheet().getVisibleRows();
      const next = visibleRows.find(range => range.endRow >= row);
      const visibleRow = next ? Math.max(row, next.startRow) : visibleRows.at(-1)?.endRow;
      if (visibleRow !== undefined) sheet.setActiveRange(sheet.getRange(visibleRow, selection.getColumn()));
    });
    this.rowFilter = { sheet, hiddenRuns };
  }

  clearRowFilter(): void {
    const filter = this.rowFilter;
    if (!filter) return;
    this.rowFilter = undefined;
    const selection = filter.sheet.getActiveRange();
    this.withApplying(() => {
      for (const { start, count } of filter.hiddenRuns) filter.sheet.showRows(start, count);
      if (selection && selection.getSheetId() === filter.sheet.getSheetId() && filter.hiddenRuns.length
        && this.workbook.getActiveSheet().getSheetId() === filter.sheet.getSheetId()) {
        filter.sheet.setActiveRange(filter.sheet.getRange(selection.getRow(), selection.getColumn(),
          selection.getHeight(), selection.getWidth()));
      }
    });
  }

  invalidateColumnWidths(sheetId: string): void {
    for (const key of this.appliedDimensions) {
      if (key.startsWith(`${sheetId}:column:`)) this.appliedDimensions.delete(key);
    }
  }

  invalidateRowHeights(sheetId: string): void {
    for (const key of this.appliedDimensions) {
      if (key.startsWith(`${sheetId}:row:`)) this.appliedDimensions.delete(key);
    }
  }

  /**
   * Mirror a worksheet rename HCD already recorded into the Univer tab. The
   * rename is not a cell edit, so it must not be read back as a pending patch.
   */
  renameSheet(sheetId: string, name: string): void {
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    if (!sheet) throw new Error(`工作表不存在: ${sheetId}`);
    this.withApplying(() => {
      sheet.setName(name);
    });
  }

  /**
   * Mirror a worksheet HCD already created into a Univer tab. The tab has to
   * carry the sheet id HCD minted for it, because every later cell edit
   * addresses the worksheet through that id and a locally generated one would
   * point at a worksheet the bundle never had.
   */
  async addSheet(name: string, sheetId: string): Promise<void> {
    if (this.workbook.getSheetBySheetId(sheetId)) {
      throw new Error(`工作表已存在: ${sheetId}`);
    }
    const address = this.client.sheets().find((sheet) => sheet.sheetId === sheetId);
    if (!address || address.sheetName !== name) {
      throw new Error(`HCD 索引里没有工作表 ${name}`);
    }
    const defaults = this.client.sheetDefaults(sheetId);
    this.dimensions.set(sheetId, {
      defaultColumnWidth: defaults.columnWidth,
      defaultRowHeight: defaults.rowHeight,
      columns: new Map(),
      rows: new Map(),
    });
    // Univer inserts the tab and makes it active in one command pair. The
    // sheet has to be created while `applying` so the read-only guard cannot
    // cancel the mutation on a viewer that is also allowed to add tabs.
    this.withApplying(() => {
      this.workbook.insertSheet(name, { index: address.sheetIndex, sheet: { id: sheetId } });
    });
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    if (!sheet) throw new Error(`工作表已创建但不在 Univer 工作簿里: ${name}`);
    sheet.onScroll(() => this.scheduleVisible(sheet));
    await this.ensureVisible(sheet);
  }

  /**
   * Take away the Univer tab for a worksheet HCD already deleted. The tab goes
   * before the index is reloaded, because `refreshFromServer` works out which
   * windows to fetch from the active sheet and that sheet has to be one the
   * document still has.
   */
  removeSheet(sheetId: string): void {
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    if (!sheet) throw new Error(`工作表不存在: ${sheetId}`);
    if (this.workbook.getSheets().length <= 1) {
      throw new Error('工作簿必须保留一个工作表');
    }
    // Same reason as inserting: the mutation is HCD's, replayed here, so it runs
    // while `applying` and the read-only guard leaves it alone.
    this.withApplying(() => {
      if (!this.workbook.deleteSheet(sheetId)) {
        throw new Error(`Univer 没有删除工作表 ${sheetId}`);
      }
    });
    if (this.workbook.getSheetBySheetId(sheetId)) {
      throw new Error(`Univer 保留了工作表 ${sheetId}`);
    }
    this.forgetSheet(sheetId);
  }

  /** Let go of every window, cell link, and dimension cached for a sheet that is gone. */
  private forgetSheet(sheetId: string): void {
    this.dimensions.delete(sheetId);
    this.rangeGeneration.delete(sheetId);
    for (const [chunkId, runtime] of [...this.runtimes]) {
      if (runtime.sheetId !== sheetId) continue;
      for (const cell of runtime.cells) {
        if (cell.link) {
          this.linksByNode.delete(cell.link.nodeId);
          this.recalculatedFormulas.delete(cell.link.nodeId);
        }
      }
      this.runtimes.delete(chunkId);
      this.loaded.delete(chunkId);
      this.loadedVersions.delete(chunkId);
    }
    const prefix = `${sheetId}:`;
    for (const [key, link] of [...this.linksByCell]) {
      if (!key.startsWith(prefix)) continue;
      this.linksByCell.delete(key);
      this.linksByNode.delete(link.nodeId);
    }
    for (const key of [...this.blankCells]) if (key.startsWith(prefix)) this.blankCells.delete(key);
    for (const key of [...this.editInputs.keys()]) if (key.startsWith(prefix)) this.editInputs.delete(key);
    for (const key of [...this.editDocuments.keys()]) if (key.startsWith(prefix)) this.editDocuments.delete(key);
    for (const key of [...this.loadedRowCeilings.keys()]) {
      if (key.startsWith(prefix)) this.loadedRowCeilings.delete(key);
    }
    for (const key of [...this.appliedDimensions]) if (key.startsWith(prefix)) this.appliedDimensions.delete(key);
  }

  /** Reload the visible HCD windows after another editor commits a revision. */
  async refreshFromServer(): Promise<boolean> {
    if (this.hasPendingPatch()) return false;
    this.clearRowFilter();
    const activeSheet = this.workbook.getActiveSheet();
    const sheetId = activeSheet.getSheetId();
    this.rangeGeneration.set(sheetId, (this.rangeGeneration.get(sheetId) ?? 0) + 1);
    await this.client.open();
    this.rangeGeneration.set(sheetId, (this.rangeGeneration.get(sheetId) ?? 0) + 1);
    const visible = activeSheet.getVisibleRange();
    const startRow = Math.max(0, (visible?.startRow ?? 0) - 128);
    const endRow = Math.min(activeSheet.getMaxRows() - 1, (visible?.endRow ?? 127) + 128);
    const nextMerges = new Set<string>();
    const nextRowHeights = new Map<number, number>();
    for (const descriptor of this.client.cellWindows(sheetId, startRow + 1, endRow + 1)) {
      const chunk = await this.client.readChunk(descriptor);
      const parsed = this.parseChunk(chunk);
      for (const merge of parsed.merges) {
        nextMerges.add(`${sheetId}:merge:${merge.startRow}:${merge.startColumn}:${merge.endRow}:${merge.endColumn}`);
      }
      for (const row of parsed.rowHeights) {
        if (row.hidden || row.height) nextRowHeights.set(row.row, row.hidden ? 0 : row.height!);
      }
    }
    for (const key of this.appliedDimensions) {
      const match = key.match(/^(s_[0-9a-f]{32}):row:(\d+)$/);
      if (match && match[1] === sheetId && nextRowHeights.has(Number(match[2]))
        && this.dimensions.get(sheetId)?.rows.get(Number(match[2])) !== nextRowHeights.get(Number(match[2]))) {
        this.appliedDimensions.delete(key);
      }
    }
    for (const key of this.appliedDimensions) {
      const match = key.match(/^(s_[0-9a-f]{32}):merge:(\d+):(\d+):(\d+):(\d+)$/);
      if (!match || match[1] !== sheetId || Number(match[4]) < startRow
        || Number(match[2]) > endRow || nextMerges.has(key)) continue;
      const sheet = this.workbook.getSheetBySheetId(match[1]);
      if (sheet) {
        this.withApplying(() => sheet.getRange(Number(match[2]), Number(match[3]),
          Number(match[4]) - Number(match[2]) + 1,
          Number(match[5]) - Number(match[3]) + 1).breakApart());
      }
      this.appliedDimensions.delete(key);
    }
    // Load the replacement window before retiring old chunks. Clearing the
    // whole grid first makes every collaborator update visibly jump.
    await this.ensureVisible(activeSheet);
    // Loading cells leaves the real selection in place. A pre-request snapshot
    // would overwrite a newer mouse/keyboard selection made during this await.
    this.onStatus(`revision ${this.client.manifest.revision} · 已同步其他协作者的修改`);
    return true;
  }

  /** Reconcile an acknowledged local cell patch without clearing the visible grid. */
  async refreshChangedCells(changes: HcdPatchEventDetail['changes']): Promise<void> {
    if (this.hasPendingPatch()) throw new Error('仍有未保存的单元格修改');
    this.clearRowFilter();
    // A scroll/selection change may have scheduled a load using the old index.
    // Prevent that load from evicting the newly reconciled chunk afterwards.
    const changedSheets = new Set(changes.map(change => change.sheetId));
    for (const sheetId of changedSheets) {
      this.rangeGeneration.set(sheetId, (this.rangeGeneration.get(sheetId) ?? 0) + 1);
    }
    const previous = new Map(this.client.descriptors.map(descriptor => [descriptor.sequence, descriptor]));
    await this.client.open();
    for (const sheetId of changedSheets) {
      this.rangeGeneration.set(sheetId, (this.rangeGeneration.get(sheetId) ?? 0) + 1);
    }
    const affected = new Map<number, ChunkDescriptor>();
    for (const { sheetId, row, column } of changes) {
      const descriptor = this.client.cellWindows(sheetId, row + 1, row + 1).find(({ grid }) =>
        (grid?.columnStart === undefined || grid.columnStart <= column + 1)
        && (grid?.columnEnd === undefined || grid.columnEnd >= column + 1));
      if (!descriptor) throw new Error(`找不到已保存单元格 ${sheetId}:${row + 1}:${column + 1}`);
      affected.set(descriptor.sequence, descriptor);
    }
    for (const descriptor of affected.values()) {
      const oldId = previous.get(descriptor.sequence)?.chunkId;
      if (previous.get(descriptor.sequence)?.htmlHash === descriptor.htmlHash
        && previous.get(descriptor.sequence)?.mapHash === descriptor.mapHash) continue;
      const old = oldId && this.runtimes.get(oldId);
      if (!old) {
        await this.loadChunk(descriptor);
        continue;
      }
      const chunk = await this.client.readChunk(descriptor);
      const parsed = this.parseChunk(chunk);
      if (descriptor.grid?.kind !== 'cells') throw new Error('单元格分片无法局部同步');
      const wasRich = new Set(old.cells.filter(cell => cell.link?.richText).map(cell => `${cell.row}:${cell.column}`));
      // Univer already holds the user's optimistic value. Writing it again can
      // emit SheetValueChanged later and create a second, reversing patch.
      for (const cell of old.cells) {
        if (cell.link) {
          const key = cellKey(cell.link.sheetId, cell.row, cell.column);
          if (this.linksByCell.get(key) === cell.link) this.linksByCell.delete(key);
          if (this.linksByNode.get(cell.link.nodeId) === cell.link) this.linksByNode.delete(cell.link.nodeId);
          this.recalculatedFormulas.delete(cell.link.nodeId);
        }
        if (cell.blank) this.blankCells.delete(cellKey(old.sheetId, cell.row, cell.column));
      }
      const lastColumns = new Map<number, number>();
      for (const cell of parsed.cells) {
        if (cell.link) {
          this.linksByCell.set(cellKey(cell.link.sheetId, cell.row, cell.column), cell.link);
          this.linksByNode.set(cell.link.nodeId, cell.link);
        }
        if (cell.blank) this.blankCells.add(cellKey(old.sheetId, cell.row, cell.column));
        lastColumns.set(cell.row, Math.max(lastColumns.get(cell.row) ?? 0, cell.column + 1));
      }
      // Text-only edits inherit the adjoining source run on the server. Apply
      // that document to the changed cell only, retaining canvas and viewport.
      const changed = new Set(changes.filter(change => change.sheetId === old.sheetId).map(change => `${change.row}:${change.column}`));
      this.withApplying(() => {
        const sheet = this.workbook.getSheetBySheetId(old.sheetId);
        for (const cell of parsed.cells) {
          const key = `${cell.row}:${cell.column}`;
          if (changed.has(key) && (cell.data.p || wasRich.has(key))) {
            sheet?.getRange(cell.row, cell.column).setValue({ ...cell.data, p: cell.data.p ?? null });
          }
        }
      });
      for (const merge of parsed.merges) {
        lastColumns.set(merge.startRow, Math.max(lastColumns.get(merge.startRow) ?? 0, merge.endColumn + 1));
      }
      for (const { row } of parsed.rowHeights) {
        this.loadedRowCeilings.set(`${old.sheetId}:${row}`,
          Math.min(16_384, (lastColumns.get(row) ?? 0) + 256));
      }
      this.runtimes.delete(oldId);
      this.loaded.delete(oldId);
      this.loadedVersions.delete(oldId);
      this.runtimes.set(descriptor.chunkId, {
        sheetId: old.sheetId, kind: old.kind,
        cells: parsed.cells.map(({ row, column, link, blank }) => ({ row, column, link, blank })),
        rows: parsed.rowHeights.map(({ row }) => row), visualIds: [],
      });
      this.loaded.add(descriptor.chunkId);
      this.loadedVersions.set(descriptor.chunkId, this.descriptorVersion(descriptor));
    }
    await this.ensureVisible(this.workbook.getActiveSheet());
  }

  private scheduleVisible(sheet: FWorksheet): void {
    window.requestAnimationFrame(() => void this.ensureVisible(sheet));
  }

  private async ensureVisible(sheet: FWorksheet): Promise<void> {
    const range = sheet.getVisibleRange();
    const start = Math.max(0, (range?.startRow ?? 0) - 128);
    const end = Math.min(sheet.getMaxRows() - 1, (range?.endRow ?? 127) + 128);
    await this.loadRange(sheet.getSheetId(), start, end);
  }

  private recalculateEditedFormulas(sheetId: string, descriptors: ChunkDescriptor[]): void {
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    if (!sheet) return;
    this.withApplying(() => {
      for (const descriptor of descriptors) {
        const runtime = this.runtimes.get(descriptor.chunkId);
        for (const { link } of runtime?.cells ?? []) {
          if (!link?.formulaEdited || !link.formula || this.recalculatedFormulas.has(link.nodeId)) continue;
          sheet.getRange(link.row, link.column).setFormula(link.formula);
          this.recalculatedFormulas.add(link.nodeId);
        }
      }
    });
  }

  private async loadChunk(descriptor: ChunkDescriptor): Promise<void> {
    const version = this.descriptorVersion(descriptor);
    if (this.loadedVersions.get(descriptor.chunkId) === version) return;
    const existing = this.loading.get(version);
    if (existing) return existing;
    const operation = (async () => {
      const chunk = await this.client.readChunk(descriptor);
      // A newer revision can arrive while the old object is being fetched.
      const current = this.client.descriptors.find(item => item.sequence === descriptor.sequence);
      if (!current || this.descriptorVersion(current) !== version) return;
      const parsed = this.parseChunk(chunk);
      const sheet = this.workbook.getSheetBySheetId(descriptor.grid!.sheetId);
      if (!sheet) throw new Error(`工作表不存在: ${descriptor.grid!.sheetName}`);
      const previous = this.runtimes.get(descriptor.chunkId);
      const previousCleared = previous ? this.clearMovedCells(sheet, previous, parsed) : false;
      await this.applyParsedChunk(sheet, descriptor, parsed);
      if (previous) this.retireReplacedCells(sheet, previous, parsed, previousCleared);
      this.runtimes.set(descriptor.chunkId, {
        sheetId: descriptor.grid!.sheetId,
        kind: descriptor.grid!.kind,
        cells: parsed.cells.map(({ row, column, link, blank }) => ({ row, column, link, blank })),
        rows: parsed.rowHeights.map(({ row }) => row),
        visualIds: parsed.visuals.map(({ nodeId }) => nodeId),
      });
      if (descriptor.grid?.kind === 'cells') {
        const lastColumns = new Map<number, number>();
        for (const cell of parsed.cells) {
          lastColumns.set(cell.row, Math.max(lastColumns.get(cell.row) ?? 0, cell.column + 1));
        }
        for (const merge of parsed.merges) {
          lastColumns.set(merge.startRow,
            Math.max(lastColumns.get(merge.startRow) ?? 0, merge.endColumn + 1));
        }
        for (const { row } of parsed.rowHeights) {
          this.loadedRowCeilings.set(`${descriptor.grid.sheetId}:${row}`,
            Math.min(16_384, (lastColumns.get(row) ?? 0) + 256));
        }
      }
      this.loaded.add(descriptor.chunkId);
      this.loadedVersions.set(descriptor.chunkId, version);
      this.onStatus(`revision ${this.client.manifest.revision} · ${this.loaded.size}/${this.client.descriptors.length} 个分片已加载`);
    })().finally(() => this.loading.delete(version));
    this.loading.set(version, operation);
    return operation;
  }

  private descriptorVersion(descriptor: ChunkDescriptor): string {
    return `${descriptor.chunkId}:${descriptor.htmlHash}:${descriptor.mapHash}`;
  }

  private clearMovedCells(sheet: FWorksheet, previous: ChunkRuntime, parsed: ParsedGridChunk): boolean {
    const oldPositions = new Map(previous.cells.filter(cell => cell.link)
      .map(cell => [cell.link!.nodeId, `${cell.row}:${cell.column}`]));
    const moved = parsed.cells.some(cell => cell.link && oldPositions.has(cell.link.nodeId)
      && oldPositions.get(cell.link.nodeId) !== `${cell.row}:${cell.column}`);
    if (!moved) return false;
    // A structural shift can reuse an old coordinate for a different cell.
    // Clear the affected rows synchronously before setValues so Univer does not
    // paint the old text/style over the newly moved cells until a full reload.
    const rows = new Map<number, { first: number; last: number }>();
    for (const cell of previous.cells) {
      const span = rows.get(cell.row);
      rows.set(cell.row, span
        ? { first: Math.min(span.first, cell.column), last: Math.max(span.last, cell.column) }
        : { first: cell.column, last: cell.column });
    }
    this.withApplying(() => {
      for (const [row, span] of rows) {
        sheet.getRange(row, span.first, 1, span.last - span.first + 1).clear();
      }
    });
    return true;
  }

  private retireReplacedCells(sheet: FWorksheet, previous: ChunkRuntime, parsed: ParsedGridChunk, previousCleared = false): void {
    const next = new Set(parsed.cells.map(cell => cellKey(previous.sheetId, cell.row, cell.column)));
    const nextBlanks = new Set(parsed.cells.filter(cell => cell.blank)
      .map(cell => cellKey(previous.sheetId, cell.row, cell.column)));
    const removed = previous.cells.filter(cell => !next.has(cellKey(previous.sheetId, cell.row, cell.column)));
    if (!previousCleared) {
      this.withApplying(() => {
        for (const cell of removed) sheet.getRange(cell.row, cell.column).clear();
      });
    }
    for (const cell of previous.cells) {
      const key = cellKey(previous.sheetId, cell.row, cell.column);
      if (cell.link) {
        if (this.linksByCell.get(key) === cell.link) this.linksByCell.delete(key);
        if (this.linksByNode.get(cell.link.nodeId) === cell.link) this.linksByNode.delete(cell.link.nodeId);
        if (!next.has(key)) this.recalculatedFormulas.delete(cell.link.nodeId);
      }
      if (cell.blank && !nextBlanks.has(key)) this.blankCells.delete(key);
    }
  }

  private async applyParsedChunk(sheet: FWorksheet, descriptor: ChunkDescriptor, parsed: ParsedGridChunk): Promise<void> {
    const dimensions = this.dimensions.get(sheet.getSheetId());
    if (dimensions) {
      if (parsed.defaultColumnWidth) dimensions.defaultColumnWidth = parsed.defaultColumnWidth;
      if (parsed.defaultRowHeight) dimensions.defaultRowHeight = parsed.defaultRowHeight;
    }
    this.withApplying(() => {
      if (parsed.cells.length) {
        const values: IObjectMatrixPrimitiveType<ICellData> = {};
        let minRow = Number.MAX_SAFE_INTEGER;
        let maxRow = 0;
        let minColumn = Number.MAX_SAFE_INTEGER;
        let maxColumn = 0;
        for (const cell of parsed.cells) {
          (values[cell.row] ??= {})[cell.column] = cell.data;
          minRow = Math.min(minRow, cell.row);
          maxRow = Math.max(maxRow, cell.row);
          minColumn = Math.min(minColumn, cell.column);
          maxColumn = Math.max(maxColumn, cell.column);
          if (cell.link) {
            this.linksByCell.set(cellKey(cell.link.sheetId, cell.row, cell.column), cell.link);
            this.linksByNode.set(cell.link.nodeId, cell.link);
          }
          if (cell.blank) this.blankCells.add(cellKey(sheet.getSheetId(), cell.row, cell.column));
        }
        sheet.getRange(minRow, minColumn, maxRow - minRow + 1, maxColumn - minColumn + 1).setValues(values);
      }
      for (const merge of parsed.merges) {
        const key = `${sheet.getSheetId()}:merge:${merge.startRow}:${merge.startColumn}:${merge.endRow}:${merge.endColumn}`;
        if (this.appliedDimensions.has(key)) continue;
        sheet.getRange(
          merge.startRow,
          merge.startColumn,
          merge.endRow - merge.startRow + 1,
          merge.endColumn - merge.startColumn + 1,
        ).merge();
        this.appliedDimensions.add(key);
      }
      for (const row of parsed.rowHeights) {
        const key = `${sheet.getSheetId()}:row:${row.row}`;
        if (this.appliedDimensions.has(key)) continue;
        if (row.hidden) {
          sheet.hideRows(row.row);
          dimensions?.rows.set(row.row, 0);
        } else if (row.height) {
          sheet.setRowHeight(row.row, row.height);
          dimensions?.rows.set(row.row, row.height);
        }
        this.appliedDimensions.add(key);
      }
      for (const column of parsed.columnWidths) {
        const key = `${sheet.getSheetId()}:column:${column.startColumn}:${column.count}`;
        if (this.appliedDimensions.has(key)) continue;
        if (column.hidden) sheet.hideColumns(column.startColumn, column.count);
        else if (column.width) sheet.setColumnWidths(column.startColumn, column.count, column.width);
        if (dimensions && (column.hidden || column.width)) {
          const width = column.hidden ? 0 : column.width!;
          for (let offset = 0; offset < column.count; offset += 1) {
            dimensions.columns.set(column.startColumn + offset, width);
          }
        }
        this.appliedDimensions.add(key);
      }
      if (parsed.freeze) sheet.setFreeze(parsed.freeze);
      if (parsed.showGridlines !== undefined) sheet.setHiddenGridlines(!parsed.showGridlines);
    });
    for (const visual of parsed.visuals) {
      const key = `${sheet.getSheetId()}:visual:${visual.nodeId}`;
      const geometry = this.resolveVisualGeometry(sheet, visual);
      if (this.appliedDimensions.has(key)) {
        const existing = sheet.getImageById(visual.nodeId);
        if (existing) {
          const updated = await existing.toBuilder()
            .setColumn(geometry.column)
            .setRow(geometry.row)
            .setColumnOffset(geometry.columnOffset)
            .setRowOffset(geometry.rowOffset)
            .setWidth(geometry.width)
            .setHeight(geometry.height)
            .buildAsync();
          this.withApplying(() => sheet.updateImages([{ ...updated, drawingId: visual.nodeId }]));
          continue;
        }
        this.appliedDimensions.delete(key);
      }
      const built = await sheet.newOverGridImage()
        .setSource(visual.assetUrl, this.univerAPI.Enum.ImageSourceType.URL)
        .setColumn(geometry.column)
        .setRow(geometry.row)
        .setColumnOffset(geometry.columnOffset)
        .setRowOffset(geometry.rowOffset)
        .setWidth(geometry.width)
        .setHeight(geometry.height)
        .buildAsync();
      this.withApplying(() => sheet.insertImages([{ ...built, drawingId: visual.nodeId }]));
      this.appliedDimensions.add(key);
      window.dispatchEvent(new CustomEvent('hcd-visual-ready', { detail: visual }));
    }
  }

  private resolveVisualGeometry(sheet: FWorksheet, visual: ParsedVisual) {
    const sheetId = sheet.getSheetId();
    let row = visual.row;
    let column = visual.column;
    let rowOffset = visual.rowOffset;
    let columnOffset = visual.columnOffset;
    if (visual.anchorKind === 'absolute') {
      ({ index: column, offset: columnOffset } = this.locateDimension(
        sheetId,
        'column',
        visual.absoluteX ?? 0,
        sheet.getMaxColumns(),
      ));
      ({ index: row, offset: rowOffset } = this.locateDimension(
        sheetId,
        'row',
        visual.absoluteY ?? 0,
        sheet.getMaxRows(),
      ));
    }
    let width = visual.extentWidth ?? visual.width;
    let height = visual.extentHeight ?? visual.height;
    if (visual.anchorKind === 'two-cell' && visual.toColumn !== undefined) {
      width = this.sumDimensions(sheetId, 'column', column, visual.toColumn)
        - columnOffset + visual.toColumnOffset;
    }
    if (visual.anchorKind === 'two-cell' && visual.toRow !== undefined) {
      height = this.sumDimensions(sheetId, 'row', row, visual.toRow)
        - rowOffset + visual.toRowOffset;
    }
    return {
      row,
      column,
      rowOffset,
      columnOffset,
      width: Math.max(1, Number.isFinite(width) ? width : visual.width),
      height: Math.max(1, Number.isFinite(height) ? height : visual.height),
    };
  }

  private dimension(sheetId: string, axis: 'row' | 'column', index: number): number {
    const dimensions = this.dimensions.get(sheetId);
    if (!dimensions) return axis === 'column' ? 64 : 20;
    return axis === 'column'
      ? dimensions.columns.get(index) ?? dimensions.defaultColumnWidth
      : dimensions.rows.get(index) ?? dimensions.defaultRowHeight;
  }

  private sumDimensions(sheetId: string, axis: 'row' | 'column', start: number, end: number): number {
    let total = 0;
    for (let index = start; index < end; index += 1) total += this.dimension(sheetId, axis, index);
    return total;
  }

  private locateDimension(
    sheetId: string,
    axis: 'row' | 'column',
    coordinate: number,
    maximum: number,
  ): { index: number; offset: number } {
    let remaining = Math.max(0, coordinate);
    for (let index = 0; index < maximum; index += 1) {
      const size = this.dimension(sheetId, axis, index);
      if (size > 0 && remaining < size) return { index, offset: remaining };
      remaining -= size;
    }
    return { index: Math.max(0, maximum - 1), offset: 0 };
  }

  private async captureChanges(ranges: Array<{ getSheetId(): string; getRow(): number; getColumn(): number; getHeight(): number; getWidth(): number; getValues(): unknown[][]; getFormulas?(): unknown[][] }>): Promise<void> {
    const operations: HcdTextSplice[] = [];
    const richOperations: HcdXlsxRichTextSet[] = [];
    const richCreations: HcdXlsxRichTextCreate[] = [];
    let richConversion = false;
    const formulaOperations: HcdXlsxFormulaSet[] = [];
    const formulaConversions: HcdXlsxFormulaToValue[] = [];
    const numberConversions: HcdXlsxFormulaToNumber[] = [];
    const numberUpdates: HcdXlsxNumberSet[] = [];
    const formulaCreations: HcdXlsxFormulaCreate[] = [];
    const changes: HcdPatchEventDetail['changes'] = [];
    const links: NodeLink[] = [];
    const previous: Array<string | number> = [];
    const seen = new Set<string>();
    const rejected: Array<{ sheetId: string; row: number; column: number; value: string | number; formula?: string }> = [];
    let rejectedUnsafeNumber = false;
    let richError = '';
    const blankChanges: Array<{ sheetId: string; row: number; column: number; text: string }> = [];
    for (const range of ranges) {
      const values = range.getValues();
      const formulas = range.getFormulas?.();
      for (let rowOffset = 0; rowOffset < range.getHeight(); rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < range.getWidth(); columnOffset += 1) {
          const row = range.getRow() + rowOffset;
          const column = range.getColumn() + columnOffset;
          const key = cellKey(range.getSheetId(), row, column);
          if (seen.has(key)) continue;
          seen.add(key);
          const link = this.linksByCell.get(key);
          // Univer may emit a second value event while the first edit is
          // awaiting HCD acknowledgement. Never submit that cell twice with
          // the old node hash.
          if ([...this.pending.values()].some(({ links, blanks }) =>
            (link && links.includes(link)) || blanks.some(blank =>
              cellKey(blank.sheetId, blank.row, blank.column) === key))) continue;
          const rawValue = values[rowOffset]?.[columnOffset];
          const editInput = this.editInputs.get(key);
          this.editInputs.delete(key);
          const editedDocument = this.editDocuments.get(key)
            ?? this.workbook.getSheetBySheetId(range.getSheetId())?.getRange(row, column).getCellData()?.p;
          this.editDocuments.delete(key);
          const richPlain = editedDocument ? this.univerAPI.newRichTextValue(editedDocument).toPlainText() : undefined;
          const next = editInput ?? String(rawValue ?? richPlain ?? '');
          const formula = String(formulas?.[rowOffset]?.[columnOffset] ?? '');
          const entered = editInput ?? next;
          const enteredFormula = formula || (entered.startsWith('=') ? entered : '');
          if (!enteredFormula && editedDocument && this.mode === 'editable'
            && (link?.editable || link?.formulaEditable || (!link && this.canEditBlankCell(range.getSheetId(), row, column)))) {
            try {
              const runs = editedInlineRuns(next, editedDocument, link ?? { text: '' });
              if (runs) {
                if (link) {
                  richConversion ||= !!link.formulaEditable || link.rawValue !== undefined || (!!link.valueType && link.valueType !== 'string');
                  richOperations.push({ type: 'xlsx.richText.set', nodeId: link.nodeId, runs, precondition: { nodeHash: link.nodeHash } });
                  changes.push({ sheetId: link.sheetId, row, column, oldText: link.formula ?? link.text, newText: next, nodeId: link.nodeId });
                  links.push(link); previous.push(link.formula ?? link.rawValue ?? link.text);
                } else {
                  richCreations.push({ type: 'xlsx.richText.create', sheetId: range.getSheetId(), row: row + 1, column: column + 1, runs });
                }
                continue;
              }
            } catch (cause) {
              richError = String(cause);
              rejected.push({ sheetId: range.getSheetId(), row, column, value: link?.rawValue ?? link?.text ?? '', formula: link?.formula });
              continue;
            }
          }
          // Imported booleans have a numeric canvas scalar and a TRUE/FALSE
          // source label. Delayed load events must not become text edits.
          if (!enteredFormula && link?.valueType === 'boolean'
            && (link.text === 'TRUE' || link.text === 'FALSE')
            && next === (link.text === 'TRUE' ? '1' : '0')
            && (editInput === undefined || editInput === next || editInput === link.text)) continue;
          // Formula recalculation emits value events after withApplying has
          // returned. An unchanged expression is not a user edit, including
          // in readonly mode: restoring it would trigger another calculation
          // and an endless restore/value-event loop.
          if (enteredFormula && enteredFormula === link?.formula) continue;
          if (link && (link.formulaEditable || link.editable) && this.mode === 'editable' && enteredFormula) {
            if ([...this.pending.values()].some(({ links }) => links.includes(link))) continue;
            if (enteredFormula === link.formula) continue;
            formulaOperations.push({ type: 'xlsx.formula.set', nodeId: link.nodeId,
              sheetId: link.sheetId, formula: enteredFormula, precondition: { nodeHash: link.nodeHash } });
            changes.push({ sheetId: link.sheetId, row, column, oldText: link.formula ?? link.text, newText: enteredFormula, nodeId: link.nodeId });
            links.push(link);
            previous.push(link.formula ?? link.text);
            continue;
          }
          if (link?.formulaEditable && this.mode === 'editable' && !enteredFormula) {
            if ([...this.pending.values()].some(({ links }) => links.includes(link))) continue;
            const cellType = this.workbook.getSheetBySheetId(link.sheetId)
              ?.getRange(row, column).getCellData()?.t;
            const numericText = numericLiteral(entered);
            const numericSyntax = /^[-+]?(?:\d|\.\d)/.test(entered.trim());
            if (numericSyntax && numericText === undefined && cellType !== 4) {
              rejectedUnsafeNumber = true;
              rejected.push({ sheetId: link.sheetId, row, column, value: link.text, formula: link.formula });
              continue;
            }
            if (numericText !== undefined && cellType !== 4) {
              numberConversions.push({ type: 'xlsx.formula.to-number', nodeId: link.nodeId,
                sheetId: link.sheetId, value: numericText, precondition: { nodeHash: link.nodeHash } });
              changes.push({ sheetId: link.sheetId, row, column, oldText: link.formula ?? link.text,
                newText: numericText, nodeId: link.nodeId });
              links.push(link);
              previous.push(link.formula ?? link.text);
              continue;
            }
            if (cellType === 2 && editInput === undefined && numericText === undefined) {
              rejectedUnsafeNumber = true;
              rejected.push({ sheetId: link.sheetId, row, column, value: link.text, formula: link.formula });
              continue;
            }
            formulaConversions.push({ type: 'xlsx.formula.to-value', nodeId: link.nodeId,
              sheetId: link.sheetId, text: entered, precondition: { nodeHash: link.nodeHash } });
            changes.push({ sheetId: link.sheetId, row, column, oldText: link.formula ?? link.text,
              newText: entered, nodeId: link.nodeId });
            links.push(link);
            previous.push(link.formula ?? link.text);
            continue;
          }
          if (enteredFormula) {
            if (!link && this.mode === 'editable' && this.canEditBlankCell(range.getSheetId(), row, column)
              && this.pending.size === 0) {
              formulaCreations.push({ type: 'xlsx.formula.create', sheetId: range.getSheetId(),
                row: row + 1, column: column + 1, formula: enteredFormula });
              continue;
            }
            rejected.push({ sheetId: range.getSheetId(), row, column, value: link?.text ?? '', formula: link?.formula });
            continue;
          }
          if (link?.editable && link.rawValue !== undefined && this.mode === 'editable') {
            const numericCellType = this.workbook.getSheetBySheetId(link.sheetId)
              ?.getRange(row, column).getCellData()?.t;
            if (next === link.text && editInput === undefined) continue;
            if (displayedNumber(next) === link.rawValue && editInput === undefined) continue;
            const numberValue = numericLiteral(entered);
            if (numberValue !== undefined && this.pending.size === 0) {
              if (Number(numberValue) === link.rawValue) continue;
              numberUpdates.push({ type: 'xlsx.number.set', nodeId: link.nodeId,
                sheetId: link.sheetId, value: numberValue, precondition: { nodeHash: link.nodeHash } });
              changes.push({ sheetId: link.sheetId, row, column, oldText: link.text,
                newText: numberValue, nodeId: link.nodeId });
              links.push(link);
              previous.push(link.rawValue);
              continue;
            }
            if (editInput === undefined && numericCellType === 2) {
              rejectedUnsafeNumber = true;
              rejected.push({ sheetId: link.sheetId, row, column, value: link.rawValue });
              continue;
            }
          }
          if (!link?.editable || this.mode === 'readonly') {
            if (this.mode === 'editable' && !link && this.canEditBlankCell(range.getSheetId(), row, column)
              && next !== '' && this.pending.size === 0) {
              blankChanges.push({ sheetId: range.getSheetId(), row, column, text: next });
              continue;
            }
            if (next === (link?.text ?? '') || (link?.rawValue !== undefined && next === String(link.rawValue))) continue;
            // Paste and fill can bypass BeforeSheetEditStart. Unsupported
            // cells are restored rather than left as unsaved local changes.
            rejected.push({
              sheetId: range.getSheetId(),
              row,
              column,
              value: link?.rawValue ?? link?.text ?? '',
              formula: link?.formula,
            });
            continue;
          }
          if (next === link.text || (link.rawValue !== undefined && next === String(link.rawValue))) continue;
          operations.push({
            type: 'text.splice',
            nodeId: link.nodeId,
            ...diffText(link.text, next),
            precondition: { nodeHash: link.nodeHash },
          });
          changes.push({ sheetId: link.sheetId, row, column, oldText: link.text, newText: next, nodeId: link.nodeId });
          links.push(link);
          previous.push(link.rawValue ?? link.text);
        }
      }
    }
    const operationCount = operations.length + richOperations.length + richCreations.length + blankChanges.length + formulaOperations.length
      + formulaCreations.length + formulaConversions.length + numberConversions.length + numberUpdates.length;
    if (rejected.length || operationCount > 10_000) {
      rejected.push(...richCreations.map(({ sheetId, row, column }) => ({ sheetId, row: row - 1, column: column - 1, value: '' })));
      rejected.push(...blankChanges.map(({ sheetId, row, column }) => ({ sheetId, row, column, value: '' })));
      rejected.push(...formulaCreations.map(({ sheetId, row, column }) => ({ sheetId, row: row - 1, column: column - 1, value: '' })));
      rejected.push(...changes.map(({ sheetId, row, column, oldText }) => ({ sheetId, row, column,
        value: this.linksByCell.get(cellKey(sheetId, row, column))?.rawValue ?? oldText,
        formula: this.linksByCell.get(cellKey(sheetId, row, column))?.formula })));
      operations.length = 0;
      richOperations.length = 0;
      richCreations.length = 0;
      formulaOperations.length = 0;
      formulaCreations.length = 0;
      formulaConversions.length = 0;
      numberConversions.length = 0;
      numberUpdates.length = 0;
      blankChanges.length = 0;
      const reason = richError || (rejectedUnsafeNumber
        ? '无法安全还原该数字，已恢复原公式；请直接编辑单元格输入原始数字'
        : '粘贴包含不可编辑单元格或超过 10000 个改动，已恢复原值');
      this.onStatus(reason);
      this.onError(reason);
    }
    if (rejected.length) {
      this.withApplying(() => rejected.forEach((cell) => {
        const range = this.workbook.getSheetBySheetId(cell.sheetId)?.getRange(cell.row, cell.column);
        if (cell.formula) range?.setFormula(cell.formula);
        else {
          const link = this.linksByCell.get(cellKey(cell.sheetId, cell.row, cell.column));
          range?.setValue(link ? restoredLiteral(link, cell.value) : cell.value);
        }
      }));
    }
    if (!operations.length && !richOperations.length && !richCreations.length && !blankChanges.length && !formulaOperations.length
      && !formulaCreations.length && !formulaConversions.length && !numberConversions.length && !numberUpdates.length) return;
    const patchId = crypto.randomUUID();
    const blankOperations: HcdXlsxCellSet[] = blankChanges.map(blank => ({
      type: 'xlsx.cell.set', sheetId: blank.sheetId,
      row: blank.row + 1, column: blank.column + 1, text: blank.text,
    }));
    const patch: HcdPatchBatch = {
      schemaVersion: richCreations.length || richConversion || (richOperations.length > 0 && operationCount > richOperations.length + operations.length) ? 'hcd-patch/50' : richOperations.length ? 'hcd-patch/49' : numberConversions.length || numberUpdates.length ? 'hcd-patch/29' : formulaConversions.length ? 'hcd-patch/28'
        : (formulaCreations.length || formulaOperations.length) && operationCount > 1
        ? 'hcd-patch/22' : formulaCreations.length ? 'hcd-patch/21' : formulaOperations.length ? 'hcd-patch/20' : blankChanges.length
        ? operations.length + blankChanges.length === 1 ? 'hcd-patch/7' : 'hcd-patch/19'
        : 'hcd-patch/1',
      documentId: this.client.manifest.documentId,
      patchId,
      baseRevision: this.client.manifest.revision,
      actor: { client: 'officecli-hcd-univer-viewer' },
      operations: [...operations, ...richOperations, ...richCreations, ...blankOperations, ...formulaOperations, ...formulaCreations, ...formulaConversions, ...numberConversions, ...numberUpdates],
      metadata: { rootHash: this.client.manifest.rootHash },
    };
    this.pending.set(patchId, { links, previous, blanks: [...blankChanges, ...richCreations.map(({ sheetId, row, column }) => ({ sheetId, row: row - 1, column: column - 1 })),
      ...formulaCreations.map(({ sheetId, row, column }) => ({ sheetId, row: row - 1, column: column - 1, text: '' }))],
      convertedFormulaIds: new Set([...formulaConversions, ...numberConversions].map(operation => operation.nodeId)),
      convertedNumberValues: new Map([...numberConversions, ...numberUpdates].map(operation => [operation.nodeId, operation.value])),
      formulaUpdates: new Map(formulaOperations.map(operation => [operation.nodeId, operation.formula])),
      richUpdates: new Map(richOperations.map(operation => [operation.nodeId, operation.runs])) });
    window.dispatchEvent(new CustomEvent<HcdPatchEventDetail>('hcd-patch', { detail: {
      patch, changes: [...changes, ...richCreations.map(({sheetId,row,column,runs}) => ({sheetId,row:row-1,column:column-1,oldText:'',newText:runs.map(run=>run.text).join('')})), ...blankChanges.map(blank => ({
        sheetId: blank.sheetId, row: blank.row, column: blank.column, oldText: '', newText: blank.text,
      })), ...formulaCreations.map(({ sheetId, row, column, formula }) => ({
        sheetId, row: row - 1, column: column - 1, oldText: '', newText: formula,
      }))],
    } }));
    this.onStatus(`patch ${patchId.slice(0, 8)} 等待服务端确认`);
  }

  private evictOutsideWindow(activeSheetId: string, keep: Set<string>): void {
    const retainedCells = new Map<string, { blank: boolean }>();
    const retainedRows = new Set<string>();
    const retainedVisuals = new Set<string>();
    for (const [chunkId, runtime] of this.runtimes) {
      if (runtime.sheetId !== activeSheetId || !keep.has(chunkId)) continue;
      for (const cell of runtime.cells) retainedCells.set(cellKey(runtime.sheetId, cell.row, cell.column), cell);
      for (const row of runtime.rows) retainedRows.add(`${runtime.sheetId}:${row}`);
      for (const nodeId of runtime.visualIds) retainedVisuals.add(`${runtime.sheetId}:visual:${nodeId}`);
    }
    for (const [chunkId, runtime] of this.runtimes) {
      const isPending = [...this.pending.values()].some(({ links, blanks }) =>
        links.some((link) => link.chunkId === chunkId)
          || blanks.some(blank => blank.sheetId === runtime.sheetId && runtime.cells.some((cell) =>
            cell.blank && cell.row === blank.row && cell.column === blank.column)));
      if (isPending || (runtime.sheetId === activeSheetId && keep.has(chunkId))) continue;
      const sheet = this.workbook.getSheetBySheetId(runtime.sheetId);
      if (!sheet) continue;
      this.withApplying(() => {
        if (runtime.cells.length) {
          const values: IObjectMatrixPrimitiveType<ICellData> = {};
          let minRow = Number.MAX_SAFE_INTEGER;
          let maxRow = 0;
          let minColumn = Number.MAX_SAFE_INTEGER;
          let maxColumn = 0;
          for (const cell of runtime.cells) {
            const key = cellKey(runtime.sheetId, cell.row, cell.column);
            if (!retainedCells.has(key)) {
              (values[cell.row] ??= {})[cell.column] = { v: null, s: null };
              minRow = Math.min(minRow, cell.row);
              maxRow = Math.max(maxRow, cell.row);
              minColumn = Math.min(minColumn, cell.column);
              maxColumn = Math.max(maxColumn, cell.column);
            }
            if (cell.link) {
              if (this.linksByCell.get(key) === cell.link) this.linksByCell.delete(key);
              if (this.linksByNode.get(cell.link.nodeId) === cell.link) this.linksByNode.delete(cell.link.nodeId);
              if (!retainedCells.has(key)) this.recalculatedFormulas.delete(cell.link.nodeId);
            }
            if (cell.blank && !retainedCells.get(key)?.blank) this.blankCells.delete(key);
          }
          if (minRow !== Number.MAX_SAFE_INTEGER) {
            sheet.getRange(minRow, minColumn, maxRow - minRow + 1, maxColumn - minColumn + 1).setValues(values);
          }
        }
        const images = runtime.visualIds
          .filter((nodeId) => !retainedVisuals.has(`${runtime.sheetId}:visual:${nodeId}`))
          .map((nodeId) => sheet.getImageById(nodeId))
          .filter((image): image is NonNullable<typeof image> => image !== null);
        if (images.length) sheet.deleteImages(images);
      });
      for (const nodeId of runtime.visualIds) {
        const key = `${runtime.sheetId}:visual:${nodeId}`;
        if (!retainedVisuals.has(key)) this.appliedDimensions.delete(key);
      }
      for (const row of runtime.rows) {
        const key = `${runtime.sheetId}:${row}`;
        if (!retainedRows.has(key)) this.loadedRowCeilings.delete(key);
      }
      this.runtimes.delete(chunkId);
      this.loaded.delete(chunkId);
      this.loadedVersions.delete(chunkId);
    }
  }

  private canEditBlankCell(sheetId: string, row: number, column: number): boolean {
    if (this.isPivotCell(sheetId, row, column)) return false;
    if (this.blankCells.has(cellKey(sheetId, row, column))
      || column < (this.loadedRowCeilings.get(`${sheetId}:${row}`) ?? 0)) return true;
    // A worksheet HCD just created, like a source tab that has no rows at all,
    // has one window that covers no range. Its first row is where the first
    // cell opens that window, so it is editable the way the row past an
    // imported grid is; later rows follow once the window has a range.
    if (row === 0 && column < 256 && this.client.descriptors.some(({ chunkId, grid }) =>
      grid?.sheetId === sheetId && grid.kind === 'cells'
      && grid.rowStart === undefined && grid.rowEnd === undefined
      && this.loaded.has(chunkId))) return true;
    // The first row after the imported grid has no HCD row markup yet. The
    // server extends the final cell window when its first cell is created.
    const tail = this.client.descriptors
      .filter(({ grid }) => grid?.sheetId === sheetId && grid.kind === 'cells')
      .reduce<ChunkDescriptor | undefined>((latest, descriptor) =>
        (descriptor.grid?.rowEnd ?? 0) > (latest?.grid?.rowEnd ?? 0) ? descriptor : latest,
      undefined);
    return column < 256 && tail?.grid?.rowEnd === row && this.loaded.has(tail.chunkId);
  }

  private withApplying(operation: () => void): void {
    this.applying += 1;
    try { operation(); } finally { this.applying -= 1; }
  }
}
