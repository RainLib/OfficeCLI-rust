import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const app = resolve(import.meta.dirname, "..");
const cli = join(app, "cli.mjs");
const assets = resolve(process.env.OFFICECLI_WORKSPACE_DIST || join(app, "dist"));
const urls = { postgres: process.env.FOLDLY_TEST_POSTGRES_URL_FILE, mysql: process.env.FOLDLY_TEST_MYSQL_URL_FILE };
assert(urls.postgres && urls.mysql, "Provide private URL files for two empty test databases.");
const scratch = mkdtempSync(join(tmpdir(), "foldly-databases-"));
const password = randomBytes(24).toString("base64url");
const api = "/workspace/api";
let worker, serviceLog = "";
const checks = [];

const sockets = [createServer(), createServer(), createServer()];
for (const socket of sockets) await new Promise(done => socket.listen(0, "127.0.0.1", done));
const [web, engine, collab] = sockets.map(socket => socket.address().port);
await Promise.all(sockets.map(socket => new Promise(done => socket.close(done))));
const base = `http://127.0.0.1:${web}`;

function environment(kind) {
  const env = { ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: password };
  for (const key of ["FOLDLY_DATABASE_URL", "FOLDLY_DATABASE_URL_FILE", "FOLDLY_DATABASE_URL_CA_FILE",
    "FOLDLY_TEST_POSTGRES_URL_FILE", "FOLDLY_TEST_MYSQL_URL_FILE"]) delete env[key];
  if (urls[kind]) env.FOLDLY_DATABASE_URL_FILE = resolve(urls[kind]);
  return env;
}

function command(kind, args, expected = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: environment(kind), encoding: "utf8", timeout: 120_000,
  });
  assert.equal(result.status, expected, result.stderr || result.error?.message);
  return result;
}

async function start(kind, root) {
  serviceLog = "";
  worker = spawn(process.execPath, [cli, "start", "--root", root, "--assets", assets],
    { env: environment(kind), stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", data => { serviceLog += data; });
  worker.stderr.on("data", data => { serviceLog += data; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (worker.exitCode !== null) break;
    const ready = await fetch(base + api + "/status", { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (ready?.ok) { await ready.body.cancel(); return; }
    await delay(100);
  }
  throw new Error(`${kind} did not become ready.\n${serviceLog}`);
}

async function stop() {
  if (worker?.exitCode === null && worker.signalCode === null) {
    const exit = once(worker, "exit");
    worker.kill("SIGTERM");
    await exit;
  }
}

async function request(path, { account, token, method = "GET", data, bytes, extra, status = 200 } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: base,
      ...(account && { Cookie: account.cookie, "X-Workspace-CSRF": account.csrf || "" }),
      ...(token && { Authorization: "Bearer " + token }),
      ...(data !== undefined && { "Content-Type": "application/json" }),
      ...(bytes && { "Content-Type": "application/octet-stream" }), ...extra,
    },
    body: bytes || (data === undefined ? undefined : JSON.stringify(data)),
    signal: AbortSignal.timeout(80_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${path} => ${body.toString().slice(0, 300)}`);
  return {
    value: response.headers.get("content-type")?.includes("json") && body.length ? JSON.parse(body.toString()) : body,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

async function login(username, status = 200, secret = password) {
  const { value, cookie } = await request(api + "/login", { method: "POST", data: { username, password: secret }, status });
  return { ...value, cookie };
}

async function launch(account, file) {
  return (await request(`${api}/files/${file.id}/editor-session`, {
    account, method: "POST", data: { sessionId: randomUUID() },
  })).value;
}

async function editAndPublish(account, file, before, after, expectedVersion) {
  const access = await launch(account, file);
  const path = "/v1/documents/" + access.documentId;
  const auth = { account, token: access.token };
  const search = await request(`${path}/search?q=${encodeURIComponent(before)}`, auth);
  assert.equal(search.value.hits.length, 1);
  const nodeId = search.value.hits[0].nodeId;
  const node = (await request(`${path}/nodes/${nodeId}`, auth)).value;
  const revision = (await request(path, auth)).value.revision;
  const epoch = async () => ({ "X-HCD-Collaboration-Epoch": String((await request(path + "/auth", auth)).value.collaborationEpoch) });
  const edited = (await request(path + "/node-patch", { ...auth, method: "POST", extra: await epoch(), data: {
    schemaVersion: "hcd-patch/1", documentId: access.documentId, patchId: randomUUID(), baseRevision: revision,
    operations: [{ op: "text.splice", nodeId, start: 0, deleteCount: [...node.text].length, insertText: after,
      precondition: { nodeHash: node.nodeHash } }],
  } })).value;
  const publication = { publicationId: randomUUID(), expectedRevision: edited.revision, exportMode: "source-backed" };
  const publish = async () => (await request(path + "/publications", {
    ...auth, method: "POST", extra: await epoch(), data: publication,
  })).value;
  const result = await publish();
  assert.equal(result.state, "committed");
  assert.equal(result.receipt.externalVersion, expectedVersion);
  assert.deepEqual((await publish()).receipt, result.receipt);

  const exported = (await request(path + "/export/docx?source=true", auth)).value;
  const filePath = join(scratch, "export-" + expectedVersion + ".docx");
  writeFileSync(filePath, exported);
  assert(execFileSync(join(assets, "officecli"), ["view", filePath, "text"], { encoding: "utf8" }).includes(after));
  return result.receipt;
}

try {
  let kind = "sqlite";
  let root = join(scratch, "source");
  command(kind, ["init", "--root", root, "--public-url", base, "--engine-port", String(engine), "--collab-port", String(collab), "--selection-mcp"]);
  await start(kind, root);
  const admin = await login("admin");
  await login("admin", 401, "incorrect-password-for-throttle");
  const member = (await request(api + "/users", { account: admin, method: "POST", status: 201,
    data: { username: "member", password, displayName: "项目成员", role: "member" } })).value.user;
  const peer = await login("member");
  const { project } = (await request(api + "/projects", { account: admin, method: "POST", status: 201, data: { name: "迁移项目" } })).value;
  const projectPath = api + "/projects/" + project.id;
  const folder = async (name, parentId, status = 201) => (await request(projectPath + "/folders", {
    account: admin, method: "POST", data: { name, parentId }, status,
  })).value.folder;
  const parent = await folder("Alpha", null);
  await folder("alpha", null, 409);
  const child = await folder("子目录", parent.id);
  await folder("É", null);
  await folder("é", null);
  await request(`${projectPath}/members/${member.id}`, { account: admin, method: "PUT", status: 204, data: { role: "viewer" } });

  const previous = "待迁移的原始文档 𠮷";
  const fixture = join(scratch, "fixture.docx");
  const binary = join(assets, "officecli");
  execFileSync(binary, ["create", fixture, "--locale", "zh-CN"]);
  execFileSync(binary, ["add", fixture, "/body", "--type", "paragraph", "--prop", "text=" + previous]);
  const original = readFileSync(fixture);
  const params = new URLSearchParams({ filename: "迁移样例.docx", projectId: project.id, folderId: child.id });
  const { file } = (await request(api + "/files?" + params, {
    account: admin, method: "POST", bytes: original, status: 201,
  })).value;
  // More rows than one transfer batch in the files, versions and audit tables.
  for (let index = 0; index < 66; index++) {
    await request(api + "/files", { account: admin, method: "POST", status: 201,
      data: { name: `迁移资料 ${index}.txt`, projectId: project.id, folderId: child.id } });
  }
  const filePath = api + "/files/" + file.id;
  await request(filePath + "/acl", { account: admin, method: "PUT", status: 204,
    data: { userId: member.id, profile: "editor", operations: ["document.view","document.edit"] } });
  const { sharing } = (await request(filePath + "/sharing", { account: admin, method: "PUT",
    data: { visibility: "link", permission: "write", expiresAt: null } })).value;
  const shareSecret = new URL(sharing.url).hash.slice(1);
  const guest = await request(`${api}/shared/${file.id}/open`, { method: "POST",
    data: { sessionId: randomUUID() }, extra: { "X-Workspace-Share": shareSecret } });
  const launchId = randomUUID();
  const { value: editor } = await request(filePath + "/editor-session", {
    account: admin, method: "POST", data: { sessionId: launchId },
  });
  const editorPath = "/v1/documents/" + editor.documentId;
  const requestAuth = { account: admin, token: editor.token };
  const { value: document } = await request(editorPath, requestAuth);
  const { value: auth } = await request(editorPath + "/auth", requestAuth);
  const { value: selection } = await request(api + "/embed/selection", {
    account: admin, method: "PUT", data: {
      fileId: file.id, launchId, generation: 1, instanceId: randomUUID(),
      selection: {
        documentId: editor.documentId, revision: document.revision, collaborationEpoch: auth.collaborationEpoch,
        target: { kind: "append" },
      },
    },
  });
  const { value: pendingJob } = await request(api + "/agent-jobs", { account: admin, method: "POST", status: 201,
    data: { id: randomUUID(), prompt: "追加：待人工核对的补充内容。", tokens: [selection.token] },
  });
  assert.equal(pendingJob.targets[0].phase, "review");

  let text = previous;
  let version = 1;
  for (const next of ["postgres", "mysql", "sqlite"]) {
    const backup = join(scratch, "snapshot-" + kind);
    command(kind, ["backup", "--root", root, "--output", backup]);
    command(kind, ["verify-backup", "--backup", backup]);
    await stop();
    const target = join(scratch, "restored-" + next);
    const restore = ["restore", "--root", target, "--backup", backup, "--database", next];
    command(next, restore);
    root = target;
    kind = next;
    assert.equal(existsSync(join(root, "business.sqlite")), kind === "sqlite");
    if (kind !== "sqlite") {
      const occupied = join(scratch, "occupied-" + kind);
      const denied = command(kind, ["restore", "--root", occupied, "--backup", backup, "--database", kind], 1);
      assert.match(denied.stderr, /目标数据库/);
      assert(!existsSync(occupied));
    }
    await start(kind, root);
    if (kind !== "sqlite") {
      const duplicate = command(kind, ["start", "--root", root, "--assets", assets], 1);
      assert.match(duplicate.stderr, /已有运行中的工作区/);
    }
    const { value: session } = await request(api + "/session", { account: admin });
    assert.equal(session.user.id, admin.user.id);
    const { value: service } = await request(api + "/service", { account: admin });
    assert(service.storage.business.startsWith({ sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL" }[kind]));
    const { value: details } = await request(projectPath, { account: peer });
    assert.equal(details.project.role, "viewer");
    assert(details.folders.some(item => item.id === child.id && item.parentId === parent.id));
    assert.equal(details.folders.length, 4);
    const { value: visible } = await request(filePath, { account: peer });
    assert(visible.file.operations.includes("document.edit"));
    assert.equal(visible.file.location.folderId, child.id);
    const { value: library } = await request(api + "/files", { account: peer });
    assert.equal(library.files.length, 67);
    const { value: jobs } = await request(api + "/agent-jobs", { account: admin });
    assert.deepEqual(jobs.jobs.find(job => job.id === pendingJob.id), pendingJob);
    const { value: people } = await request(filePath + "/mentionable", { account: admin });
    assert(people.people.some(item => item.id === member.id));
    const { value: source } = await request(filePath + "/download?version=v1", { account: admin });
    assert.deepEqual(source, original);
    const rejoined = await request(`${api}/shared/${file.id}/open`, { method: "POST",
      account: { cookie: guest.cookie }, data: { sessionId: randomUUID() }, extra: { "X-Workspace-Share": shareSecret } });
    assert.equal(rejoined.value.actor.id, guest.value.actor.id);
    const nextText = `在 ${kind} 保存发布的版本 ${++version} 𠮷`;
    await editAndPublish(admin, file, text, nextText, "v" + version);
    text = nextText;
    const { value: versions } = await request(filePath + "/versions", { account: admin });
    assert.equal(versions.versions.length, version);
    const { value: audit } = await request(api + "/audit", { account: admin });
    assert(audit.records.length > 64);
    assert(audit.records.every((row, index) => Number.isSafeInteger(row.id) &&
      (!index || audit.records[index - 1].id > row.id)));
    checks.push(`${kind} restored sessions, folders, direct ACL, guest identity, original bytes, history and the pending workbench review. Edited, exported and published v${version} once.`);
  }
  await request(filePath + "/sharing", { account: admin, method: "PUT",
    data: { visibility: "private", permission: "read" } });
  await request(`${api}/shared/${file.id}/open`, { method: "POST", account: { cookie: guest.cookie },
    data: { sessionId: randomUUID() }, extra: { "X-Workspace-Share": shareSecret }, status: 404 });
  const result = { status: "passed", path: "SQLite → PostgreSQL → MySQL → SQLite", checks };
  if (process.env.FOLDLY_DATABASE_ARTIFACTS) {
    const artifacts = resolve(process.env.FOLDLY_DATABASE_ARTIFACTS);
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "validation.json"), JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Details in ${scratch}\n${serviceLog}`);
  throw error;
} finally {
  await stop();
}
