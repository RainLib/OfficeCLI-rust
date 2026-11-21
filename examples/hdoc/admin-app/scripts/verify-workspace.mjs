// Run after `npm run build` and `cargo build -p officecli`.
// Starts isolated services and temporary documents; never uses an existing workspace.
import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "../../..");
const binary =
  process.env.OFFICECLI_BIN || join(repo, "target/debug/officecli");
const artifacts = resolve(
  process.env.HCD_ADMIN_ARTIFACTS ||
    join(repo, "docs/acceptance/hcd-admin-workspace"),
);
const temporary = await mkdtemp(join(tmpdir(), "officecli-admin-verify-"));
const root = join(temporary, "documents");
await mkdir(root);
await mkdir(artifacts, { recursive: true });
const secret = randomBytes(32).toString("hex");
const environment = { ...process.env, HCD_TOKEN_SECRET: secret };
delete environment.HCD_DATABASE_URL;
delete environment.HCD_S3_BUCKET;
const services = [],
  errors = [],
  checks = [];
let browser, page;
let holdModelResponse = false;
// Exercise the real task runner against a deterministic loopback model endpoint.
// No API keys, prompts or document content leave this machine during validation.
const modelServer = createHttpServer((request, response) => {
  request.resume();
  request.on("end", () => {
    if (holdModelResponse) return;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "验收完成：未修改文档。" }],
          },
        ],
      }),
    );
  });
});
function check(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
function start(command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => (log += data));
  child.stderr.on("data", (data) => (log += data));
  child.on("error", (error) => errors.push(String(error)));
  services.push(child);
  return () => log;
}
async function ready(url, log) {
  for (let i = 0; i < 150; i++) {
    if (
      await fetch(url)
        .then((response) => response.ok)
        .catch(() => false)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Service not ready: ${url}\n${log()}`);
}
function token(documentId, scope) {
  return execFileSync(
    binary,
    [
      "hdoc",
      "issue-token",
      "--document-id",
      documentId,
      "--scope",
      scope,
      "--user-id",
      "acceptance-user",
      "--display-name",
      "验收管理员",
      "--ttl-seconds",
      "3600",
    ],
    { env: environment, encoding: "utf8" },
  ).trim();
}
const apiPort = await port(),
  editorPort = await port();
const origin = `http://127.0.0.1:${apiPort}`,
  editorOrigin = `http://127.0.0.1:${editorPort}`;
const admin = token("*", "admin"),
  upload = token("*", "upload");
async function api(path, credential = admin, init = {}) {
  return fetch(origin + path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${credential}` },
  });
}
async function json(path, credential = admin, init = {}) {
  const response = await api(path, credential, init);
  const value = await response.json();
  assert.ok(
    response.ok,
    `${path}: ${response.status} ${JSON.stringify(value)}`,
  );
  return value;
}
const jsonBody = (value) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
async function importFile(name, body) {
  const result = await json(
    `/v1/import?filename=${encodeURIComponent(name)}`,
    upload,
    { method: "POST", body },
  );
  await expect
    .poll(
      async () =>
        (await json("/v1/admin/jobs")).jobs.find(
          (job) => job.jobId === result.jobId,
        )?.state,
      { timeout: 30000 },
    )
    .toBe("completed");
  return result.documentId;
}
async function route(path, title) {
  await page.goto(`${origin}/admin?verify=${Date.now()}#/${path}`);
  if (title)
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
}
async function screenshot(name) {
  await page.mouse.move(1000, 20);
  await page.screenshot({ path: join(artifacts, name + ".png") });
}
async function noOverflow() {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "document overflow",
  );
  assert.ok(
    await page
      .locator("#admin-main")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    "content overflow",
  );
}
try {
  await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  environment.OPENAI_API_KEY = "loopback-acceptance-only";
  environment.HCD_OPENAI_BASE_URL = `http://127.0.0.1:${modelServer.address().port}/v1`;
  environment.HCD_OPENAI_MODEL = "local-acceptance-model";
  delete environment.HCD_OPENAI_REASONING_EFFORT;
  const backendLog = start(
    binary,
    ["hdoc", "serve", "--root", root, "--bind", `127.0.0.1:${apiPort}`],
    repo,
    environment,
  );
  await ready(origin + "/admin", backendLog);
  const editorLog = start(
    process.execPath,
    [
      join(repo, "examples/hdoc/editor/node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(editorPort),
      "--strictPort",
    ],
    join(repo, "examples/hdoc/editor"),
    { ...environment, HCD_API_TARGET: origin },
  );
  await ready(editorOrigin, editorLog);
  const embedded = await (await fetch(origin + "/admin")).text();
  assert.ok(embedded.includes("/v1/admin/workspace"));
  assert.ok(embedded.includes("#ECEFF4") || embedded.includes("#eceff4"));
  check("binary serves the rebuilt single-file admin");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1040 },
    acceptDownloads: true,
  });
  await context.addInitScript(
    ({ admin, upload, origin, editorOrigin }) => {
      if (location.origin !== origin) return;
      sessionStorage.setItem("hcdAdminToken", admin);
      sessionStorage.setItem("hcdAdminUploadToken", upload);
      localStorage.setItem(
        "hcdAdminEditorSettings",
        JSON.stringify({ url: editorOrigin }),
      );
    },
    { admin, upload, origin, editorOrigin },
  );
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await route("jobs?import=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "导入文档" })).toBeVisible();
  await dialog.getByLabel("选择文件").setInputFiles({
    name: "会议原始记录.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "OfficeCLI admin acceptance\nOriginal reviewed content.\n",
    ),
  });
  await dialog.getByRole("button", { name: "导入文件", exact: true }).click();
  await expect(dialog.getByText("已接收文件", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  const firstJob = (await json("/v1/admin/jobs")).jobs.find(
    (job) => job.filename === "会议原始记录.txt",
  );
  assert.ok(firstJob);
  const id = firstJob.documentId;
  await expect
    .poll(
      async () =>
        (await json("/v1/admin/jobs")).jobs.find(
          (job) => job.jobId === firstJob.jobId,
        )?.state,
    )
    .toBe("completed");
  const secondId = await importFile(
    "项目说明.md",
    Buffer.from("# Project notes\n\nA real Markdown document."),
  );
  const wordId = await importFile(
    "品牌提案.docx",
    await readFile(
      join(repo, "examples/hdoc/editor/e2e/fixtures/word-page-layout.docx"),
    ),
  );
  await importFile(
    "活动页面.html",
    Buffer.from(
      "<html><body><h1>OfficeCLI</h1><p>Published campaign content.</p></body></html>",
    ),
  );
  const slideSource = join(temporary, "slides.pptx");
  execFileSync(binary, ["create", slideSource], { env: environment });
  await importFile("产品发布演示.pptx", await readFile(slideSource));
  const sheetSource = join(temporary, "sheet.xlsx");
  execFileSync(binary, ["create", sheetSource], { env: environment });
  await importFile("十一月经营数据.xlsx", await readFile(sheetSource));
  check("real file import, persistent task outcome and all document formats");

  await route("upload", "上传登记");
  await page.getByLabel("fontId", { exact: true }).fill("noto-emoji");
  await page.getByLabel("字族名 family").fill("Noto Emoji");
  await page.getByLabel("名称", { exact: true }).fill("OFL-1.1");
  await page
    .locator("input[type=file]")
    .setInputFiles(
      join(repo, "crates/pdf-handler/assets/NotoEmoji-Regular.ttf"),
    );
  await page
    .getByRole("button", { name: "上传并登记修订", exact: true })
    .click();
  await expect(page.getByText("修订已登记", { exact: true })).toBeVisible();
  const registered = (await json("/v1/catalog/fonts")).find(
    (font) => font.fontId === "noto-emoji",
  ).revisions[0];
  const fontRef = {
    fontId: "noto-emoji",
    fontRevisionId: registered.fontRevisionId,
  };
  await route("fonts", "字体目录");
  await screenshot("fonts");
  await expect(page.getByText("OFL-1.1", { exact: true })).toBeVisible();
  check("font upload, immutable registration and separate license permissions");

  const read = token(id, "read"),
    write = token(id, "write");
  for (const path of [
    "/session",
    "/workspace",
    "/service",
    "/jobs",
    "/agent-runs",
  ])
    assert.equal((await api("/v1/admin" + path, read)).status, 403);
  assert.equal((await api(`/v1/documents/${id}`, admin)).status, 403);
  const head = await json(`/v1/documents/${id}`, read);
  const base = head.revision;
  assert.equal(
    (
      await api(
        `/v1/documents/${id}/restore/${base}`,
        read,
        jsonBody({ expectedRevision: base }),
      )
    ).status,
    403,
  );
  const theme = await json(
    "/v1/catalog/themes",
    admin,
    jsonBody({
      name: "OfficeCLI 品牌主题",
      major: { latin: fontRef },
      minor: { latin: fontRef },
      fallbackFamilies: ["system-ui", "sans-serif"],
    }),
  );
  const theme2 = await json(
    "/v1/catalog/themes",
    admin,
    jsonBody({
      name: "极简演示主题",
      major: { latin: fontRef },
      minor: {},
      fallbackFamilies: ["serif"],
    }),
  );
  const pin = await json(`/v1/documents/${id}/theme`, admin, {
    ...jsonBody({ themeRevisionId: theme.themeRevisionId }),
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-HCD-Expected-Revision": String(base),
    },
  });
  assert.ok(pin.revision > base);
  assert.equal(
    (
      await api(`/v1/documents/${id}/theme`, admin, {
        ...jsonBody({ themeRevisionId: theme2.themeRevisionId }),
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-HCD-Expected-Revision": String(base),
        },
      })
    ).status,
    409,
  );
  assert.equal(
    (await json(`/v1/documents/${id}`, read)).themeRevisionId,
    theme.themeRevisionId,
  );
  check(
    "admin metadata/content scope isolation and atomic theme conflict guard",
  );

  await route("documents", "文档管理");
  await expect(
    page
      .getByRole("navigation", { name: "后台导航", exact: true })
      .getByRole("link", { name: "文档管理", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("button", { name: /会议原始记录.txt/ }),
  ).toBeVisible();
  await screenshot("desktop-documents");
  await noOverflow();
  await page.getByRole("button", { name: "切换深色" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await screenshot("dark-documents");
  await page.getByRole("button", { name: "切换浅色" }).click();
  assert.equal(
    await page
      .locator("aside")
      .first()
      .evaluate((element) => getComputedStyle(element).width),
    "224px",
  );
  assert.equal(
    await page
      .locator("#admin-main")
      .evaluate((element) => getComputedStyle(element).borderRadius),
    "28px",
  );
  check("V2 desktop geometry, document cards, light and dark themes");

  await page.getByLabel("选择本页文档", { exact: true }).check();
  await page.getByRole("button", { name: "批量指定主题", exact: true }).click();
  await dialog.getByLabel("批量目标主题").selectOption(theme.themeRevisionId);
  await dialog.getByRole("button", { name: /为 \d+ 份文档指定主题/ }).click();
  await expect(dialog.getByText(/已完成 · rev/).first()).toBeVisible();
  await expect(dialog.getByText("跳过 · 已有主题").first()).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /为 \d+ 份文档指定主题/ }),
  ).toBeDisabled();
  await screenshot("bulk-theme");
  await dialog
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  const second = await json(
    `/v1/documents/${secondId}`,
    token(secondId, "read"),
  );
  assert.equal(second.themeRevisionId, theme.themeRevisionId);
  check(
    "batch theme assignment skips pinned documents and prevents repeat submission",
  );

  await route(`documents/${id}`, "文档详情与修订");
  await page
    .getByRole("button", { name: "连接文档令牌", exact: true })
    .first()
    .click();
  await dialog.getByLabel("文档只读或写入令牌").fill(read);
  await dialog.getByRole("button", { name: "验证并连接" }).click();
  await expect(
    page
      .frameLocator("iframe")
      .getByText("Original reviewed content.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: new RegExp(`rev. ${base}.*查看版本`) })
    .click();
  await expect(
    page.getByRole("button", { name: "只读权限无法恢复" }),
  ).toBeDisabled();
  await screenshot("readonly-revision");
  await page
    .getByRole("button", { name: "连接文档令牌", exact: true })
    .first()
    .click();
  await dialog.getByLabel("文档只读或写入令牌").fill(write);
  await dialog.getByRole("button", { name: "验证并连接" }).click();
  await page
    .getByRole("button", { name: `恢复 rev. ${base}`, exact: true })
    .click();
  await dialog.getByLabel(`我已查看 rev. ${base} 的内容`).check();
  await screenshot("restore-confirm");
  const current = await json(`/v1/documents/${id}`, write);
  const intervening = await json(`/v1/documents/${id}/theme`, admin, {
    ...jsonBody({ themeRevisionId: theme2.themeRevisionId }),
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-HCD-Expected-Revision": String(current.revision),
    },
  });
  await dialog.getByRole("button", { name: "恢复并创建新修订" }).click();
  await expect(dialog.getByText(/文档已有新修订/)).toBeVisible();
  await screenshot("revision-conflict");
  await dialog.getByRole("button", { name: "查看最新状态" }).click();
  await page
    .getByRole("button", { name: new RegExp(`rev. ${base}.*查看版本`) })
    .click();
  await page
    .getByRole("button", { name: `恢复 rev. ${base}`, exact: true })
    .click();
  await dialog.getByLabel(`我已查看 rev. ${base} 的内容`).check();
  await dialog.getByRole("button", { name: "恢复并创建新修订" }).click();
  await expect(dialog).toHaveCount(0);
  const restored = await json(`/v1/documents/${id}`, read);
  assert.ok(restored.revision > intervening.revision);
  assert.ok(
    (await json(`/v1/documents/${id}/revisions`, read)).revisions.length >= 4,
  );
  await screenshot("document-detail");
  check(
    "readonly preview, write-only restore, conflict feedback and preserved history",
  );

  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(dialog.getByLabel("输出格式")).toBeVisible();
  await dialog.getByLabel("输出格式").selectOption("txt");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "导出并下载" }).click(),
  ]);
  const downloaded = await readFile(await download.path(), "utf8");
  assert.ok(downloaded.includes("Original reviewed content."));
  const exports = (await json("/v1/admin/jobs")).jobs.filter(
    (job) => job.kind === "export",
  );
  assert.ok(
    exports.some(
      (job) => job.state === "completed" && job.revision === restored.revision,
    ),
  );
  await route("jobs", "导入与导出");
  await screenshot("jobs");
  check("actual selected-revision download and durable export completion");

  await route(`documents/${wordId}`, "文档详情与修订");
  await page
    .getByRole("button", { name: "连接文档令牌", exact: true })
    .first()
    .click();
  await dialog.getByLabel("文档只读或写入令牌").fill(token(wordId, "read"));
  await dialog.getByRole("button", { name: "验证并连接" }).click();
  await expect(page.locator("iframe")).toHaveAttribute(
    "srcdoc",
    /<!doctype html>/,
  );
  assert.ok(
    (await page.locator("iframe").getAttribute("srcdoc")).includes(
      "default-src 'none'",
    ),
  );
  await screenshot("word-preview");
  check("Word presentation preview is read-only and sandboxed");

  await route("themes", "主题与预览");
  await screenshot("themes");
  await page.getByLabel("全局搜索").fill("极简演示");
  await expect(
    page
      .locator("#workspace-search-results")
      .getByRole("link", { name: /极简演示主题/ }),
  ).toBeVisible();
  await page
    .locator("#workspace-search-results")
    .getByRole("link", { name: /极简演示主题/ })
    .click();
  await expect(page.getByLabel("搜索主题")).toHaveValue(theme2.themeRevisionId);
  await route("agents", "AI 任务");
  await screenshot("agents-empty");
  await route("tokens", "访问与令牌");
  await page.getByLabel("文档 ID", { exact: true }).fill(id);
  await expect(
    page.locator("code").filter({ hasText: "officecli hdoc issue-token" }),
  ).toContainText(`--document-id '${id}'`);
  await screenshot("access");
  await route("settings", "服务设置");
  await screenshot("settings");
  await route("audit", "操作记录");
  await expect(
    page.getByText("acceptance-user", { exact: false }).first(),
  ).toBeVisible();
  await screenshot("audit");
  check(
    "global document/font/theme search, audit, real service settings and token commands",
  );

  const completedRun = await json(
    `/v1/documents/${id}/agent-runs`,
    write,
    jsonBody({
      name: "文档核验任务",
      task: "读取文档并报告核验完成，不修改内容。",
      agentCount: 1,
      mode: "edit",
    }),
  );
  await expect
    .poll(
      async () =>
        (await json("/v1/admin/agent-runs")).runs.find(
          (run) => run.runId === completedRun.runId,
        )?.status,
      { timeout: 15000 },
    )
    .toBe("completed");
  await route("agents", "AI 任务");
  await expect(
    page.getByText("验收完成：未修改文档。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("本任务尚未提交文档修订。", { exact: true }),
  ).toBeVisible();
  await screenshot("agents-completed");
  holdModelResponse = true;
  const pendingRun = await json(
    `/v1/documents/${id}/agent-runs`,
    write,
    jsonBody({
      name: "可停止的核验任务",
      task: "等待后续核验。",
      agentCount: 1,
      mode: "edit",
    }),
  );
  await route("agents", "AI 任务");
  await page.getByRole("button", { name: /可停止的核验任务/ }).click();
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await dialog
    .getByRole("button", { name: "停止后续执行", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await json("/v1/admin/agent-runs")).runs.find(
          (run) => run.runId === pendingRun.runId,
        )?.status,
      { timeout: 15000 },
    )
    .toBe("cancelled");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await screenshot("agents-stopped");
  holdModelResponse = false;
  check(
    "AI task aggregation, actual result/commits and owner-authorized cancellation using a local model stub",
  );

  await route(`documents/${id}`, "文档详情与修订");
  const [editor] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "打开编辑器", exact: true }).click(),
  ]);
  await expect
    .poll(
      () =>
        editor.evaluate(
          () =>
            JSON.parse(
              sessionStorage.getItem("hcd-editor-workspace-v1") || "{}",
            ).activeDocument,
        ),
      { timeout: 25000 },
    )
    .toBe(id);
  assert.ok(!editor.url().includes(write));
  assert.ok(!editor.url().includes("admin-open"));
  await editor.close();
  check(
    "editor authenticates document through nonce/source/origin-checked handshake",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await route("documents", "文档管理");
  await noOverflow();
  await screenshot("mobile-documents");
  await page.getByRole("button", { name: "更多导航", exact: true }).click();
  await expect(
    dialog.getByRole("navigation", { name: "后台导航" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "更多导航", exact: true }).click();
  await dialog.getByRole("link", { name: "服务设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "服务设置", exact: true }),
  ).toBeVisible();
  await noOverflow();
  await screenshot("mobile-settings");
  await route("tokens", "访问与令牌");
  await page.getByRole("button", { name: "清除当前会话", exact: true }).click();
  await dialog
    .getByRole("button", { name: "清除后台会话", exact: true })
    .click();
  assert.deepEqual(
    await page.evaluate(() => [
      sessionStorage.getItem("hcdAdminDocumentTokens"),
      sessionStorage.getItem("hcdAdminUploadToken"),
      sessionStorage.getItem("hcdAdminToken"),
    ]),
    [null, null, ""],
  );
  await screenshot("session-cleared");
  check(
    "390px mobile layout, drawer keyboard dismissal, navigation and session clearing",
  );
  assert.deepEqual(errors, []);
  await rm(join(artifacts, "failure.png"), { force: true });
  await writeFile(
    join(artifacts, "validation.json"),
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        checks,
        browserErrors: errors,
        viewports: [
          [1600, 1040],
          [390, 844],
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Verified ${checks.length} workflows. Screenshots: ${artifacts}`);
} catch (error) {
  if (page)
    await page
      .screenshot({ path: join(artifacts, "failure.png") })
      .catch(() => {});
  await writeFile(
    join(artifacts, "validation.json"),
    JSON.stringify(
      { passed: false, checks, error: String(error), browserErrors: errors },
      null,
      2,
    ) + "\n",
  );
  throw error;
} finally {
  await browser?.close();
  services.reverse().forEach((child) => child.kill("SIGTERM"));
  modelServer.closeAllConnections();
  await new Promise((resolve) => modelServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
