import assert from "node:assert/strict";
import test from "node:test";
import { replaceSpan } from "./selection-grants.mjs";
import { prepareUndo, reverseAppend, reverseCells, reverseText, sheetUndo, textUndo } from "./workbench-undo.mjs";

test("reversing selected prose restores the original formatting and keeps later text", () => {
  const inlines = [
    { text: "这是一段用于定位选区的长正文，协作者仍可在前面添加独立的文字内容。" },
    { text: "选📍", bold: true },
    { text: "区", italic: true },
    { text: "原文之后的独立结尾也会继续保留。" },
  ];
  const block = { blockId: "a", blockHash: "original", region: "body", content: { kind: "paragraph", inlines } };
  const start = Array.from(inlines[0].text).length;
  const span = { start, end: start + 3 };
  const replacement = "AI 内容";
  const forward = replaceSpan(block, span, replacement);
  const intent = textUndo([{ block, span }], [forward], [replacement]);
  const live = { ...block, blockHash: "latest", content: { ...forward.block, inlines: [
    { text: "协作者追加：", italic: true }, ...forward.block.inlines, { text: "另一位编辑者的结尾。", bold: true },
  ] } };
  const result = reverseText([live], intent)[0];
  assert.deepEqual(result.precondition, { blockHash: "latest" });
  assert.deepEqual(result.block.inlines, [live.content.inlines[0], ...inlines, live.content.inlines.at(-1)]);
  const editedAgain = { ...live, content: { ...live.content,
    inlines: live.content.inlines.map(run => run.text === replacement ? { ...run, text: "修改了这一句" } : run) } };
  assert.throws(() => reverseText([editedAgain], intent), { status: 409 });
});

test("undo preserves collaborators' adjacent and interleaved input in the same paragraph", () => {
  const block = { blockId: "a", blockHash: "original", region: "body", content: { kind: "paragraph", inlines: [
    { text: "开始：" }, { text: "旧句", bold: true }, { text: "。结尾" },
  ] } };
  const span = { start: 3, end: 5 }, replacement = "新内容";
  const forward = replaceSpan(block, span, replacement);
  const intent = textUndo([{ block, span }], [forward], [replacement]);
  const live = { ...block, blockHash: "latest", content: { ...forward.block, inlines: [
    { text: "开始：" }, { text: "前", italic: true },
    { text: "新", bold: true }, { text: "📍", underline: true }, { text: "内容", bold: true },
    { text: "后", italic: true }, { text: "。结尾" },
  ] } };
  const result = reverseText([live], intent)[0];
  assert.deepEqual(result.precondition, { blockHash: "latest" });
  assert.deepEqual(result.block.inlines, [
    { text: "开始：" }, { text: "前", italic: true }, { text: "旧句", bold: true },
    { text: "📍", underline: true }, { text: "后", italic: true }, { text: "。结尾" },
  ]);
});

test("undo refuses ambiguous repeated text and changed AI characters", () => {
  const block = { blockId: "a", blockHash: "original", region: "body", content: { kind: "paragraph", inlines: [{ text: "A旧B" }] } };
  const span = { start: 1, end: 2 }, replacement = "aa";
  const forward = replaceSpan(block, span, replacement);
  const intent = textUndo([{ block, span }], [forward], [replacement]);
  const live = value => ({ ...block, blockHash: "latest", content: { ...forward.block, inlines: [{ text: value }] } });
  assert.throws(() => reverseText([live("AaaaB")], intent), { status: 409 });
  assert.throws(() => reverseText([live("AaXB")], intent), { status: 409 });
});

test("undo of an AI deletion locates an unambiguous gap but refuses an edited gap", () => {
  const block = { blockId: "a", blockHash: "original", region: "body", content: { kind: "paragraph", inlines: [{ text: "前旧后" }] } };
  const span = { start: 1, end: 2 }, replacement = "";
  const forward = replaceSpan(block, span, replacement);
  const intent = textUndo([{ block, span }], [forward], [replacement]);
  const live = value => ({ ...block, blockHash: "latest", content: { ...forward.block, inlines: [{ text: value }] } });
  assert.equal(reverseText([live("新增前后")], intent)[0].block.inlines.map(run => run.text).join(""), "新增前旧后");
  assert.throws(() => reverseText([live("前人工后")], intent), { status: 409 });
});

test("long paragraphs retain interleaved peer input without the quadratic alignment budget", () => {
  const prefix = "序言".repeat(3000), suffix = "结尾".repeat(3000);
  const block = { blockId: "a", blockHash: "original", region: "body", content: { kind: "paragraph", inlines: [
    { text: prefix }, { text: "原句", italic: true }, { text: suffix },
  ] } };
  const span = { start: prefix.length, end: prefix.length + 2 }, replacement = "AI_NOTE";
  const forward = replaceSpan(block, span, replacement);
  const intent = textUndo([{ block, span }], [forward], [replacement]);
  const live = { ...block, blockHash: "latest", content: { ...forward.block, inlines: [
    { text: prefix }, { text: "AI", italic: true }, { text: "📍", bold: true },
    { text: "_NOTE", italic: true }, { text: suffix },
  ] } };
  assert.deepEqual(reverseText([live], intent)[0].block.inlines, [
    { text: prefix }, { text: "原句", italic: true }, { text: "📍", bold: true }, { text: suffix },
  ]);
});

test("undo finds a number by its stable ID after inserting a row and ignores other cells", () => {
  const base = { nodeId: "target", nodeHash: "old", address: "B2", numberEditable: true, valueType: "number", numberValue: "108", text: "108" };
  const target = { sheetId: "sheet1", sheetIndex: 0 };
  const intent = sheetUndo(target, [{ address: "B2", cell: base }], [{ address: "B2", value: "121" }]);
  const current = { ...base, address: "B3", numberValue: "121", text: "121", nodeHash: "latest" };
  const neighbor = { ...base, nodeId: "neighbor", numberValue: "9" };
  assert.deepEqual(reverseCells({ sheetId: target.sheetId, cells: [neighbor, current] }, intent), [
    { op: "xlsx.number.set", nodeId: base.nodeId, sheetId: target.sheetId, value: "108", precondition: { nodeHash: "latest" } },
  ]);
  assert.throws(() => reverseCells({ sheetId: target.sheetId, cells: [neighbor] }, intent), { status: 409 });
  assert.throws(() => reverseCells({ sheetId: target.sheetId, cells: [base] }, intent), { status: 409 });
});

test("append undo matches operation identities despite reversed receipt order and keeps peer input", () => {
  const id = "n_e71cf7a1bc7b97a90ac1bf1439ace480", other = "n_dbf7849dc449824ab2d9e932843dbcde";
  const prepared = { route: "/patch", data: { documentId: "doc", patchId: "append-patch", operations: [
    { op: "block.insert", afterBlockId: "anchor", block: { kind: "paragraph", inlines: [{ text: "AI note" }] } },
    { op: "block.insert", afterBlockId: "anchor", block: { kind: "paragraph", inlines: [{ text: "Second" }] } },
  ] } };
  const peer = { text: "同事📍", bold: true, italic: false, format: { color: "336699" } };
  const block = { blockId: id, blockHash: "current", readOnly: false, region: "body", content: {
    kind: "paragraph", alignment: "center", inlines: [
      { text: "AI", bold: false, italic: false }, peer, { text: " note", bold: false, italic: false },
    ],
  } };
  const second = { blockId: other, blockHash: "second", readOnly: false, region: "body", content: prepared.data.operations[1].block };
  const receipts = [{ id: other, hash: "second" }, { id, hash: "initial" }];
  assert.deepEqual(reverseAppend({ blocks: [second, block] }, prepared, receipts), [
    { op: "block.delete", blockId: other, precondition: { blockHash: "second" } },
    { op: "block.replace", blockId: id, precondition: { blockHash: "current" },
      block: { ...block.content, inlines: [peer] } },
  ]);
  assert.throws(() => reverseAppend({ blocks: [second, block] }, prepared, [receipts[0], receipts[0]]), { status: 409 });
  assert.throws(() => reverseAppend({ blocks: [{ ...block, blockId: "unrelated" }, second] }, prepared,
    [{ id: "unrelated", hash: "current" }, receipts[0]]), { status: 409 });
});

test("append undo keeps later paragraph structure but refuses rewritten AI characters", () => {
  const id = "n_e71cf7a1bc7b97a90ac1bf1439ace480";
  const prepared = { route: "/patch", data: { documentId: "doc", patchId: "append-patch", operations: [
    { op: "block.insert", afterBlockId: null, block: { kind: "paragraph", inlines: [{ text: "AI note" }] } },
  ] } };
  const block = { blockId: id, blockHash: "current", readOnly: false, region: "body", content: {
    kind: "heading", level: 2, inlines: [{ text: "AI note", bold: false, italic: false }],
  } };
  const receipt = [{ id, hash: "initial" }];
  assert.deepEqual(reverseAppend({ blocks: [block] }, prepared, receipt)[0].block, {
    kind: "heading", level: 2, inlines: [],
  });
  assert.throws(() => reverseAppend({ blocks: [{ ...block, content: { ...block.content,
    inlines: [{ text: "AI Xote", bold: false, italic: false }] } }] }, prepared, receipt), { status: 409 });
});

test("spreadsheet undo restores native rich runs after a row move and retains styled peer input", () => {
  const bold = { b: {}, color: { theme: "4", tint: "0.2" } }, italic = { i: { val: "1" }, scheme: { val: "minor" } };
  const peer = { text: "📍", properties: { u: { val: "double" }, color: { rgb: "FF336699" } } };
  const cell = { nodeId: "rich", nodeHash: "before", address: "A1", text: "旧句", valueType: "string", textEditable: true,
    xlsxRuns: [{ text: "旧", properties: bold }, { text: "句", properties: italic }] };
  const intent = sheetUndo({ sheetId: "sheet" }, [{ address: "A1", cell }], [{ address: "A1", value: "新内容" }], "xlsx");
  const live = { ...cell, nodeHash: "latest", address: "A2", text: "新📍内容", xlsxRuns: [
    { text: "新", properties: bold }, peer, { text: "内容", properties: bold },
  ] };
  const [inverse] = reverseCells({ sheetId: "sheet", cells: [live] }, intent);
  assert.deepEqual(inverse, { op: "xlsx.richText.set", nodeId: "rich", precondition: { nodeHash: "latest" },
    runs: [...cell.xlsxRuns, peer] });
  assert.throws(() => reverseCells({ sheetId: "sheet", cells: [{ ...live,
    xlsxRuns: live.xlsxRuns.map(run => run.text === "新" ? { ...run, properties: italic } : run) }] }, intent), { status: 409 });
});

test("a newly created sheet cell keeps a collaborator's supplement while an untouched new cell is cleared", () => {
  const target = { sheetId: "sheet" };
  const intent = sheetUndo(target, [
    { address: "A1", row: 1, column: 1 }, { address: "B1", row: 1, column: 2 },
  ], [{ address: "A1", value: "AI" }, { address: "B1", value: "待撤销" }], "xlsx");
  const peer = { text: "同事", properties: { b: { val: "1" } } };
  const current = { sheetId: "sheet", cells: [
    { nodeId: "first", nodeHash: "peer", textEditable: true, valueType: "string", text: "A同事I",
      xlsxRuns: [{ text: "A", properties: {} }, peer, { text: "I", properties: {} }] },
    { nodeId: "second", nodeHash: "unchanged", textEditable: true, valueType: "string", text: "待撤销", xlsxRuns: [{ text: "待撤销", properties: {} }] },
  ] };
  const receipt = { revision: 2, added: [
    { sheetId: "sheet", row: 1, column: 1, id: "first", hash: "initial" },
    { sheetId: "sheet", row: 1, column: 2, id: "second", hash: "unchanged" },
  ] };
  assert.deepEqual(reverseCells(current, intent, receipt), [
    { op: "xlsx.richText.set", nodeId: "first", precondition: { nodeHash: "peer" }, runs: [peer] },
    { op: "xlsx.cell.clear", nodeId: "second", sheetId: "sheet", createdRevision: 2, precondition: { nodeHash: "unchanged" } },
  ]);
});

test("CSV text undo preserves unambiguous Unicode additions and refuses a later type conversion", () => {
  const cell = { nodeId: "csv", nodeHash: "before", address: "A1", valueType: "string", textEditable: true, text: "原文" };
  const undo = sheetUndo({ sheetId: "sheet" }, [{ address: "A1", cell }], [{ address: "A1", value: "AI" }], "csv");
  const current = { ...cell, nodeHash: "latest", text: "A📍I" };
  assert.deepEqual(reverseCells({ sheetId: "sheet", cells: [current] }, undo), [
    { op: "text.splice", nodeId: "csv", start: 0, deleteCount: 3, insertText: "原文📍", precondition: { nodeHash: "latest" } },
  ]);
  assert.throws(() => reverseCells({ sheetId: "sheet", cells: [{ ...current, valueType: "number" }] }, undo), { status: 409 });
});

test("rich spreadsheet undo negotiates one atomic schema before preparing a write", async () => {
  const cell = { nodeId: "rich", nodeHash: "h", address: "A1", text: "旧", textEditable: true, valueType: "string", xlsxRuns: [{ text: "旧", properties: {} }] };
  const undo = sheetUndo({ sheetId: "sheet" }, [{ address: "A1", cell }], [{ address: "A1", value: "AI" }], "xlsx");
  const prepared = { route: "/node-patch", undo, data: { documentId: "doc", operations: [] } };
  let supported = true;
  const engine = async route => {
    if (route.endsWith("/auth")) return { documentId: "doc", collaborationEpoch: 3 };
    if (route.endsWith("/sheets/sheet")) return { revision: 5, sheetId: "sheet", cells: [{ ...cell, text: "AI", xlsxRuns: undefined }] };
    if (route.endsWith("/nodes/rich")) return { documentId: "doc", revision: 5, nodeId: "rich", nodeHash: "h", text: "AI", source: { nodeKind: "cell", editable: true } };
    if (route.endsWith("/capabilities")) return { patchSchemas: supported ? { "hcd-patch/65": {
      route: "/node-patch", operations: ["xlsx.richText.set", "xlsx.number.set", "xlsx.cell.clear"],
    } } : {} };
    assert.fail(route);
  };
  assert.equal((await prepareUndo(engine, "token", prepared)).data.schemaVersion, "hcd-patch/65");
  supported = false;
  await assert.rejects(() => prepareUndo(engine, "token", prepared), { status: 409 });
});
