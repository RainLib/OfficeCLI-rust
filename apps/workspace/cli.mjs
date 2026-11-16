#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  Store,
  atomic,
  check,
  random,
  passwordHash,
  iso,
} from "./src/store.mjs";
import { createWorkspaceServer } from "./src/server.mjs";

const here = dirname(fileURLToPath(import.meta.url)),
  repo = resolve(here, "../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    "public-url": { type: "string" },
    "bind-host": { type: "string" },
    "engine-port": { type: "string" },
    "collab-port": { type: "string" },
    admin: { type: "string" },
    "password-env": { type: "string" },
    officecli: { type: "string" },
    assets: { type: "string" },
    "sidecar-script": { type: "string" },
    name: { type: "string" },
  },
});
const command = positionals[0],
  root = values.root && resolve(values.root);
let store,
  server,
  children = [],
  closing = false;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  if (server) server.close();
  const waits = children.map(async (child) => {
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    const ended = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    timer.unref();
    try {
      await ended;
    } finally {
      clearTimeout(timer);
    }
  });
  await Promise.all(waits);
  server?.closeAllConnections();
  store?.close();
  process.exitCode = code;
}
try {
  check(root, 400, "请指定 --root。");
  if (command === "init") {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    check(
      !existsSync(join(root, "config.json")) &&
        !existsSync(join(root, "business.sqlite")),
      409,
      "此目录已初始化，请使用 start；已有数据不会覆盖。",
    );
    const url = new URL(values["public-url"] || "http://127.0.0.1:7400");
    check(
      ["http:", "https:"].includes(url.protocol) &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password,
      400,
      "public-url 必须是无路径、无凭据的 HTTP(S) origin。",
    );
    check(
      url.protocol === "https:" ||
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      400,
      "非 loopback 部署请使用 HTTPS public-url。",
    );
    const publicPort = Number(
        url.port || (url.protocol === "https:" ? 443 : 80),
      ),
      enginePort = Number(values["engine-port"] || publicPort + 1),
      collabPort = Number(values["collab-port"] || publicPort + 2);
    check(
      [publicPort, enginePort, collabPort].every(
        (p) => Number.isInteger(p) && p > 0 && p < 65536,
      ) && new Set([publicPort, enginePort, collabPort]).size === 3,
      400,
      "三个端口必须有效且不同。",
    );
    const username = values.admin || "admin";
    check(
      /^[a-z0-9_.-]{3,64}$/.test(username),
      400,
      "管理员账号需为 3–64 位小写字母、数字或 ._-。",
    );
    const password = await passwordHash(
      process.env[values["password-env"] || "OFFICECLI_BOOTSTRAP_PASSWORD"],
    );
    const keys = {
      jwt: random(),
      provider: random(),
      service: random(),
      events: random(),
      objects: random(),
      dummyPassword: await passwordHash(random()),
    };
    const config = {
      schemaVersion: "officecli-workspace/1",
      name: values.name || "OfficeCLI 工作空间",
      tenantId: "default",
      appId: "workspace",
      publicUrl: url.origin,
      bindHost: values["bind-host"] || "127.0.0.1",
      port: publicPort,
      callbackUrl: `http://127.0.0.1:${publicPort}`,
      engineUrl: `http://127.0.0.1:${enginePort}`,
      collabUrl: `http://127.0.0.1:${collabPort}`,
    };
    // The secrets file is written first; an interrupted init can be inspected
    // without ever starting with an absent or regenerated signing identity.
    atomic(join(root, "keys.json"), JSON.stringify(keys, null, 2) + "\n");
    store = new Store(root);
    store.transaction(() => {
      const id = randomUUID();
      store.run(
        "INSERT INTO users VALUES(?,?,?,?,?,0,?)",
        id,
        username,
        "工作空间管理员",
        password,
        "admin",
        iso(),
      );
      store.audit(id, "workspace.initialized");
    });
    atomic(join(root, "config.json"), JSON.stringify(config, null, 2) + "\n");
    store.close();
    store = null;
    console.log(
      `工作空间已初始化：${url.origin}\n管理员：${username}\n使用 node apps/workspace/cli.mjs start --root <目录> 启动。`,
    );
  } else if (command === "start") {
    const config = JSON.parse(readFileSync(join(root, "config.json"))),
      keys = JSON.parse(readFileSync(join(root, "keys.json")));
    check(
      config.schemaVersion === "officecli-workspace/1",
      400,
      "工作空间配置版本不兼容。",
    );
    check(
      ["jwt", "provider", "service", "events", "objects"].every(
        (key) =>
          typeof keys[key] === "string" && Buffer.byteLength(keys[key]) >= 32,
      ) &&
        new Set(
          ["jwt", "provider", "service", "events", "objects"].map(
            (key) => keys[key],
          ),
        ).size === 5,
      400,
      "工作空间密钥缺失或重复。",
    );
    // The persisted public port prevents two supervisors from serving this
    // root concurrently. The engine also holds its own root-level lock.
    const assets = resolve(values.assets || join(here, "dist"));
    const binary = resolve(
      values.officecli ||
        (existsSync(join(assets, "officecli"))
          ? join(assets, "officecli")
          : join(repo, "target/debug/officecli")),
    );
    const sidecar = resolve(
      values["sidecar-script"] || join(assets, "sidecar.cjs"),
    );
    check(
      [
        binary,
        sidecar,
        join(assets, "admin/index.html"),
        join(assets, "editor/index.html"),
      ].every(existsSync),
      400,
      "构建产物不完整，请先执行 node apps/workspace/scripts/build.mjs。",
    );
    store = new Store(root);
    const runtime = createWorkspaceServer({
      store,
      config,
      keys,
      adminAssets: join(assets, "admin"),
      editorAssets: join(assets, "editor"),
    });
    server = runtime.server;
    await new Promise((yes, no) => {
      server.once("error", no);
      server.listen(config.port, config.bindHost, yes);
    });
    const integration = {
      schemaVersion: "officecli-integration/1",
      tenantId: config.tenantId,
      appId: config.appId,
      providerUrl: config.callbackUrl,
      keyId: "provider-1",
      providerSecretEnv: "HCD_WORKSPACE_PROVIDER_SECRET",
      serviceSecretEnv: "HCD_WORKSPACE_SERVICE_SECRET",
      transferOrigins: [config.callbackUrl],
      events: {
        url: config.callbackUrl + "/officecli-events/v1/events",
        keyId: "event-1",
        secretEnv: "HCD_WORKSPACE_EVENT_SECRET",
      },
    };
    const configPath = join(root, "engine-integration.json");
    atomic(configPath, JSON.stringify(integration, null, 2) + "\n");
    const env = {
      ...process.env,
      HCD_TOKEN_SECRET: keys.jwt,
      HCD_WORKSPACE_PROVIDER_SECRET: keys.provider,
      HCD_WORKSPACE_SERVICE_SECRET: keys.service,
      HCD_WORKSPACE_EVENT_SECRET: keys.events,
      HCD_API_URL: config.engineUrl,
      HCD_COLLAB_PORT: new URL(config.collabUrl).port,
    };
    // Defaults must be repeatable and work with no developer cloud credentials.
    for (const key of [
      "HCD_DATABASE_URL",
      "HCD_S3_BUCKET",
      "HCD_DEFAULT_THEME",
      "OPENAI_API_KEY",
      "RAINY_OPENAI_API_KEY",
    ])
      delete env[key];
    // Disable before any credential discovery, including developer-home files.
    env.HCD_AI_ENABLED = "false";
    env.HCD_COLLAB_BIND = "127.0.0.1";
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    function start(executable, args) {
      const child = spawn(executable, args, {
        env,
        stdio: ["ignore", "inherit", "inherit"],
      });
      children.push(child);
      child.once("error", () => void stop(1));
      child.once("exit", () => {
        if (!closing) {
          console.error("工作空间子服务已退出，正在停止其余服务。");
          void stop(1);
        }
      });
      return child;
    }
    start(binary, [
      "hdoc",
      "serve",
      "--root",
      join(root, "engine"),
      "--bind",
      new URL(config.engineUrl).host,
      "--integration-config",
      configPath,
    ]);
    const deadline = Date.now() + 120_000;
    while (true) {
      check(!closing && Date.now() < deadline, 503, "编辑服务启动超时。");
      try {
        if (
          (
            await fetch(config.engineUrl + "/health", {
              signal: AbortSignal.timeout(1000),
            })
          ).ok
        )
          break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    start(process.execPath, [sidecar]);
    console.log(
      `OfficeCLI Workspace：${config.publicUrl}\n业务数据与编辑数据均保存在指定 root；AI 默认关闭。`,
    );
  } else
    throw new Error(
      "用法：node apps/workspace/cli.mjs <init|start> --root <目录> [--public-url URL] [--password-env NAME]",
    );
} catch (error) {
  console.error(error.message);
  await stop(1);
}
