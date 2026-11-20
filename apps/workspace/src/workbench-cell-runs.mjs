import { check } from "./store.mjs";

// Read only cells involved in this write. The worksheet's value endpoint does
// not carry native rich runs; pin every node read to the same observed revision.
export async function readCellRuns(engine, token, documentId, revision, cells) {
  const selected = [...new Map(cells.filter(cell => cell && !cell.formula && cell.textEditable &&
    cell.valueType === "string").map(cell => [cell.nodeId, cell])).values()];
  check(selected.length <= 128, 400, "请选择较小的单元格区域。");
  const runs = new Map();
  for (let start = 0; start < selected.length; start += 8) {
    await Promise.all(selected.slice(start, start + 8).map(async cell => {
      const node = await engine(`/v1/documents/${documentId}/nodes/${encodeURIComponent(cell.nodeId)}`, { token });
      check(node.documentId === documentId && node.revision === revision && node.nodeId === cell.nodeId &&
        node.nodeHash === cell.nodeHash && node.text === cell.text && node.source?.nodeKind === "cell" &&
        node.source.editable, 409, "单元格已更新，请重新核对后再操作。");
      const value = node.xlsxRuns ?? [{ text: cell.text, properties: {} }];
      check(Array.isArray(value) && value.length > 0 && value.length <= 4096 &&
        value.every(run => typeof run?.text === "string" && run.properties && typeof run.properties === "object") &&
        value.map(run => run.text).join("") === cell.text, 409, "无法核对单元格的文字格式。");
      runs.set(cell.nodeId, structuredClone(value));
    }));
  }
  return runs;
}
