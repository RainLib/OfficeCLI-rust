import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs";
import { faultPublicationCallbacks } from "./verify-publication-jobs.mjs";

const app = resolve(import.meta.dirname, ".."), assets = resolve(process.env.OFFICECLI_WORKSPACE_DIST || join(app, "dist"));
const scratch = mkdtempSync(join(tmpdir(), "officecli-backup-"));
const root = join(scratch, "live"), snapshot = join(scratch, "snapshot"), restored = join(scratch, "restored");
const artifacts = resolve(process.env.OFFICECLI_BACKUP_ARTIFACTS || scratch);
mkdirSync(artifacts, { recursive: true });
const log = createWriteStream(join(scratch, "services.log"), { mode: 0o600 });
const password = randomBytes(24).toString("base64url"), cli = join(app, "cli.mjs"), api = "/workspace/api";
const checks = [];
let browser, supervisor, slowUpload, fault;

async function port() {
  const socket = createServer();
  await new Promise(done => socket.listen(0, "127.0.0.1", done));
  const { port } = socket.address();
  await new Promise(done => socket.close(done));
  return port;
}
const web = await port(), engine = await port(), collab = await port(), base = `http://127.0.0.1:${web}`;

function command(args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: password } });
  assert.equal(result.status, expected, result.stderr);
  return result.stdout;
}

async function poll(check, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let failure;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { failure = error; }
    await delay(100);
  }
  throw failure || new Error("等待备份验收状态超时");
}

async function start(directory) {
  supervisor = spawn(process.execPath, [cli, "start", "--root", directory, "--assets", assets], { stdio: ["ignore", "pipe", "pipe"] });
  supervisor.stderr.pipe(log, { end: false });
  supervisor.stdout.pipe(log, { end: false });
  await poll(async () => (await fetch(base + api + "/status")).ok && (await fetch(`http://127.0.0.1:${collab}`)).ok);
}

async function stop() {
  if (!supervisor || supervisor.exitCode !== null || supervisor.signalCode !== null) return;
  const ended = once(supervisor, "exit");
  supervisor.kill("SIGTERM");
  await ended;
}

function headers(account, token) {
  return { Origin: base, ...(account ? { Cookie: account.cookie, "X-Workspace-CSRF": account.csrf } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function call(path, { account, token, method = "GET", data, extra = {} } = {}) {
  const result = await fetch(base + path, { method, headers: { ...headers(account, token),
    ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...extra },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const content = await result.text();
  let value;
  try { value = JSON.parse(content); } catch { value = content; }
  return { status: result.status, value, cookie: result.headers.get("set-cookie")?.split(";")[0] };
}
function expectStatus(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify(result.value));
  return result.value;
}
async function login() {
  const result = await call(api + "/login", { method: "POST", data: { username: "admin", password } });
  return { ...expectStatus(result), cookie: result.cookie };
}
async function launch(account, id) {
  return expectStatus(await call(`${api}/files/${id}/editor-session`, { account, method: "POST", data: { sessionId: randomUUID() } }));
}
async function create(account, name) {
  return expectStatus(await call(api + "/files", { account, method: "POST", data: { name } }), 201).file;
}
async function contextFor(account) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 930 } });
  const [name, value] = account.cookie.split("=");
  await context.addCookies([{ name, value, url: base }]);
  return context;
}
async function openWord(context, file) {
  const page = await context.newPage();
  await page.goto(`${base}/editor/?workspaceFile=${file.id}&locale=zh-CN`);
  const body = page.locator('.tiptap[contenteditable="true"]').first();
  await expect(body).toBeVisible({ timeout: 45_000 });
  return { page, body };
}

async function waitForCommand(args) {
  const worker = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  worker.stdout.on("data", bytes => { output += bytes; });
  worker.stderr.on("data", bytes => { errors += bytes; });
  const [status] = await once(worker, "exit");
  return { status, output, errors };
}

async function prepareUncertainPublication(account) {
  const file = await create(account, "待回写.txt");
  const session = await launch(account, file.id), auth = { account, token: session.token };
  const path = `/v1/documents/${session.documentId}`;
  const before = expectStatus(await call(path, auth));
  const { hits } = expectStatus(await call(`${path}/search?q=${encodeURIComponent("开始编写")}`, auth));
  const node = expectStatus(await call(`${path}/nodes/${hits[0].nodeId}`, auth));
  const epoch = async () => ({ "X-HCD-Collaboration-Epoch": String(expectStatus(await call(`${path}/auth`, auth)).collaborationEpoch) });
  const result = expectStatus(await call(path + "/node-patch", { ...auth, method: "POST", extra: await epoch(), data: {
    schemaVersion: "hcd-patch/1", documentId: session.documentId, patchId: randomUUID(), baseRevision: before.revision,
    operations: [{ op: "text.splice", nodeId: hits[0].nodeId, start: 0, deleteCount: Array.from(node.text).length,
      insertText: "Draft held by the original publication ID.", precondition: { nodeHash: node.nodeHash } }],
  } }));
  const publicationId = randomUUID();
  fault.set(file.id, "prepare");
  expectStatus(await call(path + "/publications", { ...auth, method: "POST", extra: await epoch(), data: {
    publicationId, expectedRevision: result.revision, exportMode: "source-backed",
  } }), 202);
  return { file, publicationId };
}

try {
  command(["init", "--root", root, "--public-url", base, "--engine-port", String(engine), "--collab-port", String(collab)]);
  fault = await faultPublicationCallbacks(root);
  await start(root);
  const runner = supervisor.pid, account = await login();
  const file = await create(account, "协作恢复.docx"), pending = await prepareUncertainPublication(account);
  const { documentId, token } = await launch(account, file.id), document = `/v1/documents/${documentId}`;
  const engineUrl = `http://127.0.0.1:${engine}`;
  const lease = `${engineUrl}/integration/v1/backup-leases/${randomUUID()}`;
  const service = { Authorization: `Bearer ${JSON.parse(readFileSync(join(root, "keys.json"), "utf8")).service}` };
  assert.equal((await fetch(lease, { method: "PUT" })).status, 401);
  assert.equal((await fetch(lease, { method: "PUT", headers: service })).status, 204);
  try {
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(engineUrl + document, { headers: auth })).status, 200);
    const blocked = await fetch(engineUrl + document + "/project", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).code, "workspace_snapshot");
  } finally {
    assert.equal((await fetch(lease, { method: "DELETE", headers: service })).status, 204);
  }
  checks.push("The engine accepts the barrier only from its application service. A held barrier rejects direct mutations and still serves document reads.");
  const obstruction = join(root, "engine", "unexpected-link");
  symlinkSync(join(scratch, "absent-target"), obstruction);
  const invalid = join(scratch, "invalid-snapshot");
  try {
    const rejected = await waitForCommand(["backup", "--root", root, "--output", invalid]);
    assert.equal(rejected.status, 1, rejected.errors);
    assert.match(rejected.errors, /非普通文件/);
    assert(!existsSync(invalid));
    expectStatus(await call(api + "/mentions/read", { account, method: "POST", data: {} }), 204);
  } finally { unlinkSync(obstruction); }
  checks.push("A failed snapshot releases the admission barriers and leaves no public backup destination.");
  browser = await chromium.launch(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {});
  const context = await contextFor(account);
  const author = await openWord(context, file), observer = await openWord(context, file);
  const savedRevision = expectStatus(await call(document, { account, token })).revision;
  const beforeCut = "Collaborative text included by the backup checkpoint.";
  await author.body.click();
  await author.page.keyboard.press("ControlOrMeta+End");
  await author.page.keyboard.insertText(beforeCut);
  await expect(observer.body).toContainText(beforeCut);
  assert.equal(expectStatus(await call(document, { account, token })).revision, savedRevision);

  const uploadBody = "A request admitted just before backup completed with its original bytes.";
  const uploaded = new Promise((resolve, reject) => {
    slowUpload = request(base + api + "/files?filename=drained.txt", { method: "POST", headers: {
      ...headers(account), "Content-Type": "application/octet-stream", "Content-Length": Buffer.byteLength(uploadBody),
    } }, result => {
      let bytes = "";
      result.setEncoding("utf8");
      result.on("data", chunk => { bytes += chunk; });
      result.on("end", () => resolve({ status: result.statusCode, value: JSON.parse(bytes) }));
    });
    slowUpload.on("error", reject);
    slowUpload.write(uploadBody.slice(0, 10));
  });
  // Keep the already-admitted write open while verifying the runtime's read-only window.
  await delay(200);
  const completed = waitForCommand(["backup", "--root", root, "--output", snapshot]);
  await poll(async () => (await call(api + "/mentions/read", { account, method: "POST", data: {} })).value?.code === "workspace_snapshot", 15_000);
  expectStatus(await call(api + "/files", { account }));
  expectStatus(await call(document + "/editor", { account, token }));
  assert.equal(supervisor.pid, runner);
  slowUpload.end(uploadBody.slice(10));
  const drainedFile = expectStatus(await uploaded, 201).file;
  slowUpload = null;
  const { status, output, errors } = await completed;
  assert.equal(status, 0, errors);
  const cut = JSON.parse(output);
  assert.equal(cut.collaborationRooms, 1);
  assert.equal(JSON.parse(command(["verify-backup", "--backup", snapshot])).id, cut.id);
  assert.equal(supervisor.pid, runner);
  const after = await create(account, "备份之后.txt");
  await author.body.click();
  await author.page.keyboard.press("ControlOrMeta+End");
  await author.page.keyboard.insertText(" Later text only in the live workspace.");
  await expect(observer.body).toContainText("Later text only in the live workspace.");
  checks.push("An admitted upload drained. New writes briefly returned a retryable response, while file and editor reads kept serving. Open Yjs clients continued afterwards on the same supervisor.");

  const corrupt = join(scratch, "corrupt");
  cpSync(snapshot, corrupt, { recursive: true });
  const object = JSON.parse(readFileSync(join(snapshot, "snapshot.json"), "utf8")).files.find(item => item.path.startsWith("objects/"));
  writeFileSync(join(corrupt, object.path), "changed");
  command(["verify-backup", "--backup", corrupt], 1);
  command(["restore", "--backup", corrupt, "--root", join(scratch, "rejected")], 1);
  command(["restore", "--backup", snapshot, "--root", root], 1);
  command(["restore", "--backup", snapshot, "--root", restored]);
  assert.deepEqual(readFileSync(join(restored, "keys.json")), readFileSync(join(root, "keys.json")));
  const roomPath = join("engine", "collaboration", `${documentId}.bin`);
  assert.deepEqual(readFileSync(join(restored, roomPath)), readFileSync(join(snapshot, roomPath)));
  checks.push("Checksums reject tampered bytes and restore refuses an existing working directory. Signing identity and Yjs bytes survive a verified restore.");

  await context.close();
  await stop();
  await start(restored);
  const restoredAccount = await login(), files = expectStatus(await call(api + "/files", { account: restoredAccount })).files;
  assert(!files.some(item => item.id === after.id));
  assert(files.some(item => item.id === drainedFile.id));
  assert.equal(expectStatus(await call(`${api}/files/${drainedFile.id}/download`, { account: restoredAccount })), uploadBody);
  const next = await launch(restoredAccount, file.id), restoredAuth = { account: restoredAccount, token: next.token };
  assert.equal(next.documentId, documentId);
  assert.equal(expectStatus(await call(document, restoredAuth)).revision, savedRevision + 1);
  const reopened = await openWord(await contextFor(restoredAccount), file);
  await expect(reopened.body).toContainText(beforeCut);
  await expect(reopened.body).not.toContainText("Later text only in the live workspace.");
  await reopened.page.screenshot({ path: join(artifacts, "restored-word.png") });
  const nativeExport = join(scratch, "restored-word.docx"), binary = join(assets, "officecli");
  const exported = spawnSync(binary, ["hdoc", "export", join(restored, "engine", `${documentId}.hcd`),
    "--source", join(restored, "engine", "sources", `${documentId}.docx`), "--to", "docx", "--output", nativeExport], { encoding: "utf8" });
  assert.equal(exported.status, 0, exported.stderr);
  const opened = spawnSync(binary, ["view", nativeExport, "text"], { encoding: "utf8" });
  assert.equal(opened.status, 0, opened.stderr);
  assert(opened.stdout.includes(beforeCut) && !opened.stdout.includes("Later text only in the live workspace."));
  cpSync(nativeExport, join(artifacts, "restored-word.docx"));
  checks.push("The restored service reopened the original DOCX with the synchronized text that was awaiting autosave at the cut. A fresh native DOCX export preserved that text and excluded the later edits.");

  const original = expectStatus(await call(`${api}/files/${pending.file.id}/download?version=v1`, { account: restoredAccount }));
  const job = expectStatus(await call(api + "/publication-jobs", { account: restoredAccount })).items.find(item => item.publicationId === pending.publicationId);
  assert(job.pending && job.canRetry);
  const receipt = expectStatus(await call(`${api}/publication-jobs/${job.publicationId}/retry`, {
    account: restoredAccount, method: "POST", data: {},
  })).job.receipt;
  assert.equal(receipt.publicationId, pending.publicationId);
  assert.equal(expectStatus(await call(`${api}/files/${pending.file.id}/versions`, { account: restoredAccount })).versions.length, 2);
  assert.equal(expectStatus(await call(`${api}/files/${pending.file.id}/download?version=v1`, { account: restoredAccount })), original);
  assert.match(expectStatus(await call(`${api}/files/${pending.file.id}/download`, { account: restoredAccount })), /Draft held by the original publication ID/);
  checks.push("The surviving Provider job committed the retained revision through the original publication ID. The business version list and original bytes remained intact.");
  const result = { status: "passed", checks, files: cut.files, bytes: cut.bytes, collaborationRooms: cut.collaborationRooms };
  writeFileSync(join(artifacts, "validation.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`备份验收失败。服务日志位于 ${join(scratch, "services.log")}`);
  throw error;
} finally {
  slowUpload?.destroy();
  await browser?.close();
  await stop();
  await fault?.close();
  log.end();
}
