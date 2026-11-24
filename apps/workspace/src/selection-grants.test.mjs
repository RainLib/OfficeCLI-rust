import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSelectionGrants, replaceSpan } from "./selection-grants.mjs";
import { documentId } from "./provider.mjs";
import { check, now } from "./store.mts";

const block = {
  blockId: "workshop",
  blockHash: "original-block-hash",
  content: {
    kind: "heading",
    level: 2,
    inlines: [
      { nodeId: "start", text: "A🍃叶", bold: true },
      {
        nodeId: "end",
        text: "子B",
        italic: true,
        link: "https://example.org/notes",
      },
    ],
  },
};

test("a Unicode selection spanning runs preserves surrounding marks and paragraph properties", () => {
  const patch = replaceSpan(block, { start: 1, end: 4 }, "花🌷");
  assert.deepEqual(patch.block, {
    kind: "heading",
    level: 2,
    inlines: [
      { text: "A花🌷", bold: true },
      { text: "B", italic: true, link: "https://example.org/notes" },
    ],
  });
  assert.deepEqual(patch.precondition, { blockHash: block.blockHash });
  assert.equal(block.content.inlines[0].text, "A🍃叶");
});

test("deleting one selected run leaves its neighboring linked run intact", () => {
  const patch = replaceSpan(block, { start: 0, end: 3 }, "");
  assert.deepEqual(patch.block.inlines, [
    { text: "子B", italic: true, link: "https://example.org/notes" },
  ]);
});

test("a selection token expires with its editor launch and rechecks current permissions", async () => {
  const config = {
    selectionMcp: true,
    publicUrl: "https://editor.example",
    tenantId: "design",
    appId: "host",
  };
  const file = { id: randomUUID(), name: "Board", format: "excalidraw" },
    id = documentId(config, file.id);
  const account = {
    user: { id: randomUUID() },
    hash: "signed-in-browser",
    expires: now() + 3600,
  };
  const launchExpiry = now() + 60,
    launchId = randomUUID(),
    instanceId = randomUUID();
  const launch = {
    documentId: id,
    token: "scoped-editor-session",
    expiresAt: launchExpiry,
  };
  let permitted = true,
    closed = false;
  const store = {
    read: work => work(),
    file: () => file,
    user: () => account.user,
    get: () => ({
      response: JSON.stringify(launch),
      expires: account.expires,
      browser_expires: account.expires,
      closed,
    }),
    permit: (_user, _file, ...ops) => {
      assert.deepEqual(ops, ["document.view", "document.edit", "document.ai"]);
      check(permitted, 403, "file permission revoked");
    },
  };
  const engine = async (path, { token }) => {
    assert.equal(token, launch.token);
    return path.endsWith("/auth")
      ? { collaborationEpoch: 1 }
      : { revision: 9, scene: { elements: [{ id: "a", type: "rectangle" }] } };
  };
  const grants = createSelectionGrants({ store, config, engine });
  const payload = {
    instanceId,
    generation: 1,
    fileId: file.id,
    launchId,
    selection: {
      documentId: id,
      revision: 9,
      collaborationEpoch: 1,
      target: { kind: "canvas", elementIds: ["a"] },
    },
  };
  const first = await grants.set(account, payload);
  assert.equal(first.expiresAt, launchExpiry);
  const authenticate = () => grants.authenticate("Bearer " + first.token);
  const grant = await authenticate();
  permitted = false;
  await assert.rejects(authenticate, (e) => e.status === 403);
  await assert.rejects(
    grants.call(grant, "read_selection", {}),
    (e) => e.status === 403,
  );
  permitted = true;
  closed = true;
  await assert.rejects(authenticate, (e) => e.status === 403);
  closed = false;
  await grants.set(account, { instanceId, generation: 3, selection: null });
  await assert.rejects(authenticate, (e) => e.status === 401);
  await assert.rejects(
    grants.set(account, { ...payload, generation: 2 }),
    (e) => e.status === 409,
  );
  config.selectionMcp = false;
  await assert.rejects(
    grants.set(account, { ...payload, generation: 4 }),
    (e) => e.status === 403,
  );
});

test("sheet ranges stay bounded; native numbers and empty cells keep their patch types", async () => {
  const { sheetTarget, selectedCells, sheetEdit } =
    await import("./workbench-targets.mts");
  const sheetId = "s_" + "a".repeat(32);
  const target = sheetTarget({
    sheetId,
    sheetIndex: 0,
    top: 0,
    left: 0,
    bottom: 1,
    right: 1,
  });
  const cells = selectedCells(target, {
    sheetId,
    sheetIndex: 0,
    cells: [
      {
        address: "A1",
        nodeId: "n1",
        nodeHash: "h1",
        valueType: "number",
        text: "33",
        textEditable: true,
        numberEditable: true,
      },
      {
        address: "B1",
        nodeId: "n2",
        nodeHash: "h2",
        valueType: "string",
        text: "🌱",
        textEditable: true,
      },
      {
        address: "A2",
        nodeId: "n3",
        formula: "SUM(A1:A1)",
        text: "33",
        textEditable: true,
      },
    ],
  });
  assert.throws(() => sheetTarget({ ...target, bottom: 128 }));
  assert.throws(() =>
    sheetEdit(target, cells, [{ address: "C1", value: "x" }]),
  );
  assert.throws(() =>
    sheetEdit(target, cells, [{ address: "A2", value: "x" }]),
  );
  assert.throws(() =>
    sheetEdit(target, cells, [{ address: "A1", value: "x" }]),
  );
  const result = sheetEdit(target, cells, [
    { address: "A1", value: "42" },
    { address: "B1", value: "新稿" },
    { address: "B2", value: "新格" },
  ]);
  assert.equal(result.schemaVersion, "hcd-patch/29");
  assert.deepEqual(
    result.operations.map((op) => op.op),
    ["xlsx.number.set", "text.splice", "xlsx.cell.set"],
  );
  assert.equal(result.operations[1].deleteCount, 1);
  assert.equal(result.operations[2].row, 2);
});

test("a saved sheet selection follows the same rectangle of native cell IDs", async () => {
  const { relocateSheetSelection, sheetTarget } = await import("./workbench-targets.mts");
  const sheetId = "s_" + "b".repeat(32);
  const before = sheetTarget({ sheetId, sheetIndex: 1, top: 1, left: 1, bottom: 2, right: 2 });
  const sheet = { sheetId, sheetIndex: 0, cells: [
    { nodeId: "a", address: "C3" }, { nodeId: "b", address: "D3" },
    { nodeId: "c", address: "C4" }, { nodeId: "d", address: "D4" },
  ] };
  assert.deepEqual(relocateSheetSelection(before, sheet, ["a", "b", "c", "d"]),
    { ...before, sheetIndex: 0, top: 2, left: 2, bottom: 3, right: 3 });
  for (const ids of [["a", "b", "c", null], ["a", "b", "c", "deleted"], ["d", "a", "b", "c"]])
    assert.throws(() => relocateSheetSelection(before, sheet, ids), { status: 409 });
});

test("workbench planner uses only the selected source and rejects out-of-scope model plans", async () => {
  const { planWorkbench } = await import("./workbench-planner.mts");
  const targets = [
    {
      kind: "document",
      fileId: "word",
      file: "访谈.docx",
      spans: [{ text: "共创笔记" }],
    },
    {
      kind: "sheet",
      fileId: "sheet",
      file: "跟进.xlsx",
      cells: [{ address: "B2", text: "已有" }],
    },
    { kind: "append", fileId: "board", file: "共创.excalidraw" },
  ];
  const plan = await planWorkbench("把文档选区同步到其他文件", targets, null);
  assert.deepEqual(
    plan.actions.map((a) => [a.fileId, a.tool]),
    [
      ["sheet", "edit_selected_cells"],
      ["board", "append_to_file"],
    ],
  );
  assert.equal(plan.actions[0].args.edits[0].value, "共创笔记");
  const anotherSource = {
    ...targets[0],
    fileId: "word-two",
    spans: [{ text: "第二份" }],
  };
  const fromTwo = await planWorkbench(
    "把文档选区同步到其他文件",
    [targets[0], anotherSource, ...targets.slice(1)],
    null,
  );
  assert.deepEqual(
    fromTwo.actions.map((a) => a.fileId),
    ["sheet", "board"],
  );
  assert.equal(fromTwo.actions[0].args.edits[0].value, "共创笔记\n第二份");
  const append = await planWorkbench("追加：条目", targets.slice(1), null);
  assert.equal(append.actions[0].args.edits[0].value, "已有条目");
  const { createServer } = await import("node:http");
  let bad = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const messages = JSON.parse(raw).messages;
    assert.equal(JSON.parse(messages[1].content).targets.length, 3);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            reply: "已准备",
            actions: [
              {
                fileId: bad ? "outside" : "board",
                tool: "append_to_file",
                args: { text: "整理后的材料" },
              },
            ],
          }),
        },
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const model = {
      name: "test-model",
      url: "http://127.0.0.1:" + server.address().port,
    };
    assert.equal(
      (await planWorkbench("整理选区并追加", targets, model)).actions[0].fileId,
      "board",
    );
    bad = true;
    await assert.rejects(planWorkbench("整理选区并追加", targets, model));
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("a granted Spec keeps its Unicode offsets as people type, and reads back the committed paragraph", async () => {
  const config = {
    selectionMcp: true,
    publicUrl: "http://localhost",
    tenantId: "tenant",
    appId: "host",
  };
  const file = { id: randomUUID(), name: "评审", format: "excalidraw" },
    id = documentId(config, file.id);
  const account = {
    user: { id: randomUUID() },
    hash: "browser",
    expires: now() + 900,
  };
  const launch = {
    documentId: id,
    token: "engine-session",
    expiresAt: account.expires,
  };
  const store = {
    read: work => work(),
    user: () => account.user,
    file: () => file,
    permit() {},
    audit() {},
    get: () => ({
      response: JSON.stringify(launch),
      expires: account.expires,
      browser_expires: account.expires,
    }),
  };
  let revision = 4,
    epoch = 1,
    locked = false,
    lines = ["🙂春季发布"];
  let committed;
  const tag = (part) => ({ kind: "spec", part, root: "paper" });
  async function engine(path, options) {
    if (path.endsWith("/auth")) return { collaborationEpoch: epoch };
    if (path.endsWith("/patch")) {
      committed = options;
      lines = ["🙂秋季（优先）发布"];
      return { revision: ++revision };
    }
    return {
      revision,
      scene: {
        elements: [
          {
            id: "paper",
            type: "rectangle",
            locked,
            customData: { officeBoard: tag("paper") },
          },
          {
            id: "body",
            type: "text",
            text: lines[0],
            customData: {
              officeBoard: tag("body"),
              officeSpec: { blocks: lines },
            },
          },
        ],
      },
    };
  }
  const grants = createSelectionGrants({ store, config, engine });
  const saved = await grants.set(account, {
    instanceId: randomUUID(),
    generation: 1,
    launchId: randomUUID(),
    fileId: file.id,
    selection: {
      documentId: id,
      revision,
      collaborationEpoch: epoch,
      target: { kind: "canvas", elementIds: ["paper", "body"] },
    },
  });
  const grant = await grants.authenticate("Bearer " + saved.token);
  revision++;
  lines = ["🙂春（优先）季发布"];
  const read = () => grants.call(grant, "read_selection", {});
  assert.equal((await read()).revision, 4);
  assert.deepEqual((await read()).elements[1].specBlocks, [
    { block: 0, text: "🙂春季发布" },
  ]);
  const specSplice = {
    block: 0,
    start: 1,
    end: 3,
    expected: "春季",
    insert: "秋季",
  };
  const send = (edits) =>
    grants.call(grant, "edit_canvas_selection", {
      requestId: randomUUID(),
      edits,
    });
  await assert.rejects(
    send([{ id: "body", specSplice: { ...specSplice, expected: "夏季" } }]),
    (e) => e.status === 409,
  );
  await assert.rejects(
    send([{ id: "body", dx: 4, specSplice }]),
    (e) => e.status === 409,
  );
  await assert.rejects(
    send([{ id: "outside", specSplice }]),
    (e) => e.status === 409 || e.status === 403,
  );
  locked = true;
  await assert.rejects(
    send([{ id: "body", specSplice }]),
    (e) => e.status === 409,
  );
  locked = false;
  epoch++;
  await assert.rejects(read(), (e) => e.status === 409);
  epoch--;
  const args = { requestId: randomUUID(), edits: [{ id: "body", specSplice }] };
  const receipt = await grants.call(grant, "edit_canvas_selection", args);
  assert.equal(receipt.revision, 6);
  assert.equal(committed.data.baseRevision, 4);
  assert.deepEqual(committed.data.operations, [
    { op: "spec.splice", id: "body", ...specSplice },
  ]);
  assert.equal(committed.headers["X-HCD-Expected-Revision"], undefined);
  assert.equal(committed.headers["X-HCD-Collaboration-Epoch"], "1");
  assert.deepEqual(
    await grants.call(grant, "edit_canvas_selection", args),
    receipt,
  );
  assert.equal((await read()).revision, 6);
  assert.deepEqual((await read()).elements[1].specBlocks, [
    { block: 0, text: "🙂秋季（优先）发布" },
  ]);
});

test("a demo phrase edit uses the paragraph and Unicode offsets of the single match", async () => {
  const { planSpecPhrase } = await import("./spec-edit.mts");
  const target = [
    { id: "b", specBlocks: [{ block: 2, text: "🙂在春季发布" }] },
  ];
  assert.deepEqual(planSpecPhrase("把「春季」改为「秋季」", target).edits, [
    {
      id: "b",
      specSplice: {
        block: 2,
        start: 2,
        end: 4,
        expected: "春季",
        insert: "秋季",
      },
    },
  ]);
  assert.ok(
    planSpecPhrase("把「春季」改为「秋季」", [...target, ...target]).reply,
  );
  assert.ok(planSpecPhrase("把「夏季」改为「秋季」", target).reply);
});
