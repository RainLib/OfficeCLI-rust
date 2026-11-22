import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { _electron as electron, expect } from "../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs";
import { verifyRelease } from "../workspace/src/release.mjs";

const archive = process.env.FOLDLY_DESKTOP_PACKAGE;
assert(process.platform === "darwin" && archive, "Set FOLDLY_DESKTOP_PACKAGE on a Mac of the matching architecture.");
const scratch = mkdtempSync(join(tmpdir(), "foldly-desktop-verify-"));
const artifacts = resolve(process.env.FOLDLY_DESKTOP_ARTIFACTS || scratch);
const data = join(scratch, "user-data");
mkdirSync(artifacts, { recursive: true });
execFileSync("/usr/bin/ditto", ["-x", "-k", resolve(archive), scratch]);
const bundle = join(scratch, "Foldly Desktop.app");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
const kit = join(bundle, "Contents", "Resources", "workspace");
const { manifest } = await verifyRelease(kit);
const kernelOffline = process.env.FOLDLY_DESKTOP_KERNEL_OFFLINE === "1";
const executable = join(bundle, "Contents", "MacOS", "Electron");

const profile = join(scratch, "loopback.sb");
const localSockets = `unix-socket (subpath ${JSON.stringify(realpathSync(tmpdir()))})`;
writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:*") (local ${localSockets}))
(allow network-inbound (local ip "localhost:*") (local ${localSockets}))
(allow network-outbound (remote ip "localhost:*") (remote ${localSockets}))
(deny file-read* (subpath ${JSON.stringify(resolve(import.meta.dirname, "../.."))}))
`);
const probe = kernelOffline ? execFileSync("/usr/bin/sandbox-exec", ["-f", profile, join(kit, "runtime/node"), "-e", `
const socket = require("node:net").connect(443, "198.51.100.1");
socket.setTimeout(1500, () => process.exit(1));
socket.on("connect", () => process.exit(1));
socket.on("error", error => { console.log(error.code); process.exit(error.code === "EPERM" ? 0 : 1); });
`], { encoding: "utf8" }).trim() : null;
if (kernelOffline) assert.equal(probe, "EPERM");
const launch = join(scratch, "launch");
writeFileSync(launch, `#!/bin/sh
exec /usr/bin/sandbox-exec -f "${profile}" "${executable}" "$@"
`, { mode: 0o700 });

let app;
let downloads = 0;
const checks = [];
const errors = [];
async function start() {
  // macOS does not allow Chromium to install a second Seatbelt sandbox.
  app = await electron.launch({
    executablePath: kernelOffline ? launch : executable,
    args: [`--user-data-dir=${data}`, ...(kernelOffline ? ["--no-sandbox"] : [])],
    timeout: 45_000,
  });
  const page = await app.firstWindow({ timeout: 45_000 });
  page.setDefaultTimeout(25_000);
  page.on("pageerror", error => errors.push(error.message));
  await expect(page.getByRole("tab", { name: "首页", exact: true })).toBeVisible({ timeout: 45_000 });
  return page;
}

async function close() {
  const process = app.process();
  const exited = once(process, "exit", { signal: AbortSignal.timeout(120_000) });
  void exited.catch(() => {});
  await app.evaluate(({ app }) => { app.quit(); });
  assert.deepEqual(await exited, [0, null]);
  app = null;
}

async function open(page, format, name) {
  await page.getByRole("tab", { name: "首页", exact: true }).click();
  await page.locator('.desk-home-main input[type="file"]').setInputFiles({
    name, mimeType: "application/octet-stream", buffer: readFileSync(join(kit, "app/dist/blank", `blank.${format}`)),
  });
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
}

function stored(text) {
  return globSync(join(data, "workspace/engine/*.hcd/chunks/sha256/*.html.gz"))
    .some(path => gunzipSync(readFileSync(path)).includes(text));
}

async function exportNative(page, pane, format) {
  const menu = pane.locator('summary[aria-label="文件操作"]');
  await menu.click();
  const control = pane.locator(".export-control");
  if (!await control.evaluate(node => node.open)) await control.locator("summary").click();
  await control.getByRole("combobox", { name: "导出格式", exact: true }).selectOption(format);
  await control.getByRole("combobox", { name: "导出方式", exact: true }).selectOption("source");
  await control.getByRole("button", { name: "准备下载", exact: true }).click();
  const link = control.locator("a.download-ready");
  await expect(link).toBeVisible({ timeout: 45_000 });
  const target = join(scratch, `exported-${++downloads}.${format}`);
  await app.evaluate(({ BrowserWindow }, destination) => {
    const browserSession = BrowserWindow.getAllWindows()[0].webContents.session;
    globalThis.verifyDownload = new Promise(resolve => {
      const handle = (_event, item) => {
        item.setSavePath(destination);
        item.once("done", (_event, state) => {
          clearTimeout(timer);
          resolve(state);
        });
      };
      const timer = setTimeout(() => {
        browserSession.off("will-download", handle);
        resolve("timeout");
      }, 20_000);
      browserSession.once("will-download", handle);
    });
  }, target);
  await link.click();
  assert.equal(await app.evaluate(() => globalThis.verifyDownload), "completed");
  return target;
}

try {
  let page = await start();
  const version = await app.evaluate(({ app }) => ({ app: app.getVersion(), electron: process.versions.electron }));
  assert.equal(version.app, manifest.version);
  const renderer = await app.evaluate(async ({ BrowserWindow, app }) => {
    const { session } = BrowserWindow.getAllWindows()[0].webContents;
    const blocked = await session.fetch("http://198.51.100.1", { signal: AbortSignal.timeout(2000) })
      .then(() => "", error => error.message);
    return { chromiumSandbox: !app.commandLine.hasSwitch("no-sandbox"), blocked };
  });
  assert.equal(renderer.chromiumSandbox, !kernelOffline);
  assert.match(renderer.blocked, /ERR_BLOCKED_BY_CLIENT/);
  checks.push(kernelOffline
    ? "Signed archive used its bundled runtime and local assets under a loopback-only macOS policy. An actual outbound socket was denied with EPERM."
    : "Signed archive used its bundled runtime and local assets with its default Chromium sandbox. Electron's own request policy denied a public URL.");
  await expect(page.getByRole("button", { name: "导入文件", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "共享项目", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "全局 AI", exact: true })).toHaveCount(0);
  const isolation = await page.evaluate(async () => {
    const account = await (await fetch("/workspace/api/session")).json();
    const routes = ["/workspace/api/projects", "/workspace/api/users", "/workspace/api/public/files",
      "/workspace/api/agent-jobs", "/workspace/mcp/selection", "/admin"];
    return {
      mode: account.workspace.mode, role: account.user.role,
      selectionMcp: account.workspace.selectionMcp, ai: account.workspace.aiEnabled,
      routes: await Promise.all(routes.map(path => fetch(path).then(response => response.status))),
      anonymous: (await fetch("/workspace/api/files", { credentials: "omit" })).status,
    };
  });
  assert.deepEqual(isolation, { mode: "desktop", role: "member", selectionMcp: false, ai: false, routes: [404, 404, 404, 404, 404, 404], anonymous: 401 });
  const cloudStart = spawnSync(join(kit, "workspace"), ["start", "--root", join(data, "workspace")], { encoding: "utf8", timeout: 5000 });
  assert.equal(cloudStart.status, 1);
  assert.match(cloudStart.stderr, /桌面工作区只能由本机客户端启动/);
  checks.push("Desktop session used the local member role, denied unauthenticated reads and blocked cloud-only endpoints. Cloud startup rejected the desktop data root.");

  const wordName = "离线验收.docx";
  const pane = () => page.locator(".desk-editor.is-visible");
  for (const [format, selector] of [["xlsx", '.hcd-univer-host [role="tab"][aria-selected="true"]'], ["pptx", ".fixed-page iframe"]]) {
    await open(page, format, `离线验收.${format}`);
    await expect(pane().locator(selector).first()).toBeVisible({ timeout: 45_000 });
  }
  await open(page, "docx", wordName);
  const fileId = await pane().getAttribute("data-file-id");
  const filePermissions = await page.evaluate(async id => {
    const base = "/workspace/api/files/" + id;
    const { file } = await (await fetch(base)).json();
    const routes = await Promise.all(["/sharing", "/acl"].map(path => fetch(base + path).then(response => response.status)));
    return { operations: file.operations, routes };
  }, fileId);
  assert.deepEqual(filePermissions.routes, [404, 404]);
  assert(filePermissions.operations.includes("document.edit") && filePermissions.operations.includes("document.export"));
  assert(!filePermissions.operations.includes("document.publish") && !filePermissions.operations.includes("document.ai"));
  const editor = () => pane().locator('.tiptap[contenteditable="true"]').first();
  await expect(editor()).toBeVisible({ timeout: 45_000 });
  await editor().click();
  const savedText = "Foldly offline saved paragraph";
  await page.keyboard.insertText(savedText);
  await pane().getByRole("button", { name: "插入", exact: true }).click();
  const savePoint = pane().getByRole("button", { name: "保存点", exact: true });
  if (!await savePoint.isVisible()) await pane().getByRole("button", { name: "展开功能区", exact: true }).click();
  await savePoint.click();
  await expect.poll(() => stored(savedText), { timeout: 25_000 }).toBe(true);
  const exported = await exportNative(page, pane(), "docx");
  assert(execFileSync("/usr/bin/unzip", ["-p", exported, "word/document.xml"], { encoding: "utf8" }).includes(savedText));
  checks.push("Opened native Word, Excel and PowerPoint files. The Word save point reached disk and the original-format download contained the edited text.");

  await pane().locator('summary[aria-label="文件操作"]').click();
  await editor().click();
  await page.keyboard.press("End");
  const lastEdit = " saved on quit";
  await page.keyboard.insertText(lastEdit);
  await expect(editor()).toContainText(lastEdit.trim());
  assert.equal(stored(lastEdit.trim()), false);
  await close();
  assert(stored(lastEdit.trim()), "The edit made immediately before quitting was missing from disk.");
  page = await start();
  const wordTab = page.getByRole("tab", { name: wordName, exact: true });
  await expect(wordTab).toBeVisible();
  if (await wordTab.getAttribute("aria-selected") !== "true") await wordTab.click();
  await expect(editor()).toContainText(savedText + lastEdit);
  await page.screenshot({ path: join(artifacts, kernelOffline ? "desktop-offline-reopened.png" : "desktop-reopened.png") });
  const reopened = await exportNative(page, pane(), "docx");
  assert(execFileSync("/usr/bin/unzip", ["-p", reopened, "word/document.xml"], { encoding: "utf8" }).includes(savedText + lastEdit));
  await close();
  checks.push("Quit before the last edit reached a save point. After relaunch, the Word tab reopened with that edit and exported it to DOCX.");
  assert.deepEqual(errors, []);
  const result = { release: manifest.id, version, protocolFingerprint: manifest.engine.protocolFingerprint,
    networkProbe: probe, chromiumSandbox: renderer.chromiumSandbox, remoteRequestBlocked: true, checks };
  writeFileSync(join(artifacts, kernelOffline ? "desktop-offline-validation.json" : "desktop-validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) {
    await app.close().catch(() => {});
  }
}
