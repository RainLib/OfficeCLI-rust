import { createWorkbenchJobs } from "./workbench-jobs.mjs";
import { createRequire } from "node:module";
import { createSelectionGrants, supportsSelectionFormat } from "./selection-grants.mjs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { resolve, join, extname, sep } from "node:path";
import {
  check,
  HttpError,
  hash,
  equal,
  now,
  iso,
  random,
  uuid,
  publicUser,
  passwordHash,
  verifyPassword,
  profiles,
  operations,
} from "./store.mts";
import {
  createProvider,
  verifySignature,
  seal,
  unseal,
  documentId,
} from "./provider.mjs";
import { Sharing, GUEST_COOKIE } from "./sharing.mts";
import { createProjects } from "./projects.mts";
import { createMentionInbox } from "./mention-inbox.mjs";
import { createPublicationJobs } from "./publication-jobs.mjs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const COOKIE = "officecli_workspace";
const DESKTOP_COOKIE = "foldly_desktop_session";
const cloudWorkspacePath = /^\/(login|logout|users|projects|public|shared|mentions|embed|agent-[a-z-]+|publication-jobs|events|audit|service)(\/|$)/;
const cloudFilePath = /^\/files\/[^/]+\/(acl|location|mentionable|sharing)(\/|$)/;
const formats = {
  excalidraw: "application/vnd.excalidraw+json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  html: "text/html",
  md: "text/markdown",
  txt: "text/plain",
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".bcmap": "application/octet-stream",
  ".icc": "application/octet-stream",
};
export async function body(request, limit) {
  check(
    !request.headers["content-length"] ||
      (/^\d+$/.test(request.headers["content-length"]) &&
        Number(request.headers["content-length"]) <= limit),
    413,
    "请求超过大小限制。",
  );
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    check(size <= limit, 413, "请求超过大小限制。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const jsonBody = async (request) => {
  check(
    request.headers["content-type"]?.split(";")[0] === "application/json",
    415,
    "请使用 JSON 请求。",
  );
  try {
    const value = JSON.parse(await body(request, 2 * 1024 * 1024));
    check(
      value && typeof value === "object" && !Array.isArray(value),
      400,
      "JSON 请求必须为对象。",
    );
    return value;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "JSON 格式无效。");
  }
};
export function jwt(secret, claims) {
  const input = [{ alg: "HS256", typ: "JWT" }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}
export function createWorkspaceServer({
  store,
  config,
  keys,
  adminAssets,
  editorAssets,
  modelIds = /** @type {string[]} */ ([]),
  workbenchModel = /** @type {{name: string, url: string} | null} */ (null),
  captureBackup,
  publicAvailable = () => true,
}) {
  const desktop = config.mode === "desktop";
  const provider = createProvider(store, config, keys, { modelIds }),
    pending = new Map();
  const sharing = new Sharing(store, config, keys);
  const projects = createProjects(store);
  const inbox = createMentionInbox({ store, engine, config });
  const publicationJobs = createPublicationJobs({ store, engine, config, serviceKey: keys.service, launch });
  const grants = createSelectionGrants({ store, config, engine });
  const hasViewOperation = {
    sqlite: "EXISTS (SELECT 1 FROM json_each(a.operations) WHERE value='document.view')",
    postgres: "jsonb_exists(a.operations::jsonb,'document.view')",
    mysql: "JSON_CONTAINS(a.operations,JSON_QUOTE('document.view'))",
  }[store.kind];
  function checkedActions(actions) {
    const { parseSelectionMutation } = selectionTransport();
    return actions.map(action => ({ ...action,
      args: parseSelectionMutation(action.tool, { ...action.args, requestId: randomUUID() }) }));
  }
  const workbenchJobs = createWorkbenchJobs({ store, grants, launch, engine,
    planFile: async input => {
      const { planWorkbenchFile } = await import("./workbench-planner.mts");
      return checkedActions(await planWorkbenchFile(input, workbenchModel));
    },
  });
  let backupPaused = false, callbacksPaused = false;
  const admitted = new Set(), callbacks = new Set();
  const selectionTransport = () => createRequire(import.meta.url)(join(adminAssets, "../selection-mcp.cjs"));
  const workspace = {
    ...(desktop && { mode: "desktop" }),
    tenantId: config.tenantId,
    name: config.name,
    workbenchModel: workbenchModel?.name ?? null,
    appId: config.appId,
    publicUrl: config.publicUrl,
    aiEnabled: modelIds.length > 0,
    selectionMcp: config.selectionMcp === true,
  };
  const cookie = (request, name = desktop ? DESKTOP_COOKIE : COOKIE) => {
    const values = (request.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${name}=`));
    return values.length === 1 ? values[0].slice(name.length + 1) : "";
  };
  async function session(request) {
    return store.read(async () => {
      const value = cookie(request);
      const record = /^[A-Za-z0-9_-]{43}$/.test(value) && await store.get(
        "SELECT * FROM sessions WHERE hash=?",
        hash(value),
      );
      if (record && record.expires > now()) return { ...record, user: await store.user(record.user_id) };
      check(!desktop, 401, "请通过折页桌面客户端打开本地工作空间。");
      const guest = await sharing.account(cookie(request, GUEST_COOKIE));
      check(guest, 401, "请登录工作空间，或通过分享链接打开文档。");
      return guest;
    });
  }
  const admin = (account) =>
    check(account.user.role === "admin", 403, "需要工作空间管理员权限。");
  const adminRead = (request, work) => store.read(async () => {
    admin(await session(request));
    return work();
  });
  async function createDesktopSession() {
    check(desktop, 403, "仅本地工作空间支持桌面会话。");
    const owner = await store.get("SELECT id FROM users WHERE username='desktop' AND role='member' AND disabled=0");
    check(owner, 409, "本机用户不存在。");
    const value = random();
    await store.transaction(async () => {
      await store.run("DELETE FROM sessions");
      await store.run("INSERT INTO sessions VALUES(?,?,?,?,?)", hash(value), owner.id, random(), now() + 30 * 86400, now());
    });
    return { name: DESKTOP_COOKIE, value };
  }
  const origin = (request) =>
    check(request.headers.origin === config.publicUrl, 403, "请求来源不匹配。");
  const csrf = (request, account) => {
    origin(request);
    check(
      equal(request.headers["x-workspace-csrf"], account.csrf),
      403,
      "会话校验已过期，请刷新页面。",
    );
  };
  const setCookie = (value, age, name = COOKIE) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(config.publicUrl).protocol === "https:" ? "; Secure" : ""}`;
  const send = (response, status, value, headers = {}) => {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(status === 204 ? undefined : JSON.stringify(value));
  };
  function summary(user, access) {
    const { file, operations, receipt } = access;
    return {
      id: file.id,
      resourceDocumentId: documentId(config, file.id),
      name: file.name,
      format: file.format,
      ownerId: file.owner_id,
      ownerName: access.ownerName,
      version: `v${file.head}`,
      size: access.size,
      createdAt: file.created_at,
      modifiedAt: file.modified_at,
      operations: provider.filteredPermissions(operations),
      location: access.location,
      canDelegateSelection: config.selectionMcp === true && supportsSelectionFormat(file.format) && !user.is_guest &&
        ["document.view", "document.edit", "document.ai"].every(op => operations.includes(op)),
      canManage: access.canManage,
      lastPublishedRevision: receipt ? JSON.parse(receipt).revision : null,
      documentId: access.hasLaunch ? documentId(config, file.id) : null,
    };
  }

  async function fileSummary(user, file) {
    const access = await store.access(user, file.id);
    check(access.operations.includes("document.view"), 403, "没有此文件的操作权限。");
    return summary(user, access);
  }

  async function engine(
    path,
    { method = "GET", data, token = keys.service, headers = {}, signal } = {},
  ) {
    const timeout = AbortSignal.timeout(120_000);
    const response = await fetch(config.engineUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      redirect: "error",
    });
    const text = await response.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new HttpError(502, "编辑服务返回了无效响应。");
    }
    check(
      response.ok,
      response.status >= 500 ? 502 : response.status,
      typeof value.error === "string" ? value.error : "编辑服务暂时不可用。",
    );
    return value;
  }
  async function launch(account, file, id) {
    check(uuid(id), 400, "编辑会话 ID 无效。");
    // Serializing by browser-supplied operation ID makes StrictMode, double
    // clicks and a lost HTTP response converge on one durable exchange.
    const previous = pending.get(id) || Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        const prepared = await store.transaction(async () => {
          const browser = await store.get("SELECT user_id,expires FROM sessions WHERE hash=?", account.hash);
          check(browser?.user_id === account.user.id && browser.expires > now(), 401, "请重新登录工作空间。");
          const user = await store.user(browser.user_id);
          await store.permit(user, file, "document.view");
          const record = await store.get("SELECT * FROM launches WHERE id=?", id);
          if (record)
            check(record.browser_hash === account.hash && record.user_id === user.id &&
              record.file_id === file.id && !record.closed, 403, "编辑会话归属不匹配。");
          if (record?.response) {
            const response = JSON.parse(record.response);
            if (response.expiresAt > now() + 60) return { response };
          }
          if (record?.request) return { request: unseal(keys.objects, record.request), purpose: record.purpose };
          const request = { sessionId: id, exchangeId: randomUUID(), externalFileId: file.id, launchCode: random() };
          const purpose = record ? "refresh" : "open";
          const expiry = Math.min(browser.expires, now() + 3600);
          const encrypted = seal(keys.objects, request);
          if (record)
            await store.run("UPDATE launches SET request=?,purpose=?,expires=? WHERE id=?", encrypted, purpose, expiry, id);
          else
            await store.run("INSERT INTO launches(id,browser_hash,user_id,file_id,expires,request) VALUES(?,?,?,?,?,?)",
              id, account.hash, user.id, file.id, expiry, encrypted);
          return { request, purpose };
        });
        if (prepared.response) return { ...prepared.response, fileName: file.name, collabUrl: "/collaboration" };
        let response;
        try {
          response = await engine(
            `/integration/v1/sessions${prepared.purpose === "refresh" ? `/${id}/refresh` : ""}`,
            { method: "POST", data: prepared.request },
          );
        } catch (error) {
          // Unknown outcomes retain the exact encrypted exchange for recovery.
          if (
            error instanceof HttpError &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 429
          ) {
            await store.run(
              "UPDATE launches SET closed=1,request=NULL WHERE id=?",
              id,
            );
          }
          throw error;
        }
        await store.transaction(async () => {
          const current = await store.get("SELECT closed FROM launches WHERE id=?", id);
          check(current && !current.closed, 403, "编辑会话已结束。");
          await store.permit(account.user, file, "document.view");
          await store.run("UPDATE launches SET response=?,request=NULL WHERE id=?", JSON.stringify(response), id);
        });
        return {
          ...response,
          fileName: file.name,
          collabUrl: "/collaboration",
        };
      });
    pending.set(id, work);
    try {
      return await work;
    } finally {
      if (pending.get(id) === work) pending.delete(id);
    }
  }
  async function business(request, response, url) {
    const path = url.pathname.slice("/workspace/api".length),
      method = request.method;
    check(!desktop || !(cloudWorkspacePath.test(path) || cloudFilePath.test(path)), 404, "此接口仅供团队工作空间使用。");
    if (path === "/status" && method === "GET")
      return send(response, 200, {
        product: "officecli-workspace",
        schemaVersion: "officecli-workspace/1",
        name: config.name,
      });
    if (path === "/public/files" && method === "GET")
      return send(response, 200, { files: await sharing.publicFiles() });
    const shared = /^\/shared\/([a-f0-9-]{36})\/open$/.exec(path);
    if (shared && method === "POST") {
      origin(request);
      const data = await jsonBody(request);
      check(data && Object.keys(data).every(key => key === "sessionId") && uuid(data.sessionId), 400, "打开文档的参数无效。");
      const file = await store.file(shared[1]);
      let account;
      try { account = await session(request); } catch (error) { if (!(error instanceof HttpError)) throw error; }
      let joined;
      if (!account || account.user.is_guest || !(await store.permissions(account.user, file)).includes("document.view")) {
        const policy = await store.get("SELECT visibility FROM shares WHERE file_id=?", file.id);
        if ((!policy || policy.visibility === "private") && !request.headers["x-workspace-share"])
          throw new HttpError(account && !account.user.is_guest ? 403 : 401, "此文档仅对受邀成员开放，请使用有权限的账号登录。");
        joined = await sharing.join(file, request.headers["x-workspace-share"], cookie(request, GUEST_COOKIE));
        account = joined.account;
        if (joined.cookie) response.setHeader("Set-Cookie", setCookie(joined.cookie, account.expires - now(), GUEST_COOKIE));
      }
      const previous = await store.get("SELECT * FROM launches WHERE id=?", data.sessionId);
      if (previous?.closed && previous.user_id === account.user.id && previous.file_id === file.id && previous.browser_hash === account.hash)
        return send(response, 409, { error: "分享权限已更新，正在重新打开。", retrySession: true }, joined?.cookie
          ? { "Set-Cookie": setCookie(joined.cookie, account.expires - now(), GUEST_COOKIE) } : {});
      const result = await launch(account, file, data.sessionId);
      return send(response, 200, { ...result, actor: publicUser(account.user), canManage: await store.canManage(account.user, file),
        sharing: await sharing.settings(file), guestExpiresAt: account.user.is_guest ? account.expires : null }, joined?.cookie
          ? { "Set-Cookie": setCookie(joined.cookie, account.expires - now(), GUEST_COOKIE) } : {});
    }
    if (path === "/login" && method === "POST") {
      origin(request);
      const data = await jsonBody(request),
        username =
          typeof data.username === "string"
            ? data.username.trim().toLowerCase()
            : "";
      check(
        /^[a-z0-9_.-]{3,64}$/.test(username) &&
          typeof data.password === "string",
        401,
        "账号或密码不正确。",
      );
      const attemptKey = hash(`${username}:${request.socket.remoteAddress}`),
        attempt = await store.get(
          'SELECT * FROM login_attempts WHERE "key"=?',
          attemptKey,
        );
      check(
        !attempt || attempt.reset_at <= now() || attempt.failures < 10,
        429,
        "登录失败次数较多，请 15 分钟后重试。",
      );
      const user = await store.get("SELECT * FROM users WHERE username=? AND id NOT IN (SELECT user_id FROM guest_identities)", username);
      const encoded = user?.password || keys.dummyPassword;
      const valid = await verifyPassword(data.password, encoded);
      if (!user || user.disabled || !valid) {
        await store.transaction(async () => {
          const current = await store.get('SELECT * FROM login_attempts WHERE "key"=?', attemptKey);
          const active = current?.reset_at > now();
          await store.upsert("login_attempts", ["key"], {
            key: attemptKey, failures: active ? current.failures + 1 : 1, reset_at: active ? current.reset_at : now() + 900,
          });
        });
        throw new HttpError(401, "账号或密码不正确。");
      }
      const value = random(),
        csrfToken = random(),
        expiry = now() + 8 * 3600;
      const current = await store.transaction(async () => {
        // Password verification yields to the event loop. A concurrent reset
        // or disable must invalidate this login before a new session is issued.
        const current = await store.get("SELECT * FROM users WHERE id=?", user.id);
        check(
          current && !current.disabled && current.password === user.password,
          401,
          "账号或密码已变化，请重新登录。",
        );
        await store.run('DELETE FROM login_attempts WHERE "key"=?', attemptKey);
        await store.run("DELETE FROM sessions WHERE expires<=?", now());
        await store.run(
          "INSERT INTO sessions VALUES(?,?,?,?,?)",
          hash(value),
          user.id,
          csrfToken,
          expiry,
          now(),
        );
        await store.audit(user.id, "session.login");
        return current;
      });
      return send(
        response,
        200,
        { user: publicUser(current), csrf: csrfToken, expiresAt: expiry, workspace },
        { "Set-Cookie": setCookie(value, 8 * 3600) },
      );
    }
    const account = await session(request);
    if (!["GET", "HEAD"].includes(method)) csrf(request, account);
    if (path === "/session" && method === "GET")
      return send(response, 200, {
        user: publicUser(account.user),
        csrf: account.csrf,
        expiresAt: account.expires,
        workspace,
      });
    check(!account.user.is_guest, 403, "访客仅可访问分享给自己的文档，请通过分享链接打开。");
    if (path === "/mentions" && method === "GET") {
      const incomplete = await inbox.refresh();
      const current = await session(request);
      check(!current.user.is_guest, 403, "请登录工作空间查看提及。");
      return send(response, 200, { ...await inbox.list(current.user, url.searchParams.get("before")), incomplete });
    }
    if (path === "/mentions/read" && method === "POST") {
      csrf(request, account);
      await inbox.markAllRead(account.user);
      return send(response, 204);
    }
    const mentionRead = /^\/mentions\/([a-f0-9-]{36})\/read$/.exec(path);
    if (mentionRead && method === "POST") {
      csrf(request, account);
      return send(response, 200, { item: await inbox.markRead(account.user, mentionRead[1]) });
    }
    if (path === "/embed/selection" && method === "PUT")
      return send(response, 200, await grants.set(account, await jsonBody(request)));
    if (path === "/board-document-preview" && method === "POST") {
      check(workbenchModel, 409, "工作台尚未配置模型。");
      const { boardId, sources, sections } = await jsonBody(request);
      check(Array.isArray(sources) && sources.length <= 128 && Array.isArray(sections) && sections.length > 0 && sections.length <= 128
        && sections.every(s => s && typeof s.id === "string" && s.id.length <= 256 && typeof s.heading === "string" && Array.isArray(s.lines) && s.lines.every(t => typeof t === "string"))
        && new Set(sections.map(s => s.id)).size === sections.length && JSON.stringify(sections).length <= 64000, 400, "请选择较小的白板选区。");
      const { organizeBoardSections } = await import("./workbench-planner.mts");
      const board = await store.file(boardId);
      check(board.format === "excalidraw", 400, "请选择一份白板。");
      for (const id of new Set([boardId, ...sources])) {
        const file = await store.file(id);
        for (const op of ["document.view", "document.copy", "document.ai"]) await store.permit(account.user, file, op);
      }
      return send(response, 200, { sections: await organizeBoardSections(workbenchModel, sections) });
    }
    if (path === "/agent-jobs" && method === "GET")
      return send(response, 200, { jobs: await workbenchJobs.list(account) });
    const jobAction = /^\/agent-jobs\/([a-f0-9-]+)\/(approve|retry|recheck|undo)$/.exec(path);
    if (jobAction && method === "POST") {
      const { files, token, reviews } = await jsonBody(request);
      if (jobAction[2] === "undo") return send(response, 200, await workbenchJobs.undo(account, jobAction[1], files));
      if (jobAction[2] === "recheck") {
        const grant = token === undefined ? undefined : await grants.authenticate("Bearer " + token);
        return send(response, 202, await workbenchJobs.recheck(account, jobAction[1], files, grant));
      }
      return send(response, 202, await workbenchJobs.transition(account, jobAction[1], jobAction[2], files, reviews));
    }
    if ((path === "/agent-plan" || path === "/agent-jobs") && method === "POST") {
      const { id, prompt, tokens } = await jsonBody(request);
      check(
        typeof prompt === "string" &&
          prompt.trim() &&
          prompt.length <= 4000 &&
          Array.isArray(tokens) &&
          tokens.length > 0 &&
          tokens.length <= 12,
        400,
        "请选择任务文件并输入指令。",
      );
      const compile = async () => {
        const { planWorkbench } = await import("./workbench-planner.mts");
        const selections = await Promise.all(tokens.map(async token => {
          const grant = await grants.authenticate("Bearer " + token);
          check(
            grant.userId === account.user.id && grant.browser === account.hash,
            403,
            "文件选区属于其他会话。",
          );
          return grant;
        }));
        check(new Set(selections.map(grant => grant.fileId)).size === selections.length, 400, "目标文件不能重复。");
        const targets = await Promise.all(selections.map(async grant =>
          ({ fileId: grant.fileId, ...(await grants.call(grant, "read_selection", {})) })));
        const stops = selections.map(grants.planning);
        let plan;
        try {
          plan = await planWorkbench(prompt.trim(), targets, workbenchModel, path === "/agent-jobs");
          if (path === "/agent-jobs") plan.actions = checkedActions(plan.actions);
          return { plan, selections, sources: targets };
        } finally {
          stops.forEach((stop, i) => stop(path === "/agent-jobs" || !plan?.actions?.some(a => a.fileId === targets[i].fileId)));
        }
      };
      if (path === "/agent-jobs") return send(response, 201, await workbenchJobs.create(account, id, prompt.trim(), compile));
      return send(response, 200, (await compile()).plan);
    }
    if (path === "/agent-activity/stream" && method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      let delivering = false;
      const deliver = async () => {
        if (delivering || response.writableEnded || response.destroyed) return;
        delivering = true;
        try {
          const current = await session(request);
          if (!current || current.hash !== account.hash || current.user.is_guest)
            return response.end();
          const payload = JSON.stringify({ activity: await grants.recentActivity(current) });
          if (response.writableLength > 256 * 1024) return response.end();
          response.write("data: " + payload + "\n\n");
        } catch {
          response.end();
        } finally { delivering = false; }
      };
      const unsubscribe = grants.subscribe(account.user.id, deliver);
      const heartbeat = setInterval(deliver, 15000);
      response.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      deliver();
      return;
    }
    if (path === "/agent-activity" && method === "GET")
      return send(response, 200, { activity: await grants.recentActivity(account) });
    if (path === "/logout" && method === "POST") {
      await store.transaction(async () => {
        await store.run("DELETE FROM sessions WHERE hash=?", account.hash);
        await store.run(
          "UPDATE launches SET closed=1 WHERE browser_hash=?",
          account.hash,
        );
        await store.audit(account.user.id, "session.logout");
      });
      return send(response, 204, null, { "Set-Cookie": setCookie("", 0) });
    }
    if (path === "/users" && method === "GET") {
      const users = await adminRead(request, () =>
        store.all("SELECT * FROM users WHERE id NOT IN (SELECT user_id FROM guest_identities) ORDER BY created_at"));
      return send(response, 200, {
        users: users.map(publicUser),
      });
    }
    if (path === "/users" && method === "POST") {
      admin(account);
      const data = await jsonBody(request);
      const username = String(data.username || "")
          .trim()
          .toLowerCase(),
        name = String(data.displayName || "").trim();
      check(
        /^[a-z0-9_.-]{3,64}$/.test(username) &&
          name.length > 0 &&
          name.length <= 128 &&
          !name.includes("\0") &&
          ["admin", "member"].includes(data.role),
        400,
        "账号、显示名称或角色无效。",
      );
      const password = await passwordHash(data.password);
      const id = randomUUID();
      await store.transaction(async () => {
        admin(await session(request));
        check(!await store.get("SELECT id FROM users WHERE username=?", username), 409, "账号已存在。");
        await store.run(
          "INSERT INTO users VALUES(?,?,?,?,?,0,?)",
          id,
          username,
          name,
          password,
          data.role,
          iso(),
        );
        await store.audit(account.user.id, "user.created", id);
      });
      return send(response, 201, { user: publicUser(await store.user(id)) });
    }
    const userMatch = /^\/users\/([a-f0-9-]+)$/.exec(path);
    if (userMatch && method === "PATCH") {
      admin(account);
      const data = await jsonBody(request),
        user = await store.get("SELECT * FROM users WHERE id=?", userMatch[1]);
      check(user && !await store.get("SELECT 1 FROM guest_identities WHERE user_id=?", user.id), 404, "用户不存在。");
      const role = data.role ?? user.role,
        disabled =
          data.disabled === undefined ? user.disabled : Number(!!data.disabled),
        displayName =
          data.displayName === undefined
            ? user.display_name
            : String(data.displayName).trim();
      check(
        ["admin", "member"].includes(role) &&
          displayName.length > 0 &&
          displayName.length <= 128 &&
          !displayName.includes("\0"),
        400,
        "用户资料无效。",
      );
      const password =
        data.password === undefined
          ? user.password
          : await passwordHash(data.password);
      await store.transaction(async () => {
        admin(await session(request));
        const current = await store.get("SELECT * FROM users WHERE id=?", user.id);
        check(
          current.password === user.password &&
            current.role === user.role &&
            current.disabled === user.disabled &&
            current.display_name === user.display_name,
          409,
          "用户资料已被更新，请刷新后重试。",
        );
        if (
          user.role === "admin" &&
          !user.disabled &&
          (role !== "admin" || disabled)
        )
          check(
            (await store.get(
              "SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0",
            )).count > 1,
            409,
            "不能停用或降级最后一个管理员。",
          );
        await store.run(
          "UPDATE users SET role=?,disabled=?,display_name=?,password=? WHERE id=?",
          role,
          disabled,
          displayName,
          password,
          user.id,
        );
        if (disabled || role !== user.role || password !== user.password) {
          await store.run("DELETE FROM sessions WHERE user_id=?", user.id);
          await store.run("UPDATE launches SET closed=1 WHERE user_id=?", user.id);
        }
        await store.audit(account.user.id, "user.updated", user.id);
      });
      return send(response, 200, {
        user: publicUser(await store.get("SELECT * FROM users WHERE id=?", user.id)),
      });
    }
    if (path === "/projects") {
      if (method === "GET") {
        const items = await store.read(async () => projects.list((await session(request)).user));
        return send(response, 200, { projects: items });
      }
      if (method === "POST") {
        const value = await jsonBody(request);
        return send(response, 201, { project: await projects.create((await session(request)).user, value) });
      }
    }
    const projectPath = /^\/projects\/([a-f0-9-]+)(?:\/(folders|members)(?:\/([a-f0-9-]+))?)?$/.exec(path);
    if (projectPath) {
      const [, id, part, item] = projectPath, user = account.user;
      if (!part && method === "GET") return send(response, 200, await projects.details(user, id));
      if (!part && method === "PATCH") {
        const value = await jsonBody(request);
        return send(response, 200, { project: await projects.rename((await session(request)).user, id, value) });
      }
      if (part === "folders") {
        if (!item && method === "POST" || item && method === "PATCH") {
          const value = await jsonBody(request);
          return send(response, item ? 200 : 201, { folder: await projects.saveFolder((await session(request)).user, id, value, item ?? null) });
        }
        if (item && method === "DELETE") {
          await projects.removeFolder(user, id, item);
          return send(response, 204);
        }
      }
      if (part === "members") {
        if (!item && method === "GET") return send(response, 200, await projects.members(user, id));
        if (item && method === "PUT") {
          const data = await jsonBody(request);
          await projects.setMember((await session(request)).user, id, item, data?.role);
          return send(response, 204);
        }
      }
    }
    if (path === "/files" && method === "GET") {
      return send(response, 200, { files: await store.read(async () => {
        const { user } = await session(request);
        check(!user.is_guest, 403, "访客仅可访问分享给自己的文档。");
        const files = await store.listFiles(user);
        return files.map(access => summary(user, access));
      }) });
    }
    if (path === "/content-search" && method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      const cursor = url.searchParams.get("after") || "";
      check(q && Array.from(q).length <= 128 && !q.includes("\0") && (!cursor || uuid(cursor)), 400, "请输入要查找的内容。");
      const scanSize = 48;
      const projectId = url.searchParams.get("projectId");
      if (projectId !== null) {
        check(uuid(projectId), 400, "项目 ID 无效。");
        check(await store.projectRole(account.user, projectId), 404, "项目不存在或无权访问。");
      }
      const batch = projectId === null ? await store.all("SELECT * FROM files WHERE id>? ORDER BY id LIMIT ?", cursor, scanSize)
        : await store.all(`SELECT files.* FROM files JOIN project_files pf ON pf.file_id=files.id
          WHERE pf.project_id=? AND files.id>? ORDER BY files.id LIMIT ?`, projectId, cursor, scanSize);
      const visible = await Promise.all(batch.map(async file => (await store.permissions(account.user, file)).includes("document.view")));
      const candidates = batch.filter((_, index) => visible[index]);
      const page = candidates.slice(0, 6);
      const next = candidates.length > page.length ? page.at(-1).id : batch.length === scanSize ? batch.at(-1).id : null;
      const params = new URLSearchParams({ q, workspace: "true" });
      const controller = new AbortController();
      response.once("close", () => controller.abort());
      const results = await Promise.allSettled(page.map(async file => {
        const existing = await store.get(`SELECT id FROM launches WHERE file_id=? AND user_id=?
          AND browser_hash=? AND closed=0 AND expires>? ORDER BY expires DESC LIMIT 1`,
        file.id, account.user.id, account.hash, now());
        const { token, documentId } = await launch(account, file, existing?.id || randomUUID());
        const result = await engine(`/v1/documents/${documentId}/search?${params}`, { token, signal: controller.signal });
        return { id: file.id, name: file.name, format: file.format, ...result };
      }));
      if (controller.signal.aborted) return;
      const current = await session(request);
      if (projectId !== null)
        check(await store.projectRole(current.user, projectId), 404, "项目不存在或无权访问。");
      const files = [], unavailable = [];
      for (const [index, result] of results.entries()) {
        const file = page[index];
        if (!(await store.permissions(current.user, file)).includes("document.view") ||
          projectId !== null && (await store.fileLocation(file.id))?.projectId !== projectId) continue;
        if (result.status === "fulfilled") {
          if (result.value.hits.length || result.value.truncated) files.push(result.value);
        } else unavailable.push({ id: file.id, name: file.name });
      }
      return send(response, 200, { files, unavailable, next });
    }
    if (path === "/files" && method === "POST") {
      let name, bytes, destination;
      if (
        request.headers["content-type"]?.split(";")[0] === "application/json"
      ) {
        const data = await jsonBody(request);
        name = String(data.name || "").trim();
        destination = { projectId: data.projectId, folderId: data.folderId };
        check(
          /\.(docx|xlsx|pptx|txt|md|html|excalidraw)$/i.test(name),
          400,
          "请选择文档、表格、演示或白板格式。",
        );
        const extension = name.split(".").at(-1).toLowerCase();
        bytes = ["docx", "xlsx", "pptx"].includes(extension)
          ? readFileSync(join(adminAssets, "../blank/blank." + extension))
          : Buffer.from(
              extension === "excalidraw"
                ? JSON.stringify({
                    type: "excalidraw",
                    version: 2,
                    source: "OfficeCLI",
                    elements: [],
                    appState: { viewBackgroundColor: "#ffffff" },
                    files: {},
                  })
                : extension === "html"
                  ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><p>开始编写文档。</p></body></html>'
                  : extension === "md"
                    ? "# 新文档\n\n开始编写文档。\n"
                    : "开始编写文档。\n",
            );
      } else {
        name = url.searchParams.get("filename") || "";
        destination = { projectId: url.searchParams.get("projectId"), folderId: url.searchParams.get("folderId") };
        bytes = await body(request, 256 * 1024 * 1024);
      }
      check(
        name && name.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(name),
        400,
        "文件名无效。",
      );
      const raw = name.split(".").at(-1).toLowerCase(),
        format = { jpg: "jpeg", markdown: "md", htm: "html" }[raw] || raw;
      check(formats[format], 415, "不支持此文件类型。");
      const actor = (await session(request)).user;
      const file = await store.createFile(
        actor,
        name,
        format,
        formats[format],
        bytes,
        () => projects.destination(actor, destination),
      );
      return send(response, 201, { file: await fileSummary(actor, file) });
    }
    const fileMatch = /^\/files\/([a-f0-9-]+)(.*)$/.exec(path);
    if (fileMatch) {
      const file = await store.file(fileMatch[1]),
        action = fileMatch[2];
      await store.permit(account.user, file, "document.view");
      if (!action && method === "GET")
        return send(response, 200, { file: await fileSummary(account.user, file) });
      if (action === "/location" && method === "PUT") {
        const value = await jsonBody(request), actor = (await session(request)).user;
        await projects.moveFile(actor, file, value);
        return send(response, 200, { file: await fileSummary(actor, file) });
      }
      if (action === "/editor-session" && method === "POST") {
        const data = await jsonBody(request);
        const result = await launch(account, file, data.sessionId);
        return send(response, 200, { ...result, actor: publicUser(account.user), canManage: !desktop && await store.canManage(account.user, file) });
      }
      if (action === "/sharing" && method === "GET") {
        await store.manage(account.user, file);
        return send(response, 200, { sharing: await sharing.settings(file) });
      }
      if (action === "/sharing" && method === "PUT") {
        const data = await jsonBody(request);
        const result = await store.read(async () => sharing.update((await session(request)).user, file, data));
        await Promise.allSettled(result.revokedSessions.map(id => engine(`/integration/v1/sessions/${id}`, { method: "DELETE" })));
        return send(response, 200, { sharing: result.sharing });
      }
      if (action === "/themes" && method === "GET") {
        await store.permit(account.user, file, "theme.assign");
        const token = jwt(keys.jwt, {
          doc: "*",
          scope: "admin",
          sub: account.user.id,
          aud: "hcd-core",
          iat: now(),
          exp: now() + 60,
        });
        const [themes, retired] = await Promise.all([
          engine("/v1/catalog/themes", { token }),
          engine("/v1/catalog/themes/retired", { token }),
        ]);
        return send(response, 200, {
          themes: themes
            .filter((theme) => !retired.includes(theme.themeRevisionId))
            .map((theme) => ({
              themeRevisionId: theme.themeRevisionId,
              name: theme.name,
            })),
        });
      }
      if (action === "/theme" && method === "POST") {
        await store.permit(account.user, file, "theme.assign", "document.edit");
        const data = await jsonBody(request);
        check(
          data.themeRevisionId === null ||
            (typeof data.themeRevisionId === "string" &&
              /^[a-f0-9]{64}$/.test(data.themeRevisionId)),
          400,
          "主题版本无效。",
        );
        const selected = await launch(account, file, randomUUID());
        const auth = await engine(`/v1/documents/${selected.documentId}/auth`, {
          token: selected.token,
        });
        const manifest = await engine(`/v1/documents/${selected.documentId}`, {
          token: selected.token,
        });
        const value = await engine(
          `/v1/documents/${selected.documentId}/theme`,
          {
            method: "PUT",
            token: selected.token,
            data: { themeRevisionId: data.themeRevisionId },
            headers: {
              "X-HCD-Expected-Revision": String(manifest.revision),
              "X-HCD-Collaboration-Epoch": String(auth.collaborationEpoch),
            },
          },
        );
        await store.audit(account.user.id, "file.theme.updated", file.id);
        return send(response, 200, value);
      }
      if (action === "/versions" && method === "GET") {
        await store.permit(account.user, file, "history.view");
        return send(response, 200, {
          versions: (await store
            .all(
              "SELECT version,sha256,size,actor_id,created_at,receipt FROM versions WHERE file_id=? ORDER BY version DESC LIMIT 200",
              file.id,
            ))
            .map((item) => ({
              ...item,
              version: `v${item.version}`,
              receipt: item.receipt ? JSON.parse(item.receipt) : null,
            })),
        });
      }
      if (action === "/download" && method === "GET") {
        await store.permit(account.user, file, "document.download");
        const version = url.searchParams.get("version") || `v${file.head}`;
        check(/^v[1-9]\d{0,12}$/.test(version), 400, "业务版本无效。");
        if (version !== `v${file.head}`)
          await store.permit(account.user, file, "history.view");
        const descriptor = await provider.descriptor(file, Number(version.slice(1))),
          bytes = readFileSync(store.object(descriptor.sha256));
        check(
          bytes.length === descriptor.sizeBytes &&
            hash(bytes) === descriptor.sha256,
          503,
          "文件校验失败。",
        );
        response.writeHead(200, {
          "Content-Type": file.media_type,
          "Content-Disposition": `attachment; filename="document.${file.format}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "Cache-Control": "no-store",
          "Content-Length": bytes.length,
        });
        response.end(bytes);
        return;
      }
      if (action === "/mentionable" && method === "GET") {
        await store.permit(account.user, file, "document.view", "document.edit");
        const people = await store.all(
          `SELECT u.id, u.display_name AS name FROM users u
           WHERE u.disabled = 0 AND u.id NOT IN (SELECT user_id FROM guest_identities)
           AND (u.id = ? OR EXISTS (SELECT 1 FROM acl a
             WHERE a.file_id = ? AND a.user_id = u.id AND ${hasViewOperation})
             OR EXISTS (SELECT 1 FROM project_files pf JOIN projects p ON p.id=pf.project_id
               LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=u.id
               WHERE pf.file_id=? AND (p.owner_id=u.id OR m.user_id IS NOT NULL)))
           ORDER BY u.display_name, u.id`, file.owner_id, file.id, file.id,
        );
        return send(response, 200, { people });
      }
      if (action === "/acl" && method === "GET") {
        await store.manage(account.user, file);
        return send(response, 200, {
          ownerId: file.owner_id,
          users: (await store
            .all(
              "SELECT id,username,display_name FROM users WHERE disabled=0 AND id NOT IN (SELECT user_id FROM guest_identities) ORDER BY username",
            ))
            .map((user) => ({
              id: user.id,
              username: user.username,
              displayName: user.display_name,
            })),
          grants: (await store
            .all(
              "SELECT user_id,profile,operations FROM acl WHERE file_id=?",
              file.id,
            ))
            .map((row) => ({
              userId: row.user_id,
              profile: row.profile,
              operations: JSON.parse(row.operations),
            })),
        });
      }
      if (action === "/acl" && method === "PUT") {
        await store.manage(account.user, file);
        const data = await jsonBody(request);
        check(
          uuid(data.userId) &&
            data.userId !== file.owner_id &&
            profiles[data.profile],
          400,
          "权限主体或角色无效。",
        );
        const granted = data.operations ?? profiles[data.profile];
        check(
          Array.isArray(granted) &&
            new Set(granted).size === granted.length &&
            granted.includes("document.view") &&
            granted.every((op) => operations.includes(op)),
          400,
          "权限操作集合无效。",
        );
        if (
          granted.includes("document.publish") ||
          granted.includes("history.restore")
        )
          check(
            granted.includes("document.edit"),
            400,
            "回写或恢复同时需要编辑权限。",
          );
        await store.transaction(async () => {
          const current = await session(request);
          await store.manage(current.user, file);
          check(!(await store.user(data.userId)).is_guest, 400, "临时访客不能作为受邀成员分配权限。");
          await store.upsert("acl", ["file_id", "user_id"], {
            file_id: file.id, user_id: data.userId, profile: data.profile, operations: JSON.stringify(granted),
          });
          await store.audit(account.user.id, "acl.updated", file.id);
        });
        return send(response, 204);
      }
      if (action.startsWith("/acl/") && method === "DELETE") {
        await store.manage(account.user, file);
        const id = action.slice(5);
        check(uuid(id), 400, "用户 ID 无效。");
        await store.transaction(async () => {
          await store.manage((await session(request)).user, file);
          await store.run(
            "DELETE FROM acl WHERE file_id=? AND user_id=?",
            file.id,
            id,
          );
          await store.audit(account.user.id, "acl.removed", file.id);
        });
        return send(response, 204);
      }
    }
    if (path === "/events" && method === "GET") {
      const events = await adminRead(request, () =>
        store.all("SELECT id,file_id,sequence,type,received_at,body FROM events ORDER BY received_at DESC LIMIT 200"));
      return send(response, 200, {
        events: events.map(row => ({ ...row, body: JSON.parse(row.body) })),
      });
    }
    if (path === "/publication-jobs" && method === "GET") {
      admin(account);
      return send(response, 200, await publicationJobs.list(account.user, url.searchParams.get("before")));
    }
    const jobPath = /^\/publication-jobs\/([a-f0-9-]{36})\/(reconcile|retry|artifact|copy|event-retry)$/.exec(path);
    if (jobPath) {
      const current = async () => { const value = await session(request); admin(value); return value; };
      const [, id, operation] = jobPath;
      check(uuid(id), 400, "回写任务无效。");
      if (operation === "artifact" && method === "GET") {
        const { response: output, size, fileName } = await publicationJobs.download(id, current);
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": size,
          "Cache-Control": "no-store", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}` });
        return await pipeline(Readable.fromWeb(output.body), response);
      }
      if (operation !== "artifact" && method === "POST") {
        csrf(request, await current());
        return send(response, 200, await publicationJobs.action(id, operation, current));
      }
    }
    if (path === "/audit" && method === "GET") {
      return send(response, 200, {
        records: await adminRead(request, () => store.all(
          "SELECT audit.*,users.display_name AS actor_name FROM audit LEFT JOIN users ON users.id=audit.actor_id ORDER BY audit.id DESC LIMIT 200",
        )),
      });
    }
    if (path === "/service" && method === "GET") {
      admin(account);
      return send(response, 200, {
        name: config.name,
        schemaVersion: "officecli-workspace/1",
        ai: { enabled: workspace.aiEnabled },
        storage: {
          business: { sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL" }[store.kind] + " + immutable objects",
          editing: "OfficeCLI HCD root",
        },
        deployment: {
          provider: "built-in",
          network: "local resources",
          offlineReleaseVerified: false,
        },
      });
    }
    throw new HttpError(404, "接口不存在。");
  }
  function proxy(request, response, target, headers = {}) {
    const url = new URL(target);
    const forwarded = { ...request.headers, ...headers, host: url.host };
    // Agent attribution for delegated edits is set by the grant handler on
    // its private engine call; a browser proxy request is a human action.
    delete forwarded["x-hcd-agent-edit"];
    delete forwarded["x-hcd-agent-presence-id"];
    delete forwarded["x-hcd-agent-name"];
    delete forwarded.origin;
    delete forwarded.connection;
    const outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: request.method, path: request.url, headers: forwarded },
      (upstream) => {
        const sanitized = { ...upstream.headers };
        delete sanitized["set-cookie"];
        response.writeHead(upstream.statusCode, sanitized);
        upstream.pipe(response);
      },
    );
    outgoing.on("error", () => {
      if (!response.headersSent)
        send(response, 502, { error: "编辑服务暂时不可用。" });
      else response.destroy();
    });
    response.on("close", () => {
      if (!response.writableEnded) outgoing.destroy();
    });
    request.pipe(outgoing);
  }
  async function handleRequest(request, response, publicIngress = false) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
    let finish;
    try {
      check(typeof request.url === "string" && /^\/(?!\/)/.test(request.url) && !request.url.includes("\\"), 400, "请求路径无效。");
      const url = new URL(request.url, config.publicUrl);
      const pathname = url.pathname;
      const snapshot = /^\/workspace\/internal\/backup\/([0-9a-f-]{36})$/.exec(pathname);
      const internal =
        !!snapshot || pathname.startsWith("/officecli-provider/") ||
        pathname === "/officecli-events/v1/events" || pathname.startsWith("/workspace/objects/");
      check(!(publicIngress && internal), 404, "接口不存在。");
      check(
        [
          new URL(config.publicUrl).host,
          ...(internal ? [new URL(config.callbackUrl).host] : []),
        ].includes(request.headers.host?.toLowerCase()),
        421,
        "服务域名不匹配。",
      );
      if (!internal && !publicAvailable()) {
        request.resume();
        return send(response, 503, { error: "工作空间正在启动，稍后可重试。" }, { "Retry-After": "2" });
      }
      if (snapshot) {
        check(captureBackup && request.method === "POST" && uuid(snapshot[1]) && !request.headers.origin &&
          ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress) &&
          equal(request.headers.authorization || "", `Bearer ${keys.service}`), 404, "接口不存在。");
        request.resume();
        return send(response, 201, await captureBackup(snapshot[1]));
      }
      if (captureBackup) {
        const read = ["GET", "HEAD"].includes(request.method);
        const statefulRead = pathname === "/workspace/api/mentions" || pathname === "/workspace/api/content-search" ||
          pathname === "/v1/admin/jobs" || pathname.startsWith("/v1/downloads/") || pathname.includes("/export/");
        const providerWrite = internal && !read && pathname !== "/officecli-provider/v1/permissions/resolve";
        const publicWrite = !internal && (!read || statefulRead);
        if (providerWrite || publicWrite) {
          if (providerWrite ? callbacksPaused : backupPaused) {
            request.resume();
            return send(response, 503, { code: "workspace_snapshot", error: "工作空间正在取备份快照，请稍后重试。" }, { "Retry-After": "2" });
          }
          const active = providerWrite ? callbacks : admitted;
          let done;
          const work = new Promise(resolve => { done = resolve; });
          active.add(work);
          finish = () => { active.delete(work); done(); };
        }
      }
      if (url.pathname.startsWith("/workspace/objects/")) {
        const result = await provider.object(
          request,
          url,
          request.method === "PUT"
            ? await body(request, 256 * 1024 * 1024)
            : null,
        );
        if (result.bytes) {
          response.writeHead(200, {
            "Content-Type": result.type,
            "Content-Length": result.bytes.length,
            "Cache-Control": "no-store",
          });
          response.end(result.bytes);
        } else send(response, result.status);
        return;
      }
      if (
        url.pathname.startsWith("/officecli-provider/") ||
        url.pathname === "/officecli-events/v1/events"
      ) {
        check(request.method === "POST", 405, "仅接受 POST。");
        const bytes = await body(request, 2 * 1024 * 1024),
          event = url.pathname === "/officecli-events/v1/events";
        await verifySignature(
          store,
          request,
          bytes,
          event ? keys.events : keys.provider,
          event ? "event-1" : "provider-1",
        );
        let data;
        try {
          data = JSON.parse(bytes);
        } catch {
          throw new HttpError(400, "JSON 格式无效。");
        }
        if (event) {
          await provider.event(data);
          send(response, 204);
        } else send(response, 200, await provider.callback(url.pathname, data));
        return;
      }
      if (url.pathname === "/workspace/mcp/selection") {
        check(!desktop, 404, "此接口仅供团队工作空间使用。");
        if (request.headers.origin) origin(request);
        const grant = await grants.authenticate(request.headers.authorization);
        if (request.method !== "POST") return send(response, 405, { error: "MCP 使用 POST。" }, { Allow: "POST" });
        const { handleSelectionMcp } = selectionTransport();
        return await handleSelectionMcp(request, response, await jsonBody(request), grant, grants.call);
      }
      if (url.pathname.startsWith("/workspace/api/"))
        return await business(request, response, url);
      if (url.pathname.startsWith("/v1/")) {
        const account = await store.read(async () => {
          const current = await session(request);
          if (url.pathname !== "/v1/capabilities" &&
              (current.user.is_guest || await sharing.guestToken(request.headers.authorization))) {
            const guest = await sharing.account(cookie(request, GUEST_COOKIE));
            check(guest, 401, "访客会话已失效，请重新打开分享链接。");
            const document = /^\/v1\/documents\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(url.pathname);
            check(document, 403, "访客仅可访问当前分享文档。");
            await sharing.authorizeProxy(guest, request.headers.authorization, document[1]);
          }
          return current;
        });
        const global =
          /^\/v1\/(catalog|themes|admin)(\/|$)/.test(url.pathname) ||
          url.pathname === "/v1/documents";
        if (global) {
          admin(account);
          if (!["GET", "HEAD"].includes(request.method)) csrf(request, account);
          const token = jwt(keys.jwt, {
            doc: "*",
            scope: "admin",
            sub: account.user.id,
            name: account.user.display_name,
            aud: "hcd-core",
            iat: now(),
            exp: now() + 60,
          });
          return proxy(request, response, config.engineUrl, {
            authorization: `Bearer ${token}`,
          });
        }
        check(
          /^\/v1\/(documents\/[A-Za-z0-9_-]+(?:\/|$)|downloads\/[a-f0-9-]+(?:\/|$)|capabilities$)/.test(
            url.pathname,
          ),
          403,
          "请通过工作空间管理业务文件。",
        );
        return proxy(request, response, config.engineUrl);
      }
      check(
        request.method === "GET" || request.method === "HEAD",
        405,
        "请求方法无效。",
      );
      if (desktop && url.pathname === "/") {
        response.writeHead(302, { Location: "/workbench/" }).end();
        return;
      }
      check(!desktop || !/^\/(admin|public|s|p)(\/|$)/.test(url.pathname), 404, "此页面仅供团队工作空间使用。");
      let path;
      if (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/public")
        path = adminAssets && join(adminAssets, "index.html");
      else if (url.pathname === "/workbench" || url.pathname === "/workbench/")
        path = join(adminAssets, "../embed-example/index.html");
      else if (url.pathname === "/embed-example" || url.pathname.startsWith("/embed-example/")) {
        const base = resolve(adminAssets, "../embed-example");
        const relative =
          decodeURIComponent(url.pathname.slice("/embed-example/".length)) || "index.html";
        path = resolve(base, relative);
        check(path.startsWith(base + sep), 400, "资源路径无效。");
      } else if (
        url.pathname === "/editor/" ||
        url.pathname === "/editor" ||
        /^\/(s|p)\/[a-f0-9-]{36}$/.test(url.pathname)
      )
        path = editorAssets && join(editorAssets, "index.html");
      else if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/canvas-assets/")) {
        const relative = decodeURIComponent(url.pathname.slice(1)),
          base = editorAssets && resolve(editorAssets);
        path = base && resolve(base, relative);
        check(path && path.startsWith(base + sep), 400, "资源路径无效。");
      }
      check(
        path && existsSync(path) && statSync(path).isFile(),
        404,
        "页面资源未构建，请先运行 Workspace build。",
      );
      response.writeHead(200, {
        "Content-Type":
          contentTypes[extname(path)] || "application/octet-stream",
        "Cache-Control":
          extname(path) === ".html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
      });
      if (request.method === "HEAD") response.end();
      else
        createReadStream(path)
          .on("error", () => response.destroy())
          .pipe(response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 503;
      if (!(error instanceof HttpError))
        console.error("Workspace request failed:", error.code || error.name);
      send(response, status, {
        error:
          error instanceof HttpError
            ? error.message
            : "业务服务暂时不可用，请稍后重试。",
      });
    } finally {
      finish?.();
    }
  }
  async function handleUpgrade(request, socket, head) {
    if (!publicAvailable()) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      check(
        request.url?.split("?")[0] === "/collaboration" &&
          request.headers.origin === config.publicUrl &&
          request.headers.host?.toLowerCase() === new URL(config.publicUrl).host,
        403,
        "WebSocket 来源无效。",
      );
      await session(request);
      if (socket.destroyed) return;
      check(publicAvailable(), 503, "工作空间正在关闭。");
      const target = new URL(config.collabUrl),
        outgoing = httpRequest(target, {
          path: "/",
          headers: { ...request.headers, host: target.host },
        });
      outgoing.on("upgrade", (upstream, other, buffer) => {
        const lines = [
          `HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}`,
          ...Object.entries(upstream.headers).map(
            ([key, value]) => `${key}: ${value}`,
          ),
          "",
          "",
        ];
        socket.write(lines.join("\r\n"));
        if (buffer.length) socket.write(buffer);
        if (head.length) other.write(head);
        socket.pipe(other);
        other.pipe(socket);
        socket.on("error", () => other.destroy());
        other.on("error", () => socket.destroy());
        other.on("close", () => socket.destroy());
        socket.on("close", () => other.destroy());
      });
      outgoing.on("response", () => socket.destroy());
      outgoing.on("error", () => socket.destroy());
      outgoing.end();
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  }
  const server = createServer(handleRequest);
  server.on("upgrade", handleUpgrade);
  server.requestTimeout = 180_000;
  server.headersTimeout = 30_000;
  return { server, handleRequest, handleUpgrade, provider, engine, session, createDesktopSession,
    pauseForBackup() {
      backupPaused = true;
      return Promise.allSettled([...admitted, workbenchJobs.pause()]);
    },
    pauseProviderCallbacks() {
      callbacksPaused = true;
      return Promise.allSettled([...callbacks]);
    },
    async resumeAgentJobs() {
      backupPaused = false;
      callbacksPaused = false;
      if (workspace.selectionMcp) await workbenchJobs.resume();
    } };
}
