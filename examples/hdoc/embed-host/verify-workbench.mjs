import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { verifyTabResources } from "./verify-tab-resources.mjs";
import { verifySlideObjects } from "./verify-slide-objects.mjs";
import { verifyPptxInheritance } from "./verify-pptx-inheritance.mjs";
import { verifySlideNoteDraft } from "./verify-slide-notes-draft.mjs";
import { verifySheetCharts } from "./verify-sheet-charts.mjs";
import { verifyWordPictures } from "./verify-word-pictures.mjs";
import { verifyWordReview, verifyWordTracked } from "./verify-word-review.mjs";
import { verifyWordTableCells } from "./verify-word-table-cells.mjs";
import { planWorkbench } from "../../../apps/workspace/src/workbench-planner.mts";
import {
  chromium,
  expect,
} from "../editor/node_modules/@playwright/test/index.mjs";

const output = resolve(
  process.env.OFFICECLI_DESK_ARTIFACTS ||
    mkdtempSync(join(tmpdir(), "office-desk-proof-")),
);
mkdirSync(output, { recursive: true });
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const site = "http://fold.localhost:" + port;
const workflowPrompt = "先在表格记录核对结果，等保存后写入文档，再把文档结果记录到白板";
const stageRequests = [];
const model = createHttpServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (request.url === "/api/chat") {
      const input = JSON.parse(body.messages[1].content);
      let plan;
      if (Array.isArray(input)) plan = { sections: input };
      else if (input.prompt !== workflowPrompt) {
        plan = await planWorkbench(input.prompt, input.targets, null);
      } else if (input.targets) {
        const grid = input.targets.find(item => item.kind === "sheet");
        const doc = input.targets.find(item => item.kind === "append" && item.format === "docx");
        const board = input.targets.find(item => item.kind === "append" && item.format === "excalidraw");
        assert.deepEqual(grid.cells.map(cell => cell.address), ["A1"]);
        plan = { reply: "", actions: [{ fileId: grid.fileId, tool: "edit_selected_cells",
          args: { edits: [{ address: "A1", value: "已核对 12 条访谈" }] } }],
          steps: [{ fileId: doc.fileId, dependsOn: [grid.fileId], task: "写入已核对的记录" },
            { fileId: board.fileId, dependsOn: [doc.fileId], task: "记录文档结论" }],
        };
      } else {
        const previous = input.facts[0];
        assert.equal(input.facts.length, 1);
        assert(Number.isSafeInteger(previous.revision));
        assert(input.sources.every(source => source.fileId !== previous.fileId));
        const text = input.target.format === "docx" ? "文档核对记录" : "白板核对结论";
        stageRequests.push({ format: input.target.format, targetRevision: input.target.revision,
          previousRevision: previous.revision, previous: previous.changes[0].after });
        plan = { reply: "", actions: [{ fileId: input.target.fileId, tool: "append_to_file",
          args: { text: text + " · " + previous.changes[0].after } }] };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: JSON.stringify(plan) } }));
      return;
    }
    const name = body.tool_choice?.name;
    assert.equal(name, "hcd_draft_canvas_from_document");
    const { selection } = JSON.parse(body.input[0].content);
    assert(selection.some(item => item.text.includes("可以验证的假设")));
    const draft = {
      title: "工作坊讲解图",
      sections: [{
        sources: selection.map(item => item.id),
        composition: {
          title: "验证假设",
          layout: "flowchart",
          items: [],
          diagram: {
            groups: [],
            nodes: [
              { id: "hypothesis", title: "提炼假设", body: "保留访谈中的原话。", kind: "process", group: null },
              { id: "experiment", title: "安排验证", body: "记录下一步试验。", kind: "terminal", group: null },
            ],
            edges: [{ from: "hypothesis", to: "experiment", label: "下一步", kind: "arrow" }],
          },
          visual: { style: "studio", palette: "ocean", paper: "plain", brush: "ink", stickers: [] },
        },
      }],
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "completed", output: [{ type: "function_call", name, call_id: randomUUID(), arguments: JSON.stringify(draft) }] }));
  } catch {
    response.writeHead(400).end();
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const service = spawn(
  process.execPath,
  [join(import.meta.dirname, "demo.mjs")],
  {
    env: { ...process.env, OFFICECLI_EMBED_PORT: String(port),
      OFFICECLI_DEMO_ENGINE_AI: "true", OPENAI_API_KEY: "loopback-workbench-test", HCD_OPENAI_MODEL: "workbench-fixture",
      HCD_OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      OFFICECLI_DEMO_OLLAMA_MODEL: "workbench-fixture", OFFICECLI_DEMO_OLLAMA_URL: `http://127.0.0.1:${model.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
service.stdout.on("data", (s) => (log += s));
service.stderr.on("data", (s) => (log += s));
const stopped = once(service, "exit"),
  checks = [];
let browser, page;
const doc = "工作坊简报.docx",
  board = "共创工作坊.excalidraw",
  sheet = "工作坊行动表.xlsx";
async function checkDock(page) {
  const cards = await page
    .locator(".desk-ai-card, .desk-compose")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect(),
          css = getComputedStyle(node);
        return {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          rightInset: innerWidth - r.right,
          corners: [
            css.borderTopLeftRadius,
            css.borderTopRightRadius,
            css.borderBottomLeftRadius,
            css.borderBottomRightRadius,
          ],
          fill: css.backgroundColor,
          background: css.backgroundImage,
        };
      }),
    );
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.deepEqual(card.corners, Array(4).fill("16px"));
    assert.equal(card.fill, "rgb(255, 255, 255)");
    assert.equal(card.background, "none");
    assert(card.rightInset >= 8);
  }
  assert.equal(cards[0].left, cards[1].left);
  assert.equal(cards[1].top - cards[0].bottom, 10);
}
try {
  await expect
    .poll(() => log.includes("业务系统 "), { timeout: 60000 })
    .toBe(true);
  browser = await chromium.launch({
    ...(process.env.HCD_BROWSER_PATH
      ? { executablePath: process.env.HCD_BROWSER_PATH }
      : {}),
    args: ["--no-proxy-server"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
    reducedMotion: "reduce",
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", async (r) => {
    if (
      r.status() >= 400 &&
      new URL(r.url()).pathname === "/workspace/api/embed/selection"
    ) {
      const value = r.request().postDataJSON()?.selection;
      console.error(
        "Scope issue",
        r.status(),
        value?.target?.kind,
        value?.revision,
        value?.collaborationEpoch,
      );
    }
  });
  await page.goto(site + "/workbench/");
  await expect(
    page.getByRole("heading", { name: "工作空间", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".desk-tiles button")).toHaveCount(4);
  await expect(page.locator(".desk-list-row")).toHaveCount(4);
  await checkDock(page);
  const tileStyles = await page
    .locator(".desk-tiles > button")
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        getComputedStyle(node).backgroundColor,
        getComputedStyle(node).backgroundImage,
        getComputedStyle(node.querySelector("svg")).stroke,
      ]),
    );
  for (const style of tileStyles) assert.deepEqual(style, tileStyles[0]);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output, "home.png") });
  const openWidth = (await page.locator(".desk-home-main").boundingBox()).width;
  await page.getByRole("button", { name: "收起全局 AI" }).click();
  assert(
    (await page.locator(".desk-home-main").boundingBox()).width >
      openWidth + 280,
  );
  await page.screenshot({ path: join(output, "home-closed.png") });
  await page.getByRole("button", { name: "全局 AI", exact: true }).click();
  checks.push(
    "All four file creation icons share one ink tone. Both AI dock surfaces have four 16px corners, a 10px gap and an outer inset; closing the dock gives its width back to the file library.",
  );
  checks.push(
    "Unified home, four creation actions and four authorized mixed-format files.",
  );
  await page.getByRole("button", { name: "星标 " + doc, exact: true }).click();
  await page.getByRole("button", { name: "星标文件", exact: true }).click();
  await expect(page.locator(".desk-list-row")).toHaveCount(1);
  await page
    .locator(".desk-rail")
    .getByRole("button", { name: "首页", exact: true })
    .click();
  await page.getByRole("textbox", { name: "搜索文件" }).fill("行动表");
  await expect(page.locator(".desk-list-row")).toHaveCount(1);
  await page.getByRole("button", { name: "清空搜索" }).click();
  checks.push(
    "Home search and starred files operate on the authorized catalog.",
  );
  const homeTab = page.getByRole("tab", { name: "首页", exact: true });
  const open = async (name) => {
    await homeTab.click();
    await page
      .getByRole("button", { name: "打开 " + name, exact: true })
      .click();
  };
  const target = (name) =>
    page.getByRole("checkbox", { name: "加入任务 " + name, exact: true });
  await open(doc);
  await expect(page.locator(".is-visible .tiptap")).toContainText("共创简报", {
    timeout: 50000,
  });
  await open(board);
  await expect(page.locator(".is-visible .excalidraw")).toBeVisible({
    timeout: 50000,
  });
  const boardPane = page.locator(".desk-editor.is-visible");
  const drawing = boardPane.locator(".excalidraw__canvas.interactive");
  const assertCanvasFillsPane = async () => {
    await expect.poll(async () => {
      const [tabs, pane, canvas, dock, bottom] = await Promise.all([
        page.locator(".desk-chrome").boundingBox(), boardPane.boundingBox(), drawing.boundingBox(),
        boardPane.locator(".board-dock-shell").boundingBox(),
        page.evaluate(() => visualViewport ? visualViewport.offsetTop + visualViewport.height : innerHeight),
      ]);
      return !!(tabs && pane && canvas && dock) && Math.abs(canvas.y - tabs.y - tabs.height) <= 1
        && Math.abs(canvas.x - pane.x) <= 1 && Math.abs(canvas.width - pane.width) <= 1
        && Math.abs(canvas.y + canvas.height - (pane.y + pane.height)) <= 1
        && Math.abs(canvas.y + canvas.height - bottom) <= 1 && dock.y + dock.height <= bottom + 1;
    }).toBe(true);
  };
  await assertCanvasFillsPane();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", {pageScaleFactor: 1.25});
  await assertCanvasFillsPane();
  await cdp.send("Emulation.setPageScaleFactor", {pageScaleFactor: 1});
  await cdp.detach();
  await expect(boardPane.locator(".document-identity")).toHaveCount(0);
  await expect(boardPane.locator(".canvas-surface")).toHaveCSS("border-radius", "0px");
  checks.push("The drawing surface fills the active tab below the global toolbar, including alongside global AI.");
  await open(sheet);
  await expect(target(sheet)).toBeEnabled({ timeout: 60000 });
  const appearance = page.locator(".desk-chrome").getByRole("combobox", { name: "界面主题" });
  const liveDocument = await page.locator(".desk-editor .tiptap").first().elementHandle();
  await appearance.selectOption("dark");
  await expect(page.getByRole("combobox", { name: "界面主题" })).toHaveCount(1);
  await expect(page.locator('.desk-editor .hcd-embedded[data-theme="dark"]')).toHaveCount(3);
  await expect(page.locator(".desk-editor.is-visible .hcd-univer-host.univer-dark")).toBeVisible();
  await expect(page.locator(".desk-ai-card")).toHaveCSS("background-color", "rgb(36, 42, 47)");
  await expect(page.locator(".desk-compose textarea")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  assert(await liveDocument.evaluate((node) => node.isConnected));
  const fileTabs = page.locator(".desk-file-tab");
  await fileTabs
    .filter({ hasText: "工作坊行动表" })
    .dragTo(fileTabs.filter({ hasText: "工作坊简报" }));
  await expect(fileTabs.first()).toContainText("工作坊行动表");
  checks.push("Dragging reorders tabs without remounting their editors.");
  await target(sheet).check();
  await target(board).check();
  await target(doc).check();
  await homeTab.click();
  const editor = page.getByRole("textbox", { name: "全局 AI 指令" });
  await editor.fill("追加：下次访谈回访");
  await page.getByRole("button", { name: "收起全局 AI" }).click();
  await page.reload();
  await expect(homeTab).toHaveAttribute("aria-selected", "true");
  await expect(appearance).toHaveValue("dark");
  await appearance.selectOption("system");
  for (const colorScheme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator(".office-desk")).toHaveAttribute("data-theme", colorScheme);
    await expect(page.locator(`.desk-editor .hcd-embedded[data-theme="${colorScheme}"]`)).toHaveCount(3);
  }
  checks.push(
    "The top bar themes Home, all three editors and global AI together. Switching preserves the live document, explicit dark survives reload, and system mode follows OS changes.",
  );
  await page.getByRole("button", { name: "全局 AI", exact: true }).click();
  await expect(editor).toHaveValue("追加：下次访谈回访");
  await expect(target(sheet)).toBeEnabled({ timeout: 60000 });
  await expect(page.locator(".desk-file-tab")).toHaveCount(3);
  checks.push(
    "Three restored background editors; optional global panel, targets and unsent draft survive reload.",
  );
  const readBack = (needle = "下次访谈回访") => page.evaluate(async (needle) => {
    const json = async (path, init = {}) => {
      const response = await fetch(path, init);
      if (!response.ok) throw Error(path + " " + response.status);
      return response.json();
    };
    const account = await json("/workspace/api/session"),
      { files } = await json("/workspace/api/files"),
      out = {};
    for (const file of files.filter((f) =>
      ["docx", "xlsx", "excalidraw"].includes(f.format),
    )) {
      const launch = await json(
        "/workspace/api/files/" + file.id + "/editor-session",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workspace-CSRF": account.csrf,
          },
          body: JSON.stringify({ sessionId: crypto.randomUUID() }),
        },
      );
      const base = "/v1/documents/" + launch.documentId;
      const path =
        file.format === "xlsx"
          ? "/sheets/0"
          : file.format === "excalidraw"
            ? "/canvas"
            : "/editor";
      const state = await json(base + path, {
        headers: { Authorization: "Bearer " + launch.token },
      });
      out[file.format] = {
        contains: JSON.stringify(state).includes(needle),
        revision: state.revision,
      };
    }
    return out;
  }, needle);
  const beforeReview = await readBack();
  await page.getByRole("button", { name: "发送全局指令" }).click();
  const review = page.getByRole("button", { name: "应用全部待审核修改", exact: true });
  await expect(review).toBeVisible({ timeout: 45000 });
  await expect(page.locator(".desk-change dd:last-child").filter({ hasText: "下次访谈回访" })).toHaveCount(3);
  assert.deepEqual(await readBack(), beforeReview);
  await page.reload();
  await expect(review).toBeVisible({ timeout: 45000 });
  await expect(homeTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: new RegExp(doc) }).click();
  await expect(page.locator(".desk-editor.is-visible .tiptap")).toBeVisible();
  await page.screenshot({ path: join(output, "multi-tab.png") });
  const accepted = page.waitForResponse(r => r.status() === 202 && r.url().endsWith('/approve'));
  await review.click();
  await accepted;
  await page.reload();
  await expect(page.locator('.desk-receipt em[data-phase="complete"]')).toHaveCount(3, { timeout: 45000 });
  await expect(page.getByRole("tab", { name: new RegExp(doc) })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".is-visible .tiptap")).toContainText("下次访谈回访", { timeout: 40000 });
  await expect(page.locator(".desk-tab-pointer")).toHaveCount(0);
  const task = await readBack();
  for (const value of Object.values(task))
    assert(value.contains, JSON.stringify(task));
  checks.push(
    "DOCX, XLSX and Excalidraw stayed unchanged before approval. Review and write receipts survived reload. Independent engine read-back confirmed edits in the three authorized files.",
  );
  const passage = "可以验证的假设";
  const coords = await page
    .locator(".is-visible .tiptap p")
    .filter({ hasText: passage })
    .first()
    .evaluate((p, needle) => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode,
          i = n.textContent.indexOf(needle);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + needle.length);
        const r = range.getBoundingClientRect();
        return { x: r.x + 0.1, y: r.y + r.height / 2, end: r.right - 0.1 };
      }
      throw Error("Missing source passage");
    }, passage);
  await page.mouse.move(coords.x, coords.y);
  await page.mouse.down();
  await page.mouse.move(coords.end, coords.y, { steps: 12 });
  await page.mouse.up();
  await expect(
    page.locator(".desk-targets label").filter({ hasText: "工作坊简报" }),
  ).toContainText("正文");
  await editor.fill("把文档选区同步到其他文件");
  await page.reload();
  await expect(editor).toHaveValue("把文档选区同步到其他文件");
  await expect(
    page.locator(".desk-targets label").filter({ hasText: "工作坊简报" }),
  ).toContainText("正文", { timeout: 45000 });
  await expect(target(sheet)).toBeEnabled({ timeout: 45000 });
  checks.push(
    "The Word range and its pending global instruction were recovered on the same revision after reloading.",
  );
  await page.getByRole("button", { name: "发送全局指令" }).click();
  const transfer = page.locator(".desk-thread article").last();
  await transfer.getByRole("button", { name: "应用全部待审核修改", exact: true }).click();
  await expect(transfer.locator('em[data-phase="complete"]')).toHaveCount(2, {
    timeout: 45000,
  });
  await expect(transfer.locator('em[data-phase="reading"]')).toHaveCount(1);
  await editor.fill("读取选区");
  await page.getByRole("button", { name: "发送全局指令" }).click();
  const read = page.locator(".desk-thread article").last();
  await expect(read.locator(".desk-answer-text")).toContainText(
    "工作坊行动表.xlsx\n" + passage,
  );
  await expect(read.locator(".desk-tab-pointer")).toHaveCount(0);
  checks.push(
    "Copied an actual selected Word passage into the authorized spreadsheet cell and a new whiteboard note, with the source file remaining read-only for this task.",
  );
  await target(board).uncheck();
  await target(sheet).uncheck();
  await expect(target(doc)).toBeChecked();
  const revised = "能够试验的假设";
  const changedSentence = page.locator(".is-visible .tiptap p").filter({ hasText: revised });
  await editor.fill(`改写为：${revised}`);
  await page.getByRole("button", { name: "发送全局指令" }).click();
  const rewrite = page.locator(".desk-thread article").last();
  await expect(rewrite.locator(".desk-change dd").filter({ hasText: passage })).toHaveCount(1);
  await rewrite.getByRole("button", { name: "应用到 " + doc }).click();
  await expect(changedSentence).toBeVisible({ timeout: 45000 });
  let independent = page.locator(".is-visible .tiptap p").filter({ hasText: "下次访谈回访" }).last();
  await independent.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" · 人工补录");
  await expect(independent).toContainText("人工补录");
  await rewrite.getByRole("button", { name: /撤销 工作坊简报\.docx r\d+ 的修改/ }).click();
  await expect(rewrite.getByText("已撤销", { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(changedSentence).toHaveCount(0);
  await expect(page.locator(".is-visible .tiptap p").filter({ hasText: passage })).toBeVisible();
  await page.reload();
  await expect(rewrite.getByText("已撤销", { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(independent).toContainText("人工补录");
  checks.push("Only the chosen Word range was undone, and a later manual paragraph edit and undo receipt survived reload.");
  const original = page.locator(".desk-thread article").filter({ has: page.locator(".desk-user-message", { hasText: "追加：下次访谈回访" }) });
  await original.getByRole("button", { name: /撤销 工作坊简报\.docx r\d+ 的修改/ }).click();
  await expect(original.getByText("已撤销", { exact: true })).toHaveCount(1);
  independent = page.locator(".is-visible .tiptap p").filter({ hasText: "人工补录" }).last();
  await expect(independent).toHaveText(" · 人工补录");
  const append = "只撤回这段试验文字";
  await target(board).check();
  await editor.fill(`追加：${append}`);
  await page.getByRole("button", { name: "发送全局指令" }).click();
  const appended = page.locator(".desk-thread article").filter({ has: page.locator(".desk-user-message", { hasText: append }) });
  await appended.getByRole("button", { name: "应用全部待审核修改", exact: true }).click();
  await expect(appended.locator('em[data-phase="complete"]')).toHaveCount(2, { timeout: 45000 });
  await expect(page.locator(".is-visible .tiptap")).toContainText(append, { timeout: 45000 });
  assert((await readBack(append)).excalidraw.contains);
  await independent.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" · 后续补记");
  await appended.getByRole("button", { name: /撤销 工作坊简报\.docx r\d+ 的修改/ }).click();
  await expect(appended.getByText("已撤销", { exact: true })).toHaveCount(1);
  await expect(independent).toContainText("后续补记");
  await appended.getByRole("button", { name: /撤销 共创工作坊\.excalidraw r\d+ 的修改/ }).click();
  await expect(appended.getByText("已撤销", { exact: true })).toHaveCount(2);
  const afterUndo = await readBack(append);
  assert.equal(afterUndo.docx.contains, false);
  assert.equal(afterUndo.excalidraw.contains, false);
  assert((await readBack()).excalidraw.contains);
  checks.push("Approved Word and canvas additions can be removed individually; undo of a supplemented Word paragraph retains the manual text, and changes in separate paragraphs and canvas objects remain.");

  async function contentSearch(query = passage) {
    await homeTab.click();
    await page.getByRole("button", { name: "查找正文", exact: true }).click();
    const search = page.getByRole("dialog", { name: "搜索文件内容", exact: true });
    await search.getByRole("textbox", { name: "内容关键词" }).fill(query);
    await search.getByRole("button", { name: "搜索", exact: true }).click();
    return search;
  }
  const acrossFiles = await contentSearch();
  for (const name of [doc, sheet, board]) await expect(acrossFiles.getByRole("region", { name, exact: true })).toContainText(passage, { timeout: 45000 });
  await page.screenshot({ path: join(output, "content-search.png") });
  await acrossFiles.getByRole("region", { name: sheet, exact: true }).getByRole("button", { name: new RegExp(passage) }).first().click();
  await expect(page.getByRole("tab", { name: sheet, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".is-visible").getByRole("textbox", { name: "单元格内容或公式", exact: true })).toHaveValue(passage);
  const prose = await contentSearch();
  await prose.getByRole("region", { name: doc, exact: true }).getByRole("button", { name: new RegExp(passage) }).first().click();
  await expect(page.getByRole("tab", { name: doc, exact: true })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(passage);
  checks.push("One workspace search reads authorized content in Word, spreadsheets and canvas; choosing a result opens its exact Word selection or spreadsheet cell.");
  const newName = "会后手记.txt", newText = "另一个会话刚补充的验证结论";
  const imported = await page.evaluate(async ({name, text}) => {
    const {csrf} = await (await fetch("/workspace/api/session")).json();
    return (await fetch("/workspace/api/files?filename=" + encodeURIComponent(name), {
      method: "POST", headers: {"X-Workspace-CSRF": csrf, "Content-Type": "application/octet-stream"}, body: text,
    })).status;
  }, {name: newName, text: newText});
  assert.equal(imported, 201);
  const fresh = await contentSearch(newText);
  await fresh.getByRole("region", {name: newName, exact: true}).getByRole("button", {name: new RegExp(newText)}).click();
  await expect(page.getByRole("tab", {name: newName, exact: true})).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".is-visible .tiptap")).toContainText(newText);
  await page.getByRole("button", {name: "关闭 " + newName, exact: true}).click();
  await page.getByRole("tab", {name: doc, exact: true}).click();
  checks.push("A search result for a file added after Home loaded opens without refreshing or losing the other tabs.");
  await page.getByRole("button", { name: "管理标签", exact: true }).click();
  const menu = page.locator(".desk-tab-menu");
  await menu.getByLabel("工作坊简报").check();
  await menu.getByLabel("共创工作坊").check();
  await menu.getByLabel("分组名称").fill("共创");
  await menu.getByRole("button", { name: "分组", exact: true }).click();
  await expect(
    page.locator(".desk-file-tab small", { hasText: "共创" }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "管理标签", exact: true }).click();
  await menu.getByLabel("工作坊简报").check();
  await menu.getByLabel("共创工作坊").check();
  await menu.getByRole("button", { name: "关闭选中标签" }).click();
  await expect(page.locator(".desk-file-tab")).toHaveCount(1);
  await page.getByRole("button", { name: "管理标签", exact: true }).click();
  await menu.getByRole("button", { name: doc, exact: true }).click();
  await expect(page.locator(".is-visible .tiptap")).toContainText(
    "人工补录 · 后续补记",
    { timeout: 45000 },
  );
  checks.push("Group, batch close, reopen and read saved content.");
  await homeTab.click();
  await page.getByRole("button", { name: "新建文档", exact: true }).click();
  await page.getByLabel("文件名称", { exact: true }).fill("工作台验收");
  await page.getByRole("button", { name: "创建并打开" }).click();
  await expect(
    page.getByRole("tab", { name: "工作台验收.docx", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  checks.push("Create a native Word file from Home and open it in a new tab.");
  const created = "工作台验收.docx";
  await expect(page.locator(".is-visible .tiptap")).toBeVisible({
    timeout: 45000,
  });
  await target(created).check();
  await expect(target(sheet)).not.toBeChecked();
  await target(sheet).check();
  const share = page.getByRole("button", {
    name: "复制所选范围的 MCP 配置",
    exact: true,
  });
  await share.click();
  await expect(
    page.getByText("已复制 2 份文件范围的短期 MCP 配置。"),
  ).toBeVisible();
  const config = await page.evaluate(async () =>
    JSON.parse(await navigator.clipboard.readText()),
  );
  assert.equal(Object.keys(config.mcpServers).length, 2);
  const [externalName, connection] = Object.entries(config.mcpServers).find(
    ([name]) => name.startsWith("office-docx-"),
  );
  const fileId = externalName.slice("office-docx-".length);
  const streamReady = page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const source = new EventSource("/workspace/api/agent-activity/stream");
        const phases = [];
        const timeout = setTimeout(() => {
          source.close();
          resolve(phases);
        }, 10000);
        source.onmessage = (e) => {
          for (const item of JSON.parse(e.data).activity.filter(
            (a) => a.fileId === id,
          ))
            if (!phases.includes(item.phase)) phases.push(item.phase);
          if (phases.includes("complete")) {
            clearTimeout(timeout);
            source.close();
            resolve(phases);
          }
        };
      }),
    fileId,
  );
  await page.getByRole("button", { name: "收起全局 AI" }).click();
  await homeTab.click();
  const client = new Client({ name: "external-workbench-agent", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: connection.headers },
      }),
    );
    const externalWrite = await client.callTool({
      name: "append_to_file",
      arguments: {
        requestId: crypto.randomUUID(),
        text: "来自外部 Agent 的记录",
      },
    });
    assert(!externalWrite.isError);
    await expect(
      page.locator('.desk-file-tab[data-file-id="' + fileId + '"]'),
    ).toHaveAttribute("data-phase", "complete", { timeout: 12000 });
    assert.deepEqual(await streamReady, ["editing", "complete"]);
    await expect(homeTab).toHaveAttribute("aria-selected", "true");
  } finally {
    await client.close();
  }
  checks.push(
    "An independent MCP client used one of two scoped file connections, streamed the real editing and completion events into the open tabs, and left Home and the closed AI panel in place.",
  );
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    deviceScaleFactor: 1,
  });
  try {
    const small = await phone.newPage();
    await small.goto(site + "/workbench/");
    await expect(
      small.getByRole("heading", { name: "工作空间", exact: true }),
    ).toBeVisible();
    await expect(
      small.getByRole("complementary", { name: "全局 AI" }),
    ).toHaveCount(0);
    assert(
      await small.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await small.getByRole("button", { name: "全局 AI", exact: true }).click();
    await expect(
      small.getByRole("button", { name: "收起全局 AI" }),
    ).toBeVisible();
    await checkDock(small);
    await small.screenshot({ path: join(output, "mobile-ai.png") });
    await small.getByRole("button", { name: "收起全局 AI" }).click();
    await small
      .getByRole("button", { name: "打开 " + sheet, exact: true })
      .click();
    await expect(
      small.getByRole("tab", { name: sheet, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await small.getByRole("button", { name: "全局 AI", exact: true }).click();
    await small.getByRole("tab", { name: sheet, exact: true }).click();
    await expect(
      small.getByRole("complementary", { name: "全局 AI" }),
    ).toHaveCount(0);
  } finally {
    await phone.close();
  }
  checks.push(
    "On a 390px phone the home, file opener and optional AI drawer stay within the viewport.",
  );
  const resources = await browser.newContext({ viewport: { width: 1500, height: 950 }, reducedMotion: "reduce" });
  try {
    page = await resources.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(site + "/workbench/");
    await verifyTabResources(page, checks);
    await page.screenshot({ path: join(output, "resource-workflow.png") });
  } catch (error) {
    console.error((await page.getByRole('alert').allTextContents().catch(() => [])).join('\n'));
    if (errors.length) console.error(errors.slice(-4).join('\n'));
    await page.screenshot({ path: join(output, 'resource-failed.png') }).catch(() => {});
    throw error;
  } finally {
    await resources.close();
  }
  const panels = await browser.newContext({ viewport: { width: 1185, height: 1033 } });
  try {
    page = await panels.newPage();
    await page.goto(site + "/workbench/?ai=0");
    const editor = page.locator(".desk-editor.is-visible");
    const left = editor.locator(".workspace-left-panel");
    for (const [name, navigation] of [[doc, "显示大纲"], [sheet, "工作表导航"], ["复盘提案.pptx", "幻灯片列表"]]) {
      await page.getByRole("tab", {name:"首页", exact:true}).click();
      await page.getByRole("button", {name:"打开 " + name, exact:true}).click();
      const view = editor.getByRole("button", {name:"视图", exact:true});
      await expect(view).toBeVisible({timeout:30000});
      await expect(editor.locator(".editor-header,.workspace-panel-controls")).toHaveCount(0);
      await expect(left).toBeHidden();
      await view.click();
      const toggle = editor.getByRole("checkbox", {name:navigation, exact:true});
      await toggle.check();
      await expect(left).toBeVisible();
      if (name.endsWith(".pptx")) {
        await page.reload();
        await expect(left).toBeVisible({timeout:30000});
        await expect(toggle).toBeChecked();
        await left.getByRole("button", {name:"幻灯片 2", exact:true}).click();
        await editor.getByRole("button", {name:"从当前页放映", exact:true}).click();
        const show = page.getByRole("dialog", {name:"幻灯片放映"});
        await expect(show.locator("output")).toHaveText(/^2\s*\//);
        await page.keyboard.press("Escape");
        await expect(show).toHaveCount(0);
      }
      await left.getByRole("button", {name:"收起左侧面板", exact:true}).click();
      await expect(left).toBeHidden();
      await editor.getByRole("button", {name:"界面设置", exact:true}).click();
      const settings = editor.getByRole("complementary", {name:"界面设置", exact:true});
      await expect(settings).toBeVisible();
      await settings.getByRole("button", {name:"隐藏右侧栏", exact:true}).click();
      await expect(settings).toBeHidden();
      await expect(editor.locator(".integrated-file-menu > summary")).toBeVisible();
    }
    checks.push("Word, spreadsheet and slide tabs use one file title, reclaim both closed panel columns, and reopen their panels from View. The slide navigator survives reload.");
  } finally {
    await panels.close();
  }
  await context.close();
  const workflow = await browser.newContext({ viewport: { width: 1500, height: 950 }, reducedMotion: "reduce" });
  try {
    page = await workflow.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(site + "/workbench/");
    const home = page.getByRole("tab", { name: "首页", exact: true });
    const visiblePane = page.locator(".desk-editor.is-visible");
    for (const name of [doc, board, sheet]) {
      await home.click();
      await page.getByRole("button", { name: "打开 " + name, exact: true }).click();
    }
    const activeCell = visiblePane.getByLabel("选中单元格", { exact: true });
    await visiblePane.locator('canvas[id^="univer-sheet-main-canvas_"]').first().click({position:{x:58,y:32}});
    await expect(activeCell).toHaveText("A1");
    await home.click();
    for (const name of [doc, board, sheet]) await target(name).check();
    const chat = page.getByRole("textbox", { name: "全局 AI 指令" });
    await chat.fill(workflowPrompt);
    await page.getByRole("button", { name: "发送全局指令" }).click();
    const chain = page.locator(".desk-thread article").filter({ has: page.locator(".desk-user-message", { hasText: workflowPrompt }) });
    const approve = name => chain.getByRole("button", { name: "应用到 " + name, exact: true });
    const wait = chain.locator('em[data-phase="waiting"]');
    await expect(wait).toHaveCount(2, {timeout:30000});
    await expect(approve(doc)).toHaveCount(0);
    assert.equal(stageRequests.length, 0);
    await approve(sheet).click();
    await expect(approve(doc)).toBeEnabled({ timeout: 45000 });
    await expect(wait).toHaveCount(1);
    assert.equal(stageRequests[0].previous, "已核对 12 条访谈");
    assert((await readBack("已核对 12 条访谈")).xlsx.contains);
    await expect(approve(board)).toHaveCount(0);
    const firstRevision = stageRequests[0].targetRevision;
    const originalSheetRevision = stageRequests[0].previousRevision;
    await page.getByRole("tab", { name: doc, exact: true }).click();
    const manualText = "并行补录的问卷编号";
    const prose = visiblePane.locator(".tiptap p").filter({hasText:"可以验证的假设"}).first();
    await expect(visiblePane.locator(".tiptap").first()).toHaveAttribute("contenteditable", "true");
    await prose.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" · " + manualText);
    await expect(prose).toContainText(manualText);
    await visiblePane.getByRole("button", { name: "插入", exact: true }).click();
    const savePoint = visiblePane.getByRole("button", { name: "保存点", exact: true });
    if (!await savePoint.isVisible()) {
      await visiblePane.getByRole("button", { name: "展开功能区", exact: true }).click();
    }
    await savePoint.click();
    await expect.poll(async () => (await readBack(manualText)).docx.contains, {timeout:25000}).toBe(true);
    await approve(doc).click();
    const recheck = chain.getByRole("button", { name: "重新核对 " + doc, exact: true });
    await expect(recheck).toBeEnabled({timeout:45000});
    await expect(approve(board)).toHaveCount(0);
    assert.equal(stageRequests.length, 1);
    await page.reload();
    await expect(recheck).toBeEnabled({timeout:45000});
    await recheck.click();
    await expect(approve(doc)).toBeEnabled({timeout:45000});
    assert(stageRequests[1].targetRevision > firstRevision);
    assert.equal(stageRequests[1].previousRevision, originalSheetRevision);
    await page.screenshot({ path: join(output, "workflow-recheck.png") });
    assert.equal((await readBack("文档核对记录")).docx.contains, false);
    await approve(doc).click();
    await expect(approve(board)).toBeEnabled({timeout:45000});
    assert.equal(stageRequests[2].previous, "文档核对记录 · 已核对 12 条访谈");
    assert.equal((await readBack("白板核对结论")).excalidraw.contains, false);
    await approve(board).click();
    await expect(chain.locator('em[data-phase="complete"]')).toHaveCount(3, {timeout:45000});
    assert.equal((await readBack("已核对 12 条访谈")).xlsx.revision, originalSheetRevision);
    assert((await readBack("白板核对结论")).excalidraw.contains);
    assert((await readBack(manualText)).docx.contains);
    checks.push("A real worksheet → Word → whiteboard dependency chain waits for each saved revision. A later Word edit rejects its stale review; after reload only Word is rechecked, the worksheet receipt and manual text remain, and the whiteboard draft uses the confirmed Word result.");
  } catch (error) {
    console.error((await page.getByRole("alert").allTextContents().catch(() => [])).join("\n"));
    await page.screenshot({ path: join(output, "workflow-failed.png") }).catch(() => {});
    throw error;
  } finally {
    await workflow.close();
  }
  const projectContext = await browser.newContext({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  try {
    page = await projectContext.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(site + "/workbench/?ai=0");
    const home = page.getByRole("tab", { name: "首页", exact: true });
    const files = page.locator(".desk-home-main");
    const button = (name, host = files) => host.getByRole("button", { name, exact: true });
    const dialog = name => page.getByRole("dialog", { name, exact: true });
    await button("共享项目", page.getByRole("navigation", { name: "工作空间导航" })).click();
    await button("新建项目").click();
    const projectName = "六月交付小组";
    await dialog("新建项目").getByRole("textbox", { name: "项目名称" }).fill(projectName);
    await button("保存", dialog("新建项目")).click();
    await expect(files.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
    async function addFolder(name) {
      await button("新建文件夹").click();
      const add = dialog("新建文件夹");
      await add.getByRole("textbox", { name: "文件夹名称" }).fill(name);
      await button("保存", add).click();
      await button(name).click();
      await expect(files.getByRole("heading", { name, exact: true })).toBeVisible();
    }
    await addFolder("工作记录");
    await addFolder("会议");
    const directory = new URL(page.url());
    assert(directory.searchParams.has("project") && directory.searchParams.has("folder"));
    await button("新建文档").click();
    const welcome = dialog("新建文档");
    await expect(welcome.getByText("保存到 六月交付小组 / 工作记录 / 会议")).toBeVisible();
    await welcome.getByRole("textbox", { name: "文件名称" }).fill("团队计划");
    await button("创建并打开", welcome).click();
    await expect(page.getByRole("tab", { name: "团队计划.docx", exact: true })).toHaveAttribute("aria-selected", "true");
    await home.click();
    const teamNote = "会议信息.txt", text = "项目会议核对记录";
    await files.locator('input[type="file"]').setInputFiles({ name: teamNote, mimeType: "text/plain", buffer: Buffer.from(text) });
    await expect(page.getByRole("tab", { name: teamNote, exact: true })).toHaveAttribute("aria-selected", "true");
    await home.click();
    await expect(button("打开 " + teamNote)).toBeVisible();
    await expect(button("打开 团队计划.docx")).toBeVisible();
    await page.screenshot({ path: join(output, "project-folder.png") });
    await button("移动 " + teamNote).click();
    const mover = dialog("移动文件");
    await mover.getByRole("combobox", { name: "文件夹", exact: true }).selectOption({ label: "项目根目录" });
    await button("移动到这里", mover).click();
    await expect(button("打开 " + teamNote)).toHaveCount(0);
    await button(projectName, files.locator(".desk-breadcrumb")).click();
    await expect(button("打开 " + teamNote)).toBeVisible();
    await button("查找正文").click();
    const finder = dialog("搜索文件内容");
    await finder.getByRole("textbox", { name: "内容关键词" }).fill(text);
    await button("搜索", finder).click();
    await expect(finder.getByRole("region", { name: teamNote })).toContainText(text);
    await button("关闭内容搜索", finder).click();
    await button("项目成员").click();
    const roster = dialog("项目成员");
    const addPerson = roster.getByRole("combobox", { name: "添加成员", exact: true });
    const memberId = await addPerson.locator("option").nth(1).getAttribute("value");
    assert(memberId);
    await addPerson.selectOption(memberId);
    await roster.getByRole("combobox", { name: "项目角色", exact: true }).selectOption("viewer");
    await button("添加到项目", roster).click();
    await expect(roster.getByRole("combobox", { name: /的角色$/ })).toHaveValue("viewer");
    await page.screenshot({ path: join(output, "project-members.png") });
    await button("关闭", roster).click();
    await button("工作记录").click();
    await button("管理文件夹 会议").click();
    const rename = dialog("管理文件夹");
    await rename.getByRole("textbox", { name: "文件夹名称" }).fill("评审会议");
    await button("保存", rename).click();
    await button("评审会议").click();
    await page.reload();
    await expect(files.getByRole("heading", { name: "评审会议", exact: true })).toBeVisible();
    await expect(button("打开 团队计划.docx")).toBeVisible();
    await expect(button("打开 " + teamNote)).toHaveCount(0);
    checks.push("The real workbench creates a shared project and nested folders, places new Word and uploaded text files in the selected folder, moves a file to the root, searches within the project, updates a member role and restores the same folder after reload.");
  } catch (error) {
    console.error((await page.getByRole("alert").allTextContents().catch(() => [])).join("\n"));
    await page.screenshot({ path: join(output, "project-failed.png") }).catch(() => {});
    throw error;
  } finally {
    await projectContext.close();
  }
  const slides = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
  try {
    page = await slides.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(site + "/workbench/?ai=0");
    await verifySlideObjects(page, output, checks);
    await verifyPptxInheritance(page, output, checks);
    await verifySheetCharts(page, output, checks);
    await verifyWordPictures(page, output, checks);
    await verifyWordReview(page, output, checks);
    await verifyWordTracked(page, output, checks);
    await verifyWordTableCells(page, output, checks);
  } catch (error) {
    console.error((await page.getByRole("alert").allTextContents().catch(() => [])).join("\n"));
    await page.screenshot({ path: join(output, "pptx-object-failure.png") }).catch(() => {});
    throw error;
  } finally {
    await slides.close();
  }
  await verifySlideNoteDraft(browser, site, output, checks);
  assert.deepEqual(errors, []);
  writeFileSync(
    join(output, "validation.json"),
    JSON.stringify({ checks, readBack: task }, null, 2) + "\n",
  );
  console.log(checks.join("\n") + "\n" + output);
} catch (e) {
  writeFileSync(join(output, "failure.json"), JSON.stringify({ error: String(e), stack: e?.stack }, null, 2));
  if (page) {
    console.error(
      (
        await page
          .locator(".desk-ai")
          .innerText({timeout:1500})
          .catch(() => "")
      ).slice(-2800),
    );
    await page.screenshot({ path: join(output, "failed.png") }).catch(() => {});
  }
  console.error(log.slice(-1800));
  throw e;
} finally {
  await browser?.close();
  service.kill("SIGTERM");
  await stopped;
  await new Promise(resolve => model.close(resolve));
}
