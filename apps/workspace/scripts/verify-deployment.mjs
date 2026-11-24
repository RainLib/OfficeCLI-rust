import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants, createWriteStream, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs";
import { sealRelease, verifyRelease } from "../src/release.mjs";
import { verifySheetPivots } from "../../../examples/hdoc/embed-host/verify-sheet-pivots.mjs";
import { verifySheetConditions } from "../../../examples/hdoc/embed-host/verify-sheet-conditions.mjs";
import { verifyPdfOcr } from "../../../examples/hdoc/embed-host/verify-pdf-ocr.mjs";
import { verifyImageLayers } from "../../../examples/hdoc/embed-host/verify-image-layers.mjs";
import { verifyPptxInheritance } from "../../../examples/hdoc/embed-host/verify-pptx-inheritance.mjs";
import { verifyWordTableCells } from "../../../examples/hdoc/embed-host/verify-word-table-cells.mjs";

const repo = resolve(import.meta.dirname, "../../.."), input = process.env.OFFICECLI_RELEASE_PACKAGE;
assert(input, "Set OFFICECLI_RELEASE_PACKAGE to a built native release directory");
const scratch = mkdtempSync(join(tmpdir(), "officecli-deployment-"));
const artifacts = resolve(process.env.OFFICECLI_RELEASE_ARTIFACTS || scratch);
mkdirSync(artifacts, { recursive: true });
const log = createWriteStream(join(scratch, "services.log"), { mode: 0o600 });
const pack = join(scratch, "original"), deployment = join(scratch, "installation"), installed = join(deployment, "workspace");
const password = randomBytes(24).toString("base64url"), api = "/workspace/api";
const checks = [];
const nativeCases = [];
let supervisor, browser;

const profile = join(scratch, "loopback-only.sb");
const isolated = process.platform === "darwin";
if (isolated) writeFileSync(profile, `(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(deny file-read* (subpath ${JSON.stringify(repo)}))
`);
const childEnvironment = {
  PATH: "/usr/bin:/bin", LANG: process.env.LANG || "en_US.UTF-8",
  OFFICECLI_BOOTSTRAP_PASSWORD: password,
};
const execution = (file, args) => isolated ? ["/usr/bin/sandbox-exec", ["-f", profile, file, ...args]] : [file, args];
function execute(file, args, expected = 0) {
  const [binary, parameters] = execution(file, args);
  const result = spawnSync(binary, parameters, { cwd: scratch, env: childEnvironment, encoding: "utf8", timeout: 300_000 });
  assert.equal(result.status, expected, result.stderr || result.error?.message);
  return result;
}
const readState = () => JSON.parse(readFileSync(join(deployment, "deployment.json"), "utf8"));
const workspace = data => join(deployment, "workspaces", data);

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
const publicPort = await port(), enginePort = await port(), collabPort = await port(), base = `http://127.0.0.1:${publicPort}`;

async function call(path, { account, token, method = "GET", data, bytes } = {}) {
  const response = await fetch(base + path, { method, headers: { Origin: base, Connection: "close",
    ...(account ? { Cookie: account.cookie, "X-Workspace-CSRF": account.csrf } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    ...(bytes ? { "Content-Type": "application/octet-stream" } : {}),
  }, body: bytes ?? (data === undefined ? undefined : JSON.stringify(data)) });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, value, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
function ok({ status, value }, expected = 200) { assert.equal(status, expected, JSON.stringify(value)); return value; }

async function readSavedText(account, file, text) {
  const session = ok(await call(`${api}/files/${file.id}/editor-session`, { account, method: "POST", data: { sessionId: randomUUID() } }));
  const projection = ok(await call(`/v1/documents/${session.documentId}/editor`, { account, token: session.token }));
  assert(JSON.stringify(projection.blocks).includes(text), "The active engine has no matching text in its saved document");
}

async function start() {
  const [binary, args] = execution(installed, ["start"]);
  supervisor = spawn(binary, args, { cwd: scratch, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  supervisor.stderr.pipe(log, { end: false });
  supervisor.stdout.pipe(log, { end: false });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && supervisor.exitCode === null) {
    try { if ((await call(api + "/status")).status === 200) return; } catch {}
    await delay(100);
  }
  throw new Error("安装后的工作区未就绪。");
}
async function stop() {
  if (!supervisor || supervisor.exitCode !== null || supervisor.signalCode !== null) return;
  const ended = once(supervisor, "exit");
  supervisor.kill("SIGTERM");
  await ended;
}

async function fixtureRelease(manifest, version, bad) {
  const root = join(scratch, version);
  cpSync(pack, root, { recursive: true, mode: constants.COPYFILE_FICLONE });
  unlinkSync(join(root, "release.json"));
  const path = join(root, "app/src/business-schema.mjs");
  const before = readFileSync(path, "utf8");
  const changed = before.replace('const workspaceSchemaRevision = "1";', 'const workspaceSchemaRevision = "2";')
    .replace('compatible(revisionKey, workspaceSchemaRevision)', '(values.get(revisionKey) === "1" || compatible(revisionKey, workspaceSchemaRevision))')
    .replace('const versions = await verifySchema(db, true);',
      `const versions = await verifySchema(db, true);
      if (versions.get(revisionKey) === "1") {
        await db.run('UPDATE metadata SET value=? WHERE "key"=?', [workspaceSchemaRevision, revisionKey]);
        await db.exec("CREATE TABLE IF NOT EXISTS release_upgrade_fixture(migrated TEXT NOT NULL)");
        ${bad ? 'await db.exec("UPDATE files SET name=\'Unsuccessful migration\'");' : ''}
      }`);
  assert.notEqual(changed, before);
  writeFileSync(path, changed);
  if (bad) writeFileSync(join(root, "app/dist/sidecar.cjs"), "process.exit(42);\n");
  return { root, manifest: await sealRelease(root, { ...manifest, version }) };
}

function readDatabase(root, sql) {
  const db = new DatabaseSync(join(root, "business.sqlite"), { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}

function tinyPdf() {
  const stream = "BT /F1 16 Tf 50 180 Td (Offline PDF example) Tj ET\n";
  const items = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = items.map((item, i) => { const offset = pdf.length; pdf += `${i + 1} 0 obj\n${item}\nendobj\n`; return offset; });
  return Buffer.from(pdf + `xref\n0 6\n0000000000 65535 f \n` + offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`);
}

try {
  cpSync(resolve(input), pack, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const { manifest } = await verifyRelease(pack);
  const rejectedNetwork = execute(join(pack, "runtime/node"), ["--input-type=module", "-e",
    'import {connect} from "node:net"; const socket=connect(443,"198.51.100.1"); socket.setTimeout(1500,()=>process.exit(1)); socket.on("connect",()=>process.exit(1)); socket.on("error",e=>{console.log(e.code); process.exit(["EPERM","ENETUNREACH","EHOSTUNREACH"].includes(e.code)?0:1)});']);
  assert.match(rejectedNetwork.stdout, /EPERM|ENETUNREACH|EHOSTUNREACH/);
  const info = JSON.parse(execute(join(pack, "workspace"), ["release-info"]).stdout);
  assert.equal(info.id, manifest.id);
  const bad = await fixtureRelease(manifest, "startup-failure", true);
  const good = await fixtureRelease(manifest, "newer-schema", false);
  assert(!existsSync(join(deployment, "node_modules")));
  execute(join(pack, "workspace"), ["install", "--deployment", deployment, "--public-url", base,
    "--engine-port", String(enginePort), "--collab-port", String(collabPort)]);
  const first = readState().active;
  await start();
  checks.push("Independent installation used its own Node, native engine, local static assets and a fresh data directory. External socket access was denied.");

  const login = await call(api + "/login", { method: "POST", data: { username: "admin", password } });
  const account = { ...ok(login), cookie: login.cookie };
  assert.equal(account.user.role, "admin");
  assert.equal(ok(await call(api + "/users", { account })).users.length, 1);
  checks.push("The server used its own administrator and admitted the team user management API.");
  const files = [];
  for (const name of ["部署演练.docx", "项目表.xlsx", "评审.pptx", "白板.excalidraw"])
    files.push(ok(await call(api + "/files", { account, method: "POST", data: { name } }), 201).file);
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGOQaY36jw8zjAwFAO8IfoFgFVfAAAAAAElFTkSuQmCC", "base64");
  for (const [name, bytes] of [["示例.pdf", tinyPdf()], ["图片.png", pixel]])
    files.push(ok(await call(`${api}/files?filename=${encodeURIComponent(name)}`, { account, method: "POST", bytes }), 201).file);

  browser = await chromium.launch(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {});
  const context = await browser.newContext({ viewport: { width: 1380, height: 950 }, serviceWorkers: "block" });
  const blocked = [];
  function local(url) { return new URL(url).host === new URL(base).host; }
  await context.route("**/*", route => {
    const url = route.request().url();
    if (local(url)) return route.continue();
    blocked.push(new URL(url).hostname);
    return route.abort();
  });
  await context.routeWebSocket("**/*", route => { if (local(route.url())) route.connectToServer(); else { blocked.push(new URL(route.url()).hostname); route.close(); } });
  const [name, value] = account.cookie.split("=");
  await context.addCookies([{ name, value, url: base }]);
  const selectors = ['.tiptap[contenteditable="true"]', '.hcd-univer-host [role="tab"][aria-selected="true"]', ".fixed-page iframe",
    ".excalidraw__canvas.interactive", ".fixed-page iframe", ".image-workspace .image-pixels"];
  for (let i = 1; i < selectors.length; i++) {
    const preview = await context.newPage();
    await preview.goto(`${base}/editor/?workspaceFile=${files[i].id}&locale=zh-CN`);
    await expect(preview.locator(selectors[i]).first()).toBeVisible({ timeout: 60_000 });
    await preview.close();
  }
  const documentUrl = `${base}/editor/?workspaceFile=${files[0].id}&locale=zh-CN`;
  const page = await context.newPage(), mirror = await context.newPage();
  await Promise.all([page.goto(documentUrl), mirror.goto(documentUrl)]);
  const editable = page.locator(selectors[0]).first(), replicated = mirror.locator(selectors[0]).first();
  await expect(replicated).toBeVisible({ timeout: 45_000 });
  await editable.click();
  await page.keyboard.insertText("Synced before release cutover.");
  await expect(replicated).toContainText("Synced before release cutover.");
  assert.deepEqual(blocked, []);
  checks.push("A cold browser opened native Word, Excel, PPT, an Excalidraw board, PDF and PNG with no public asset requests. Two Word tabs synchronized via the bundled sidecar.");

  if (process.env.OFFICECLI_RELEASE_NATIVE_VERIFY === "1") {
    // The driver supplies only synthetic input documents. The installed product
    // must supply its own engine, OCR models, WASM and all UI assets offline.
    const cases = [["pivots", verifySheetPivots], ["conditions", verifySheetConditions],
      ["ocr", verifyPdfOcr], ["layers", verifyImageLayers], ["pptx", verifyPptxInheritance], ["word", verifyWordTableCells]];
    const selected = process.env.OFFICECLI_RELEASE_NATIVE_CASE;
    assert(!selected || cases.some(([kind]) => kind === selected), "unknown offline native case");
    for (const [kind, verify] of cases.filter(([kind]) => !selected || selected === kind)) {
      const output = join(artifacts, kind);
      mkdirSync(output, { recursive: true });
      const nativeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"],
        locale: "zh-CN", reducedMotion: "reduce" });
      await nativeContext.addCookies([{ name, value, url: base }]);
      await nativeContext.route("**/*", route => {
        if (local(route.request().url())) return route.continue();
        blocked.push(new URL(route.request().url()).hostname);
        return route.abort();
      });
      await nativeContext.routeWebSocket("**/*", route => {
        if (local(route.url())) route.connectToServer();
        else { blocked.push(new URL(route.url()).hostname); route.close(); }
      });
      const nativePage = await nativeContext.newPage(), errors = [], caseChecks = [];
      const trace = [], pending = new Map();
      nativePage.on("console", message => { if (["error", "warning"].includes(message.type())) trace.push({ type: message.type(), text: message.text().slice(0, 1500) }); });
      nativePage.on("request", request => pending.set(request, { path: new URL(request.url()).pathname, started: Date.now() }));
      nativePage.on("requestfinished", request => {
        const detail = pending.get(request); pending.delete(request);
        if (detail) trace.push({ type: "response", ...detail, duration: Date.now() - detail.started });
      });
      nativePage.on("requestfailed", request => { pending.delete(request); trace.push({ type: "failed", path: new URL(request.url()).pathname, reason: request.failure()?.errorText }); });
      nativePage.on("pageerror", error => errors.push(error.message));
      try {
        await nativePage.goto(base + "/workbench/?ai=0");
        await verify(nativePage, output, caseChecks);
        assert.deepEqual(errors, []);
        assert.deepEqual(blocked, []);
        nativeCases.push({ name: kind, checks: caseChecks });
        writeFileSync(join(output, "offline-browser.json"), JSON.stringify({ checks: caseChecks }, null, 2));
        console.log(`Offline installed workbench passed: ${kind}`);
      } catch (error) {
        writeFileSync(join(output, "failure-state.json"), JSON.stringify({ errors, trace: trace.slice(-100), pending: [...pending.values()],
          state: await nativePage.evaluate(() => {
            return { alerts: [...document.querySelectorAll('[role=alert]')].map(el => el.textContent),
              status: document.querySelector('.desk-editor.is-visible .editor-statusbar')?.textContent,
              canvases: [...document.querySelectorAll('.desk-editor.is-visible canvas')].map(canvas => ({
                id: canvas.id, width: canvas.width, height: canvas.height,
              })) };

          }).catch(() => null) }, null, 2));
        await nativePage.screenshot({ path: join(output, "failure.png"), timeout: 6000 }).catch(() => {});
        throw error;
      } finally { await nativeContext.close(); }
    }
    checks.push(selected ? `The installed offline workbench edited and reopened the ${selected} case using only its bundled assets.`
      : "The installed offline workbench edited and reopened native pivots, conditional rules, OCR PDF text, image layers, PPTX master text styles and merged/split Word table cells using only its bundled assets.");
  }

  const broken = execute(installed, ["upgrade", "--release", bad.root], 1);
  assert.match(broken.stderr, /已恢复原版本/);
  assert.deepEqual(readState().active, first);
  assert.equal(readDatabase(workspace(first.data), "SELECT value FROM metadata WHERE key='schemaRevision'")[0].value, "1");
  assert(readDatabase(workspace(first.data), "SELECT name FROM files").every(file => file.name !== "Unsuccessful migration"));
  await readSavedText(account, files[0], "Synced before release cutover.");
  await page.reload();
  await expect(editable).toContainText("Synced before release cutover.", { timeout: 45_000 });
  checks.push("A sealed candidate mutated its own migrated database and its sidecar exited. The controller restarted the previous release with the original dataset and the collaboration checkpoint intact.");

  const changed = JSON.parse(execute(installed, ["upgrade", "--release", good.root]).stdout);
  const newer = readState().active;
  assert.equal(newer.release, good.manifest.id);
  assert.notEqual(newer.data, first.data);
  assert.deepEqual(readState().previous, first);
  assert.equal(readDatabase(workspace(newer.data), "SELECT value FROM metadata WHERE key='schemaRevision'")[0].value, "2");
  assert.equal(readDatabase(workspace(first.data), "SELECT value FROM metadata WHERE key='schemaRevision'")[0].value, "1");
  assert(existsSync(join(changed.snapshot, "snapshot.json")));
  await readSavedText(account, files[0], "Synced before release cutover.");
  await page.reload();
  await expect(editable).toContainText("Synced before release cutover.", { timeout: 45_000 });
  await page.screenshot({ path: join(artifacts, "after-offline-upgrade.png") });
  const after = ok(await call(api + "/files", { account, method: "POST", data: { name: "新版操作.txt" } }), 201).file;
  checks.push("A second release performed an actual schema upgrade on its new copy. A verified snapshot exists and both the original session and collaborative text remained usable.");

  const rollback = JSON.parse(execute(installed, ["rollback", "--to", first.data]).stdout);
  assert.deepEqual(readState().active, first);
  assert.deepEqual(readState().previous, newer);
  assert.equal((await call(`${api}/files/${after.id}`, { account })).status, 404);
  assert(readDatabase(workspace(newer.data), "SELECT id FROM files").some(row => row.id === after.id));
  assert(existsSync(join(rollback.snapshot, "snapshot.json")));
  const repeated = JSON.parse(execute(installed, ["rollback", "--to", first.data]).stdout);
  assert.equal(repeated.alreadyActive, true);
  assert.deepEqual(readState().active, first);
  execute(installed, ["rollback", "--to", newer.data]);
  assert.deepEqual(readState().active, newer);
  ok(await call(`${api}/files/${after.id}`, { account }));
  await context.close();
  await stop();
  await start();
  ok(await call(`${api}/files/${after.id}`, { account }));
  await readSavedText(account, files[0], "Synced before release cutover.");
  assert.deepEqual(readState().active, newer);
  checks.push("Rollback switched the release and compatible data together. The newer dataset retained its writes, could be reactivated, and remained pinned after a controller restart.");

  const report = { status: "passed", platform: `${manifest.platform}/${manifest.arch}`, package: manifest.id,
    runtimeNode: manifest.node, engine: manifest.engine, networkProbe: rejectedNetwork.stdout.trim(), checks, nativeCases };
  writeFileSync(join(artifacts, "validation.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`发行验收失败。服务日志位于 ${join(scratch, "services.log")}`);
  throw error;
} finally {
  await browser?.close();
  await stop();
  await new Promise(resolve => log.end(resolve));
  if (artifacts !== scratch && existsSync(join(scratch, "services.log")))
    cpSync(join(scratch, "services.log"), join(artifacts, "services.log"));
}
