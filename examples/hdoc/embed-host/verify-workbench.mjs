import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const service = spawn(
  process.execPath,
  [join(import.meta.dirname, "demo.mjs")],
  {
    env: { ...process.env, OFFICECLI_EMBED_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
service.stdout.on("data", (s) => (log += s));
service.stderr.on("data", (s) => (log += s));
const stopped = once(service, "exit"),
  checks = [];
let browser, page, failRelease;
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
    const [tabs, pane, canvas] = await Promise.all([
      page.locator(".desk-chrome").boundingBox(), boardPane.boundingBox(), drawing.boundingBox(),
    ]);
    assert(Math.abs(canvas.y - tabs.y - tabs.height) <= 1);
    assert(Math.abs(canvas.x - pane.x) <= 1 && Math.abs(canvas.width - pane.width) <= 1);
    assert(Math.abs(canvas.y + canvas.height - (pane.y + pane.height)) <= 1);
  };
  await assertCanvasFillsPane();
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
  const waiting = [],
    released = new Promise((r) => (failRelease = r));
  await page.route("**/workspace/mcp/selection", async (route) => {
    let rpc;
    try {
      rpc = route.request().postDataJSON();
    } catch {}
    if (
      rpc?.method === "tools/call" &&
      ["edit_selected_cells", "append_to_file"].includes(rpc.params?.name)
    ) {
      waiting.push(rpc.params.name);
      await released;
    }
    await route.continue().catch(() => {});
  });
  await page.getByRole("button", { name: "发送全局指令" }).click();
  await expect.poll(() => waiting.length, { timeout: 45000 }).toBe(3);
  await expect(
    page.locator('.desk-file-tab[data-phase="editing"] .desk-tab-pointer'),
  ).toHaveCount(3);
  await expect(homeTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: new RegExp(doc) }).click();
  await expect(page.locator(".desk-editor.is-visible .tiptap")).toBeVisible();
  const pointerColors = [];
  for (const name of [doc, board, sheet]) {
    const title = name.slice(0, name.lastIndexOf("."));
    const tab = page.locator(".desk-file-tab").filter({ hasText: title });
    const fill = await tab
      .locator(".desk-tab-pointer .agent-arrow-face")
      .evaluate((node) => getComputedStyle(node).fill);
    const receipt = page.locator(".desk-receipt").filter({ hasText: title });
    assert.equal(
      await receipt
        .locator("em")
        .evaluate((node) => getComputedStyle(node).color),
      fill,
    );
    pointerColors.push(fill);
  }
  assert.equal(new Set(pointerColors).size, 3);
  await page.screenshot({ path: join(output, "multi-tab.png") });
  await expect(
    page.getByRole("tab", { name: new RegExp(doc) }),
  ).toHaveAttribute("aria-selected", "true");
  failRelease();
  await expect(
    page.locator('.desk-receipt em[data-phase="complete"]'),
  ).toHaveCount(3, { timeout: 45000 });
  await expect(page.locator(".is-visible .tiptap")).toContainText(
    "下次访谈回访",
    { timeout: 40000 },
  );
  await expect(page.locator(".desk-tab-pointer")).toHaveCount(0);
  checks.push(
    "Actual MCP writes to DOCX, XLSX and Excalidraw, three file-colored pointers only during writes; switching the foreground tab did not retarget work.",
  );
  const task = await page.evaluate(async () => {
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
        contains: JSON.stringify(state).includes("下次访谈回访"),
        revision: state.revision,
      };
    }
    return out;
  });
  for (const value of Object.values(task))
    assert(value.contains, JSON.stringify(task));
  checks.push(
    "Independent engine read-back confirmed the appended text in all three formats.",
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
    "下次访谈回访",
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
  assert.deepEqual(errors, []);
  writeFileSync(
    join(output, "validation.json"),
    JSON.stringify({ checks, readBack: task }, null, 2) + "\n",
  );
  console.log(checks.join("\n") + "\n" + output);
} catch (e) {
  if (page) {
    console.error(
      (
        await page
          .locator(".desk-ai")
          .innerText()
          .catch(() => "")
      ).slice(-2800),
    );
    await page.screenshot({ path: join(output, "failed.png") }).catch(() => {});
  }
  console.error(log.slice(-1800));
  throw e;
} finally {
  failRelease?.();
  await browser?.close();
  service.kill("SIGTERM");
  await stopped;
}
