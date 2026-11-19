import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { askExternalAgent } from "./agent.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, expect } from "../editor/node_modules/@playwright/test/index.mjs";

const artifacts = resolve(
  process.env.OFFICECLI_EMBED_ARTIFACTS || mkdtempSync(join(tmpdir(), "officecli-embed-proof-")),
);
mkdirSync(artifacts, { recursive: true });
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const site = "http://fold.localhost:" + port;
const service = spawn(process.execPath, [join(import.meta.dirname, "demo.mjs")], {
  env: { ...process.env, OFFICECLI_EMBED_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
service.stdout.on("data", (x) => (log += x));
service.stderr.on("data", (x) => (log += x));
const done = once(service, "exit"),
  checks = [];
let browser;
async function connect(grant) {
  const c = new Client({ name: "independent-mcp-verifier", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(grant.endpoint), {
      requestInit: { headers: { Authorization: "Bearer " + grant.token } },
    }),
  );
  return c;
}
async function tool(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw Error(r.content[0].text);
  return r.structuredContent || JSON.parse(r.content[0].text);
}
async function selectText(page, needle) {
  const rect = await textRect(page, needle);
  await page.mouse.move(rect.left + 0.2, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.right - 0.2, rect.y, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "连接当前选区" })).toBeEnabled();
}
async function textRect(page, needle) {
  const p = page.locator(".tiptap p").filter({ hasText: needle }).first();
  await p.scrollIntoViewIfNeeded();
  return p.evaluate((p, needle) => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT),
      nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const full = nodes.map((n) => n.textContent).join(""),
      start = full.indexOf(needle),
      end = start + needle.length;
    if (start < 0) throw Error("Selection text missing: " + full);
    const range = document.createRange();
    let offset = 0;
    for (const node of nodes) {
      const next = offset + node.textContent.length;
      if (offset <= start && start < next) range.setStart(node, start - offset);
      if (offset < end && end <= next) {
        range.setEnd(node, end - offset);
        break;
      }
      offset = next;
    }
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  }, needle);
}
async function grantFor(p) {
  const wait = p.waitForResponse(
    (r) =>
      r.url().endsWith("/workspace/api/embed/selection") &&
      r.request().method() === "PUT" &&
      JSON.parse(r.request().postData()).selection !== null,
  );
  await p.getByRole("button", { name: "连接当前选区" }).click();
  const response = await wait;
  assert.equal(response.status(), 200, await response.text().then((x) => (response.ok() ? "" : x)));
  return { ...(await response.json()), request: response.request().postDataJSON() };
}
try {
  await expect.poll(() => log.includes("业务系统 "), { timeout: 60000 }).toBe(true);
  browser = await chromium.launch({
    ...(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {}),
    args: ["--no-proxy-server"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 990 } });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(site + "/embed-example/?view=document");
  await expect(page.locator(".tiptap")).toContainText("共创简报", { timeout: 45000 });
  await expect(page.getByRole("complementary", { name: "AI 聊天" })).toHaveCount(0);
  await selectText(page, "访谈");
  const doc = await grantFor(page);
  const dc = await connect(doc);
  const { csrf } = await (await page.request.get(site + "/workspace/api/session")).json();
  const putSelection = (data) =>
    page.request.put(site + "/workspace/api/embed/selection", {
      headers: { Origin: site, "X-Workspace-CSRF": csrf },
      data,
    });
  const secondBody = { ...doc.request, instanceId: randomUUID(), generation: 1 };
  const concurrent = await putSelection(secondBody);
  assert.equal(concurrent.status(), 200);
  const peer = await connect(await concurrent.json());
  const mismatched = await putSelection({
    ...secondBody,
    instanceId: randomUUID(),
    fileId: randomUUID(),
  });
  assert.equal(mismatched.ok(), false);
  const noBearer = await page.request.post(site + "/workspace/mcp/selection", {
    headers: { Origin: site },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(noBearer.status(), 401);
  assert.deepEqual((await dc.listTools()).tools.map((t) => t.name).sort(), [
    "read_selection",
    "replace_selected_text",
  ]);
  const read = await tool(dc, "read_selection");
  assert.equal(read.spans.length, 1);
  assert.equal(read.spans[0].text, "访谈");
  await assert.rejects(
    tool(dc, "replace_selected_text", {
      requestId: randomUUID(),
      replacements: ["越界", "不应写入"],
    }),
    /每个选区/,
  );
  let modelRequest;
  const mock = httpServer(async (req, res) => {
    assert.equal(req.url, "/api/chat");
    const parts = [];
    for await (const part of req) parts.push(part);
    modelRequest = JSON.parse(Buffer.concat(parts).toString());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        message: { content: JSON.stringify({ action: "answer", reply: "指的是访谈。" }) },
      }),
    );
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  try {
    const reply = await askExternalAgent({
      endpoint: doc.endpoint,
      token: doc.token,
      prompt: "用一句话解释选中的词",
      model: "fixture",
      base: "http://127.0.0.1:" + mock.address().port,
    });
    assert.equal(reply.reply, "指的是访谈。");
    assert.deepEqual(JSON.parse(modelRequest.messages[1].content).selection, read);
    assert(!JSON.stringify(modelRequest).includes(doc.token));
    assert(!JSON.stringify(modelRequest).includes("周五一起查看白板"));
  } finally {
    await new Promise((done) => mock.close(done));
  }
  await page.getByRole("button", { name: "AI 聊天", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "AI 聊天" })).toBeVisible();
  assert.equal((await tool(dc, "read_selection")).spans[0].text, "访谈");
  await page.getByLabel("消息", { exact: true }).fill("读取选区");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".chat-messages")).toContainText("访谈");
  await page.screenshot({ path: join(artifacts, "document-chat.png"), fullPage: true });
  await page.getByRole("button", { name: "AI 聊天", exact: true }).click();
  const receipt = await tool(dc, "replace_selected_text", {
    requestId: randomUUID(),
    replacements: ["田野记录"],
  });
  assert.equal(receipt.documentId, doc.documentId);
  assert(Number.isSafeInteger(receipt.revision));
  await assert.rejects(
    tool(peer, "replace_selected_text", {
      requestId: randomUUID(),
      replacements: ["覆盖过期内容"],
    }),
    /选区或文件版本已改变/,
  );
  await peer.close();
  await expect(page.locator(".tiptap")).toContainText("我们将田野记录整理成一份共创简报。", {
    timeout: 30000,
  });
  await expect(page.locator(".tiptap")).toContainText("周五一起查看白板");
  checks.push(
    "独立 Word 编辑器提供精确文字选区。无 Cookie 的 MCP 客户端仅替换选中两字，前后文与其他段落保留，页面收到新修订。",
  );
  checks.push(
    "宿主聊天栏可打开、发出选区请求并关闭，切换聊天显示不会重新创建编辑器或更换 MCP 目标。",
  );
  checks.push(
    "并发持有旧修订的外部连接收到冲突。登录 Cookie 单独无法访问 MCP，模拟模型端仅收到选区内容与指令。",
  );
  await dc.close();
  await selectText(page, "周五");
  const cleared = await grantFor(page);
  const revoked = await connect(cleared);
  assert.deepEqual(
    (await tool(revoked, "read_selection")).spans.map((s) => s.text),
    ["周五"],
  );
  const preciseText = await textRect(page, "周五");
  await page.mouse.click(preciseText.left + 1, preciseText.y);
  await expect(page.getByRole("button", { name: "读取选区", exact: true })).toBeDisabled();
  await expect
    .poll(
      async () => {
        try {
          await tool(revoked, "read_selection");
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 8000 },
    )
    .toBe(true);
  await revoked.close();
  await selectText(page, "周五");
  const next = await grantFor(page);
  const old = await connect(next);
  await page.getByRole("button", { name: "白板", exact: true }).click();
  await page.getByText("实时协作已连接", { exact: false }).waitFor({ timeout: 40000 });
  await expect
    .poll(
      async () => {
        try {
          await tool(old, "read_selection");
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 8000 },
    )
    .toBe(true);
  await old.close();
  checks.push(
    "鼠标收起选区及切换文件都会撤销已发凭据。宿主按钮获得焦点后再选正文，以新手势的位置为准。",
  );
  const surface = await page.locator(".canvas-surface").boundingBox(),
    x = surface.x + surface.width / 2 - 230,
    y = surface.y + surface.height / 2 + 86;
  await page.mouse.click(x, y);
  const board = await grantFor(page);
  const bc = await connect(board);
  assert.deepEqual((await bc.listTools()).tools.map((t) => t.name).sort(), [
    "edit_canvas_selection",
    "read_selection",
  ]);
  const before = await tool(bc, "read_selection");
  assert.deepEqual(before.elements.map((e) => e.id).sort(), [
    "observe",
    "observe-note",
    "observe-title",
  ]);
  await assert.rejects(
    tool(bc, "edit_canvas_selection", {
      requestId: randomUUID(),
      edits: [{ id: "choose", dx: 100 }],
    }),
    /选区之外/,
  );
  await page.screenshot({ path: join(artifacts, "board-agent.png"), fullPage: true });
  await page.getByRole("button", { name: "向右移动 24" }).click();
  await expect(page.locator(".agent-receipt")).toContainText("已保存到 r", { timeout: 12000 });
  await page.reload();
  await page.getByText("实时协作已连接", { exact: false }).waitFor({ timeout: 40000 });
  if (!(await page.getByRole("button", { name: "连接当前选区" }).isEnabled()))
    await page.mouse.click(x + 24, y);
  const again = await grantFor(page),
    wc = await connect(again);
  const after = await tool(wc, "read_selection");
  assert.equal(after.elements.length, before.elements.length);
  for (const element of before.elements)
    assert.equal(after.elements.find((e) => e.id === element.id)?.x, element.x + 24);
  checks.push(
    "独立白板仅接受选中对象 ID。越界修改被拒绝，原生对象右移 24 个画布单位后刷新仍然保留。",
  );
  await page.getByText("外部连接信息", { exact: true }).click();
  const release = page.waitForResponse(
    (r) =>
      r.url().endsWith("/workspace/api/embed/selection") &&
      r.request().postDataJSON()?.selection === null,
  );
  await page.getByRole("button", { name: "断开连接" }).click();
  assert.equal((await release).status(), 200);
  await assert.rejects(tool(wc, "read_selection"));
  await wc.close();
  await bc.close();
  await page.goto(site + "/embed-example/?view=document");
  await expect(page.locator(".tiptap")).toContainText("我们将田野记录整理成一份共创简报。", {
    timeout: 30000,
  });
  await page.getByRole("link", { name: "单独打开" }).click();
  await expect(page.getByRole("navigation", { name: "嵌入视图" })).toHaveCount(0);
  await expect(page.locator(".tiptap")).toContainText("田野记录", { timeout: 30000 });
  await page.goto(site + "/embed-example/?view=board&standalone=1");
  await expect(page.getByRole("navigation", { name: "嵌入视图" })).toHaveCount(0);
  await expect(page.locator(".canvas-workspace")).toBeVisible({ timeout: 30000 });
  assert.equal(await page.getByRole("complementary", { name: "AI 聊天" }).count(), 0);
  checks.push("文档和白板可用单文件地址独立打开。两种入口均默认关闭聊天。");
  assert.deepEqual(errors, []);
  writeFileSync(
    join(artifacts, "validation.json"),
    JSON.stringify({ status: "passed", checks }, null, 2) + "\n",
  );
  console.log(checks.join("\n"), "\n", artifacts);
} catch (e) {
  console.error(log.slice(-1200));
  throw e;
} finally {
  await browser?.close();
  service.kill("SIGTERM");
  await done;
}
