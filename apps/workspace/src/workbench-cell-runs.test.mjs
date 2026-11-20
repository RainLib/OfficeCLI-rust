import assert from "node:assert/strict";
import test from "node:test";
import { readCellRuns } from "./workbench-cell-runs.mjs";

test("native cell runs are bound to the worksheet revision even when only formatting changed", async () => {
  const cell = { nodeId: "cell", nodeHash: "same-text-hash", text: "正文", valueType: "string", textEditable: true };
  const runs = [{ text: "正文", properties: { color: { theme: "4" }, b: {} } }];
  let revision = 2;
  const engine = async (route, options) => {
    assert.equal(route, "/v1/documents/doc/nodes/cell");
    assert.equal(options.token, "scoped");
    return { documentId: "doc", revision, ...cell, source: { nodeKind: "cell", editable: true }, xlsxRuns: runs };
  };
  assert.deepEqual((await readCellRuns(engine, "scoped", "doc", 2, [cell])).get("cell"), runs);
  revision++;
  await assert.rejects(() => readCellRuns(engine, "scoped", "doc", 2, [cell]), { status: 409 });
});
