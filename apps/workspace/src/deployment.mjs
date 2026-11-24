import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { once } from "node:events";
import { chmod, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { restoreBackup, snapshotAfterShutdown } from "./backup.mjs";
import { installRelease, releaseId, verifyRelease } from "./release.mjs";
import { listen } from "./runtime.mts";
import { atomic, check, equal, HttpError, random, uuid, workspaceSchemaVersion } from "./store.mts";
import { readWorkspace } from "./tenants.mts";
import { deploymentChildFlag } from "./contracts.mts";

const schema = "officecli-workspace-deployment/1";
const stateFile = "deployment.json", secretFile = "control.key";
const validPair = pair => pair && releaseId(pair.release) && uuid(pair.data);
const pointer = (root, state) => atomic(join(root, stateFile), JSON.stringify(state, null, 2) + "\n");
const dataRoot = (root, pair) => join(root, "workspaces", pair.data);
const kitRoot = (root, id) => join(root, "releases", id);
const running = child => child?.pid && child.exitCode === null && child.signalCode === null;

async function readDeployment(path) {
  const root = await realpath(path);
  const state = JSON.parse(await readFile(join(root, stateFile), "utf8"));
  const key = (await readFile(join(root, secretFile), "utf8")).trim();
  check(state?.schemaVersion === schema && releaseId(state.controller) && validPair(state.active) &&
    (!state.previous || validPair(state.previous)) && Number.isInteger(state.port) && state.port > 0 && state.port < 65536 &&
    /^[a-zA-Z0-9_-]{43}$/.test(key), 409, "部署记录或控制凭据无效。");
  return { root, state, key };
}

async function availablePort() {
  const reservation = socketServer();
  await listen(reservation, 0, "127.0.0.1");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

export async function installDeployment({ path, release, backup, init }) {
  const verified = await verifyRelease(release);
  check(verified.manifest.workspaceSchema === workspaceSchemaVersion, 409, "发行包的存储版本不兼容。");
  const root = resolve(path);
  await mkdir(root, { mode: 0o700 });
  try {
    for (const child of ["releases", "workspaces", "backups", "operations"]) await mkdir(join(root, child), { mode: 0o700 });
    const kit = await installRelease(root, verified);
    const active = { release: kit.manifest.id, data: randomUUID() };
    if (backup) {
      const target = dataRoot(root, active);
      await restoreBackup(backup, target);
      check(readWorkspace(target).config.mode !== "desktop", 409, "桌面备份不能用于托管部署。");
    } else {
      const child = spawnSync(join(kit.root, "runtime/node"), [join(kit.root, "app/cli.mjs"), "init", "--root", dataRoot(root, active), ...init],
        { env: process.env, encoding: "utf8" });
      check(child.status === 0, 409, child.stderr?.trim() || "初始化托管工作区失败。");
    }
    const port = await availablePort();
    atomic(join(root, secretFile), random() + "\n", { exclusive: true });
    const state = { schemaVersion: schema, controller: kit.manifest.id, port, active, previous: null, lastOperation: null };
    const launcher = '#!/bin/sh\nset -eu\ndeployment=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\n' +
      `exec "$deployment/releases/${state.controller}/workspace" "$@" --deployment "$deployment"\n`;
    atomic(join(root, "workspace"), launcher, { exclusive: true });
    await chmod(join(root, "workspace"), 0o700);
    pointer(root, state);
    return { release: kit.manifest.id, path: root, data: active.data };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function reply(child, type, message, timeout) {
  return new Promise((resolve, reject) => {
    const fail = error => finish(error);
    const ended = () => fail(new Error("发行进程在完成启动或切换检查前退出。"));
    const receive = data => {
      if (data?.type === type && (!message || data.id === message.id))
        finish(data.error ? new Error(data.error) : null, data);
    };
    function finish(error, data) {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", ended);
      child.off("error", fail);
      if (error) reject(error);
      else resolve(data);
    }
    const timer = setTimeout(() => fail(new Error("等待发行进程响应超时。")), timeout);
    child.on("message", receive);
    child.once("exit", ended);
    child.once("error", fail);
    if (message) child.send(message, error => { if (error) finish(error); });
  });
}

async function terminate(child) {
  if (!running(child)) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try { await done; } finally { clearTimeout(timer); }
}

async function boot(root, pair, verified) {
  const kit = verified || await verifyRelease(kitRoot(root, pair.release));
  check(kit.manifest.id === pair.release && kit.manifest.workspaceSchema === workspaceSchemaVersion,
    409, "发行与数据版本不兼容。");
  const child = spawn(join(kit.root, "runtime/node"), [join(kit.root, "app/cli.mjs"), "start", "--root", dataRoot(root, pair)],
    { cwd: kit.root, env: { ...process.env, [deploymentChildFlag]: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
  // Node emits an error on failed spawn and on an IPC write to a dead child.
  child.on("error", () => {});
  try {
    const { engine, node } = await reply(child, "ready", null, 125_000);
    check(engine?.ok === true && engine.build?.version === kit.manifest.engine.version &&
      engine.protocolFingerprint === kit.manifest.engine.protocolFingerprint && node === kit.manifest.node,
    409, "运行时版本与发行清单不一致。");
    return { child, pair, manifest: kit.manifest };
  } catch (error) {
    await terminate(child);
    throw error;
  }
}

const tell = (child, type, timeout) => reply(child, type, { type, id: randomUUID() }, timeout);

async function drain(child) {
  const ending = new AbortController();
  const exited = once(child, "exit", { signal: AbortSignal.any([ending.signal, AbortSignal.timeout(125_000)]) });
  void exited.catch(() => {});
  try {
    const { cut } = await tell(child, "drain", 115_000);
    const [code] = await exited;
    check(code === 0 && cut && typeof cut.capturedAt === "string" && Number.isSafeInteger(cut.collaborationRooms),
      503, "旧版未完成协作落盘和安全退出。");
    return cut;
  } finally { ending.abort(); }
}

// Implemented by the installed release, so its own process owns its startup
// migrations and all filesystem writers drained during handoff.
export async function connectDeploymentChild(runtime) {
  process.on("message", async message => {
    if (!uuid(message?.id) || !["activate", "drain"].includes(message.type)) return;
    const { id, type } = message;
    try {
      if (type === "activate") {
        await runtime.activate();
        process.send?.({ type, id }, () => {});
      } else {
        const cut = await runtime.drain();
        process.send?.({ type, id, cut }, () => { if (process.connected) process.disconnect(); });
      }
    } catch (error) { process.send?.({ type, id, error: error.message }, () => {}); }
  });
  const response = await fetch(runtime.config.engineUrl + "/health", { redirect: "error", signal: AbortSignal.timeout(5000) });
  check(response.ok, 503, "引擎启动检查失败。");
  const engine = await response.json();
  if (process.connected) process.send({ type: "ready", node: process.version, engine }, () => {});
}

export async function runDeployment(path) {
  const { root, key, state: initial } = await readDeployment(path);
  let state = initial, live, transition, stopping, started = false;
  const read = () => ({ active: state.active, previous: state.previous, lastOperation: state.lastOperation,
    busy: !!transition, online: started && !!running(live?.child),
    ...(live && { version: live.manifest.version, engine: live.manifest.engine, node: live.manifest.node }) });

  function finish(code) {
    if (stopping) return stopping;
    process.exitCode = code;
    stopping = (async () => {
      control.close();
      await transition?.catch(() => {});
      // A normal service stop preserves collaboration edits just like upgrade.
      if (running(live?.child)) await drain(live.child).catch(() => terminate(live.child));
      control.closeAllConnections();
    })();
    return stopping;
  }

  async function startLive(pair, prepared) {
    const instance = prepared || await boot(root, pair);
    if (stopping) {
      await terminate(instance.child);
      throw new Error("部署管理进程正在退出。");
    }
    live = instance;
    instance.child.once("exit", () => {
      if (live === instance && !transition && !stopping) void finish(1);
    });
    try { await tell(instance.child, "activate", 5000); }
    catch (error) { await terminate(instance.child); throw error; }
    return instance;
  }

  async function change(action, requested) {
    const before = state.active;
    const id = randomUUID();
    const backup = join(root, "backups", id);
    const record = { id, action, before, startedAt: new Date().toISOString() };
    const log = result => atomic(join(root, "operations", `${id}.json`), JSON.stringify({ ...record, ...result }, null, 2) + "\n");
    const logResult = result => {
      try { log(result); }
      catch (error) { console.error("无法写入部署操作记录", id, error.code || error.name); }
    };
    let candidate, prepared, committed = false;
    try {
      if (action === "upgrade") {
        check(typeof requested === "string" && isAbsolute(requested), 400, "需要本机发行包路径。");
        const verified = await verifyRelease(requested);
        check(verified.manifest.id !== before.release, 409, "当前已运行此发行版本。");
        check(verified.manifest.workspaceSchema === workspaceSchemaVersion, 409, "发行包不支持当前工作区存储版本。");
        prepared = await installRelease(root, verified);
        candidate = { release: prepared.manifest.id, data: randomUUID() };
      } else {
        candidate = state.previous;
        check(validPair(candidate), 409, "没有可回滚的上一版本。");
        prepared = await verifyRelease(kitRoot(root, candidate.release));
      }
      log({ status: "prepared", candidate });
      const cut = await drain(live.child);
      await snapshotAfterShutdown(readWorkspace(dataRoot(root, before)), backup, cut);
      if (action === "upgrade") await restoreBackup(backup, dataRoot(root, candidate));
      let instance;
      try {
        instance = await boot(root, candidate, prepared);
        check(!stopping, 503, "管理进程正在退出。");
        const next = { ...state, active: candidate, previous: before, lastOperation: id };
        pointer(root, next);
        state = next;
        committed = true;
        await startLive(candidate, instance);
      } catch (error) {
        if (instance && !committed) await terminate(instance.child);
        throw error;
      }
      logResult({ status: "completed", candidate, snapshot: backup });
      return { ...read(), operation: id, snapshot: backup };
    } catch (error) {
      logResult({ status: committed ? "activation_failed" : "failed", candidate, error: error.message });
      if (!committed && !running(live?.child) && !stopping) {
        try { await startLive(before); }
        catch (restoreError) { void finish(1); throw restoreError; }
        logResult({ status: "restored_previous", candidate, error: error.message });
        throw new HttpError(409, `目标版本启动失败，已恢复原版本（${error.message}）。`);
      }
      if (committed && !running(live?.child)) void finish(1);
      throw error;
    }
  }

  const control = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      check(!req.headers.origin && equal(req.headers.authorization || "", `Bearer ${key}`), 404, "接口不存在。");
      if (req.method === "GET" && req.url === "/status") return send(200, read());
      const action = req.url?.slice(1);
      check(req.method === "POST" && ["upgrade", "rollback"].includes(action), 404, "接口不存在。");
      check(started && !stopping && !transition && running(live?.child), 409, "部署尚未就绪或正在切换。");
      let input = "";
      for await (const chunk of req) { input += chunk.toString("utf8"); check(Buffer.byteLength(input) <= 16_384, 413, "部署请求过大。"); }
      const { release, target, expectedData } = JSON.parse(input);
      check(!stopping && !transition && running(live?.child), 409, "部署尚未就绪或正在切换。");
      if (action === "rollback" && target !== undefined) {
        check(uuid(target), 400, "回滚目标应为数据版本 ID。");
        if (target === state.active.data) return send(200, { ...read(), alreadyActive: true });
        check(target === state.previous?.data, 409, "目标已不是记录中的上一组数据，请重新核对部署状态。");
      }
      check(expectedData === state.active.data, 409, "部署状态已变化，请重新核对当前发行与数据版本。");
      transition = change(action, release);
      try { return send(200, await transition); }
      finally { transition = null; }
    } catch (error) { send(error.status || 503, { error: error.message }); }
  });
  control.requestTimeout = 180_000;
  await listen(control, state.port, "127.0.0.1");
  process.once("SIGTERM", () => void finish(0));
  process.once("SIGINT", () => void finish(0));
  try {
    await startLive(state.active);
    started = true;
    console.log(`OfficeCLI Workspace · ${live.manifest.id}`);
  } catch (error) {
    await finish(1);
    throw error;
  }
}

export async function deploymentCommand(path, command, release, target) {
  const { state, key } = await readDeployment(path);
  const read = command === "status";
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${state.port}/${command}`, {
      method: read ? "GET" : "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(read ? {} : { body: JSON.stringify({ release, target, expectedData: state.active.data }) }),
      redirect: "error", signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (error) {
    if (read && error.cause?.code === "ECONNREFUSED") return { active: state.active, previous: state.previous, lastOperation: state.lastOperation, online: false };
    throw new Error("无法连接本机部署控制进程，请确认部署已启动。", { cause: error });
  }
  const result = await response.json();
  check(response.ok, response.status, result.error || "部署切换失败。");
  return result;
}
