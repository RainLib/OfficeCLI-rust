import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser, Locator, Page } from "../../../examples/hdoc/editor/node_modules/@playwright/test/index.js";

const editorRequire = createRequire(new URL("../../../examples/hdoc/editor/package.json", import.meta.url));
const { chromium, expect } = editorRequire("@playwright/test") as typeof import("../../../examples/hdoc/editor/node_modules/@playwright/test/index.js");
const Y = editorRequire("yjs") as typeof import("../../../examples/hdoc/editor/node_modules/yjs/dist/src/index.js");

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = await mkdtemp(join(await realpath(tmpdir()), "foldly-collaboration-"));
const source = "foldlycollab" + randomBytes(6).toString("hex");
const restored = source + "restore";
const artifacts = process.env.FOLDLY_COMPOSE_TEST_ARTIFACTS;
const root = "/var/lib/foldly/workspace";
const password = randomBytes(24).toString("hex");
const peerPassword = randomBytes(24).toString("hex");
const postgresPassword = randomBytes(24).toString("hex");
const adminPasswordPath = join(scratch, "admin");
const postgresPasswordPath = join(scratch, "pg-admin");
const databasePasswordPath = join(scratch, "pg-user");
const dsnPath = join(scratch, "pg-url");
await Promise.all([
  writeFile(adminPasswordPath, password, { mode: 0o600 }),
  writeFile(postgresPasswordPath, randomBytes(24).toString("hex"), { mode: 0o600 }),
  writeFile(databasePasswordPath, postgresPassword, { mode: 0o600 }),
  writeFile(dsnPath, `postgresql://foldly:${postgresPassword}@postgres:5432/foldly`, { mode: 0o600 }),
]);

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const httpPort = await freePort(), httpsPort = await freePort();
const base = `http://localhost:${httpPort}`;
const env = {
  ...process.env,
  FOLDLY_PUBLIC_URL: base, FOLDLY_LISTEN_ADDR: "127.0.0.1", FOLDLY_PROXY_SITE: ":80",
  FOLDLY_HTTP_PORT: String(httpPort), FOLDLY_HTTPS_PORT: String(httpsPort), FOLDLY_INTERNAL_PORT: "7400",
  FOLDLY_IMAGE: process.env.FOLDLY_COMPOSE_TEST_IMAGE || "foldly-workspace:local",
  FOLDLY_ADMIN: "admin", FOLDLY_ADMIN_PASSWORD_FILE: adminPasswordPath,
  FOLDLY_DATABASE_ADMIN_PASSWORD_FILE: postgresPasswordPath, FOLDLY_DATABASE_PASSWORD_FILE: databasePasswordPath,
  FOLDLY_DATABASE_URL_FILE: dsnPath, FOLDLY_RUNTIME_ENV_FILE: join(scratch, "unused.env"),
};
const run = promisify(execFile);
function docker(args: string[]) {
  return run("docker", args, { cwd: repo, env, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 });
}
function compose(project: string, ...args: string[]) {
  return docker(["compose", "-f", "docker-compose.yaml", "--project-name", project, ...args]);
}
const execWorkspace = (project: string, ...args: string[]) => compose(project, "exec", "-T", "workspace", ...args);
const workers = async () => (await compose(source, "ps", "-q", "collaboration")).stdout.trim().split("\n").filter(Boolean);
const wait = { timeout: 60_000 };
const prepared = { method: "POST" as const };

type Account = { user: { id: string }; csrf: string; cookie: string };
type File = { id: string; name: string };
type Launch = { documentId: string; token: string; collabUrl: string };
type Editor = { page: Page; body: Locator; sockets: Set<string>; opened: () => number };

async function call(path: string, account?: Account, { method = "GET", data, token }: {
  method?: string; data?: unknown; token?: string;
} = {}) {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { Origin: base, ...(data !== undefined && { "Content-Type": "application/json" }),
      ...(account && { Cookie: account.cookie, "X-Workspace-CSRF": account.csrf }),
      ...(token && { Authorization: `Bearer ${token}` }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  assert(response.ok, `${method} ${path} failed with HTTP ${response.status}`);
  return response;
}

async function login(username: string, password: string): Promise<Account> {
  const response = await call("/workspace/api/login", undefined, { ...prepared, data: { username, password } });
  return { ...(await response.json()), cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

async function createDocument(account: Account, name: string) {
  return (await (await call("/workspace/api/files", account, { ...prepared, data: { name } })).json()).file as File;
}

async function launch(account: Account, file: File): Promise<Launch> {
  return await (await call(`/workspace/api/files/${file.id}/editor-session`, account, {
    ...prepared, data: { sessionId: randomUUID() },
  })).json();
}

async function readRevision(account: Account, session: Launch) {
  return (await (await call(`/v1/documents/${session.documentId}/editor`, account, { token: session.token })).json()).blocks;
}

let browser: Browser | undefined;
async function open(account: Account, file: File, workbench = false): Promise<Editor> {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 960 } });
  const separator = account.cookie.indexOf("=");
  await context.addCookies([{ name: account.cookie.slice(0, separator), value: account.cookie.slice(separator + 1), url: base }]);
  const page = await context.newPage();
  const sockets = new Set<string>();
  let opened = 0;
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    if (url.pathname !== "/collaboration" || !url.searchParams.has("route")) return;
    opened++;
    sockets.add(socket.url());
  });
  await page.goto(base + (workbench ? `/workbench/?file=${file.id}` : `/editor/?workspaceFile=${file.id}&locale=zh-CN`));
  const body = page.locator('.tiptap[contenteditable="true"]').first();
  await expect(body).toBeVisible(wait);
  assert(opened > 0);
  return { page, body, sockets, opened: () => opened };
}

async function type(editor: Editor, marker: string) {
  await editor.body.click();
  await editor.page.keyboard.press("ControlOrMeta+End");
  await editor.page.keyboard.insertText(" " + marker);
  await expect(editor.body).toContainText(marker, wait);
}

async function save(editor: Editor, marker: string, account: Account, session: Launch) {
  await editor.page.getByRole("button", { name: "保存点", exact: true }).click();
  await expect.poll(async () => JSON.stringify(await readRevision(account, session)).includes(marker), wait).toBe(true);
}

async function workerSaved(worker: string, id: string) {
  const logs = await docker(["logs", "--tail", "200", worker]);
  return (logs.stdout + logs.stderr).includes(`HCD checkpoint ${id}:`);
}

async function durableRoom(id: string) {
  const bytes = await run("docker", [
    "compose", "-f", "docker-compose.yaml", "--project-name", source, "exec", "-T", "workspace",
    "cat", `${root}/engine/collaboration/${id}.bin`,
  ], { cwd: repo, env, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, bytes.stdout);
    return document.getXmlFragment("default").toString();
  } finally { document.destroy(); }
}

try {
  const build = process.env.FOLDLY_COMPOSE_TEST_NO_BUILD === "1" ? "--no-build" : "--build";
  await compose(source, "up", "-d", "--wait", build);
  assert.equal((await workers()).length, 1);
  const workspaceId = (await compose(source, "ps", "-q", "workspace")).stdout;
  await compose(source, "up", "-d", "--no-build", "--wait", "--scale", "collaboration=2");
  const instances = await workers();
  assert.equal(instances.length, 2);
  assert.equal((await compose(source, "ps", "-q", "workspace")).stdout, workspaceId);
  console.log("Compose starts one independent worker and scales to two without restarting Workspace.");

  browser = await chromium.launch({ executablePath: process.env.HCD_BROWSER_PATH, args: ["--no-proxy-server"] });
  const admin = await login("admin", password);
  await call("/workspace/api/users", admin, { ...prepared,
    data: { username: "peer", displayName: "协作验证成员", password: peerPassword, role: "member" } });
  const peer = await login("peer", peerPassword);
  assert.notEqual(admin.user.id, peer.user.id);
  const file = await createDocument(admin, "Compose collaboration.docx");
  await call(`/workspace/api/files/${file.id}/acl`, admin, { method: "PUT",
    data: { userId: peer.user.id, profile: "editor", operations: ["document.view", "document.edit", "document.copy"] } });
  const session = await launch(admin, file);
  assert.equal(new URL(session.collabUrl, base).searchParams.get("document"), session.documentId);
  const [author, observer] = await Promise.all([open(admin, file), open(peer, file, true)]);
  assert.equal([...author.sockets][0], [...observer.sockets][0]);
  const otherDocument = new URL([...author.sockets][0]);
  otherDocument.searchParams.set("document", "different-document");
  assert.equal(await author.page.evaluate(url => new Promise<boolean>(resolve => {
    const socket = new WebSocket(url);
    socket.onopen = () => { socket.close(); resolve(false); };
    socket.onerror = () => resolve(true);
  }), otherDocument.href), true, "a routing signature is bound to its document");
  const baseline = "baseline-" + randomUUID();
  await type(author, baseline);
  await expect(observer.body).toContainText(baseline, wait);
  await save(author, baseline, admin, session);
  await expect.poll(async () => (await Promise.all(instances.map(instance => workerSaved(instance, session.documentId))))
    .filter(Boolean).length, wait).toBe(1);
  const ownership = await Promise.all(instances.map(instance => workerSaved(instance, session.documentId)));
  assert.equal(ownership.filter(Boolean).length, 1);
  const crashed = instances[ownership.indexOf(true)];
  const survivor = instances.find(instance => instance !== crashed)!;

  const beforeCrash = "uncheckpointed-" + randomUUID();
  await type(observer, beforeCrash);
  await expect(author.body).toContainText(beforeCrash, wait);
  await expect.poll(async () => (await durableRoom(session.documentId)).includes(beforeCrash), wait).toBe(true);
  assert(!JSON.stringify(await readRevision(admin, session)).includes(beforeCrash));
  const counts = [author.opened(), observer.opened()];
  await docker(["update", "--restart=no", crashed]);
  await docker(["kill", "--signal", "KILL", crashed]);
  await Promise.all([author, observer].map((editor, index) =>
    expect.poll(() => editor.opened(), wait).toBeGreaterThan(counts[index])));
  for (const editor of [author, observer]) {
    await expect(editor.body).toBeVisible(wait);
    await expect(editor.body).toContainText(beforeCrash, wait);
  }
  // Restore the dirty checkpoint on the new worker without another edit first.
  await save(author, beforeCrash, admin, session);
  await expect.poll(() => workerSaved(survivor, session.documentId), wait).toBe(true);
  const afterCrash = "after-handoff-" + randomUUID();
  await type(author, afterCrash);
  await expect(observer.body).toContainText(afterCrash, wait);
  await save(author, afterCrash, admin, session);
  if (artifacts) {
    await mkdir(artifacts, { recursive: true });
    await observer.page.screenshot({ path: join(artifacts, "compose-collaboration.png") });
  }
  console.log("Two authorized users reconnected to the surviving worker and saved the recovered edit.");

  await docker(["start", crashed]);
  await expect.poll(async () => (await docker(["inspect", "--format", "{{.State.Health.Status}}", crashed])).stdout.trim(), wait).toBe("healthy");
  let otherRoom: { file: File; session: Launch; editor: Editor } | undefined;
  for (let attempt = 0; attempt < 16 && !otherRoom; attempt++) {
    const file = await createDocument(admin, `Worker routing ${attempt + 1}.docx`);
    const session = await launch(admin, file);
    const editor = await open(admin, file);
    const marker = "routing-" + randomUUID();
    await type(editor, marker);
    await save(editor, marker, admin, session);
    if (await workerSaved(crashed, session.documentId)) otherRoom = { file, session, editor };
    else await editor.page.context().close();
  }
  assert(otherRoom, "new documents should reach both workers");
  const reopenedPeer = await open(peer, file);
  await expect(reopenedPeer.body).toContainText(afterCrash, wait);
  const roomOne = "included-in-first-room-" + randomUUID(), roomTwo = "included-in-second-room-" + randomUUID();
  await Promise.all([type(author, roomOne), type(otherRoom.editor, roomTwo)]);
  await expect(reopenedPeer.body).toContainText(roomOne, wait);
  assert(!JSON.stringify(await readRevision(admin, session)).includes(roomOne));
  assert(!JSON.stringify(await readRevision(admin, otherRoom.session)).includes(roomTwo));
  const cut = JSON.parse((await execWorkspace(source, "foldly", "backup", "--root", root, "--output", "/tmp/validation-backup")).stdout);
  assert.equal(cut.collaborationRooms, 2);
  const verified = JSON.parse((await execWorkspace(source, "foldly", "verify-backup", "--backup", "/tmp/validation-backup")).stdout);
  assert.equal(verified.id, cut.id);
  const backup = join(scratch, "backup");
  await mkdir(backup, { mode: 0o700 });
  await compose(source, "cp", "workspace:/tmp/validation-backup/.", backup);
  const afterCut = "live-only-" + randomUUID();
  await type(author, afterCut);
  await expect(observer.body).toContainText(afterCut, wait);
  await save(author, afterCut, admin, session);
  await browser.close();
  await compose(source, "stop", "proxy");

  await compose(restored, "up", "-d", "--wait", "postgres");
  await compose(restored, "run", "--no-deps", "--rm", "--volume", `${backup}:/verify-backup:ro`,
    "--entrypoint", "sh", "workspace", "-ec",
    "cp -a /verify-backup /tmp/validation-backup && chown -R node:node /tmp/validation-backup && " +
    "exec foldly restore --backup /tmp/validation-backup --root /var/lib/foldly/workspace --database postgres");
  await compose(restored, "up", "-d", "--no-build", "--wait");
  browser = await chromium.launch({ executablePath: process.env.HCD_BROWSER_PATH, args: ["--no-proxy-server"] });
  const restoredAdmin = await login("admin", password);
  const restoredPeer = await login("peer", peerPassword);
  assert.equal(restoredPeer.user.id, peer.user.id);
  const [first, second] = await Promise.all([open(restoredPeer, file, true), open(restoredAdmin, otherRoom.file)]);
  for (const marker of [baseline, beforeCrash, afterCrash, roomOne]) await expect(first.body).toContainText(marker, wait);
  await expect(first.body).not.toContainText(afterCut);
  await expect(second.body).toContainText(roomTwo, wait);
  const binary = "/opt/foldly/app/dist/officecli";
  const exported = "/tmp/restored-validation.docx";
  await execWorkspace(restored, binary, "hdoc", "export", `${root}/engine/${session.documentId}.hcd`,
    "--source", `${root}/engine/sources/${session.documentId}.docx`, "--to", "docx", "--output", exported);
  const native = (await execWorkspace(restored, binary, "view", exported, "text")).stdout;
  assert.equal(native.split(beforeCrash).length, 2, "recovered text is present once in the native file");
  assert(native.includes(roomOne) && !native.includes(afterCut));
  console.log("Both workers flushed before backup. Restored PostgreSQL, ACLs and DOCX content match the snapshot.");
} catch (error) {
  for (const project of [source, restored]) {
    const logs = await compose(project, "logs", "--tail", "60", "collaboration", "workspace").catch(() => null);
    if (logs) console.error(logs.stdout);
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  for (const project of [restored, source]) {
    await compose(project, "down", "--volumes", "--remove-orphans").catch(error => console.error(error.message));
  }
  await rm(scratch, { recursive: true, force: true });
}
