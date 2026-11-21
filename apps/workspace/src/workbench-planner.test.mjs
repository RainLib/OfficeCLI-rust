import assert from "node:assert/strict";
import test from "node:test";
import { combineFileActions, organizeBoardSections, planWorkbench, planWorkbenchFile } from "./workbench-planner.mjs";

test("separate proposals for the same file produce one reviewed batch", () => {
  const make = (tool, args) => ({ fileId: "workshop", tool, args: { requestId: "reviewed", ...args } });
  const prose = (...replacements) => make("replace_selected_text", { replacements });
  assert.deepEqual(combineFileActions([prose("甲", null), prose(null, "乙")]).args.replacements, ["甲", "乙"]);
  assert.throws(() => combineFileActions([prose("甲"), prose("乙")]), { status: 400 });
  const shape = (id, fields) => make("edit_canvas_selection", { edits: [{ id, ...fields }] });
  const merged = combineFileActions([shape("box", { dx: 12 }), shape("box", { strokeColor: "#224466" })]);
  assert.deepEqual(merged.args.edits, [{ id: "box", dx: 12, strokeColor: "#224466" }]);
  assert.throws(() => combineFileActions([shape("box", { dx: 12 }), shape("box", { dx: 16 })]), { status: 400 });
});

test("a board preview keeps each source anchor and rejects invented or repeated sections", async (t) => {
  const sections = [
    { id: "note", heading: "结论", lines: ["净增 7 单"] },
    { id: "table", heading: "明细", lines: ["海棠店 +15", "梧桐店 -8"] },
  ];
  let output = [sections[1], sections[0]];
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    const { messages } = JSON.parse(request.body);
    assert.deepEqual(JSON.parse(messages[1].content), sections);
    return Response.json({ message: { content: JSON.stringify({ sections: output }) } });
  });
  const model = { url: "http://localhost", name: "fixture" };
  assert.deepEqual(await organizeBoardSections(model, sections), output);
  for (const invalid of [[sections[0], sections[0]], [{ ...sections[0], id: "other" }, sections[1]], [sections[0]]]) {
    output = invalid;
    await assert.rejects(organizeBoardSections(model, sections), /白板选区不匹配/);
  }
});

test("a workflow validates dependencies and a deferred plan cannot write to its prerequisites", async t => {
  const targets = [
    { fileId: "a", kind: "sheet", cells: [{ address: "A1", text: "1" }] },
    { fileId: "b", kind: "append" },
    { fileId: "c", kind: "append" },
  ];
  const action = { fileId: "a", tool: "edit_selected_cells", args: { edits: [{ address: "A1", value: "2" }] } };
  const step = (fileId, ...dependsOn) => ({ fileId, dependsOn, task: "根据前序结果追加" });
  let plan = { reply: "", actions: [action], steps: [step("c", "b"), step("b", "a")] };
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: { content: JSON.stringify(plan) } }));
  const model = { url: "http://localhost", name: "fixture" };
  assert.deepEqual((await planWorkbench("先核对表格再整理", targets, model, true)).steps.map(item => item.fileId), ["b", "c"]);
  for (const steps of [[step("c", "b"), step("b", "c")], [step("b", "not-selected")], [step("a", "b")]]) {
    plan = { reply: "", actions: [action], steps };
    await assert.rejects(planWorkbench("先核对表格再整理", targets, model, true), { status: 502 });
  }
  await assert.rejects(planWorkbenchFile({
    prompt: "先核对表格再整理", target: targets[1], sources: [], task: "整理", facts: [],
  }, model), { status: 502 });
});
