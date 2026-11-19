import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { Store, atomic, check } from "./store.mjs";
import { createWorkspaceServer } from "./server.mjs";

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

export function createRuntime(workspace, { assets, binary, sidecar }, onFailure) {
  const { root, config, keys } = workspace;
  const children = [];
  let store,
    business,
    ready = false,
    failure = false,
    stopped;
  const aiEnabled = process.env.OFFICECLI_AI_ENABLED === "true" && workspace.allowAI !== false;
  const aiModel = process.env.HCD_OPENAI_MODEL || "gpt-6.1-sol";

  function spawnService(executable, args, env) {
    const child = spawn(executable, args, { env, stdio: ["ignore", "inherit", "inherit"] });
    children.push(child);
    function failed() {
      if (stopped || failure) return;
      failure = true;
      ready = false;
      onFailure(config.tenantId);
    }
    child.once("error", failed);
    child.once("exit", failed);
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

  async function start() {
    check(!stopped, 503, "工作空间启动已结束。");
    store = new Store(root);
    business = createWorkspaceServer({
      store,
      config,
      keys,
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
    spawnService(process.execPath, [sidecar], env);
    await waitForService(config.collabUrl, "协作服务");
    ready = true;
  }

  function stop() {
    if (stopped) return stopped;
    ready = false;
    stopped = Promise.resolve().then(async () => {
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
    get ready() {
      return ready;
    },
    handleRequest: (...args) => business.handleRequest(...args),
    handleUpgrade: (...args) => business.handleUpgrade(...args),
  };
}
