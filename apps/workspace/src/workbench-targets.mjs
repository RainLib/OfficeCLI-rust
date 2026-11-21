import { check } from "./store.mjs";

export function sheetTarget(target) {
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
function address(row, col) {
  let label = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  return label + (row + 1);
}
export function selectedCells(target, sheet) {
  check(
    sheet.sheetId === target.sheetId && sheet.sheetIndex === target.sheetIndex,
    409,
    "工作表已改变，请重新选择。",
  );
  const byAddress = new Map(sheet.cells.map((c) => [c.address, c]));
  const cells = [];
  for (let row = target.top; row <= target.bottom; row++)
    for (let column = target.left; column <= target.right; column++) {
      const key = address(row, column);
      cells.push({
        row: row + 1,
        column: column + 1,
        address: key,
        cell: byAddress.get(key),
      });
    }
  return cells;
}

export function relocateSheetSelection(target, sheet, nodeIds) {
  check(sheet.sheetId === target.sheetId && Array.isArray(nodeIds) && nodeIds.length && nodeIds.every(Boolean),
    409, "包含空白单元格的旧选区需要重新选择。");
  const addresses = new Map(sheet.cells.map(cell => [cell.nodeId, cell.address]));
  const positions = nodeIds.map(id => {
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

export function sheetEdit(target, cells, edits) {
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
        op: "xlsx.cell.set",
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
        op: "xlsx.number.set",
        nodeId: cell.nodeId,
        sheetId: target.sheetId,
        value,
        precondition,
      };
    }
    check(cell.textEditable, 409, "此单元格无法按文字编辑。");
    return {
      op: "text.splice",
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
