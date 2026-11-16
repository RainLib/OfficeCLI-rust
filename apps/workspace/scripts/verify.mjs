import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  createWriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

const app = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  repo = resolve(app, "../.."),
  root = mkdtempSync(join(tmpdir(), "officecli-workspace-"));
const artifacts = resolve(
  process.env.OFFICECLI_WORKSPACE_ARTIFACTS ||
    join(repo, "docs/acceptance/hcd-default-workspace-v1"),
);
mkdirSync(artifacts, { recursive: true });
const log = createWriteStream(join(root, "services.log"), { mode: 0o600 }),
  checks = [];
writeFileSync(
  join(artifacts, "validation.json"),
  JSON.stringify(
    { status: "running", scope: "default-workspace-phase-b" },
    null,
    2,
  ) + "\n",
);
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const p = await port(),
  ep = await port(),
  cp = await port(),
  base = `http://127.0.0.1:${p}`;
const password = randomBytes(24).toString("base64url"),
  memberPassword = randomBytes(24).toString("base64url");
const init = spawnSync(
  process.execPath,
  [
    join(app, "cli.mjs"),
    "init",
    "--root",
    root,
    "--public-url",
    base,
    "--engine-port",
    String(ep),
    "--collab-port",
    String(cp),
  ],
  {
    env: { ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: password },
    encoding: "utf8",
  },
);
assert.equal(init.status, 0, init.stderr);
const another = spawnSync(
  process.execPath,
  [join(app, "cli.mjs"), "init", "--root", root],
  {
    env: { ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: password },
    encoding: "utf8",
  },
);
assert.notEqual(another.status, 0);
checks.push(
  "explicit bootstrap and repeated init never overwrite existing accounts or signing identity",
);
let supervisor, browser;
async function poll(check, timeout = 45000) {
  let last;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await check();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw last || new Error("acceptance timed out");
}
async function start() {
  supervisor = spawn(
    process.execPath,
    [join(app, "cli.mjs"), "start", "--root", root],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  supervisor.stdout.pipe(log, { end: false });
  supervisor.stderr.pipe(log, { end: false });
  await poll(async () => {
    const health = await fetch(`http://127.0.0.1:${ep}/health`);
    return health.ok;
  });
  await poll(async () => (await fetch(base)).ok);
}
async function stop() {
  if (
    supervisor &&
    supervisor.exitCode === null &&
    supervisor.signalCode === null
  ) {
    const ended = once(supervisor, "exit");
    supervisor.kill("SIGTERM");
    await ended;
  }
}
async function call(
  path,
  { account, token, method = "GET", data, bytes, headers = {} } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(account
        ? { Cookie: account.cookie, "X-Workspace-CSRF": account.csrf }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Origin: base,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(data !== undefined
      ? { body: JSON.stringify(data) }
      : bytes
        ? { body: bytes }
        : {}),
  });
  const content = await response.text();
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    value = content;
  }
  return {
    status: response.status,
    value,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
    setCookie: response.headers.get("set-cookie"),
  };
}
async function login(username, pass) {
  const result = await call("/workspace/api/login", {
    method: "POST",
    data: { username, password: pass },
  });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.match(result.setCookie, /HttpOnly/);
  assert.match(result.setCookie, /SameSite=Strict/);
  return { ...result.value, cookie: result.cookie };
}
async function launch(account, fileId, sessionId = randomUUID()) {
  const result = await call(`/workspace/api/files/${fileId}/editor-session`, {
    account,
    method: "POST",
    data: { sessionId },
  });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value;
}
const doc = (s, suffix = "") => `/v1/documents/${s.documentId}${suffix}`;
try {
  await start();
  assert.equal((await call("/workspace/api/files")).status, 401);
  assert.equal(
    (
      await call("/workspace/api/login", {
        method: "POST",
        data: { username: "admin", password: "wrong password" },
      })
    ).status,
    401,
  );
  const admin = await login("admin", password);
  assert.equal(
    (await call("/v1/admin/service", { account: admin })).value.agentAvailable,
    false,
  );
  assert(admin.cookie && !admin.cookie.includes(password));
  assert.equal(
    (
      await call("/workspace/api/files", {
        account: { ...admin, csrf: "" },
        method: "POST",
        data: { name: "blocked.txt" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/workspace/api/files", {
        account: admin,
        method: "POST",
        data: { name: "blocked.txt" },
        headers: { Origin: "https://unregistered.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/workspace/api/users/${admin.user.id}`, {
        account: admin,
        method: "PATCH",
        data: { disabled: true },
      })
    ).status,
    409,
  );
  checks.push(
    "HttpOnly login, CSRF/origin checks and last administrator protection",
  );
  const created = await call("/workspace/api/users", {
    account: admin,
    method: "POST",
    data: {
      username: "reader",
      displayName: "只读验收成员",
      password: memberPassword,
      role: "member",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  const readerId = created.value.user.id,
    reader = await login("reader", memberPassword);
  const original = Buffer.from(
    "Original production workspace file.\n\nImmutable source baseline.\n",
  );
  const uploaded = await call("/workspace/api/files?filename=workspace.txt", {
    account: admin,
    method: "POST",
    bytes: original,
    headers: { "Content-Type": "application/octet-stream" },
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.value));
  const fileId = uploaded.value.file.id;
  assert.equal(
    (await call("/workspace/api/files", { account: reader })).value.files
      .length,
    0,
  );
  assert.equal(
    (await call("/v1/catalog/fonts", { account: reader })).status,
    403,
  );
  assert.equal(
    (
      await call("/officecli-provider/v1/sessions/resolve", {
        method: "POST",
        data: {},
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call(`/workspace/api/files/${fileId}/editor-session`, {
        account: reader,
        method: "POST",
        data: { sessionId: randomUUID() },
      })
    ).status,
    403,
  );
  checks.push(
    "private files and global administration stay isolated from ungranted members",
  );
  const grant = await call(`/workspace/api/files/${fileId}/acl`, {
    account: admin,
    method: "PUT",
    data: {
      userId: readerId,
      profile: "viewer",
      operations: ["document.view"],
    },
  });
  assert.equal(grant.status, 204, JSON.stringify(grant.value));
  const ownerSession = await launch(admin, fileId),
    readSession = await launch(reader, fileId);
  const duplicate = await launch(admin, fileId, ownerSession.sessionId);
  assert.equal(duplicate.token, ownerSession.token);
  assert.equal(
    (
      await call(`/workspace/api/files/${fileId}/editor-session`, {
        account: reader,
        method: "POST",
        data: { sessionId: ownerSession.sessionId },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(doc(readSession, "/auth"), {
        account: reader,
        token: readSession.token,
      })
    ).value.scope,
    "read",
  );
  for (const suffix of ["/revisions", "/export/txt"])
    assert.equal(
      (
        await call(doc(readSession, suffix), {
          account: reader,
          token: readSession.token,
        })
      ).status,
      403,
    );
  assert.equal(
    (await call(`/workspace/api/files/${fileId}/download`, { account: reader }))
      .status,
    403,
  );
  checks.push(
    "same Provider enforces per-operation ACL and durable idempotent document session exchanges",
  );
  const auth = (
    await call(doc(ownerSession, "/auth"), {
      account: admin,
      token: ownerSession.token,
    })
  ).value;
  const manifest = (
    await call(doc(ownerSession), { account: admin, token: ownerSession.token })
  ).value;
  const found = (
    await call(doc(ownerSession, "/search?q=Original"), {
      account: admin,
      token: ownerSession.token,
    })
  ).value.hits[0];
  const node = (
    await call(doc(ownerSession, `/nodes/${found.nodeId}`), {
      account: admin,
      token: ownerSession.token,
    })
  ).value;
  const patch = await call(doc(ownerSession, "/node-patch"), {
    account: admin,
    token: ownerSession.token,
    method: "POST",
    headers: { "X-HCD-Collaboration-Epoch": String(auth.collaborationEpoch) },
    data: {
      schemaVersion: "hcd-patch/1",
      documentId: ownerSession.documentId,
      patchId: randomUUID(),
      baseRevision: manifest.revision,
      operations: [
        {
          op: "text.splice",
          nodeId: found.nodeId,
          start: 0,
          deleteCount: [...node.text].length,
          insertText: "Changed by the default Workspace.",
          precondition: { nodeHash: node.nodeHash },
        },
      ],
    },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.value));
  const revision = (
      await call(doc(ownerSession), {
        account: admin,
        token: ownerSession.token,
      })
    ).value.revision,
    publicationId = randomUUID();
  const publish = async () => {
    const currentAuth = (
      await call(doc(ownerSession, "/auth"), {
        account: admin,
        token: ownerSession.token,
      })
    ).value;
    return call(doc(ownerSession, "/publications"), {
      account: admin,
      token: ownerSession.token,
      method: "POST",
      headers: {
        "X-HCD-Collaboration-Epoch": String(currentAuth.collaborationEpoch),
      },
      data: {
        publicationId,
        expectedRevision: revision,
        exportMode: "source-backed",
      },
    });
  };
  const committed = await publish();
  assert.equal(committed.status, 200, JSON.stringify(committed.value));
  assert.equal(committed.value.state, "committed");
  assert.deepEqual((await publish()).value.receipt, committed.value.receipt);
  assert.equal(
    (await call(`/workspace/api/files/${fileId}/versions`, { account: admin }))
      .value.versions.length,
    2,
  );
  assert.equal(
    (
      await call(`/workspace/api/files/${fileId}/download?version=v1`, {
        account: admin,
      })
    ).value,
    original.toString(),
  );
  assert(
    (
      await call(`/workspace/api/files/${fileId}/download?version=v2`, {
        account: admin,
      })
    ).value.includes("Changed by the default Workspace."),
  );
  checks.push(
    "real HCD patch, immutable source, CAS business versions and repeated commit return one durable receipt",
  );
  await call("/workspace/api/logout", {
    account: reader,
    method: "POST",
    data: {},
  });
  assert.equal(
    (
      await call(doc(readSession, "/auth"), {
        account: admin,
        token: readSession.token,
      })
    ).status,
    403,
  );
  checks.push(
    "logout revokes previously issued document JWTs through live business authorization",
  );
  await poll(
    async () =>
      (
        await call("/workspace/api/events", { account: admin })
      ).value.events.some((event) => event.id === publicationId),
    20000,
  );
  await stop();
  await start();
  assert.equal(
    (await call("/workspace/api/session", { account: admin })).status,
    200,
  );
  assert.equal(
    (await call(`/workspace/api/files/${fileId}/versions`, { account: admin }))
      .value.versions.length,
    2,
  );
  assert.equal((await publish()).value.receipt.externalVersion, "v2");
  checks.push(
    "application restart preserves browser sessions, ACL, exact versions, receipts and deduplicated events",
  );
  const restoredAuth = (
    await call(doc(ownerSession, "/auth"), {
      account: admin,
      token: ownerSession.token,
    })
  ).value;
  const restored = await call(
    doc(ownerSession, `/restore/${manifest.revision}`),
    {
      account: admin,
      token: ownerSession.token,
      method: "POST",
      headers: {
        "X-HCD-Collaboration-Epoch": String(restoredAuth.collaborationEpoch),
      },
      data: { expectedRevision: revision },
    },
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  assert(restored.value.revision > revision);
  assert.equal(
    (await call(`/workspace/api/files/${fileId}`, { account: admin })).value
      .file.version,
    "v2",
  );
  checks.push(
    "history restore creates a new HCD revision without replacing a confirmed business version",
  );
  if (process.env.OFFICECLI_SKIP_BROWSER !== "1") {
    const { chromium } = await import(
      join(repo, "examples/hdoc/editor/node_modules/@playwright/test/index.mjs")
    );
    browser = await chromium.launch(
      process.env.HCD_BROWSER_PATH
        ? { executablePath: process.env.HCD_BROWSER_PATH }
        : {},
    );
    const context = await browser.newContext({
        viewport: { width: 1500, height: 1000 },
      }),
      blocked = [];
    const restrictNetwork = async (context) => {
      await context.route("**/*", (route) => {
        if (
          ["127.0.0.1", "localhost"].includes(
            new URL(route.request().url()).hostname,
          )
        )
          return route.continue();
        blocked.push(route.request().url());
        return route.abort();
      });
      await context.routeWebSocket("**/*", (route) => {
        if (["127.0.0.1", "localhost"].includes(new URL(route.url()).hostname))
          return route.connectToServer();
        blocked.push(route.url());
        route.close();
      });
    };
    await restrictNetwork(context);
    const page = await context.newPage();
    await page.goto(base);
    await page.getByLabel("账号", { exact: true }).fill("admin");
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "登录工作空间", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "文档管理", exact: true })
      .waitFor();
    assert.equal(
      await page.getByText("连接管理令牌", { exact: true }).count(),
      0,
    );
    await page.getByRole("link", { name: "用户与角色", exact: true }).click();
    await page.getByRole("button", { name: "添加用户", exact: true }).click();
    await page.getByLabel("用户账号", { exact: true }).fill("browser-member");
    await page.getByLabel("显示名称", { exact: true }).fill("浏览器成员");
    await page.getByLabel("初始密码", { exact: true }).fill(memberPassword);
    await page.getByRole("button", { name: "创建用户", exact: true }).click();
    await page.getByRole("row").filter({ hasText: "browser-member" }).waitFor();
    await page.screenshot({
      path: join(artifacts, "users-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "字体目录", exact: true }).click();
    await page.getByRole("button", { name: "上传登记", exact: true }).click();
    await page.getByLabel("fontId", { exact: true }).fill("workspace-emoji");
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
    await page.getByText("修订已登记", { exact: true }).waitFor();
    const font = (
      await call("/v1/catalog/fonts", { account: admin })
    ).value.find((item) => item.fontId === "workspace-emoji");
    await page.getByRole("button", { name: "去新建主题", exact: true }).click();
    await page
      .getByRole("button", { name: "新建主题", exact: true })
      .first()
      .click();
    await page.getByLabel("主题名", { exact: true }).fill("工作空间品牌主题");
    await page
      .locator("#major-latin")
      .selectOption(`workspace-emoji/${font.revisions[0].fontRevisionId}`);
    await page.getByRole("button", { name: "保存主题", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.screenshot({
      path: join(artifacts, "themes-desktop.png"),
      fullPage: true,
    });
    checks.push(
      "cookie session registers licensed local fonts and creates immutable themes without pasted tokens",
    );
    await page.getByRole("link", { name: "文档管理", exact: true }).click();
    await page.getByLabel("上传业务文件", { exact: true }).setInputFiles({
      name: "浏览器上传.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Browser upload without engine credentials."),
    });
    await page
      .getByRole("button", { name: "浏览器上传.txt", exact: false })
      .waitFor();
    await page.getByRole("button", { name: "新建文档", exact: true }).click();
    await page.getByLabel("文档名称", { exact: true }).fill("默认工作空间验收");
    await page.getByRole("button", { name: "创建文档", exact: true }).click();
    await page
      .getByRole("heading", { name: "默认工作空间验收.txt", exact: true })
      .waitFor();
    const browserFileId = page.url().split("documents/")[1];
    await page
      .getByLabel("文档字体主题", { exact: true })
      .selectOption({ label: "工作空间品牌主题" });
    await page.getByRole("button", { name: "应用主题", exact: true }).click();
    await page
      .getByText("文档主题已更新，请在编辑器检查并回写。", { exact: true })
      .waitFor();
    await page
      .getByLabel("授权成员", { exact: true })
      .selectOption({ label: "浏览器成员 · browser-member" });
    await page
      .getByRole("button", { name: "保存文件权限", exact: true })
      .click();
    await page
      .getByText("文件权限已更新，对已有编辑会话生效。", { exact: true })
      .waitFor();
    await page.screenshot({
      path: join(artifacts, "file-access-desktop.png"),
      fullPage: true,
    });
    const opened = context.waitForEvent("page");
    await page.getByRole("link", { name: "进入编辑器", exact: true }).click();
    const editor = await opened;
    // Install before the navigation that schedules renewal; existing native
    // timers are not controlled by Playwright's clock installation.
    await editor.clock.install();
    await editor.reload();
    await editor
      .locator('.tiptap[contenteditable="true"]')
      .waitFor({ timeout: 60000 });
    const editable = editor.locator('.tiptap[contenteditable="true"]').first();
    await editable.click();
    await editor.keyboard.press("ControlOrMeta+End");
    await editor.keyboard.press("Enter");
    await editor.keyboard.type(
      "Saved through the production default Workspace.",
    );
    await editor.locator(".host-publication>summary").click();
    await editor.getByLabel("回写方式").selectOption("semantic");
    await editor
      .getByRole("button", { name: "回写业务系统", exact: true })
      .click();
    await editor
      .locator('.host-publication[data-publication-state="committed"]')
      .waitFor({ timeout: 60000 });
    await editor.screenshot({
      path: join(artifacts, "editor-publication-desktop.png"),
      fullPage: true,
    });
    assert(
      (
        await call(`/workspace/api/files/${browserFileId}/download`, {
          account: admin,
        })
      ).value.includes("Saved through the production default Workspace."),
    );
    // Real renewal must retain the mounted editor, Y.Doc and unsaved text.
    await editor.locator(".host-publication>summary").click();
    await editable.click();
    await editor.keyboard.press("ControlOrMeta+End");
    await editor.keyboard.type(" Unsaved draft survives credential renewal.");
    await editor.evaluate(() => {
      document.querySelector(".tiptap").dataset.renewalProbe = "same-editor";
    });
    const db = new DatabaseSync(join(root, "business.sqlite"));
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    const row = db
      .prepare(
        "SELECT * FROM launches WHERE file_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(browserFileId);
    const expires = JSON.parse(row.response);
    expires.expiresAt = Math.floor(Date.now() / 1000) + 1;
    db.prepare("UPDATE launches SET response=? WHERE id=?").run(
      JSON.stringify(expires),
      row.id,
    );
    db.exec("COMMIT");
    db.close();
    await editor.clock.fastForward(211_000);
    await poll(() => {
      const db = new DatabaseSync(join(root, "business.sqlite"));
      try {
        return (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM exchanges WHERE session_id=?",
            )
            .get(row.id).count >= 2
        );
      } finally {
        db.close();
      }
    }, 30000);
    assert.equal(
      await editor.locator(".tiptap").getAttribute("data-renewal-probe"),
      "same-editor",
    );
    assert(
      (await editable.innerText()).includes(
        "Unsaved draft survives credential renewal.",
      ),
    );
    checks.push(
      "browser creates accounts and business files, grants ACL, opens editor without pasted tokens, edits and publishes",
    );
    checks.push(
      "session renewal preserves the same mounted editor and unsaved draft",
    );
    await editor.close();
    await page.getByRole("link", { name: "业务事件", exact: true }).click();
    await page
      .getByText("业务文件已回写", { exact: true })
      .first()
      .waitFor({ timeout: 20000 });
    while (
      await page.getByRole("button", { name: "关闭提示", exact: true }).count()
    )
      await page
        .getByRole("button", { name: "关闭提示", exact: true })
        .first()
        .click();
    await page.screenshot({
      path: join(artifacts, "events-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "服务设置", exact: true }).click();
    await page
      .getByRole("heading", { name: "离线部署", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("编辑器地址", { exact: true }).count(),
      0,
    );
    await page.screenshot({
      path: join(artifacts, "settings-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "文档管理", exact: true }).click();
    await page
      .getByRole("heading", { name: "文档管理", exact: true })
      .waitFor();
    await page.screenshot({
      path: join(artifacts, "documents-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: join(artifacts, "documents-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "切换深色", exact: true }).click();
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
    await page.screenshot({
      path: join(artifacts, "documents-mobile-dark.png"),
      fullPage: true,
    });
    assert.equal(blocked.length, 0);
    checks.push(
      "V2 desktop/mobile/dark management pages use local assets without public requests",
    );
    // A fresh member browser sees only its explicitly shared file and read UI.
    const memberContext = await browser.newContext(),
      memberPage = await memberContext.newPage();
    await restrictNetwork(memberContext);
    await memberPage.goto(base);
    await memberPage.getByLabel("账号", { exact: true }).fill("browser-member");
    await memberPage.getByLabel("密码", { exact: true }).fill(memberPassword);
    await memberPage
      .getByRole("button", { name: "登录工作空间", exact: true })
      .click();
    await memberPage
      .getByRole("button", { name: "默认工作空间验收.txt", exact: false })
      .click();
    assert.equal(
      await memberPage
        .getByRole("link", { name: "用户与角色", exact: true })
        .count(),
      0,
    );
    const memberOpened = memberContext.waitForEvent("page");
    await memberPage
      .getByRole("link", { name: "打开只读预览", exact: true })
      .click();
    const viewer = await memberOpened;
    await viewer
      .locator(".hcd-embedded .workspace")
      .waitFor({ timeout: 60000 });
    assert.equal(
      await viewer.locator('.tiptap[contenteditable="true"]').count(),
      0,
    );
    checks.push(
      "member login lists only shared files and opens a real read-only editor",
    );
    assert.equal(blocked.length, 0);
    await browser.close();
    browser = null;
  }
  const report = {
    status: "passed",
    scope: "default-workspace-phase-b",
    checks,
    browserVerified: process.env.OFFICECLI_SKIP_BROWSER !== "1",
    storage: "production SQLite/immutable-object Provider",
    defaultAccounts: false,
    offlineReleaseVerified: false,
  };
  writeFileSync(
    join(artifacts, "validation.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  writeFileSync(
    join(artifacts, "validation.json"),
    JSON.stringify(
      {
        status: "failed",
        scope: "default-workspace-phase-b",
        checks,
        error: error.message,
        offlineReleaseVerified: false,
      },
      null,
      2,
    ) + "\n",
  );
  if (browser)
    for (const [index, page] of browser
      .contexts()
      .flatMap((context) => context.pages())
      .entries())
      await page
        .screenshot({
          path: join(artifacts, `failure-${index}.png`),
          fullPage: true,
        })
        .catch(() => {});
  console.error(`验收失败；服务日志：${join(root, "services.log")}`);
  throw error;
} finally {
  if (browser) await browser.close();
  await stop();
  log.end();
}
