import type { FUniver, ICellData, IObjectMatrixPrimitiveType } from '@univerjs/presets';
import type { FWorkbook, FWorksheet } from '@univerjs/preset-sheets-core';
import { HcdBundleClient, type ChunkDescriptor } from './hcd.ts';
import type { NodeLink, ParsedGridChunk, ParsedVisual } from './hcd-parser.ts';

export interface HcdTextSplice {
  type: 'text.splice';
  nodeId: string;
  start: number;
  deleteCount: number;
  insertText: string;
  precondition: { nodeHash: string };
}

export interface HcdPatchBatch {
  schemaVersion: 'hcd-patch/1';
  documentId: string;
  patchId: string;
  baseRevision: number;
  actor: Record<string, string>;
  operations: HcdTextSplice[];
  metadata: Record<string, string>;
}

export interface HcdPatchEventDetail {
  patch: HcdPatchBatch;
  changes: Array<{ sheetId: string; row: number; column: number; oldText: string; newText: string }>;
}

export type HcdViewerMode = 'readonly' | 'editable';

/** Optional owner-managed drafts. The reference editor owns persistence and
 * submission; the standalone adapter retains its existing patch event API. */
export interface HcdGridDraftPort {
  text(link: Readonly<NodeLink>): string | undefined;
  edit(changes: ReadonlyArray<{ link: Readonly<NodeLink>; text: string }>, revision: number): void;
  writable(): boolean;
  canStartEdit?():boolean;
  observed?(nodeId:string,text:string):void;
  rejected?(nodeId:string):void;
  blankAllowed?(sheetId:string,row:number,column:number):boolean;
  blankActive?(sheetId:string,row:number,column:number):boolean;
  blankPrepare?(sheetId:string,row:number,column:number):boolean;
  blankObserved?(sheetId:string,row:number,column:number,text:string):void;
  /** Batch capture can be permitted independently of single-cell edits. */
  blankBatchWritable?():boolean;
  /** The owner must synchronously take responsibility for the whole batch,
   * including a durable draft or an explicit recovery path, before returning true. */
  stageBlankBatch?(cells:ReadonlyArray<{sheetId:string;row:number;column:number;text:string}>,revision:number,rootHash:string):boolean;
}

interface PendingPatch {
  links: NodeLink[];
  previous: string[];
}

interface ChunkRuntime {
  sheetId: string;
  kind: 'cells' | 'picture' | 'chart';
  cells: Array<{ row: number; column: number; link?: NodeLink }>;
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
  private visibleLoadSequence = 0;
  private disposed = false;
  private readonly subscriptions: Array<{dispose():void}> = [];
  private scheduledFrames = new Set<number>();
  private readonly loaded = new Set<string>();
  private readonly remoteText = new Map<string,{text:string;nodeHash:string;revision:number}>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly appliedDimensions = new Set<string>();
  private readonly linksByCell = new Map<string, NodeLink>();
  private readonly linksByNode = new Map<string, NodeLink>();
  private readonly canonicalCells = new Map<string, ICellData>();
  private readonly canonicalGrid = new Map<string, ICellData>();
  private readonly paintedDrafts = new Set<string>();
  private readonly pending = new Map<string, PendingPatch>();
  private readonly runtimes = new Map<string, ChunkRuntime>();
  private rangeGeneration = 0;
  private requestedWindow?: { sheetId: string; keep: Set<string> };
  private editingChunk?: string;
  private readonly dimensions = new Map<string, SheetDimensions>();
  private applying = 0;

  constructor(
    readonly client: HcdBundleClient,
    readonly univerAPI: FUniver,
    readonly workbook: FWorkbook,
    readonly mode: HcdViewerMode,
    private readonly onStatus: (message: string) => void,
    private readonly drafts?: HcdGridDraftPort,
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
    // The worksheet onScroll facade can be registered before its render exists,
    // in which case it silently installs no listener. The global Scroll event
    // is attached by Univer once rendering is ready.
    this.subscriptions.push(this.univerAPI.addEvent(this.univerAPI.Event.Scroll, ({ workbook, worksheet }) => {
      if (workbook.getId() === this.workbook.getId()) this.scheduleVisible(worksheet);
    }));
    this.subscriptions.push(this.univerAPI.addEvent(this.univerAPI.Event.ActiveSheetChanged, ({ activeSheet }) => {
      this.scheduleVisible(activeSheet);
    }));
    this.subscriptions.push(this.univerAPI.addEvent(this.univerAPI.Event.BeforeSheetEditStart, (event) => {
      if (this.mode === 'readonly' || this.drafts && (!this.drafts.writable()||this.drafts.canStartEdit?.()===false)) {
        event.cancel = true;
        return;
      }
      const key = cellKey(event.worksheet.getSheetId(), event.row, event.column);
      const link = this.linksByCell.get(key);
      if (!link) {
        if (!this.drafts?.blankAllowed?.(event.worksheet.getSheetId(),event.row,event.column)) {
          event.cancel = true;
          this.onStatus(this.drafts?.blankPrepare?.(event.worksheet.getSheetId(),event.row,event.column)?'workbookBlankPreparing':'workbookCellUnmapped');
        }
      } else if (!link.editable) {
        event.cancel = true;
        this.onStatus('workbookCellProtected');
      } else if ([...this.pending.values()].some(({ links }) => links.includes(link))) {
        event.cancel = true;
        this.onStatus('workbookCellPending');
      }
    }));
    this.subscriptions.push(this.univerAPI.addEvent(this.univerAPI.Event.BeforeCommandExecute, (event) => {
      if (
        (this.mode === 'readonly' || this.drafts && !this.drafts.writable())
        && !this.applying
        && event.type === this.univerAPI.Enum.CommandType.MUTATION
      ) {
        event.cancel = true;
      }
    }));
    this.subscriptions.push(this.univerAPI.addEvent(this.univerAPI.Event.SheetValueChanged, (event) => {
      if (this.applying) return;
      void this.captureChanges(event.effectedRanges);
    }));
    this.subscriptions.push(this.univerAPI.addEvent(this.univerAPI.Event.SheetEditStarted, (event) => {
      this.editingChunk=this.linksByCell.get(cellKey(event.worksheet.getSheetId(),event.row,event.column))?.chunkId;
    }));
    this.subscriptions.push(this.univerAPI.addEvent(this.univerAPI.Event.SheetEditEnded, () => {
      this.editingChunk=undefined;
      const frame=window.requestAnimationFrame(()=>{this.scheduledFrames.delete(frame);this.trimToVisibleWindow()});
      this.scheduledFrames.add(frame);
    }));
    await this.ensureVisible(this.workbook.getActiveSheet());
  }

  getNodeAt(sheetId: string, row: number, column: number): NodeLink | undefined {
    return this.linksByCell.get(cellKey(sheetId, row, column));
  }

  /** Never treat an unloaded window, formula, numeric cell or other visible
   * non-text cell as an empty source coordinate. A server check is still
   * required after this local readiness check. */
  canInspectBlank(sheetId: string, row: number, column: number): boolean {
    if (this.disposed || !Number.isInteger(row) || !Number.isInteger(column)
      || row < 0 || row >= 1_048_576 || column < 0 || column >= 16_384
      || !this.client.sheets().some(sheet => sheet.sheetId === sheetId)
      || this.requestedWindow?.sheetId !== sheetId
      || this.canonicalGrid.has(cellKey(sheetId, row, column))
      || this.linksByCell.has(cellKey(sheetId, row, column))) return false;
    const windows = this.client.cellWindows(sheetId, row + 1, row + 1);
    return windows.every(chunk => this.requestedWindow!.keep.has(chunk.chunkId) && this.loaded.has(chunk.chunkId));
  }

  cellLabel(nodeId:string):string|undefined {
    const link=this.linksByNode.get(nodeId);
    if(!link)return undefined;
    let column=link.column+1,letters='';
    while(column>0){column--;letters=String.fromCharCode(65+column%26)+letters;column=Math.floor(column/26);}
    const name=this.client.sheets().find(sheet=>sheet.sheetId===link.sheetId)?.sheetName;
    return `${name ? name+'!':''}${letters}${link.row+1}`;
  }

  /** Repaint loaded cells only. Offscreen drafts stay in the workspace store. */
  refreshDrafts(): void {
    // Univer may replace the active in-cell editor's data stream when a
    // programmatic setValues targets that cell. Repaint after editing ends.
    if (!this.drafts || this.workbook.isCellEditing?.()) return;
    this.withApplying(() => {
      for (const link of this.linksByNode.values()) {
        const text = this.drafts!.text(link);
        if (text === undefined && !this.paintedDrafts.has(link.nodeId)) continue;
        const original = this.canonicalCells.get(link.nodeId) ?? { v: link.text };
        this.workbook.getSheetBySheetId(link.sheetId)?.getRange(link.row, link.column)
          .setValues([[text === undefined ? original : { ...original, v: text, t: 1, f: null }]]);
        if (text === undefined) this.paintedDrafts.delete(link.nodeId);
        else this.paintedDrafts.add(link.nodeId);
      }
    });
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

  async loadRange(sheetId: string, startRow: number, endRow: number, pinnedRows: ReadonlyArray<{startRow:number;endRow:number}> = []): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.rangeGeneration;
    const ranges = [{startRow,endRow}, ...pinnedRows];
    const cellDescriptors = [...new Map(ranges.flatMap(range => this.client.cellWindows(sheetId, range.startRow + 1, range.endRow + 1)).map(descriptor => [descriptor.chunkId, descriptor])).values()];
    const visualDescriptors = this.client.visuals(sheetId).filter(({ grid }) => grid?.rowStart === undefined
      || grid.rowEnd === undefined
      || ranges.some(range => grid.rowEnd! >= range.startRow + 1 && grid.rowStart! <= range.endRow + 1));
    const descriptors = [...cellDescriptors, ...visualDescriptors];
    const keep = new Set(descriptors.map(({ chunkId }) => chunkId));
    this.requestedWindow = { sheetId, keep };
    // Cell chunks establish the real row/column geometry. Drawings must be
    // inserted afterwards or their two-cell anchors are measured against the
    // temporary default grid.
    await Promise.all(cellDescriptors.map((descriptor) => this.loadChunk(descriptor)));
    if (this.disposed || this.rangeGeneration !== generation) return;
    await Promise.all(visualDescriptors.map((descriptor) => this.loadChunk(descriptor)));
    if (this.disposed || this.rangeGeneration !== generation) return;
    this.evictOutsideWindow(sheetId, keep);
  }

  /** Revisit the latest window after the in-cell editor has closed. */
  trimToVisibleWindow(): void {
    if (this.disposed || !this.requestedWindow) return;
    this.evictOutsideWindow(this.requestedWindow.sheetId, this.requestedWindow.keep);
  }

  applyRemoteText(nodeId: string, text: string, nodeHash: string, revision: number): boolean {
    const link = this.linksByNode.get(nodeId);
    if (link && [...this.pending.values()].some(({ links }) => links.includes(link))) return false;
    const existing=this.remoteText.get(nodeId);
    if(existing&&existing.revision>revision)return true;
    if(!existing&&this.remoteText.size>=10_000)return false;
    this.remoteText.set(nodeId,{text,nodeHash,revision});
    this.client.manifest.revision = Math.max(this.client.manifest.revision, revision);
    if(!link)return true;
    this.withApplying(() => {
      this.workbook.getSheetBySheetId(link.sheetId)?.getRange(link.row, link.column).setValue(this.drafts?.text({ ...link, text, nodeHash, revision }) ?? text);
    });
    link.text = text;
    link.nodeHash = nodeHash;
    link.revision = revision;
    this.canonicalCells.set(nodeId, { ...this.canonicalCells.get(nodeId), v: text, t: 1, f: null, si: null, ref: null, xf: null, p: null });
    this.canonicalGrid.set(cellKey(link.sheetId,link.row,link.column),this.canonicalCells.get(nodeId)!);
    return true;
  }

  acknowledgePatch(patchId: string, revision: number, nodeHashes: Record<string, string>): void {
    const pending = this.pending.get(patchId);
    if (!pending) return;
    for (const link of pending.links) {
      const nextHash = nodeHashes[link.nodeId];
      if (nextHash) link.nodeHash = nextHash;
      const sheet = this.workbook.getSheetBySheetId(link.sheetId);
      link.text = String(sheet?.getRange(link.row, link.column).getValue() ?? '');
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
        this.workbook.getSheetBySheetId(link.sheetId)?.getRange(link.row, link.column).setValue(pending.previous[index]);
      });
    });
    this.pending.delete(patchId);
    this.onStatus(reason);
  }

  private scheduleVisible(sheet: FWorksheet): void {
    if(this.disposed)return;
    const frame=window.requestAnimationFrame(() => {this.scheduledFrames.delete(frame);if(!this.disposed)void this.loadVisible(sheet)});
    this.scheduledFrames.add(frame);
  }

  dispose():void {
    this.disposed=true;this.visibleLoadSequence++;
    for (const subscription of this.subscriptions.splice(0)) subscription?.dispose?.();
    for(const frame of this.scheduledFrames)window.cancelAnimationFrame(frame);
    this.scheduledFrames.clear();
  }

  /** Retry only the active window, retaining local drafts and loaded data. */
  async retryVisible(): Promise<void> {
    if(this.disposed)return;
    await this.loadVisible(this.workbook.getActiveSheet());
  }

  private async loadVisible(sheet: FWorksheet): Promise<void> {
    if(this.disposed)return;
    if (sheet.getSheetId() !== this.workbook.getActiveSheet().getSheetId()) return;
    const sequence = ++this.visibleLoadSequence;
    try {
      await this.ensureVisible(sheet);
      if (!this.disposed && sequence === this.visibleLoadSequence && sheet.getSheetId() === this.workbook.getActiveSheet().getSheetId()) this.onStatus('workbookVisibleLoaded');
    } catch {
      if (!this.disposed && sequence === this.visibleLoadSequence && sheet.getSheetId() === this.workbook.getActiveSheet().getSheetId()) this.onStatus('workbookVisibleLoadFailed');
    }
  }

  private async ensureVisible(sheet: FWorksheet): Promise<void> {
    const range = sheet.getVisibleRange();
    const start = Math.max(0, (range?.startRow ?? 0) - 128);
    const end = Math.min(sheet.getMaxRows() - 1, (range?.endRow ?? 127) + 128);
    // Frozen rows remain visible even when the main viewport is far away.
    // Keep their chunks in the same generation and eviction set as the window.
    const frozen = Math.min(sheet.getMaxRows(), Math.max(0, sheet.getFreeze()?.ySplit ?? 0));
    const pinnedRows: Array<{startRow:number;endRow:number}> = [];
    if (frozen) {
      const viewports = sheet.getVisibleRangesOfAllViewports?.();
      const keys = this.univerAPI.Enum?.SHEET_VIEWPORT_KEY;
      for (const key of keys ? [keys.VIEW_MAIN_TOP, keys.VIEW_MAIN_LEFT_TOP] : []) {
        const visible = viewports?.get(key);
        if (visible && visible.startRow < frozen) pinnedRows.push({startRow:Math.max(0, visible.startRow),endRow:Math.min(frozen-1,visible.endRow)});
      }
      // Before the frozen viewport is rendered, bound the fallback so an
      // unusually large freeze does not materialize the entire worksheet.
      if (!pinnedRows.length) pinnedRows.push({startRow:0,endRow:Math.min(frozen-1,127)});
    }
    await this.loadRange(sheet.getSheetId(), start, end, pinnedRows);
  }

  private async loadChunk(descriptor: ChunkDescriptor): Promise<void> {
    if (this.disposed) return;
    if (this.loaded.has(descriptor.chunkId)) return;
    const existing = this.loading.get(descriptor.chunkId);
    if (existing) return existing;
    const operation = (async () => {
      const chunk = await this.client.readChunk(descriptor);
      if (this.disposed) return;
      const parsed = await this.parseChunk(chunk);
      if (this.disposed) return;
      const sheet = this.workbook.getSheetBySheetId(descriptor.grid!.sheetId);
      if (!sheet) throw new Error(`工作表不存在: ${descriptor.grid!.sheetName}`);
      await this.applyParsedChunk(sheet, descriptor, parsed, this.client.chunkRevision());
      if (this.disposed) return;
      this.runtimes.set(descriptor.chunkId, {
        sheetId: descriptor.grid!.sheetId,
        kind: descriptor.grid!.kind,
        cells: parsed.cells.map(({ row, column, link }) => ({ row, column, link })),
        visualIds: parsed.visuals.map(({ nodeId }) => nodeId),
      });
      this.loaded.add(descriptor.chunkId);
      this.onStatus(`revision ${this.client.manifest.revision} · ${this.loaded.size}/${this.client.descriptors.length} 个分片已加载`);
    })().finally(() => {
      this.loading.delete(descriptor.chunkId);
      // A superseded load can finish after the latest window was cleaned up.
      // Reconcile every completion against the current window, including
      // when another chunk in the same request has already failed.
      if (!this.disposed && this.requestedWindow
        && (descriptor.grid?.sheetId !== this.requestedWindow.sheetId || !this.requestedWindow.keep.has(descriptor.chunkId))) {
        this.evictOutsideWindow(this.requestedWindow.sheetId, this.requestedWindow.keep);
      }
    });
    this.loading.set(descriptor.chunkId, operation);
    return operation;
  }

  private async parseChunk(chunk: Awaited<ReturnType<HcdBundleClient['readChunk']>>): Promise<ParsedGridChunk> {
    const { parseGridChunk } = await import('./hcd-parser.ts');
    return parseGridChunk(chunk, (href) => this.client.resolve(href).toString());
  }

  private async applyParsedChunk(sheet: FWorksheet, descriptor: ChunkDescriptor, parsed: ParsedGridChunk, revision:number): Promise<void> {
    if (this.disposed) return;
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
          const update=cell.link&&this.remoteText.get(cell.link.nodeId);
          if(update&&update.revision>=revision){
            if(cell.formula||!cell.link!.editable)throw new Error('workbook remote text target is protected');
            cell.link!.text=update.text;cell.link!.nodeHash=update.nodeHash;cell.link!.revision=update.revision;
            cell.data={...cell.data,v:update.text,t:1,f:null,si:null,ref:null,xf:null,p:null};
          }
          this.canonicalGrid.set(cellKey(sheet.getSheetId(),cell.row,cell.column),cell.data);
          if(cell.link&&(!update||update.revision<revision))cell.link.revision=revision;
          const draft = cell.link && this.drafts?.text(cell.link);
          (values[cell.row] ??= {})[cell.column] = draft === undefined ? cell.data : { ...cell.data, v: draft, t: 1, f: null };
          minRow = Math.min(minRow, cell.row);
          maxRow = Math.max(maxRow, cell.row);
          minColumn = Math.min(minColumn, cell.column);
          maxColumn = Math.max(maxColumn, cell.column);
          if (cell.link) {
            this.canonicalCells.set(cell.link.nodeId, cell.data);
            if (draft !== undefined) this.paintedDrafts.add(cell.link.nodeId);
            this.linksByCell.set(cellKey(cell.link.sheetId, cell.row, cell.column), cell.link);
            this.linksByNode.set(cell.link.nodeId, cell.link);
          }
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
      if (this.disposed) return;
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
      if (this.disposed) return;
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

  private async captureChanges(ranges: Array<{ getSheetId(): string; getRow(): number; getColumn(): number; getHeight(): number; getWidth(): number; getValues(): unknown[][]; getCellDataGrid(): (ICellData|null|undefined|void)[][] }>): Promise<void> {
    const drafts: Array<{ link: Readonly<NodeLink>; text: string }> = [];
    const accepted = new Map<string,NodeLink>();
    const operations: HcdTextSplice[] = [];
    const changes: HcdPatchEventDetail['changes'] = [];
    const links: NodeLink[] = [];
    const previous: string[] = [];
    const rejected: Array<{ sheetId: string; row: number; column: number; value?: string }> = [];
    const observed = new Map<string,string>();
    let blank: {sheetId:string;row:number;column:number;text:string}|undefined;
    const batch: Array<{sheetId:string;row:number;column:number;text:string}> = [];
    let unsupportedFormula = false;
    for (const range of ranges) {
      const values = range.getValues();
      const cellData = range.getCellDataGrid();
      for (let rowOffset = 0; rowOffset < range.getHeight(); rowOffset += 1) {
        for (let columnOffset = 0; columnOffset < range.getWidth(); columnOffset += 1) {
          const row = range.getRow() + rowOffset;
          const column = range.getColumn() + columnOffset;
          const link = this.linksByCell.get(cellKey(range.getSheetId(), row, column));
          const data = cellData[rowOffset]?.[columnOffset];
          const formula = Boolean(data?.f || data?.si);
          if(formula) unsupportedFormula = true;
          if (!formula && !link && ranges.length===1 && range.getHeight()===1 && range.getWidth()===1
            && this.mode==='editable' && this.drafts?.writable() && this.drafts.blankActive?.(range.getSheetId(),row,column)) {
            blank={sheetId:range.getSheetId(),row,column,text:String(values[rowOffset]?.[columnOffset]??'')};
            continue;
          }
          if (formula || !link?.editable || this.mode === 'readonly' || this.drafts && !this.drafts.writable()
            || [...this.pending.values()].some(({ links }) => links.includes(link))) {
            // Editing can enter through paste/fill commands without first
            // emitting BeforeSheetEditStart. Revert both read-only mapped
            // cells and blank cells that have no HCD/source-map node.
            rejected.push({
              sheetId: range.getSheetId(),
              row,
              column,
              value: link ? this.drafts?.text(link) ?? link.text : undefined,
            });
            const value=values[rowOffset]?.[columnOffset];
            if (!formula && !link && this.mode==='editable' && (this.drafts?.blankBatchWritable?.() ?? this.drafts?.writable()) && this.drafts?.stageBlankBatch
              && typeof value==='string' && value.length>0 && !value.startsWith('=') && this.canInspectBlank(range.getSheetId(),row,column)) {
              batch.push({sheetId:range.getSheetId(),row,column,text:value});
            }
            continue;
          }
          const next = String(values[rowOffset]?.[columnOffset] ?? '');
          accepted.set(link.nodeId,link);
          if (this.drafts) {
            observed.set(link.nodeId,next);
            if (next !== (this.drafts.text(link) ?? link.text)) drafts.push({ link, text: next });
            continue;
          }
          if (next === link.text) continue;
          operations.push({
            type: 'text.splice',
            nodeId: link.nodeId,
            ...diffText(link.text, next),
            precondition: { nodeHash: link.nodeHash },
          });
          changes.push({ sheetId: link.sheetId, row, column, oldText: link.text, newText: next });
          links.push(link);
          previous.push(link.text);
        }
      }
    }
    if (rejected.length) {
      this.withApplying(() => {
        rejected.forEach((cell) => {
          const original=this.canonicalGrid.get(cellKey(cell.sheetId,cell.row,cell.column))??{v:null,s:null};
          this.workbook.getSheetBySheetId(cell.sheetId)?.getRange(cell.row, cell.column).setValue({...original,v:cell.value ?? original.v ?? null,f:null,si:null,ref:null,xf:null,p:null});
        });
        // A mixed paste is one user operation: if any target is protected,
        // restore supported cells too and never leave a partially staged paste.
        accepted.forEach(link=>{
          const original=this.canonicalCells.get(link.nodeId)??{v:link.text};
          this.workbook.getSheetBySheetId(link.sheetId)?.getRange(link.row,link.column).setValue({...original,v:this.drafts?.text(link)??link.text,f:null,si:null,ref:null,xf:null,p:null});
        });
      });
      for(const cell of rejected){const link=this.linksByCell.get(cellKey(cell.sheetId,cell.row,cell.column));if(link)this.drafts?.rejected?.(link.nodeId);}
      accepted.forEach(link=>this.drafts?.rejected?.(link.nodeId));
      if (!unsupportedFormula && !accepted.size && !blank && batch.length>=2 && batch.length<=4000 && batch.length===rejected.length && this.drafts?.stageBlankBatch) {
        try { if (this.drafts.stageBlankBatch(batch,this.client.chunkRevision(),this.client.manifest.rootHash)) return; }
        catch { /* The unchanged grid and clipboard remain available for retry. */ }
      }
      this.onStatus(unsupportedFormula?'workbookUnsupportedFormula':'workbookUnsupportedPaste');
      return;
    }
    if (blank) { this.drafts?.blankObserved?.(blank.sheetId,blank.row,blank.column,blank.text); return; }
    if (this.drafts && drafts.length) {
      drafts.forEach(({ link }) => this.paintedDrafts.add(link.nodeId));
      try { this.drafts.edit(drafts, this.client.manifest.revision); }
      catch (error) {
        // No successful cell observation follows a rejected draft batch.
        // Release any matching editor capture while keeping its private
        // buffer available for explicit review and recovery.
        accepted.forEach(link=>this.drafts?.rejected?.(link.nodeId));
        this.refreshDrafts();
        this.onStatus(error instanceof Error ? error.message : String(error));
        return;
      }
      observed.forEach((text,id)=>this.drafts?.observed?.(id,text));
      return;
    }
    if(this.drafts){observed.forEach((text,id)=>this.drafts?.observed?.(id,text));return;}
    if (!operations.length) return;
    const patchId = crypto.randomUUID();
    const patch: HcdPatchBatch = {
      schemaVersion: 'hcd-patch/1',
      documentId: this.client.manifest.documentId,
      patchId,
      baseRevision: this.client.manifest.revision,
      actor: { client: 'officecli-hcd-univer-viewer' },
      operations,
      metadata: { rootHash: this.client.manifest.rootHash },
    };
    this.pending.set(patchId, { links, previous });
    window.dispatchEvent(new CustomEvent<HcdPatchEventDetail>('hcd-patch', { detail: { patch, changes } }));
    this.onStatus(`patch ${patchId.slice(0, 8)} 等待服务端确认`);
  }

  private evictOutsideWindow(activeSheetId: string, keep: Set<string>): void {
    // Clearing the active cell can replace its editor's input stream. If the
    // start event did not identify a chunk, retain everything until it ends.
    const editing=this.workbook.isCellEditing?.()===true;
    if (editing&&!this.editingChunk) return;
    for (const [chunkId, runtime] of this.runtimes) {
      const isPending = [...this.pending.values()].some(({ links }) =>
        links.some((link) => link.chunkId === chunkId));
      if (isPending || (editing&&chunkId===this.editingChunk) || (runtime.sheetId === activeSheetId && keep.has(chunkId))) continue;
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
            this.canonicalGrid.delete(cellKey(runtime.sheetId,cell.row,cell.column));
            (values[cell.row] ??= {})[cell.column] = { v: null, s: null };
            minRow = Math.min(minRow, cell.row);
            maxRow = Math.max(maxRow, cell.row);
            minColumn = Math.min(minColumn, cell.column);
            maxColumn = Math.max(maxColumn, cell.column);
            if (cell.link) {
              this.linksByCell.delete(cellKey(cell.link.sheetId, cell.row, cell.column));
              this.linksByNode.delete(cell.link.nodeId);
              this.canonicalCells.delete(cell.link.nodeId);
              this.paintedDrafts.delete(cell.link.nodeId);
            }
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
      this.runtimes.delete(chunkId);
      this.loaded.delete(chunkId);
    }
  }

  private withApplying(operation: () => void): void {
    this.applying += 1;
    try { operation(); } finally { this.applying -= 1; }
  }
}
