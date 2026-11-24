import { createHash, randomUUID } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { check, HttpError } from "./contracts.mts";
import type { Workspace } from "./contracts.mts";
import { jwt } from "./server.mjs";
import { equal, now } from "./store.mts";

const control = "/internal/collaboration";
const keyHeader = "x-foldly-collaboration-key";
const workerHeader = "x-foldly-collaboration-worker";
const documentHeader = "x-foldly-collaboration-document";
const ownerHeader = "x-hcd-collaboration-owner";
const documentIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const workerRoutes = new Set([
  "GET ", "GET /auth", "GET /editor", "GET /collaboration/state",
  "PUT /collaboration/state",
  "POST /project", "POST /checkpoints", "POST /collaboration/pending",
]);

export interface CollaborationTarget {
  url: string;
  headers: Record<string, string>;
}

type Worker = { id: string; url: string; draining: boolean };
type Room = { worker: Worker; token: string; sockets: Set<Socket> };

export function createCollaborationPool({ config, keys }: Workspace) {
  const hostname = process.env.FOLDLY_COLLABORATION_SERVICE;
  if (!hostname || config.mode === "desktop") return;
  const keyFile = process.env.FOLDLY_COLLABORATION_KEY_FILE;
  const port = Number(process.env.FOLDLY_COLLABORATION_PORT || 7402);
  const bridgePort = Number(process.env.FOLDLY_COLLABORATION_BRIDGE_PORT || 7403);
  check(keyFile && [port, bridgePort].every(value => Number.isInteger(value) && value > 0 && value < 65536) &&
    bridgePort !== config.port && bridgePort !== Number(new URL(config.engineUrl).port),
  400, "协作服务的端口或凭证配置无效。");
  const key = readFileSync(keyFile, "utf8").trim();
  check(/^[a-f0-9]{64}$/.test(key), 400, "协作服务凭证无效。");
  const headers = { [keyHeader]: key };
  const dns = new Resolver({ timeout: 800, tries: 1 });
  const rooms = new Map<string, Room>();
  const assigning = new Map<string, Promise<Room>>();
  let sequence = 0;
  let members: Worker[] = [];
  let expires = 0;
  let discovery: Promise<Worker[]> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pause: { id: string; workers: Worker[] } | undefined;
  let stopped = false;

  async function refresh(): Promise<Worker[]> {
    const addresses = await dns.resolve4(hostname!).catch(error => {
      if (error.code === "ENOTFOUND" || error.code === "ENODATA") return [];
      throw error;
    });
    const responses = await Promise.allSettled([...new Set(addresses)].map(async address => {
      const url = `http://${address}:${port}`;
      const response = await fetch(url + control, { headers, signal: AbortSignal.timeout(1200), redirect: "error" });
      check(response.ok, 503, "协作实例未就绪。");
      const status = await response.json() as { id?: string; draining?: boolean };
      check(typeof status.id === "string" && /^[a-f0-9-]{36}$/.test(status.id), 503, "协作实例标识无效。");
      return { id: status.id, url, draining: status.draining === true };
    }));
    members = responses.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    expires = Date.now() + 1000;
    // Disconnect stuck transports too. Clients then reconnect through the
    // gateway, which fences the old owner before routing to its replacement.
    const available = new Set(members.map(worker => worker.id));
    for (const room of rooms.values()) if (!available.has(room.worker.id)) closeRoom(room);
    return members;
  }

  function discover(fresh = false) {
    if (!fresh && Date.now() < expires) return Promise.resolve(members);
    discovery ??= refresh().finally(() => { discovery = undefined; });
    return discovery;
  }

  function closeRoom(room: Room) {
    for (const socket of room.sockets) socket.destroy();
  }

  async function fence(documentId: string, signal = AbortSignal.timeout(5000)) {
    const token = randomUUID();
    const response = await fetch(`${config.engineUrl}/integration/v1/collaboration-owners/${documentId}`, {
      method: "PUT", headers: { Authorization: `Bearer ${keys.service}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token, sequence: ++sequence }), signal, redirect: "error",
    });
    await response.body?.cancel();
    check(response.ok, response.status === 404 ? 404 : 503, "协作文档未就绪。");
    return token;
  }

  async function assign(documentId: string) {
    const candidates = await discover();
    check(!pause && !stopped, 503, "协作服务正在取快照或停止。");
    const current = rooms.get(documentId);
    if (current && candidates.some(worker => worker.id === current.worker.id && worker.url === current.worker.url)) return current;
    // Rendezvous hashing spreads new rooms over the live workers. Established
    // rooms stay pinned when additional workers join.
    const worker = candidates.filter(candidate => !candidate.draining)
      .map(candidate => ({ candidate, rank: createHash("sha256").update(documentId + "/" + candidate.id).digest("hex") }))
      .sort((a, b) => b.rank.localeCompare(a.rank))[0]?.candidate;
    check(worker, 503, "协作实例暂时不可用。");
    if (current) closeRoom(current);
    const route = { worker, token: await fence(documentId), sockets: new Set<Socket>() };
    rooms.set(documentId, route);
    return route;
  }

  async function target(documentId: string | null, socket: Socket): Promise<CollaborationTarget> {
    check(documentId && documentIdPattern.test(documentId), 400, "协作连接缺少文档 ID。");
    check(!pause && !stopped, 503, "协作服务正在取快照或停止。");
    let pending = assigning.get(documentId);
    if (!pending) {
      pending = assign(documentId).finally(() => assigning.delete(documentId));
      assigning.set(documentId, pending);
    }
    const room = await pending;
    check(!pause && !stopped && !socket.destroyed, 503, "协作服务正在取快照或停止。");
    room.sockets.add(socket);
    socket.once("close", () => room.sockets.delete(socket));
    return { url: room.worker.url, headers: {
      ...headers, [workerHeader]: room.worker.id, [documentHeader]: documentId, [ownerHeader]: room.token,
    } };
  }

  async function command(worker: Worker, id: string, method: "PUT" | "DELETE", signal: AbortSignal) {
    const response = await fetch(`${worker.url}${control}/backup/${id}`, {
      method, headers: { ...headers, [workerHeader]: worker.id }, signal, redirect: "error",
    });
    check(response.ok, 503, "协作实例未确认备份状态。");
    if (method === "DELETE") return 0;
    const { flushed } = await response.json() as { flushed?: number };
    check(typeof flushed === "number" && Number.isSafeInteger(flushed) && flushed >= 0, 503, "协作实例未确认落盘。");
    return flushed;
  }

  async function freeze(id: string, signal: AbortSignal) {
    check(!pause, 409, "已有协作备份进行中。");
    const active = { id, workers: [] as Worker[] };
    pause = active;
    await Promise.allSettled(assigning.values());
    const connected = new Set([...rooms.values()].filter(room => room.sockets.size).map(room => room.worker.id));
    const workers = await discover(true);
    check(workers.length, 503, "协作实例暂时不可用。");
    const live = new Set(workers.map(worker => worker.id));
    for (const [documentId, room] of rooms) {
      if (!live.has(room.worker.id)) {
        check(!connected.has(room.worker.id), 503, "取快照时协作实例失联，请等待重连后重试。");
        // Unreachable rooms can contribute only their durable Yjs state.
        // Fence them too so the returning worker can't mutate this snapshot.
        await fence(documentId, signal);
        rooms.delete(documentId);
      }
    }
    active.workers = workers;
    const results = await Promise.allSettled(workers.map(worker => command(worker, id, "PUT", signal)));
    let flushed = 0;
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      flushed += result.value;
    }
    return { flushed };
  }

  async function resume(id: string, signal: AbortSignal) {
    if (pause?.id !== id) return;
    try {
      const results = await Promise.allSettled(pause.workers.map(worker => command(worker, id, "DELETE", signal)));
      if (results.some(result => result.status === "rejected")) {
        // No previously paused worker may block traffic indefinitely.
        console.error("协作实例未确认解除备份暂停，暂停将在实例端自动到期。");
      }
    } finally {
      pause = undefined;
    }
  }

  function bridgeRequest(request: IncomingMessage, response: ServerResponse) {
    try {
      check(equal(String(request.headers[keyHeader] ?? ""), key), 403, "协作服务凭证无效。");
      const match = /^\/v1\/documents\/([A-Za-z0-9_-]{1,128})(\/[^?]*)?$/.exec(request.url ?? "");
      check(match && workerRoutes.has(`${request.method} ${match[2] ?? ""}`), 404, "协作接口不存在。");
      const [, documentId, path] = match;
      const room = rooms.get(documentId);
      check(room && room.worker.id === request.headers[workerHeader] && room.token === request.headers[ownerHeader],
        409, "协作房间已移交。");
      const instant = now();
      const authorization = path === "/auth" ? request.headers.authorization :
        `Bearer ${jwt(keys.jwt, { doc: documentId, scope: "write", sub: "hcd-collaboration",
          name: "Collaboration autosave", aud: "hcd-core", iat: instant, exp: instant + 60 })}`;
      const forwarded: Record<string, string> = { [ownerHeader]: room.token };
      if (authorization) forwarded.authorization = authorization;
      for (const header of ["content-type", "content-length", "x-hcd-collaboration-epoch", "x-hcd-checkpoint-author"]) {
        const value = request.headers[header];
        if (typeof value === "string") forwarded[header] = value;
      }
      const outgoing = httpRequest(new URL(request.url!, config.engineUrl), {
        method: request.method, headers: forwarded, signal: AbortSignal.timeout(90_000),
      }, upstream => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.on("error", () => response.destroy());
        upstream.pipe(response);
      });
      outgoing.on("error", () => {
        if (response.headersSent) response.destroy();
        else response.writeHead(502).end();
      });
      response.on("close", () => { if (!response.writableEnded) outgoing.destroy(); });
      request.pipe(outgoing);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 409) response.setHeader("x-foldly-collaboration-stale", "true");
      response.writeHead(status).end();
    }
  }

  const bridge = createServer(bridgeRequest);
  bridge.requestTimeout = 90_000;

  return {
    bridge, bridgePort, target, freeze, resume,
    async ready() {
      if (!(await discover(true)).some(worker => !worker.draining)) return false;
      timer ??= setInterval(() => void discover().catch(() => {}), 1000);
      timer.unref();
      return true;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      dns.cancel();
      for (const room of rooms.values()) closeRoom(room);
      if (pause) await resume(pause.id, AbortSignal.timeout(5000));
      bridge.close();
      bridge.closeAllConnections();
    },
  };
}
