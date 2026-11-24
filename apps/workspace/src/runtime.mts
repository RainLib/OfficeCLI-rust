import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import type { Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Store, atomic, check } from "./store.mts";
import { databaseEnvKeys } from "./database.mts";
import { createWorkspaceServer } from "./server.mjs";
import { createCollaborationPool } from "./collaboration.mts";
import { errorMessage } from "./contracts.mts";
import type { Workspace } from "./contracts.mts";

export function listen(server: Server, port: number, host: string) {
  return new Promise<void>((yes, no) => {
    const failed = (error: Error) => {
      server.off("listening", listening);
      no(error);
    };
    const listening = () => {
      server.off("error", failed);
      yes();
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, host);
  });
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal) {
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { if (abort) signal.removeEventListener("abort", abort); }
}

type CollabCommand = "backup-freeze" | "backup-resume";

function collabCommand(child: ChildProcess, type: CollabCommand, id: string, signal: AbortSignal) {
  return new Promise<{ flushed?: number }>((resolve, reject) => {
    const finish = (result: { flushed?: number } | Error) => {
      child.off("message", message);
      child.off("disconnect", disconnected);
      signal.removeEventListener("abort", aborted);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const disconnected = () => finish(new Error("协作服务已断开。"));
    const aborted = () => finish(signal.reason instanceof Error ? signal.reason : new Error(errorMessage(signal.reason)));
    const message = (result: unknown) => {
      if (!result || typeof result !== "object" || !("type" in result) || result.type !== type || !("id" in result) || result.id !== id) return;
      if ("error" in result && typeof result.error === "string" && result.error) finish(new Error(result.error));
      else finish({ flushed: "flushed" in result && typeof result.flushed === "number" ? result.flushed : undefined });
    };
    if (signal.aborted) return aborted();
    if (!child.connected) return disconnected();
    child.on("message", message);
    child.once("disconnect", disconnected);
    signal.addEventListener("abort", aborted, { once: true });
    child.send({ type, id }, error => { if (error) finish(error); });
  });
}

interface RuntimeOptions {
  assets: string;
  binary: string;
  sidecar: string;
  standby?: boolean;
  privateEnv?: readonly string[];
}

export function createRuntime(workspace: Workspace, { assets, binary, sidecar, standby = false, privateEnv = [] }: RuntimeOptions, onFailure: (tenantId: string) => void) {
  const { root, config, keys } = workspace;
  const children: ChildProcess[] = [];
  let store: Store | undefined;
  let business: ReturnType<typeof createWorkspaceServer> | undefined;
  let collab: ChildProcess | undefined;
  let backupTask: Promise<unknown> | undefined;
  let backupAbort: AbortController | undefined;
  let stopped: Promise<void> | undefined;
  let draining = false, ready = false, failure = false;
  const desktop = config.mode === "desktop";
  const pool = createCollaborationPool(workspace);
  const aiEnabled = !desktop && process.env.OFFICECLI_AI_ENABLED === "true" && workspace.allowAI !== false;
  const aiModel = process.env.HCD_OPENAI_MODEL || "gpt-6.1-sol";

  function failed() {
    if (stopped || failure) return;
    failure = true;
    ready = false;
    onFailure(config.tenantId);
  }

  function spawnService(executable: string, args: string[], env: NodeJS.ProcessEnv, ipc = false) {
    const stdio: StdioOptions = ipc ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "inherit", "inherit"];
    const child = spawn(executable, args, { env, stdio });
    children.push(child);
    child.once("error", failed);
    child.once("exit", failed);
    return child;
  }

  async function waitForService(url: string, label: string) {
    const deadline = Date.now() + 120_000;
    let interval = 20;
    while (!stopped && !failure && Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "error" });
        await response.body?.cancel();
        if (response.ok && !stopped && !failure) return;
      } catch {}
      await delay(interval);
      interval = Math.min(interval * 2, 200);
    }
    throw new Error(config.name + " 的" + label + "未就绪。");
  }

  async function holdForBackup(id: string, copy: () => Promise<unknown>, signal: AbortSignal, shutdown = false) {
    check(business && (pool || collab), 503, "工作空间未就绪。");
    const url = `${config.engineUrl}/integration/v1/backup-leases/${id}`;
    const headers = { Authorization: `Bearer ${keys.service}` };
    const prep = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    const removeLease = () => fetch(url, { method: "DELETE", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
    let releaseConfirmed = false;
    let heldUntilShutdown = false;
    try {
      await bounded(business.pauseForBackup(), prep);
      const paused = await (pool ? pool.freeze(id, prep) : collabCommand(collab!, "backup-freeze", id, prep));
      check(typeof paused.flushed === "number" && Number.isSafeInteger(paused.flushed), 503, "协作服务未确认落盘。");
      while (true) {
        prep.throwIfAborted();
        const response = await fetch(url, { method: "PUT", headers, redirect: "error", signal: prep });
        await response.body?.cancel();
        if (response.status === 204) break;
        check(response.status === 409, 503, "编辑服务未能开启备份写入屏障。");
        await delay(125, undefined, { signal: prep });
      }
      await bounded(business.pauseProviderCallbacks(), prep);
      const capturedAt = new Date().toISOString();
      await copy();
      signal.throwIfAborted();
      if (shutdown) heldUntilShutdown = true;
      else {
        releaseConfirmed = (await removeLease()).status === 204;
        check(releaseConfirmed, 503, "备份取点超时，快照未生成。");
      }
      return { capturedAt, collaborationRooms: paused.flushed };
    } finally {
      if (!heldUntilShutdown) {
        if (!releaseConfirmed) await removeLease().then(result => result.body?.cancel()).catch(() => {});
        try {
          const timeout = AbortSignal.timeout(5000);
          if (pool) await pool.resume(id, timeout);
          else await collabCommand(collab!, "backup-resume", id, timeout);
        }
        finally { if (!standby) await business.resumeAgentJobs(); }
      }
    }
  }

  function snapshot(id: string) {
    const currentStore = store;
    check(currentStore && ready && !stopped && !standby && !draining, 503, "工作空间未就绪。");
    check(!backupTask, 409, "已有在线备份进行中。");
    backupAbort = new AbortController();
    const { signal } = backupAbort;
    backupTask = import("./backup.mjs")
      .then(({ captureWorkspace }) => captureWorkspace({
        root, config, id, signal, copyDatabase: (path: string) => currentStore.exportDatabase(path, signal),
        hold: (copy: () => Promise<unknown>) => holdForBackup(id, copy, signal),
      }))
      .finally(() => { backupTask = undefined; backupAbort = undefined; });
    return backupTask;
  }

  async function start() {
    check(!stopped, 503, "工作空间启动已结束。");
    check(!standby || !config.database, 409, "托管版本切换使用本机 SQLite。远程数据库可以用 Compose 或直接启动。");
    const opened = await Store.open(root, { database: config.database, onFailure: failed });
    if (stopped || failure) {
      await opened.close();
      check(false, 503, "工作空间启动已结束。");
    }
    store = opened;
    business = createWorkspaceServer({
      store,
      config,
      keys,
      captureBackup: snapshot,
      collaborationTarget: pool?.target,
      publicAvailable: () => ready && !standby,
      adminAssets: join(assets, "admin"),
      editorAssets: join(assets, "editor"),
      modelIds: aiEnabled ? [aiModel] : [],
      workbenchModel: !desktop && config.selectionMcp && workspace.allowAI !== false && process.env.OFFICECLI_WORKBENCH_OLLAMA_MODEL
        ? {name:process.env.OFFICECLI_WORKBENCH_OLLAMA_MODEL,url:process.env.OFFICECLI_WORKBENCH_OLLAMA_URL || "http://127.0.0.1:11434"} : null,
    });
    await listen(business.server, config.port, config.bindHost);
    if (pool) await listen(pool.bridge, pool.bridgePort, config.bindHost);
    check(!stopped, 503, "工作空间启动已结束。");
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HCD_TOKEN_SECRET: keys.jwt,
      HCD_WORKSPACE_PROVIDER_SECRET: keys.provider,
      HCD_WORKSPACE_SERVICE_SECRET: keys.service,
      HCD_WORKSPACE_EVENT_SECRET: keys.events,
      HCD_API_URL: config.engineUrl,
      HCD_COLLAB_PORT: new URL(config.collabUrl).port,
      HCD_OPENAI_MODEL: aiModel,
    };
    // Defaults must be repeatable and work with no developer cloud credentials.
    for (const key of [
      "HCD_DATABASE_URL",
      "HCD_S3_BUCKET",
      "HCD_DEFAULT_THEME",
      "FOLDLY_COLLABORATION_KEY_FILE",
      ...databaseEnvKeys(),
      ...privateEnv,
      ...(aiEnabled ? [] : ["OPENAI_API_KEY", "RAINY_OPENAI_API_KEY"]),
    ])
      delete env[key];
    // Disable before any credential discovery, including developer-home files.
    env.HCD_AI_ENABLED = aiEnabled ? "true" : "false";
    env.HCD_COLLAB_BIND = new URL(config.collabUrl).hostname.replace(/^\[|\]$/g, "");
    env.HCD_LOCAL_WORKSPACE_BACKUP = "true";
    env.HCD_WORKSPACE_COLLABORATION = pool ? "true" : "false";
    spawnService(
      binary,
      [
        "hdoc",
        "serve",
        "--root",
        join(root, "engine"),
        "--bind",
        new URL(config.engineUrl).host,
        "--integration-config",
        configPath,
      ],
      env,
    );
    await waitForService(config.engineUrl + "/health", "编辑服务");
    if (pool) {
      const deadline = Date.now() + 120_000;
      while (!stopped && !failure && Date.now() < deadline) {
        if (await pool.ready().catch(() => false)) break;
        await delay(250);
      }
      check(!stopped && !failure && Date.now() < deadline, 503, "协作服务未就绪。");
    } else {
      collab = spawnService(process.execPath, [sidecar], env, true);
      await waitForService(config.collabUrl, "协作服务");
    }
    if (!standby) await business.resumeAgentJobs();
    ready = true;
  }

  async function activate() {
    check(business && ready && !draining && !stopped, 503, "工作空间未通过启动检查。");
    standby = false;
    await business.resumeAgentJobs();
  }

  async function drain() {
    check(ready && !standby && !draining && !stopped && !backupTask, 409, "工作空间当前无法切换版本，请等待备份等任务完成。");
    draining = true;
    let cut;
    try { cut = await holdForBackup(randomUUID(), async () => {}, new AbortController().signal, true); }
    catch (error) { draining = false; throw error; }
    await stop();
    return cut;
  }

  function stop() {
    if (stopped) return stopped;
    ready = false;
    stopped = Promise.resolve().then(async () => {
      backupAbort?.abort();
      await backupTask?.catch(() => {});
      business?.server.close();
      await pool?.stop();
      await Promise.all(
        children.map(async (child) => {
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
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
        }),
      );
      business?.server.closeAllConnections();
      await store?.close();
    });
    return stopped;
  }
  function service() {
    check(business, 503, "工作空间未就绪。");
    return business;
  }
  return {
    config,
    start,
    stop,
    activate,
    drain,
    get ready() {
      return ready && !standby;
    },
    createDesktopSession: () => service().createDesktopSession(),
    handleRequest: (...args: Parameters<ReturnType<typeof createWorkspaceServer>["handleRequest"]>) => service().handleRequest(...args),
    handleUpgrade: (...args: Parameters<ReturnType<typeof createWorkspaceServer>["handleUpgrade"]>) => service().handleUpgrade(...args),
  };
}
