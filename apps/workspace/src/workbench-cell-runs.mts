import { check } from "./store.mts";
import { isRecord, type WorkbookCell } from "./workbench-types.mts";

type CellRun = { text: string; properties: object };
type EngineRead = (route: string, options: { token: string }) => Promise<unknown>;

// Read only cells involved in this write. The worksheet's value endpoint does
// not carry native rich runs; pin every node read to the same observed revision.
export async function readCellRuns(
  engine: EngineRead,
  token: string,
  documentId: string,
  revision: number,
  cells: readonly (WorkbookCell | null | undefined)[],
) {
  const selected = [...new Map(cells.filter((cell): cell is WorkbookCell => cell != null &&
    !cell.formula && !!cell.textEditable &&
    cell.valueType === "string").map(cell => [cell.nodeId, cell])).values()];
  check(selected.length <= 128, 400, "请选择较小的单元格区域。");
  const runs = new Map<string, CellRun[]>();
  for (let start = 0; start < selected.length; start += 8) {
    await Promise.all(selected.slice(start, start + 8).map(async cell => {
      const node = await engine(`/v1/documents/${documentId}/nodes/${encodeURIComponent(cell.nodeId)}`, { token });
      check(isRecord(node) && node.documentId === documentId && node.revision === revision && node.nodeId === cell.nodeId &&
        node.nodeHash === cell.nodeHash && node.text === cell.text && isRecord(node.source) && node.source.nodeKind === "cell" &&
        node.source.editable, 409, "单元格已更新，请重新核对后再操作。");
      const value = node.xlsxRuns ?? [{ text: cell.text, properties: {} }];
      check(Array.isArray(value) && value.length > 0 && value.length <= 4096 &&
        value.every((run: unknown): run is CellRun => isRecord(run) && typeof run.text === "string" &&
          run.properties !== null && typeof run.properties === "object") &&
        value.map(run => run.text).join("") === cell.text, 409, "无法核对单元格的文字格式。");
      runs.set(cell.nodeId, structuredClone(value));
    }));
  }
  return runs;
}
