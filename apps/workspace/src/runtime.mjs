import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store, atomic, check } from "./store.mjs";
import { createWorkspaceServer } from "./server.mjs";
import { captureWorkspace } from "./backup.mjs";

export function listen(server, port, host) {
  return new Promise((yes, no) => {
    const failed = (error) => {
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

async function bounded(work, signal) {
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

function collabCommand(child, type, id, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      child.off("message", message);
      child.off("disconnect", disconnected);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(result);
    };
    const disconnected = () => finish(new Error("协作服务已断开。"));
    const aborted = () => finish(signal.reason);
    const message = result => {
      if (result?.type === type && result.id === id)
        finish(result.error ? new Error(result.error) : null, result);
    };
    if (signal.aborted) return aborted();
    if (!child.connected) return disconnected();
    child.on("message", message);
    child.once("disconnect", disconnected);
    signal.addEventListener("abort", aborted, { once: true });
    child.send({ type, id }, error => { if (error) finish(error); });
  });
}

export function createRuntime(workspace, { assets, binary, sidecar, standby = false }, onFailure) {
  const { root, config, keys } = workspace;
  const children = [];
  let store,
    business,
    collab,
    backupTask,
    backupAbort,
    draining = false,
    ready = false,
    failure = false,
    stopped;
  const aiEnabled = process.env.OFFICECLI_AI_ENABLED === "true" && workspace.allowAI !== false;
  const aiModel = process.env.HCD_OPENAI_MODEL || "gpt-6.1-sol";

  function spawnService(executable, args, env, ipc = false) {
    const stdio = ["ignore", "inherit", "inherit", ...(ipc ? ["ipc"] : [])];
    const child = spawn(executable, args, { env, stdio });
    children.push(child);
    function failed() {
      if (stopped || failure) return;
      failure = true;
      ready = false;
      onFailure(config.tenantId);
    }
    child.once("error", failed);
    child.once("exit", failed);
    return child;
  }

  async function waitForService(url, label) {
    const deadline = Date.now() + 120_000;
    while (!stopped && !failure && Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "error" });
        await response.body?.cancel();
        if (response.ok && !stopped && !failure) return;
      } catch {}
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(config.name + " 的" + label + "未就绪。");
  }

  async function holdForBackup(id, copy, signal, shutdown = false) {
    const url = `${config.engineUrl}/integration/v1/backup-leases/${id}`;
    const headers = { Authorization: `Bearer ${keys.service}` };
    const prep = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    const removeLease = () => fetch(url, { method: "DELETE", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
    let releaseConfirmed = false;
    let heldUntilShutdown = false;
    try {
      await bounded(business.pauseForBackup(), prep);
      const paused = await collabCommand(collab, "backup-freeze", id, prep);
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
        try { await collabCommand(collab, "backup-resume", id, AbortSignal.timeout(5000)); }
        finally { if (!standby) business.resumeAgentJobs(); }
      }
    }
  }

  function snapshot(id) {
    check(ready && !stopped && !standby && !draining, 503, "工作空间未就绪。");
    check(!backupTask, 409, "已有在线备份进行中。");
    backupAbort = new AbortController();
    const { signal } = backupAbort;
    backupTask = captureWorkspace({ root, store, config, id, signal, hold: copy => holdForBackup(id, copy, signal) })
      .finally(() => { backupTask = null; backupAbort = null; });
    return backupTask;
  }

  async function start() {
    check(!stopped, 503, "工作空间启动已结束。");
    store = new Store(root);
    business = createWorkspaceServer({
      store,
      config,
      keys,
      captureBackup: snapshot,
      publicAvailable: () => ready && !standby,
      adminAssets: join(assets, "admin"),
      editorAssets: join(assets, "editor"),
      modelIds: aiEnabled ? [aiModel] : [],
      workbenchModel: config.selectionMcp && workspace.allowAI !== false && process.env.OFFICECLI_WORKBENCH_OLLAMA_MODEL
        ? {name:process.env.OFFICECLI_WORKBENCH_OLLAMA_MODEL,url:process.env.OFFICECLI_WORKBENCH_OLLAMA_URL || "http://127.0.0.1:11434"} : null,
    });
    await listen(business.server, config.port, config.bindHost);
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
    const env = {
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
      ...(aiEnabled ? [] : ["OPENAI_API_KEY", "RAINY_OPENAI_API_KEY"]),
    ])
      delete env[key];
    // Disable before any credential discovery, including developer-home files.
    env.HCD_AI_ENABLED = aiEnabled ? "true" : "false";
    env.HCD_COLLAB_BIND = new URL(config.collabUrl).hostname.replace(/^\[|\]$/g, "");
    env.HCD_LOCAL_WORKSPACE_BACKUP = "true";
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
    collab = spawnService(process.execPath, [sidecar], env, true);
    await waitForService(config.collabUrl, "协作服务");
    ready = true;
    if (!standby) business.resumeAgentJobs();
  }

  function activate() {
    check(ready && !draining && !stopped, 503, "工作空间未通过启动检查。");
    standby = false;
    business.resumeAgentJobs();
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
      store?.close();
    });
    return stopped;
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
    handleRequest: (...args) => business.handleRequest(...args),
    handleUpgrade: (...args) => business.handleUpgrade(...args),
  };
}
