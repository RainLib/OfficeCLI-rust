#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  Store,
  atomic,
  check,
  random,
  passwordHash,
  iso,
} from "./src/store.mjs";
import { createRuntime, listen } from "./src/runtime.mjs";
import {
  bindAddress,
  createTenantGateway,
  publicOrigin,
  readTenantRegistry,
  readWorkspace,
  validIdentity,
} from "./src/tenants.mjs";

const here = dirname(fileURLToPath(import.meta.url)),
  repo = resolve(here, "../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    tenants: { type: "string" },
    port: { type: "string" },
    "selection-mcp": { type: "boolean" },
    "tenant-id": { type: "string" },
    "app-id": { type: "string" },
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
  gateway,
  shutdown,
  started = false;
const runtimes = [];
function stop(code = 0) {
  if (!shutdown) {
    process.exitCode = code;
    gateway?.close();
    shutdown = Promise.all(runtimes.map((rt) => rt.stop())).finally(() =>
      store?.close(),
    );
  }
  return shutdown;
}
try {
  if (command === "init") {
    check(root && !values.tenants, 400, "初始化工作空间需要 --root。");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    check(
      !existsSync(join(root, "config.json")) &&
        !existsSync(join(root, "business.sqlite")) &&
        !existsSync(join(root, "keys.json")),
      409,
      "此目录已初始化，请使用 start；已有数据不会覆盖。",
    );
    const url = publicOrigin(values["public-url"] || "http://127.0.0.1:7400");
    const tenantId = values["tenant-id"] ?? "default",
      appId = values["app-id"] ?? "workspace";
    check(
      validIdentity(tenantId) && validIdentity(appId),
      400,
      "租户和应用标识需为 1–256 个字符。",
    );
    const publicPort = Number(
        values.port ?? (url.port || (url.protocol === "https:" ? 443 : 80)),
      ),
      enginePort = Number(values["engine-port"] || publicPort + 1),
      collabPort = Number(values["collab-port"] || publicPort + 2);
    const bindHost = bindAddress(values["bind-host"] || "127.0.0.1");
    const internalHost = bindHost === "::1" ? "[::1]" : "127.0.0.1";
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
      tenantId,
      appId,
      publicUrl: url.origin,
      selectionMcp: values["selection-mcp"] === true,
      bindHost,
      port: publicPort,
      callbackUrl: `http://${internalHost}:${publicPort}`,
      engineUrl: `http://${internalHost}:${enginePort}`,
      collabUrl: `http://${internalHost}:${collabPort}`,
    };
    // The secrets file is written first; an interrupted init can be inspected
    // without ever starting with an absent or regenerated signing identity.
    atomic(join(root, "keys.json"), JSON.stringify(keys, null, 2) + "\n", {
      exclusive: true,
    });
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
    check(
      Boolean(root) !== Boolean(values.tenants),
      400,
      "请选择 --root <目录> 或 --tenants <租户清单>。",
    );
    const port = Number(values.port ?? 7400);
    check(
      Number.isInteger(port) && port > 0 && port < 65536,
      400,
      "监听端口无效。",
    );
    const workspaces = values.tenants
      ? readTenantRegistry(resolve(values.tenants), port)
      : [readWorkspace(root)];
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
    for (const workspace of workspaces) {
      const runtime = createRuntime(
        workspace,
        { assets, binary, sidecar },
        (tenant) => {
          console.error(`工作空间 ${tenant} 的子服务已退出。`);
          if (values.tenants && started) void runtime.stop();
          else void stop(1);
        },
      );
      runtimes.push(runtime);
    }
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
    if (values.tenants) {
      gateway = createTenantGateway(runtimes);
      await listen(gateway.server, port, values["bind-host"] || "127.0.0.1");
    }
    await Promise.all(runtimes.map((runtime) => runtime.start()));
    started = true;
    for (const { config } of workspaces)
      console.log(`OfficeCLI Workspace · ${config.name} · ${config.publicUrl}`);
  } else
    throw new Error(
      "用法：node apps/workspace/cli.mjs init --root <目录> 或 start (--root <目录> | --tenants <清单>)",
    );
} catch (error) {
  console.error(error.message);
  await stop(1);
}
