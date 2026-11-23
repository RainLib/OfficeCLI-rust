import { check } from "./store.mts";
import type { CellEdit, WorkbookCell, Worksheet } from "./workbench-types.mts";

interface SheetRange {
  sheetId: string;
  sheetIndex: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface SelectedCell {
  row: number;
  column: number;
  address: string;
  cell: WorkbookCell | undefined;
}

export function sheetTarget(target: SheetRange): SheetRange & { kind: "sheet" } {
  const { sheetId, sheetIndex, top, left, bottom, right } = target;
  const values = [sheetIndex, top, left, bottom, right];
  check(
    /^s_[a-f0-9]{32}$/.test(sheetId) &&
      values.every(Number.isSafeInteger) &&
      sheetIndex >= 0 &&
      top >= 0 &&
      left >= 0 &&
      bottom >= top &&
      right >= left &&
      bottom < 1048576 &&
      right < 16384 &&
      (right - left + 1) * (bottom - top + 1) <= 128,
    400,
    "请选择同一工作表内最多 128 个单元格。",
  );
  return { kind: "sheet", sheetId, sheetIndex, top, left, bottom, right };
}
function address(row: number, col: number) {
  let label = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label + (row + 1);
}
export function selectedCells(target: SheetRange, sheet: Worksheet): SelectedCell[] {
  check(
    sheet.sheetId === target.sheetId && sheet.sheetIndex === target.sheetIndex,
    409,
    "工作表已改变，请重新选择。",
  );
  const selected = new Map<string, SelectedCell>();
  for (let row = target.top; row <= target.bottom; row++)
    for (let column = target.left; column <= target.right; column++) {
      const key = address(row, column);
      selected.set(key, { row: row + 1, column: column + 1, address: key, cell: undefined });
    }
  // The worksheet can carry far more cells than the 128-cell grant.
  for (const cell of sheet.cells) {
    const entry = selected.get(cell.address);
    if (entry) entry.cell = cell;
  }
  return [...selected.values()];
}

export function relocateSheetSelection(target: SheetRange, sheet: Worksheet, nodeIds: unknown) {
  check(sheet.sheetId === target.sheetId && Array.isArray(nodeIds) && nodeIds.length &&
    nodeIds.every((id): id is string => typeof id === "string" && id.length > 0),
    409, "包含空白单元格的旧选区需要重新选择。");
  const selectedIds = new Set(nodeIds);
  const addresses = new Map<string, string>();
  for (const cell of sheet.cells) {
    if (selectedIds.has(cell.nodeId)) addresses.set(cell.nodeId, cell.address);
  }
  const positions = nodeIds.map((id): [number, number] => {
    const address = /^([A-Z]+)([1-9][0-9]*)$/.exec(addresses.get(id) || "");
    check(address, 409, "原选区的单元格已被移除，请重新选择。");
    let column = 0;
    for (const letter of address[1]) column = column * 26 + letter.charCodeAt(0) - 64;
    return [+address[2] - 1, column - 1];
  });
  const [top, left] = positions[0];
  const rows = target.bottom - target.top + 1;
  const columns = target.right - target.left + 1;
  check(positions.length === rows * columns && positions.every(([row, column], index) =>
    row === top + Math.floor(index / columns) && column === left + index % columns),
  409, "原来的单元格不再形成同一个区域，请重新选择。");
  return sheetTarget({ ...target, sheetIndex: sheet.sheetIndex, top, left, bottom: top + rows - 1, right: left + columns - 1 });
}

export function sheetEdit(target: SheetRange, cells: readonly SelectedCell[], edits: readonly CellEdit[]) {
  const selected = new Map(cells.map((c) => [c.address, c]));
  check(
    new Set(edits.map((e) => e.address)).size === edits.length,
    400,
    "不能重复修改同一个单元格。",
  );
  const operations = edits.map(({ address, value }) => {
    const entry = selected.get(address);
    check(entry, 403, "单元格不在当前授权范围。");
    const { row, column, cell } = entry;
    if (!cell)
      return {
        op: "xlsx.cell.set" as const,
        sheetId: target.sheetId,
        row,
        column,
        text: value,
      };
    check(
      !cell.formula && (cell.textEditable || cell.numberEditable),
      409,
      "选中区域含公式或受保护单元格。",
    );
    const precondition = { nodeHash: cell.nodeHash };
    if (cell.numberEditable && cell.valueType === "number") {
      check(
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) &&
          Number.isFinite(Number(value)),
        400,
        "数字单元格需要数字。",
      );
      return {
        op: "xlsx.number.set" as const,
        nodeId: cell.nodeId,
        sheetId: target.sheetId,
        value,
        precondition,
      };
    }
    check(cell.textEditable, 409, "此单元格无法按文字编辑。");
    return {
      op: "text.splice" as const,
      nodeId: cell.nodeId,
      start: 0,
      deleteCount: [...cell.text].length,
      insertText: value,
      precondition,
    };
  });
  const hasBlank = operations.some((op) => op.op === "xlsx.cell.set");
  const version = operations.some((op) => op.op === "xlsx.number.set")
    ? 29
    : hasBlank
      ? operations.length === 1
        ? 7
        : 19
      : 1;
  return { operations, schemaVersion: "hcd-patch/" + version };
}
