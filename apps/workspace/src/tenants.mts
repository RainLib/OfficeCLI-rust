import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { check } from "./store.mts";
import { validateDatabaseConfig } from "./database.mts";
import type { Workspace, WorkspaceConfig, WorkspaceKeys } from "./contracts.mts";
import type { createRuntime } from "./runtime.mts";

const signingKeys = ["jwt", "provider", "service", "events", "objects"] as const;
const privateEndpoints = ["callbackUrl", "engineUrl", "collabUrl"] as const;
const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function bindAddress(host: string) {
  if (host === "localhost") return "127.0.0.1";
  return host === "[::1]" ? "::1" : host;
}

export function publicOrigin(value: string) {
  const u = new URL(value);
  check(
    ["http:", "https:"].includes(u.protocol) &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password,
    400,
    "public-url 必须是 HTTP(S) 站点地址。",
  );
  check(
    u.protocol === "https:" || loopback.has(u.hostname) || u.hostname.endsWith(".localhost"),
    400,
    "外部工作空间域名需使用 HTTPS。",
  );
  return u;
}

export function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    Array.from(value).length <= 256 &&
    !/\p{Cc}/u.test(value)
  );
}

export function readWorkspace(path: string, configName = "config.json"): Workspace {
  const root = realpathSync(path);
  const config: WorkspaceConfig = JSON.parse(readFileSync(join(root, configName), "utf8"));
  check(
    config && validIdentity(config.tenantId) &&
      validIdentity(config.appId),
    400,
    "工作空间配置版本或身份无效。",
  );
  validateDatabaseConfig(config);
  // The engine requires a numeric socket address. Use the same loopback
  // address for Node and Rust when a legacy configuration names localhost.
  config.bindHost = bindAddress(config.bindHost);
  for (const field of privateEndpoints) {
    const endpoint = new URL(config[field]);
    if (endpoint.hostname === "localhost") {
      endpoint.hostname = "127.0.0.1";
      config[field] = endpoint.href.replace(/\/$/, "");
    }
  }
  const keys: WorkspaceKeys = JSON.parse(readFileSync(join(root, "keys.json"), "utf8"));
  const secrets = signingKeys.map((key) => keys[key]);
  check(
    secrets.every((v) => typeof v === "string" && Buffer.byteLength(v) >= 32) &&
      new Set(secrets).size === secrets.length,
    400,
    "工作空间密钥缺失或重复。",
  );
  return { root, config, keys };
}

export function readTenantRegistry(path: string, listenPort: number): Workspace[] {
  const registry: { workspaces?: Array<{ root?: string; ai?: boolean }> } = JSON.parse(readFileSync(path, "utf8"));
  check(
    Array.isArray(registry.workspaces) && registry.workspaces.length > 0,
    400,
    "租户清单需要 workspaces 列表。",
  );
  const tenants = new Set(),
    hosts = new Set(),
    ports = new Set(),
    secrets = new Set(),
    databases = new Set(),
    roots: string[] = [];
  return registry.workspaces.map((entry) => {
    check(
      typeof entry?.root === "string" &&
        entry.root.trim() &&
        (entry.ai === undefined || typeof entry.ai === "boolean"),
      400,
      "清单条目需要工作空间 root，ai 可设为布尔值。",
    );
    const workspace = readWorkspace(resolve(dirname(path), entry.root));
    const { root, config, keys } = workspace;
    const url = publicOrigin(config.publicUrl);
    const hostname = url.hostname.replace(/\.$/, "");
    const identity = JSON.stringify([config.tenantId, config.appId]);
    check(
      !hosts.has(hostname) && !tenants.has(identity),
      400,
      "工作区域名或租户与应用的组合已被登记。",
    );
    hosts.add(hostname);
    tenants.add(identity);
    check(
      !roots.some((r) => r === root || root.startsWith(r + sep) || r.startsWith(root + sep)),
      400,
      "工作空间的数据目录必须独立。",
    );
    roots.push(root);
    const sqlite = !config.database;
    for (const name of [...(sqlite ? ["business.sqlite"] : []), "objects", "staging", "engine"]) {
      const part = join(root, name);
      if (!existsSync(part) && name !== "business.sqlite") continue;
      const inside = relative(root, realpathSync(part));
      check(
        inside && inside !== ".." && !inside.startsWith(".." + sep),
        400,
        "业务库和编辑数据需要位于各自的工作空间目录内。",
      );
    }
    const database = config.database ? config.database.id : (() => {
      const db = statSync(join(root, "business.sqlite"), { bigint: true });
      return db.dev + "/" + db.ino;
    })();
    check(!databases.has(database), 400, "两个租户使用了同一业务库。");
    databases.add(database);
    for (const key of signingKeys) {
      check(!secrets.has(keys[key]), 400, "租户之间需要独立生成的密钥。");
      secrets.add(keys[key]);
    }
    check(
      loopback.has(config.bindHost) || config.bindHost === "::1",
      400,
      "共享入口后的工作空间需要监听本机回环地址。",
    );
    for (const field of privateEndpoints) {
      const target = new URL(config[field]);
      const port = Number(target.port || 80);
      check(
        target.href === target.origin + "/" &&
          target.protocol === "http:" &&
          loopback.has(target.hostname) &&
          (field !== "callbackUrl" ||
            (port === config.port && target.hostname.replace(/^\[|\]$/g, "") === config.bindHost)),
        400,
        "工作空间内部服务地址无效。",
      );
      check(
        port !== listenPort && !ports.has(target.origin),
        400,
        "共享入口和各工作空间的监听地址发生冲突。",
      );
      ports.add(target.origin);
    }
    return { ...workspace, allowAI: entry.ai === true };
  });
}

export function createTenantGateway(runtimes: ReturnType<typeof createRuntime>[]) {
  const routes = new Map(runtimes.map((r) => [new URL(r.config.publicUrl).host, r] as const));
  const sockets = new Set<Socket>();
  function route(req: IncomingMessage) {
    return req.headers.host ? routes.get(req.headers.host.toLowerCase()) : undefined;
  }
  const server = createServer((req, res) => {
    const runtime = route(req);
    if (runtime?.ready) return runtime.handleRequest(req, res, true);
    res.writeHead(runtime ? 503 : 421, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: runtime ? "工作空间暂时不可用。" : "未登记的工作空间域名。" }));
  });
  server.on("upgrade", (req, socket, head) => {
    const runtime = route(req);
    if (runtime?.ready) return runtime.handleUpgrade(req, socket, head);
    socket.end(
      "HTTP/1.1 " +
        (runtime ? "503 Service Unavailable" : "421 Misdirected Request") +
        "\r\nConnection: close\r\n\r\n",
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 180_000;
  return {
    server,
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
