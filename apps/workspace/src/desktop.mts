import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { initializeWorkspace } from "./initialize.mts";
import { createRuntime, listen } from "./runtime.mts";
import { check, random } from "./store.mts";
import { readWorkspace } from "./tenants.mts";
import { errorMessage } from "./contracts.mts";

const loopback = "127.0.0.1";
const origin = (port: number) => `http://${loopback}:${port}`;

async function initializeDesktop(root: string) {
  const servers = [createServer(), createServer(), createServer()];
  let ports;
  try {
    for (const server of servers) await listen(server, 0, loopback);
    ports = servers.map(server => {
      const address = server.address();
      check(address && typeof address === "object", 503, "无法取得桌面工作区端口。");
      return address.port;
    });
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
  const [port, enginePort, collabPort] = ports;
  await initializeWorkspace(root, {
    schemaVersion: "officecli-workspace/1",
    mode: "desktop",
    name: "折页本地工作空间",
    tenantId: "local-" + randomUUID(),
    appId: "foldly-desktop",
    publicUrl: origin(port),
    callbackUrl: origin(port),
    engineUrl: origin(enginePort),
    collabUrl: origin(collabPort),
    bindHost: loopback,
    port,
    selectionMcp: false,
  }, { username: "desktop", displayName: "本机用户", password: random(), role: "member" });
}

export async function runDesktop(root: string, assets: string) {
  if (!existsSync(join(root, "config.json"))) await initializeDesktop(root);
  const workspace = readWorkspace(root);
  const { config } = workspace;
  check(config.mode === "desktop" && config.appId === "foldly-desktop" &&
    config.bindHost === loopback && config.publicUrl === origin(config.port) &&
    config.callbackUrl === config.publicUrl && config.selectionMcp === false &&
    [config.engineUrl, config.collabUrl].every(url => /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(url)),
  409, "桌面版需要独立的本机工作区。");
  check(process.connected, 400, "桌面客户端已退出。");
  const runtime = createRuntime(workspace, {
    assets, binary: join(assets, "officecli"), sidecar: join(assets, "sidecar.cjs"),
  }, () => void stop(1));
  async function stop(code: number | string) {
    process.exitCode = code;
    await runtime.stop();
    if (process.connected) process.disconnect?.();
  }
  process.once("disconnect", () => void stop(process.exitCode ?? 0));
  process.once("SIGTERM", () => void stop(1));
  let saving = false;
  process.on("message", async (message: unknown) => {
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "save-and-stop" || saving) return;
    saving = true;
    try {
      await runtime.drain();
      await stop(0);
    } catch (error) {
      saving = false;
      if (process.connected) process.send?.({ type: "save-error", error: errorMessage(error) });
    }
  });
  try {
    await runtime.start();
    check(process.connected && process.send, 400, "桌面客户端已退出。");
    const cookie = await runtime.createDesktopSession();
    process.send({ type: "ready", url: config.publicUrl, cookie });
  } catch (error) {
    await stop(1);
    throw error;
  }
}
