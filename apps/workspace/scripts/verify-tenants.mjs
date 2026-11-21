import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const app = resolve(import.meta.dirname, "..");
const { chromium, expect } = await import(
  join(app, "../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs")
);
const sandbox = mkdtempSync(join(tmpdir(), "officecli-tenant-"));
const artifacts = resolve(process.env.OFFICECLI_TENANT_ARTIFACTS || join(sandbox, "evidence"));
mkdirSync(artifacts, { recursive: true });
const bind = process.env.OFFICECLI_TENANT_TEST_HOST || "127.0.0.1";
const ip = bind.includes(":") ? "[" + bind + "]" : bind;
const checks = [];
const log = createWriteStream(join(sandbox, "services.log"), { mode: 0o600 });
const registry = join(sandbox, "tenants.json");
const cli = join(app, "cli.mjs");
const distribution = resolve(process.env.OFFICECLI_WORKSPACE_DIST || join(app, "dist"));
const observedSidecar = join(sandbox, "sidecar.cjs");
// Run the packaged sidecar and record its own process ID in the private fixture.
writeFileSync(
  observedSidecar,
  [
    'require("node:fs").writeFileSync(require("node:path").join(__dirname, "pid-" + process.env.HCD_COLLAB_PORT), String(process.pid));',
    "require(" + JSON.stringify(join(distribution, "sidecar.cjs")) + ");",
  ].join("\n"),
);
let supervisor, exit, browser, model;
const listen = async (s) => {
  s.listen(0, bind);
  await once(s, "listening");
  return s.address().port;
};
const listeners = Array.from({ length: 7 }, () => createServer());
const ports = await Promise.all(listeners.map(listen));
await Promise.all(listeners.map((s) => new Promise((done) => s.close(done))));
const [publicPort, ...internalPorts] = ports;
const teams = ["studio", "press"].map((id, i) => ({
  id,
  name: ["山岚设计室", "白露编辑部"][i],
  origin: "http://" + id + ".localhost:" + publicPort,
  password: randomBytes(24).toString("base64url"),
  ports: internalPorts.slice(i * 3, i * 3 + 3),
}));

// Connect locally while retaining the same origin and Host a customer's browser uses.
function call(team, path, { account, token, method = "GET", data, bytes, headers = {} } = {}) {
  const origin = new URL(team.origin);
  return new Promise((done, fail) => {
    const req = request(
      {
        hostname: bind,
        port: publicPort,
        path,
        method,
        headers: {
          Host: origin.host,
          Origin: origin.origin,
          ...(account ? { Cookie: account.cookie, "X-Workspace-CSRF": account.csrf } : {}),
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", fail);
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let value = raw;
          try {
            value = JSON.parse(raw);
          } catch {}
          done({
            status: res.statusCode,
            value,
            cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
          });
        });
      },
    );
    req.on("error", fail);
    req.end(data === undefined ? bytes : JSON.stringify(data));
  });
}
function success(result, status = 200) {
  assert.equal(result.status, status, result.value?.error);
  return result.value;
}
async function poll(read, ms = 60_000) {
  let last;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const answer = await read();
      if (answer) return answer;
    } catch (error) {
      last = error;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw last || new Error("等待工作空间超时");
}
async function start() {
  supervisor = spawn(
    process.execPath,
    [
      cli,
      "start",
      "--tenants",
      registry,
      "--port",
      String(publicPort),
      "--bind-host",
      bind,
      "--assets",
      distribution,
      "--sidecar-script",
      observedSidecar,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OFFICECLI_AI_ENABLED: "true",
        OPENAI_API_KEY: "local-test-only",
        HCD_OPENAI_MODEL: "tenant-test",
        HCD_OPENAI_BASE_URL: "http://" + ip + ":" + model.address().port + "/v1",
      },
    },
  );
  exit = once(supervisor, "exit");
  supervisor.stdout.pipe(log, { end: false });
  supervisor.stderr.pipe(log, { end: false });
  for (const team of teams)
    await poll(async () => success(await call(team, "/workspace/api/status")).name === team.name);
}
async function stop() {
  if (!supervisor) return;
  supervisor.kill("SIGTERM");
  await exit;
  supervisor = null;
}
function engine(team, path, options = {}) {
  return call(team, "/v1/documents/" + team.boardSession.documentId + path, {
    account: team.account,
    token: team.boardSession.token,
    ...options,
  });
}
try {
  // A local read-only model response is sufficient to exercise the real durable Agent runner.
  let modelCalls = 0;
  model = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    modelCalls++;
    const documentId = body.input[0].content.match(/Document ID: ([^\n]+)/)?.[1];
    const output = body.input.some((x) => x.type === "function_call_output")
      ? [{ type: "message", content: [{ type: "output_text", text: "已读取当前工作区的白板。" }] }]
      : [
          {
            type: "function_call",
            call_id: randomUUID(),
            name: "hcd_read",
            arguments: JSON.stringify({ document_id: documentId, resource: "canvas" }),
          },
        ];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "completed", output }));
  });
  await listen(model);
  for (const team of teams) {
    const [web, enginePort, collab] = team.ports;
    const init = spawnSync(
      process.execPath,
      [
        cli,
        "init",
        "--root",
        join(sandbox, team.id),
        "--name",
        team.name,
        "--tenant-id",
        team.id,
        "--app-id",
        "office",
        "--public-url",
        team.origin,
        "--bind-host",
        bind,
        "--port",
        String(web),
        "--engine-port",
        String(enginePort),
        "--collab-port",
        String(collab),
      ],
      { env: { ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: team.password }, encoding: "utf8" },
    );
    assert.equal(init.status, 0, init.stderr);
  }
  writeFileSync(
    registry,
    JSON.stringify({ workspaces: teams.map((t, i) => ({ root: t.id, ai: i === 0 })) }),
  );
  await start();
  const [alpha, beta] = teams;
  assert.equal(
    (await call({ origin: "http://unknown.localhost:" + publicPort }, "/workspace/api/status"))
      .status,
    421,
  );
  const commonSession = randomUUID();
  for (const team of teams) {
    const login = await call(team, "/workspace/api/login", {
      method: "POST",
      data: { username: "admin", password: team.password },
    });
    const signedIn = success(login);
    team.account = { cookie: login.cookie, csrf: signedIn.csrf };
    assert.equal(signedIn.workspace.tenantId, team.id);
    assert.equal(signedIn.workspace.aiEnabled, team === alpha);
    team.doc = success(
      await call(team, "/workspace/api/files?filename=brief.txt", {
        account: team.account,
        method: "POST",
        bytes: team.name + "的原始文档。",
        headers: { "Content-Type": "application/octet-stream" },
      }),
      201,
    ).file;
    team.board = success(
      await call(team, "/workspace/api/files", {
        account: team.account,
        method: "POST",
        data: { name: "ideas.excalidraw" },
      }),
      201,
    ).file;
    team.boardSession = success(
      await call(team, "/workspace/api/files/" + team.board.id + "/editor-session", {
        account: team.account,
        method: "POST",
        data: { sessionId: commonSession },
      }),
    );
    team.auth = success(await engine(team, "/auth"));
    assert.equal(team.auth.operations.includes("document.ai"), team === alpha);
    success(
      await engine(team, "/canvas/patch", {
        method: "POST",
        headers: { "X-HCD-Collaboration-Epoch": String(team.auth.collaborationEpoch) },
        data: {
          schemaVersion: "officecli-canvas/1",
          documentId: team.boardSession.documentId,
          patchId: randomUUID(),
          baseRevision: 0,
          operations: [
            {
              op: "element.add",
              element: {
                id: "shared-label",
                type: "text",
                x: 65,
                y: 70,
                width: 180,
                height: 28,
                text: team.name,
                fontSize: 20,
                fontFamily: 5,
                lineHeight: 1.25,
              },
            },
          ],
        },
      }),
    );
  }
  assert.notEqual(alpha.boardSession.documentId, beta.boardSession.documentId);
  for (const [team, other] of [
    [alpha, beta],
    [beta, alpha],
  ]) {
    const list = success(await call(team, "/workspace/api/files", { account: team.account })).files;
    assert.deepEqual(new Set(list.map((f) => f.id)), new Set([team.doc.id, team.board.id]));
    assert.equal(
      (await call(team, "/workspace/api/files/" + other.doc.id, { account: team.account })).status,
      404,
    );
    assert.equal(
      (await call(team, "/workspace/api/session", { account: other.account })).status,
      401,
    );
    assert.equal(
      success(
        await call(team, "/workspace/api/files/" + team.doc.id + "/download", {
          account: team.account,
        }),
      ),
      team.name + "的原始文档。",
    );
    const wrong = await engine(team, "/auth", { token: other.boardSession.token });
    assert([401, 403].includes(wrong.status));
    assert.equal(success(await engine(team, "/canvas")).scene.elements[0].text, team.name);
  }
  checks.push("同名文档、同名白板、相同画布对象 ID 和编辑会话 ID 分别绑定各自的租户");
  const task = {
    task: "读取选中的文字并概括，不修改画布。",
    target: {
      canvas: { elementIds: ["shared-label"], region: { x: 0, y: 0, width: 300, height: 200 } },
    },
  };
  const run = success(await engine(alpha, "/agent-runs", { method: "POST", data: task }), 202);
  await poll(async () => {
    const status = success(await engine(alpha, "/agent-runs/" + run.runId));
    assert.notEqual(status.status, "failed");
    return status.status === "completed";
  });
  assert(modelCalls > 0);
  const callsBefore = modelCalls;
  assert(
    [403, 503].includes((await engine(beta, "/agent-runs", { method: "POST", data: task })).status),
  );
  assert([403, 404, 503].includes((await engine(beta, "/agent-runs/" + run.runId)).status));
  assert.equal(modelCalls, callsBefore);
  checks.push("真实 AI 任务使用本地测试模型，只在启用它的租户执行和查询");
  const share = success(
    await call(alpha, "/workspace/api/files/" + alpha.board.id + "/sharing", {
      account: alpha.account,
      method: "PUT",
      data: { visibility: "link", permission: "read", expiresAt: null },
    }),
  ).sharing;
  assert.equal(new URL(share.url).origin, alpha.origin);
  success(
    await call(beta, "/workspace/api/files/" + beta.board.id + "/sharing", {
      account: beta.account,
      method: "PUT",
      data: { visibility: "public", permission: "read", expiresAt: null },
    }),
  );
  assert.deepEqual(success(await call(alpha, "/workspace/api/public/files")).files, []);
  assert.deepEqual(
    success(await call(beta, "/workspace/api/public/files")).files.map((f) => f.id),
    [beta.board.id],
  );
  assert.equal(
    (
      await call(beta, "/workspace/api/shared/" + alpha.board.id + "/open", {
        method: "POST",
        data: { sessionId: randomUUID() },
      })
    ).status,
    404,
  );
  checks.push("分享链接使用所属工作区域名，公开目录和访客授权独立");

  browser = await chromium.launch({
    ...(process.env.HCD_BROWSER_PATH ? { executablePath: process.env.HCD_BROWSER_PATH } : {}),
    args: ["--no-proxy-server", "--host-resolver-rules=MAP *.localhost " + ip],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  for (const team of teams) {
    const page = await context.newPage();
    team.page = page;
    await page.goto(team.origin + "/#/integration");
    await page.getByLabel("账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(team.password);
    await page.getByRole("button", { name: "登录工作空间", exact: true }).click();
    const info = page.getByRole("region", { name: "当前工作区接入信息" });
    await expect(info).toContainText(team.id);
    await expect(info).toContainText(team === alpha ? "已启用" : "已关闭");
    if (team === alpha) await page.screenshot({ path: join(artifacts, "tenant-integration.png") });
    await page.goto(team.origin + "/editor/?workspaceFile=" + team.doc.id);
    await expect(page.locator('.tiptap[contenteditable="true"]')).toContainText(team.name, {
      timeout: 60000,
    });
  }
  const mirror = await context.newPage();
  await mirror.goto(alpha.origin + "/editor/?workspaceFile=" + alpha.doc.id);
  await expect(mirror.locator('.tiptap[contenteditable="true"]')).toContainText(alpha.name, {
    timeout: 60000,
  });
  const docEditor = alpha.page.locator('.tiptap[contenteditable="true"]');
  await docEditor.click();
  await alpha.page.keyboard.press("ControlOrMeta+End");
  await alpha.page.keyboard.press("Enter");
  await alpha.page.keyboard.insertText("独立工作区内的协同记录");
  await expect(mirror.locator(".tiptap")).toContainText("独立工作区内的协同记录", {
    timeout: 30000,
  });
  await expect(beta.page.locator(".tiptap")).not.toContainText("独立工作区内的协同记录");
  const guest = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const shared = await guest.newPage();
  await shared.goto(share.url);
  await expect(shared.locator(".canvas-workspace")).toBeVisible({ timeout: 60000 });
  checks.push("同一浏览器分别登录两个工作区，文档通过 WebSocket 协同，访客能打开所属白板");
  success(
    await call(beta, "/workspace/api/files/" + beta.doc.id + "/sharing", {
      account: beta.account,
      method: "PUT",
      data: { visibility: "public", permission: "write", expiresAt: null },
    }),
  );
  await shared.goto(beta.origin + "/public");
  const documents = shared.getByRole("region", { name: "文档", exact: true });
  const boards = shared.getByRole("region", { name: "白板", exact: true });
  await expect(
    documents.getByRole("link", { name: /brief.txt.*访客可编辑.*打开文档/ }),
  ).toBeVisible();
  const openBoard = boards.getByRole("link", { name: /ideas.excalidraw.*访客只读.*打开白板/ });
  await expect(openBoard).toBeVisible();
  await shared.screenshot({ path: join(artifacts, "public-library.png") });
  const search = shared.getByRole("searchbox", { name: "搜索公开文件" });
  await search.fill("IDEAS");
  await expect(documents.getByRole("link")).toHaveCount(0);
  await expect(openBoard).toBeVisible();
  await search.fill("");
  await expect(documents.getByRole("link")).toHaveCount(1);
  await openBoard.click();
  await expect(shared.locator(".canvas-workspace")).toBeVisible({ timeout: 60000 });
  checks.push("访客文件库并列展示文档与白板，支持跨类型搜索，分别显示真实分享权限并进入对应编辑器");
  const archive = join(sandbox, "studio-backup");
  const backedUp = spawnSync(process.execPath, [cli, "backup", "--root", join(sandbox, alpha.id), "--output", archive], { encoding: "utf8" });
  assert.equal(backedUp.status, 0, backedUp.stderr);
  const manifest = JSON.parse(readFileSync(join(archive, "snapshot.json"), "utf8"));
  assert.equal(manifest.tenantId, alpha.id);
  assert(manifest.files.some(item => item.path.startsWith(`engine/${alpha.boardSession.documentId}.hcd/`)));
  assert(!manifest.files.some(item => item.path.startsWith(`engine/${beta.boardSession.documentId}.hcd/`)));
  const archived = new DatabaseSync(join(archive, "business.sqlite"), { readOnly: true });
  try { assert.deepEqual(new Set(archived.prepare("SELECT id FROM files").all().map(row => row.id)), new Set([alpha.doc.id, alpha.board.id])); }
  finally { archived.close(); }
  assert.equal(success(await engine(beta, "/canvas")).scene.elements[0].text, beta.name);
  checks.push("通过本机命令备份指定租户，业务库和可编辑白板只包含该租户，另一工作区继续提供服务");
  await browser.close();
  browser = null;
  const pidFile = join(sandbox, "pid-" + alpha.ports[2]);
  const sidecarPid = Number(readFileSync(pidFile, "utf8"));
  assert(Number.isSafeInteger(sidecarPid) && sidecarPid > 1);
  process.kill(sidecarPid, "SIGTERM");
  await poll(async () => (await call(alpha, "/workspace/api/status")).status === 503);
  assert.equal(success(await engine(beta, "/canvas")).scene.elements[0].text, beta.name);
  checks.push("一个工作区的协作进程退出后，该域名返回暂不可用，另一个工作区仍能读取白板");
  await stop();
  await start();
  for (const team of teams) {
    assert.equal(
      success(await call(team, "/workspace/api/session", { account: team.account })).workspace
        .tenantId,
      team.id,
    );
    assert.equal(success(await engine(team, "/canvas")).scene.elements[0].text, team.name);
  }
  checks.push("重启共享入口后租户身份、登录会话和画布内容保持一致");
  writeFileSync(
    join(artifacts, "validation.json"),
    JSON.stringify({ status: "passed", checks }, null, 2) + "\n",
  );
  console.log(checks.map((x) => "PASS " + x).join("\n"));
  console.log("验收资料", artifacts);
} catch (error) {
  writeFileSync(
    join(artifacts, "validation.json"),
    JSON.stringify({ status: "failed", checks }, null, 2) + "\n",
  );
  console.error("验收工作目录", sandbox);
  throw error;
} finally {
  await browser?.close();
  await stop();
  model?.close();
  log.end();
}
