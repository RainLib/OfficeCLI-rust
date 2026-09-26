import type { FUniver, ICellData, IObjectMatrixPrimitiveType, IStyleData } from '@univerjs/presets';
import type { FWorkbook, FWorksheet } from '@univerjs/preset-sheets-core';
import { HcdBundleClient, type ChunkDescriptor } from './hcd.ts';
import { parseGridChunk, type NodeLink, type ParsedGridChunk, type ParsedVisual } from './hcd-parser.ts';

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

export interface HcdXlsxFormulaCreate {
  type: 'xlsx.formula.create';
  sheetId: string;
  row: number;
  column: number;
  formula: string;
}

export interface HcdPatchBatch {
  schemaVersion: 'hcd-patch/1' | 'hcd-patch/7' | 'hcd-patch/19' | 'hcd-patch/20' | 'hcd-patch/21' | 'hcd-patch/22' | 'hcd-patch/28';
  documentId: string;
  patchId: string;
  baseRevision: number;
  actor: Record<string, string>;
  operations: Array<HcdTextSplice | HcdXlsxCellSet | HcdXlsxFormulaSet | HcdXlsxFormulaCreate | HcdXlsxFormulaToValue>;
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

export class HcdUniverAdapter {
  private readonly loaded = new Set<string>();
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
  private applying = 0;

  constructor(
    readonly client: HcdBundleClient,
    readonly univerAPI: FUniver,
    readonly workbook: FWorkbook,
    readonly mode: HcdViewerMode,
    private readonly onStatus: (message: string) => void,
    private readonly styleCatalog: Record<string, IStyleData> = {},
  ) {
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
      if (this.mode === 'readonly') {
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
    this.univerAPI.addEvent(this.univerAPI.Event.BeforeCommandExecute, (event) => {
      if (
        this.mode === 'readonly'
        && !this.applying
        && event.type === this.univerAPI.Enum.CommandType.MUTATION
      ) {
        event.cancel = true;
      }
    });
    this.univerAPI.addEvent(this.univerAPI.Event.SheetValueChanged, (event) => {
      if (this.applying) return;
      void this.captureChanges(event.effectedRanges);
    });
    await this.ensureVisible(this.workbook.getActiveSheet());
  }

  getNodeAt(sheetId: string, row: number, column: number): NodeLink | undefined {
    return this.linksByCell.get(cellKey(sheetId, row, column));
  }

  async focusCell(sheetId: string, row: number, column: number): Promise<void> {
    const sheet = this.workbook.getSheetBySheetId(sheetId);
    if (!sheet) throw new Error('工作表不存在');
    this.workbook.setActiveSheet(sheet);
    sheet.scrollToCell(row, column);
    sheet.setActiveRange(sheet.getRange(row, column));
    await this.ensureVisible(sheet);
  }

  async focusNode(nodeId: string): Promise<boolean> {
    const link = this.linksByNode.get(nodeId);
    if (!link) return false;
    const sheet = this.workbook.getSheetBySheetId(link.sheetId);
    if (!sheet) return false;
    this.workbook.setActiveSheet(sheet);
    sheet.scrollToCell(link.row, link.column);
    sheet.setActiveRange(sheet.getRange(link.row, link.column));
    return true;
  }

  async loadRange(sheetId: string, startRow: number, endRow: number): Promise<void> {
    const generation = (this.rangeGeneration.get(sheetId) ?? 0) + 1;
    this.rangeGeneration.set(sheetId, generation);
    const cellDescriptors = this.client.cellWindows(sheetId, startRow + 1, endRow + 1);
    const visualDescriptors = this.client.visuals(sheetId).filter(({ grid }) => grid?.rowStart === undefined
      || grid.rowEnd === undefined
      || (grid.rowEnd >= startRow + 1 && grid.rowStart <= endRow + 1));
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
  }

  acknowledgePatch(patchId: string, revision: number, nodeHashes: Record<string, string>): void {
    const pending = this.pending.get(patchId);
    if (!pending) return;
    for (const link of pending.links) {
      const nextHash = nodeHashes[link.nodeId];
      if (nextHash) link.nodeHash = nextHash;
      const sheet = this.workbook.getSheetBySheetId(link.sheetId);
      if (pending.convertedFormulaIds.has(link.nodeId)) {
        link.formulaEditable = false;
        link.editable = true;
        link.formula = undefined;
        link.text = String(sheet?.getRange(link.row, link.column).getValue() ?? '');
        link.rawValue = undefined;
      } else if (link.formulaEditable) {
        link.formula = String(sheet?.getRange(link.row, link.column).getFormulas?.()[0]?.[0] ?? link.formula ?? '');
        link.text = link.formula;
      } else {
        link.text = String(sheet?.getRange(link.row, link.column).getValue() ?? '');
        link.rawValue = undefined;
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
        else range?.setValue(pending.previous[index]);
      });
      for (const { sheetId, row, column } of pending.blanks) {
        this.workbook.getSheetBySheetId(sheetId)?.getRange(row, column).setValue('');
      }
    });
    this.pending.delete(patchId);
    this.onStatus(reason);
  }

  hasPendingPatch(): boolean { return this.pending.size > 0; }

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

  /** Reload the visible HCD windows after another editor commits a revision. */
  async refreshFromServer(): Promise<boolean> {
    if (this.hasPendingPatch()) return false;
    const activeSheet = this.workbook.getActiveSheet();
    const activeRange = activeSheet.getActiveRange();
    const selection = activeRange && {
      row: activeRange.getRow(), column: activeRange.getColumn(),
      height: activeRange.getHeight(), width: activeRange.getWidth(),
    };
    await this.client.open();
    for (const key of this.appliedDimensions) {
      if (/^s_[0-9a-f]{32}:row:/.test(key)) this.appliedDimensions.delete(key);
    }
    for (const key of this.appliedDimensions) {
      const match = key.match(/^(s_[0-9a-f]{32}):merge:(\d+):(\d+):(\d+):(\d+)$/);
      if (!match) continue;
      const sheet = this.workbook.getSheetBySheetId(match[1]);
      if (sheet) {
        this.withApplying(() => sheet.getRange(Number(match[2]), Number(match[3]),
          Number(match[4]) - Number(match[2]) + 1,
          Number(match[5]) - Number(match[3]) + 1).breakApart());
      }
      this.appliedDimensions.delete(key);
    }
    this.evictOutsideWindow('', new Set());
    this.workbook.setActiveSheet(activeSheet);
    if (selection) activeSheet.setActiveRange(activeSheet.getRange(
      selection.row, selection.column, selection.height, selection.width,
    ));
    await this.ensureVisible(activeSheet);
    this.onStatus(`revision ${this.client.manifest.revision} · 已同步其他协作者的修改`);
    return true;
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
    if (this.loaded.has(descriptor.chunkId)) return;
    const existing = this.loading.get(descriptor.chunkId);
    if (existing) return existing;
    const operation = (async () => {
      const chunk = await this.client.readChunk(descriptor);
      const parsed = parseGridChunk(chunk, (href) => this.client.resolve(href).toString(), this.styleCatalog);
      const sheet = this.workbook.getSheetBySheetId(descriptor.grid!.sheetId);
      if (!sheet) throw new Error(`工作表不存在: ${descriptor.grid!.sheetName}`);
      await this.applyParsedChunk(sheet, descriptor, parsed);
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
      this.onStatus(`revision ${this.client.manifest.revision} · ${this.loaded.size}/${this.client.descriptors.length} 个分片已加载`);
    })().finally(() => this.loading.delete(descriptor.chunkId));
    this.loading.set(descriptor.chunkId, operation);
    return operation;
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
      if (this.appliedDimensions.has(key)) continue;
      const geometry = this.resolveVisualGeometry(sheet, visual);
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
    const formulaOperations: HcdXlsxFormulaSet[] = [];
    const formulaConversions: HcdXlsxFormulaToValue[] = [];
    const formulaCreations: HcdXlsxFormulaCreate[] = [];
    const changes: HcdPatchEventDetail['changes'] = [];
    const links: NodeLink[] = [];
    const previous: Array<string | number> = [];
    const seen = new Set<string>();
    const rejected: Array<{ sheetId: string; row: number; column: number; value: string | number; formula?: string }> = [];
    let rejectedNumericFormula = false;
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
          const rawValue = values[rowOffset]?.[columnOffset];
          const next = String(rawValue ?? '');
          const formula = String(formulas?.[rowOffset]?.[columnOffset] ?? '');
          const enteredFormula = formula || (next.startsWith('=') ? next : '');
          if (link?.formulaEditable && this.mode === 'editable' && enteredFormula) {
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
            const numericLike = next.trim() !== '' && /\d/.test(next)
              && Number.isFinite(Number(next.trim().replaceAll(',', '')));
            if ((rawValue !== null && rawValue !== undefined && rawValue !== '' && typeof rawValue !== 'string')
              || cellType === 2 || (numericLike && cellType !== 4)) {
              rejectedNumericFormula = true;
              rejected.push({ sheetId: link.sheetId, row, column, value: link.text, formula: link.formula });
              continue;
            }
            formulaConversions.push({ type: 'xlsx.formula.to-value', nodeId: link.nodeId,
              sheetId: link.sheetId, text: next, precondition: { nodeHash: link.nodeHash } });
            changes.push({ sheetId: link.sheetId, row, column, oldText: link.formula ?? link.text,
              newText: next, nodeId: link.nodeId });
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
    const operationCount = operations.length + blankChanges.length + formulaOperations.length
      + formulaCreations.length + formulaConversions.length;
    if (rejected.length || operationCount > 10_000) {
      rejected.push(...blankChanges.map(({ sheetId, row, column }) => ({ sheetId, row, column, value: '' })));
      rejected.push(...formulaCreations.map(({ sheetId, row, column }) => ({ sheetId, row: row - 1, column: column - 1, value: '' })));
      rejected.push(...changes.map(({ sheetId, row, column, oldText }) => ({ sheetId, row, column,
        value: this.linksByCell.get(cellKey(sheetId, row, column))?.rawValue ?? oldText,
        formula: this.linksByCell.get(cellKey(sheetId, row, column))?.formula })));
      operations.length = 0;
      formulaOperations.length = 0;
      formulaCreations.length = 0;
      formulaConversions.length = 0;
      blankChanges.length = 0;
      this.onStatus(rejectedNumericFormula
        ? '公式转数字需要保留数值类型，当前仅支持改为文字或清空；已恢复原公式'
        : '粘贴包含不可编辑单元格或超过 10000 个改动，已恢复原值');
    }
    if (rejected.length) {
      this.withApplying(() => rejected.forEach((cell) => {
        const range = this.workbook.getSheetBySheetId(cell.sheetId)?.getRange(cell.row, cell.column);
        if (cell.formula) range?.setFormula(cell.formula);
        else range?.setValue(cell.value);
      }));
    }
    if (!operations.length && !blankChanges.length && !formulaOperations.length
      && !formulaCreations.length && !formulaConversions.length) return;
    const patchId = crypto.randomUUID();
    const blankOperations: HcdXlsxCellSet[] = blankChanges.map(blank => ({
      type: 'xlsx.cell.set', sheetId: blank.sheetId,
      row: blank.row + 1, column: blank.column + 1, text: blank.text,
    }));
    const patch: HcdPatchBatch = {
      schemaVersion: formulaConversions.length ? 'hcd-patch/28'
        : (formulaCreations.length || formulaOperations.length) && operationCount > 1
        ? 'hcd-patch/22' : formulaCreations.length ? 'hcd-patch/21' : formulaOperations.length ? 'hcd-patch/20' : blankChanges.length
        ? operations.length + blankChanges.length === 1 ? 'hcd-patch/7' : 'hcd-patch/19'
        : 'hcd-patch/1',
      documentId: this.client.manifest.documentId,
      patchId,
      baseRevision: this.client.manifest.revision,
      actor: { client: 'officecli-hcd-univer-viewer' },
      operations: [...operations, ...blankOperations, ...formulaOperations, ...formulaCreations, ...formulaConversions],
      metadata: { rootHash: this.client.manifest.rootHash },
    };
    this.pending.set(patchId, { links, previous, blanks: [...blankChanges,
      ...formulaCreations.map(({ sheetId, row, column }) => ({ sheetId, row: row - 1, column: column - 1, text: '' }))],
      convertedFormulaIds: new Set(formulaConversions.map(operation => operation.nodeId)) });
    window.dispatchEvent(new CustomEvent<HcdPatchEventDetail>('hcd-patch', { detail: {
      patch, changes: [...changes, ...blankChanges.map(blank => ({
        sheetId: blank.sheetId, row: blank.row, column: blank.column, oldText: '', newText: blank.text,
      })), ...formulaCreations.map(({ sheetId, row, column, formula }) => ({
        sheetId, row: row - 1, column: column - 1, oldText: '', newText: formula,
      }))],
    } }));
    this.onStatus(`patch ${patchId.slice(0, 8)} 等待服务端确认`);
  }

  private evictOutsideWindow(activeSheetId: string, keep: Set<string>): void {
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
            (values[cell.row] ??= {})[cell.column] = { v: null, s: null };
            minRow = Math.min(minRow, cell.row);
            maxRow = Math.max(maxRow, cell.row);
            minColumn = Math.min(minColumn, cell.column);
            maxColumn = Math.max(maxColumn, cell.column);
            if (cell.link) {
              this.linksByCell.delete(cellKey(cell.link.sheetId, cell.row, cell.column));
              this.linksByNode.delete(cell.link.nodeId);
              this.recalculatedFormulas.delete(cell.link.nodeId);
            }
            if (cell.blank) this.blankCells.delete(cellKey(runtime.sheetId, cell.row, cell.column));
          }
          sheet.getRange(minRow, minColumn, maxRow - minRow + 1, maxColumn - minColumn + 1).setValues(values);
        }
        const images = runtime.visualIds
          .map((nodeId) => sheet.getImageById(nodeId))
          .filter((image): image is NonNullable<typeof image> => image !== null);
        if (images.length) sheet.deleteImages(images);
      });
      for (const nodeId of runtime.visualIds) {
        this.appliedDimensions.delete(`${runtime.sheetId}:visual:${nodeId}`);
      }
      for (const row of runtime.rows) this.loadedRowCeilings.delete(`${runtime.sheetId}:${row}`);
      this.runtimes.delete(chunkId);
      this.loaded.delete(chunkId);
    }
  }

  private canEditBlankCell(sheetId: string, row: number, column: number): boolean {
    return this.blankCells.has(cellKey(sheetId, row, column))
      || column < (this.loadedRowCeilings.get(`${sheetId}:${row}`) ?? 0);
  }

  private withApplying(operation: () => void): void {
    this.applying += 1;
    try { operation(); } finally { this.applying -= 1; }
  }
}
