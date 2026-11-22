#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { check } from "./src/store.mjs";
import { createRuntime, listen } from "./src/runtime.mjs";
import { initializeWorkspace } from "./src/initialize.mjs";
import { runDesktop } from "./src/desktop.mjs";
import { requestOnlineBackup, restoreBackup, verifyBackup } from "./src/backup.mjs";
import { connectDeploymentChild, deploymentCommand, installDeployment, isDeploymentChild, runDeployment } from "./src/deployment.mjs";
import { verifyRelease } from "./src/release.mjs";
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
    output: { type: "string" },
    backup: { type: "string" },
    deployment: { type: "string" },
    release: { type: "string" },
    to: { type: "string" },
  },
});
const command = positionals[0],
  root = values.root && resolve(values.root);
let gateway,
  shutdown,
  started = false;
const runtimes = [];
function stop(code = 0) {
  if (!shutdown) {
    process.exitCode = code;
    gateway?.close();
    shutdown = Promise.all(runtimes.map((rt) => rt.stop())).finally(() => {
      if (isDeploymentChild()) process.disconnect();
    });
  }
  return shutdown;
}
try {
  if (command === "desktop") {
    check(root && process.connected, 400, "桌面工作区只能由本机客户端通过进程通道启动。");
    await runDesktop(root, join(here, "dist"));
  } else if (command === "release-info") {
    const { manifest, root: path } = await verifyRelease(values.release || dirname(here));
    const { files, ...identity } = manifest;
    console.log(JSON.stringify({ ...identity, path, files: files.length }, null, 2));
  } else if (command === "install") {
    check(values.deployment && !root && !values.tenants, 400, "安装需要 --deployment <新目录>，可指定 --backup 恢复已有工作区。");
    const init = [];
    for (const option of ["tenant-id", "app-id", "public-url", "port", "bind-host", "engine-port", "collab-port", "admin", "password-env", "name"])
      if (values[option] !== undefined) init.push("--" + option, values[option]);
    if (values["selection-mcp"]) init.push("--selection-mcp");
    console.log(JSON.stringify(await installDeployment({ path: values.deployment, release: values.release || dirname(here), backup: values.backup, init }), null, 2));
  } else if (command === "start" && values.deployment) {
    check(!root && !values.tenants && !values.assets && !values.officecli && !values["sidecar-script"],
      400, "托管部署按安装记录启动，直接工作区参数仅用于开发启动。");
    await runDeployment(values.deployment);
  } else if (["upgrade", "rollback", "deployment-status"].includes(command)) {
    check(values.deployment && !root && !values.tenants && (command !== "upgrade" || values.release),
      400, "切换或查看部署需要 --deployment；升级还需要 --release <发行包目录>。");
    const action = command === "deployment-status" ? "status" : command;
    console.log(JSON.stringify(await deploymentCommand(values.deployment, action, values.release && resolve(values.release), values.to), null, 2));
  } else if (command === "init") {
    check(root && !values.tenants, 400, "初始化工作空间需要 --root。");
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
    await initializeWorkspace(root, config, {
      username,
      displayName: "工作空间管理员",
      password: process.env[values["password-env"] || "OFFICECLI_BOOTSTRAP_PASSWORD"],
      role: "admin",
    });
    console.log(
      `工作空间已初始化：${url.origin}\n管理员：${username}\n使用 node apps/workspace/cli.mjs start --root <目录> 启动。`,
    );
  } else if (command === "backup") {
    check(root && values.output && !values.tenants, 400, "在线备份需要 --root <正在运行的工作区> --output <新目录>。");
    console.log(JSON.stringify(await requestOnlineBackup(readWorkspace(root), values.output), null, 2));
  } else if (command === "verify-backup") {
    check(values.backup, 400, "备份校验需要 --backup <备份目录>。");
    console.log(JSON.stringify(await verifyBackup(values.backup), null, 2));
  } else if (command === "restore") {
    check(root && values.backup && !values.tenants, 400, "恢复需要 --backup <备份目录> --root <新工作区目录>。");
    console.log(JSON.stringify(await restoreBackup(values.backup, root), null, 2));
  } else if (command === "start") {
    const standby = isDeploymentChild();
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
    check(workspaces.every(({ config }) => config.mode !== "desktop"), 409, "桌面工作区只能由本机客户端启动。");
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
        { assets, binary, sidecar, standby },
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
    if (standby) process.once("disconnect", () => void stop());
    if (values.tenants) {
      gateway = createTenantGateway(runtimes);
      await listen(gateway.server, port, values["bind-host"] || "127.0.0.1");
    }
    await Promise.all(runtimes.map((runtime) => runtime.start()));
    started = true;
    if (standby) await connectDeploymentChild(runtimes[0]);
    for (const { config } of workspaces)
      console.log(`OfficeCLI Workspace · ${config.name} · ${config.publicUrl}`);
  } else
    throw new Error(
      "命令包括 init、install、start、release-info、deployment-status、upgrade、rollback、backup、verify-backup、restore。参数见 Workspace README。",
    );
} catch (error) {
  console.error(error.message);
  await stop(1);
}
