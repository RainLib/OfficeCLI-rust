import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";

// Real packaged Workspace, SQLite Provider, Rust engine and browsers. Only the
// model is scripted locally: this test never consumes external API credentials.
const repo = resolve(import.meta.dirname, "../../.."), app = join(repo, "apps/workspace");
const testHost = process.env.OFFICECLI_CANVAS_TEST_HOST || "127.0.0.1";
const urlHost = testHost.includes(":") ? `[${testHost}]` : testHost;
const root = mkdtempSync(join(tmpdir(), "officecli-workspace-canvas-"));
const artifacts = resolve(process.env.OFFICECLI_CANVAS_ARTIFACTS || join(root, "artifacts"));
mkdirSync(artifacts, { recursive: true });
const checks = [], password = randomBytes(24).toString("base64url");
const log = createWriteStream(join(root, "services.log"), { mode: 0o600 });
let supervisor, browser, model;
const listen = async server => { await new Promise(done => server.listen(0, testHost, done)); return server.address().port; };
async function port() { const server = createServer(), value = await listen(server); await new Promise(done => server.close(done)); return value; }
const webPort = await port(), enginePort = await port(), collabPort = await port(), base = `http://${urlHost}:${webPort}`;
const engineUrl = `http://${urlHost}:${enginePort}`;
async function poll(read, timeout = 45_000) {
  let last; const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await new Promise(done => setTimeout(done, 200));
  }
  throw last || new Error("canvas acceptance timed out");
}
async function call(path, { account, token, method = "GET", data, headers = {} } = {}) {
  const response = await fetch(base + path, { method, headers: {
    Origin: base, ...(account ? { Cookie: account.cookie, "X-Workspace-CSRF": account.csrf } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers,
  }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const content = await response.text(); let value;
  try { value = JSON.parse(content); } catch { value = content; }
  return { status: response.status, value, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
function ok(result, status = 200) { assert.equal(result.status, status, JSON.stringify(result.value)); return result.value; }
try {
  model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()), calls = body.input.filter(item => item.type === "function_call");
    const results = body.input.filter(item => item.type === "function_call_output").map(item => ({
      call: calls.find(call => call.call_id === item.call_id), result: JSON.parse(item.output),
    }));
    const latest = resource => results.filter(item => item.call?.name === "hcd_read" && JSON.parse(item.call.arguments).resource === resource).at(-1)?.result.data;
    const documentId = body.input[0].content.match(/Document ID: ([^\n]+)/)[1];
    const tool = (name, args) => ({ status: "completed", output: [{ type: "function_call", call_id: randomUUID(), name, arguments: JSON.stringify(args) }] });
    let output;
    if (!latest("auth")) output = tool("hcd_read", { document_id: documentId, resource: "auth" });
    else if (!latest("canvas") || results.at(-1)?.call.name === "hcd_patch") output = tool("hcd_read", { document_id: documentId, resource: "canvas" });
    else if (!calls.some(call => call.name === "hcd_patch")) {
      const canvas = latest("canvas"), element = canvas.scene.elements.find(element => element.id === "focus");
      output = tool("hcd_patch", { document_id: documentId, mode: "canvas", expected_revision: canvas.revision, collaboration_epoch: latest("auth").collaborationEpoch,
        patch: { schemaVersion: "officecli-canvas/1", documentId, patchId: randomUUID(), baseRevision: canvas.revision,
          operations: [{ op: "element.update", id: "focus", before: { strokeColor: element.strokeColor }, changes: { strokeColor: "#7c3aed" } }] } });
    } else output = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "已修改所选方案并回读验证。" }] }] };
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(output));
  });
  const modelPort = await listen(model);
  const initialized = spawnSync(process.execPath, [join(app, "cli.mjs"), "init", "--root", root, "--public-url", base, "--engine-port", String(enginePort), "--collab-port", String(collabPort)], {
    env: { ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: password }, encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  if (testHost !== "127.0.0.1") {
    // This private fixture can use IPv6 without touching the user's Workspace
    // configuration or network settings. The canvas uses SSE, not the sidecar.
    const configPath = join(root, "config.json"), config = JSON.parse(readFileSync(configPath, "utf8"));
    Object.assign(config, { bindHost: testHost, callbackUrl: base, engineUrl });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }
  supervisor = spawn(process.execPath, [join(app, "cli.mjs"), "start", "--root", root, ...(process.env.OFFICECLI_WORKSPACE_DIST ? ["--assets", resolve(process.env.OFFICECLI_WORKSPACE_DIST)] : [])], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OFFICECLI_AI_ENABLED: "true", OPENAI_API_KEY: "local-canvas-fixture-only",
      HCD_OPENAI_BASE_URL: `http://${urlHost}:${modelPort}/v1`, HCD_OPENAI_MODEL: "canvas-fixture" },
  });
  supervisor.stdout.pipe(log, { end: false }); supervisor.stderr.pipe(log, { end: false });
  await poll(async () => (await fetch(`${engineUrl}/health`)).ok);
  await poll(async () => (await fetch(base)).ok);
  const login = await call("/workspace/api/login", { method: "POST", data: { username: "admin", password } });
  const admin = { ...ok(login), cookie: login.cookie };
  const { chromium, expect } = await import(join(repo, "examples/hdoc/editor/node_modules/@playwright/test/index.mjs"));
  browser = await chromium.launch(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
  const external = [], errors = [];
  await context.route("**/*", route => {
    if (["localhost", "127.0.0.1", "[::1]"].includes(new URL(route.request().url()).hostname)) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(base); await page.getByLabel("账号", { exact: true }).fill("admin"); await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
  await page.getByRole("link", { name: "文件管理", exact: true }).click();
  await page.getByRole("link", { name: "白板空间", exact: true }).click();
  await page.getByRole("button", { name: "新建白板", exact: true }).click();
  await page.getByLabel("白板名称", { exact: true }).fill("自由画布协作验收");
  await page.getByRole("button", { name: "创建白板", exact: true }).click();
  await expect(page.getByRole("heading", { name: "自由画布协作验收.excalidraw", exact: true })).toBeVisible();
  const fileId = page.url().split("boards/")[1];
  const launched = ok(await call(`/workspace/api/files/${fileId}/editor-session`, { account: admin, method: "POST", data: { sessionId: randomUUID() } }));
  const doc = suffix => `/v1/documents/${launched.documentId}${suffix}`;
  const engine = (suffix, options = {}) => call(doc(suffix), { account: admin, token: launched.token, ...options });
  const auth = ok(await engine("/auth")); assert(auth.operations.includes("document.ai"));
  const patch = operations => engine("/canvas/patch", { method: "POST", headers: { "X-HCD-Collaboration-Epoch": String(auth.collaborationEpoch) }, data: {
    schemaVersion: "officecli-canvas/1", documentId: launched.documentId, patchId: randomUUID(), baseRevision: 0, operations,
  } });
  ok(await patch([
    { op: "element.add", element: { id: "focus", type: "rectangle", x: 0, y: 0, width: 260, height: 160, strokeColor: "#000000", backgroundColor: "#e0f2fe", fillStyle: "solid" } },
    { op: "element.add", element: { id: "label", type: "text", x: 25, y: 50, width: 180, height: 30, text: "一起讨论方案", fontSize: 20, fontFamily: 5, lineHeight: 1.25 } },
    { op: "element.add", element: { id: "outside", type: "ellipse", x: 400, y: 0, width: 220, height: 160, strokeColor: "#000000" } },
  ]));
  const opened = context.waitForEvent("page"); await page.getByRole("link", { name: "打开白板", exact: true }).click();
  const editor = await opened; editor.on("pageerror", error => errors.push(error.message));
  await expect(editor.locator(".canvas-workspace")).toBeVisible({ timeout: 60_000 });
  await expect(editor.getByText("实时协作已连接", { exact: false })).toBeVisible();
  await editor.evaluate(() => document.fonts.ready);
  await editor.screenshot({ path: join(artifacts, "canvas-workspace.png"), fullPage: true });
  checks.push("packaged Workspace creates and opens a native free canvas with local fonts");

  // Create text at a known screen position, then physically drag its glyphs in selection mode.
  const surface = await editor.locator(".canvas-surface").boundingBox();
  const x = Math.round(surface.x + surface.width * 0.61), y = Math.round(surface.y + surface.height * 0.63);
  await editor.getByRole("toolbar",{name:"白板工具栏"}).getByRole("button",{name:"文字",exact:true}).click();
  await editor.mouse.click(x, y);
  const input = editor.locator("textarea.excalidraw-wysiwyg");
  await input.fill("可以拖动的独立文字");
  const textBox = await input.boundingBox();
  await input.press("Escape");
  const textElement = async () => ok(await engine("/canvas")).scene.elements.find(o => o.type === "text" && o.text === "可以拖动的独立文字" && !o.isDeleted);
  const original = await poll(textElement);
  await editor.getByRole("toolbar",{name:"白板工具栏"}).getByRole("button",{name:"选择",exact:true}).click();
  const startX = textBox.x + 9, startY = textBox.y + textBox.height / 2;
  await editor.mouse.move(startX, startY);
  await editor.mouse.down();
  await editor.mouse.move(startX + 80, startY + 48, { steps: 10 });
  await editor.mouse.up();
  const moved = await poll(async () => {
    const current = await textElement();
    return current && current.x > original.x + 20 && current.y > original.y + 10 ? current : null;
  });
  await editor.reload();
  await expect(editor.getByText("实时协作已连接", { exact: false })).toBeVisible();
  const reopened = await textElement();
  assert.equal(reopened.id, moved.id);
  assert.deepEqual([reopened.x, reopened.y], [moved.x, moved.y]);
  checks.push("selection tool drags native text, commits its new coordinates and preserves them on reopen");

  const outside = ok(await engine("/canvas")).scene.elements.find(element => element.id === "outside");
  const run = ok(await engine("/agent-runs", { method: "POST", data: { task: "修改已选方案边框颜色。", target: { canvas: { elementIds: ["focus"], region: { x: 0, y: 0, width: 260, height: 160 } } } } }), 202);
  await poll(async () => {
    const result = ok(await engine(`/agent-runs/${run.runId}`));
    if (result.status === "failed") throw new Error(JSON.stringify(result));
    return result.status === "completed";
  });
  const scene = ok(await engine("/canvas"));
  assert.equal(scene.scene.elements.find(element => element.id === "focus").strokeColor, "#7c3aed");
  assert.deepEqual(scene.scene.elements.find(element => element.id === "outside"), outside);
  await expect(editor.locator(".canvas-workspace")).toHaveAttribute("data-canvas-revision", String(scene.revision));
  await editor.reload();
  await expect(editor.locator(".agent-task-run.run-completed")).toBeVisible({ timeout: 30_000 });
  await editor.screenshot({ path: join(artifacts, "canvas-ai-collaboration.png"), fullPage: true });
  checks.push("host-owned actor delegates a scoped AI task through the real durable runner and the local scripted model; outside objects survive");
  await editor.locator(".canvas-export-control > summary").click();
  const exported = editor.waitForEvent("download"); await editor.getByRole("button", { name: "PNG", exact: true }).click();
  const png = await exported; assert.equal(await png.failure(), null);
  const pngPath = join(artifacts, "canvas-export.png"); await png.saveAs(pngPath);
  assert(readFileSync(pngPath).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  checks.push("native PNG export and font loading work with all external HTTP traffic blocked");

  const published = ok(await engine("/publications", { method: "POST", headers: { "X-HCD-Collaboration-Epoch": String(auth.collaborationEpoch) }, data: {
    publicationId: randomUUID(), expectedRevision: scene.revision, exportMode: "source-backed",
  } }));
  assert.equal(published.state, "committed");
  const downloaded = ok(await call(`/workspace/api/files/${fileId}/download`, { account: admin }));
  assert.equal(downloaded.type, "excalidraw"); assert.equal(downloaded.elements.find(element => element.id === "focus").strokeColor, "#7c3aed");
  checks.push("business publication downloads an editable native scene rather than flattening it to HTML");

  const sharing = ok(await call(`/workspace/api/files/${fileId}/sharing`, { account: admin, method: "PUT", data: { visibility: "link", permission: "write", expiresAt: null } }));
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 1050 } }), guest = await guestContext.newPage();
  await guest.goto(sharing.sharing.url); await expect(guest.locator(".canvas-workspace")).toBeVisible({ timeout: 60_000 });
  assert.equal(await guest.getByRole("button", { name: "AI 协作", exact: true }).count(), 0);
  const guestIdentity = await (await guest.request.get(`${base}/workspace/api/session`)).json(); assert(guestIdentity.user.isGuest);
  const guestCookie = (await guestContext.cookies(base)).find(cookie => cookie.name === "officecli_workspace_guest");
  const guestAccount = { cookie: `${guestCookie.name}=${guestCookie.value}`, csrf: "" };
  const guestSession = ok(await call(`/workspace/api/shared/${fileId}/open`, { account: guestAccount, method: "POST", headers: { "X-Workspace-Share": new URL(sharing.sharing.url).hash.slice(1) }, data: { sessionId: randomUUID() } }));
  const forbidden = await call(`/v1/documents/${guestSession.documentId}/agent-runs`, { account: guestAccount, token: guestSession.token, method: "POST", data: { task: "不能使用 AI" } });
  assert.equal(forbidden.status, 403);
  await guest.getByRole("toolbar",{name:"白板工具栏"}).getByRole("button",{name:"画笔",exact:true}).click();
  const bounds = await guest.locator(".canvas-surface").boundingBox();
  await guest.mouse.move(bounds.x + 250, bounds.y + 450); await guest.mouse.down(); await guest.mouse.move(bounds.x + 340, bounds.y + 470, { steps: 8 }); await guest.mouse.up();
  const next = await poll(async () => { const current = ok(await engine("/canvas")); return current.revision > scene.revision ? current : null; });
  await expect(editor.locator(".canvas-workspace")).toHaveAttribute("data-canvas-revision", String(next.revision));
  await guest.screenshot({ path: join(artifacts, "canvas-shared-guest.png"), fullPage: true });
  await call(`/workspace/api/files/${fileId}/sharing`, { account: admin, method: "PUT", data: { visibility: "link", permission: "read", expiresAt: null } });
  await expect(guest.locator("[data-document-scope]")).toHaveAttribute("data-document-scope", "read", { timeout: 30_000 });
  checks.push("anonymous visitors draw collaboratively, cannot invoke AI, and become read-only after permission downgrade");
  writeFileSync(join(artifacts, "validation.json"), JSON.stringify({ status: "passed", model: "local-scripted-fixture", checks }, null, 2) + "\n");
  console.log(JSON.stringify({ status: "passed", root, artifacts, checks }, null, 2));
} catch (error) {
  writeFileSync(join(artifacts, "validation.json"), JSON.stringify({ status: "failed", checks, error: String(error) }, null, 2) + "\n");
  console.error(`Workspace canvas evidence: ${root}`); throw error;
} finally {
  await browser?.close();
  if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) { const ended = once(supervisor, "exit"); supervisor.kill("SIGTERM"); await ended; }
  model?.close(); log.end();
}
