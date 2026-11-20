import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as portServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { askExternalAgent } from "./agent.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const cli = join(repo, "apps/workspace/cli.mjs");
const assets = resolve(process.env.OFFICECLI_WORKSPACE_DIST || join(repo, "apps/workspace/dist"));
const binary = join(assets, "officecli");
const root = mkdtempSync(join(tmpdir(), "officecli-embed-example-"));
const bind = "127.0.0.1";
const hostPort = Number(process.env.OFFICECLI_EMBED_PORT || 4417);
const adminPassword = randomBytes(28).toString("base64url");
const memberPassword = randomBytes(28).toString("base64url");
const sockets = new Set();
let service, host, referenceBoardId, specBoardId;
function run(file, args, env = process.env) {
  const p = spawnSync(file, args, { env, encoding: "utf8" });
  if (p.status !== 0) throw new Error(p.stderr || "初始化演示失败");
}
function cookies(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}
async function json(url, path, options = {}) {
  const { data, bytes, method = "GET", account } = options;
  const response = await fetch(url + path, {
    method,
    headers: {
      Origin: url,
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(bytes ? { "Content-Type": "application/octet-stream" } : {}),
      ...(account ? { Cookie: account.cookie, "X-Workspace-CSRF": account.csrf } : {}),
    },
    body: bytes || (data ? JSON.stringify(data) : undefined),
  });
  if (!response.ok)
    throw Error("Workspace " + response.status + " " + (await response.text()).slice(0, 200));
  return {
    value: response.status === 204 ? null : await response.json(),
    cookie: cookies(response),
  };
}
const scene = {
  type: "excalidraw",
  version: 2,
  source: "OfficeCLI",
  appState: { viewBackgroundColor: "#fcfaf5" },
  files: {},
  elements: [],
};
function card(id, x, color, title, note) {
  scene.elements.push(
    {
      id,
      type: "rectangle",
      groupIds: [id + "-card"],
      x,
      y: 130,
      width: 202,
      height: 140,
      strokeColor: "#766d6c",
      backgroundColor: color,
      fillStyle: "solid",
      roughness: 0,
      strokeWidth: 1,
      roundness: { type: 3 },
    },
    {
      id: id + "-title",
      type: "text",
      groupIds: [id + "-card"],
      x: x + 18,
      y: 156,
      width: 150,
      height: 28,
      fontSize: 22,
      fontFamily: 5,
      lineHeight: 1.25,
      text: title,
      strokeColor: "#3c3c43",
    },
    {
      id: id + "-note",
      type: "text",
      groupIds: [id + "-card"],
      x: x + 18,
      y: 204,
      width: 175,
      height: 24,
      fontSize: 15,
      fontFamily: 5,
      lineHeight: 1.25,
      text: note,
      strokeColor: "#534d56",
    },
  );
}
scene.elements.push({
  id: "workshop-heading",
  type: "text",
  x: 43,
  y: 43,
  width: 350,
  height: 40,
  fontSize: 30,
  fontFamily: 5,
  lineHeight: 1.25,
  text: "从访谈到下一步",
  strokeColor: "#364047",
});
card("observe", 40, "#e5edf0", "观察", "记录原话，保留语境");
card("choose", 269, "#eee4f2", "选择", "圈出最值得验证的假设");
card("try", 498, "#f6e5b0", "试验", "约一次小范围的试用");

async function main() {
  if (
    !existsSync(join(assets, "embed-example/index.html")) ||
    !existsSync(join(assets, "selection-mcp.cjs"))
  )
    throw Error("请先运行 npm run build --prefix apps/workspace。");
  const listeners = Array.from({ length: 3 }, () => portServer());
  await Promise.all(
    listeners.map((s) => new Promise((yes, no) => s.once("error", no).listen(0, bind, yes))),
  );
  const [port, engine, collab] = listeners.map((s) => s.address().port);
  await Promise.all(listeners.map((s) => new Promise((done) => s.close(done))));
  const origin = "http://" + bind + ":" + port;
  const site = "http://fold.localhost:" + hostPort;
  const model = process.env.OFFICECLI_DEMO_OLLAMA_MODEL;
  const demoAgent = { model: model || null };
  run(
    process.execPath,
    [
      cli,
      "init",
      "--root",
      root,
      "--tenant-id",
      "fold-example",
      "--app-id",
      "project-desk",
      "--name",
      "折页工作室",
      "--selection-mcp",
      "--public-url",
      origin,
      "--engine-port",
      String(engine),
      "--collab-port",
      String(collab),
    ],
    { ...process.env, OFFICECLI_BOOTSTRAP_PASSWORD: adminPassword },
  );
  service = spawn(process.execPath, [cli, "start", "--root", root, "--assets", assets], {
    env: { ...process.env, OFFICECLI_AI_ENABLED: process.env.OFFICECLI_DEMO_ENGINE_AI === "true" ? "true" : "false",
      ...(model ? { OFFICECLI_WORKBENCH_OLLAMA_MODEL: model, OFFICECLI_WORKBENCH_OLLAMA_URL: process.env.OFFICECLI_DEMO_OLLAMA_URL || "http://127.0.0.1:11434" } : {}),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  service.on("exit", () => {
    for (const socket of sockets) socket.destroy();
    host?.close();
  });
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      await json(origin, "/workspace/api/status");
      const h = await fetch("http://" + bind + ":" + engine + "/health");
      if (h.ok) break;
    } catch {}
    if (Date.now() > deadline || service.exitCode !== null) throw Error("演示工作区未启动。");
    await new Promise((done) => setTimeout(done, 180));
  }
  const signed = await json(origin, "/workspace/api/login", {
    method: "POST",
    data: { username: "admin", password: adminPassword },
  });
  const account = { cookie: signed.cookie, csrf: signed.value.csrf };
  const member = (
    await json(origin, "/workspace/api/users", {
      method: "POST",
      account,
      data: {
        username: "designer",
        password: memberPassword,
        displayName: "工作坊成员",
        role: "member",
      },
    })
  ).value.user;
  const doc = join(root, "工作坊简报.docx");
  run(binary, ["create", doc, "--locale", "zh-CN"]);
  for (const [style, text] of [
    ["Heading1", "六月工作坊"],
    ["Normal", "我们将访谈整理成一份共创简报。"],
    ["Heading2", "本周观察"],
    ["Normal", "保留原话，再提炼下一步可以验证的假设。"],
    ["Heading2", "下次碰面"],
    ["Normal", "周五一起查看白板，把共识写回文档。"],
  ])
    run(binary, [
      "add",
      doc,
      "/body",
      "--type",
      "paragraph",
      "--prop",
      "style=" + style,
      "--prop",
      "text=" + text,
    ]);
  for (const [paragraph, size, color] of [
    [2, 24, "304B48"],
    [4, 15, "654C73"],
    [6, 15, "654C73"],
  ]) {
    run(binary, [
      "set",
      doc,
      "/body/p[" + paragraph + "]/r[1]",
      "--prop",
      "bold=true",
      "--prop",
      "size=" + size,
      "--prop",
      "color=" + color,
    ]);
  }
  const sheet = join(root, "工作坊行动表.xlsx"), deck = join(root, "复盘提案.pptx");
  run(binary, ["create", sheet]);
  for (const [address, value] of Object.entries({ A1:"工作事项", B1:"负责人", A2:"整理访谈", B2:"内容组", A3:"验证假设", B3:"设计组" })) {
    run(binary, ["set", sheet, "/Sheet1/" + address, "--prop", "value=" + value]);
  }
  run(binary, ["create", deck, "--locale", "zh-CN"]);
  run(binary, ["add", deck, "/", "--type", "slide"]);
  for (const [text, y, size] of [["六月工作坊 · 复盘", "2cm", 34], ["从访谈记录，到可验证的下一步", "4.5cm", 20]]) {
    run(binary, ["add", deck, "/slide[1]", "--type", "textbox", "--prop", "x=2cm", "--prop", "y=" + y,
      "--prop", "width=20cm", "--prop", "height=2cm", "--prop", "text=" + text, "--prop", "size=" + size]);
  }
  for (const [name, bytes] of [
    ["工作坊简报.docx", readFileSync(doc)],
    ["共创工作坊.excalidraw", Buffer.from(JSON.stringify(scene))],
    ["工作坊行动表.xlsx", readFileSync(sheet)],
    ["复盘提案.pptx", readFileSync(deck)],
    ...(process.env.OFFICECLI_DEMO_SPEC_BOARD === "1"
      ? [["发布评审.excalidraw", readFileSync(join(import.meta.dirname, "boards/spec-release.excalidraw"))]]
      : []),
    ...(process.env.OFFICECLI_DEMO_REFERENCE_BOARD === "1"
      ? [["FigJam 白板示例.excalidraw", readFileSync(join(import.meta.dirname, "boards/spec-workshop.excalidraw"))]]
      : []),
  ]) {
    const file = (
      await json(origin, "/workspace/api/files?filename=" + encodeURIComponent(name), {
        method: "POST",
        account,
        bytes,
      })
    ).value.file;
    if (name === "发布评审.excalidraw") specBoardId = file.id;
    if (name === "FigJam 白板示例.excalidraw") referenceBoardId = file.id;
    await json(origin, "/workspace/api/files/" + file.id + "/acl", {
      method: "PUT",
      account,
      data: {
        userId: member.id,
        profile: "editor",
        operations: ["document.view", "document.edit", "document.ai", "document.copy"],
      },
    });
  }
  // Two actual origins. Only the local showcase auto-signs a restricted fixture
  // member. Browser/editor sessions otherwise go through the real Workspace.
  host = httpServer(async (req, res) => {
    try {
      if (
        req.headers.host !== new URL(site).host ||
        (req.headers.origin && req.headers.origin !== site)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (specBoardId && req.url === "/examples/spec") {
        res.writeHead(302, { Location: "/workbench/?file=" + encodeURIComponent(specBoardId) + "&node-id=spec-release&ai=0" });
        res.end();
        return;
      }
      if (referenceBoardId && req.url === "/examples/figjam") {
        res.writeHead(302, { Location: "/workbench/?file=" + encodeURIComponent(referenceBoardId) + "&node-id=reference-spec&ai=0" });
        res.end();
        return;
      }
      if (req.url === "/") {
        res.writeHead(302, { Location: "/workbench/" });
        res.end();
        return;
      }
      if (req.url === "/business/agent" && req.method === "POST") {
        if (
          req.headers.origin !== site ||
          req.headers["content-type"]?.split(";")[0] !== "application/json"
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        const parts = [];
        let size = 0;
        for await (const part of req) {
          size += part.length;
          if (size > 16384) {
            res.writeHead(413);
            res.end();
            return;
          }
          parts.push(part);
        }
        const { token, prompt } = JSON.parse(Buffer.concat(parts).toString());
        if (
          typeof token !== "string" ||
          typeof prompt !== "string" ||
          !prompt.trim() ||
          prompt.length > 4000
        ) {
          res.writeHead(400);
          res.end();
          return;
        }
        try {
          const answer = await askExternalAgent({
            endpoint: origin + "/workspace/mcp/selection",
            token,
            prompt,
            model,
            base: process.env.OFFICECLI_DEMO_OLLAMA_URL,
          });
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(answer));
        } catch (e) {
          res.writeHead(422, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }
      if (req.method === "GET" && req.url === "/workspace/api/session") {
        if (req.headers.cookie) {
          const active = await fetch(origin + req.url, { headers: { cookie: req.headers.cookie } });
          if (active.ok) {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ ...(await active.json()), demoAgent }));
            return;
          }
        }
        const login = await json(origin, "/workspace/api/login", {
          method: "POST",
          data: { username: "designer", password: memberPassword },
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": login.cookie + "; HttpOnly; SameSite=Strict; Path=/",
        });
        res.end(JSON.stringify({ ...login.value, demoAgent }));
        return;
      }
      if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) {
        res.writeHead(400);
        res.end();
        return;
      }
      const upstream = httpRequest(
        origin,
        {
          method: req.method,
          path: req.url,
          headers: {
            ...req.headers,
            host: new URL(origin).host,
            ...(req.headers.origin ? { origin } : {}),
          },
        },
        (remote) => {
          res.writeHead(remote.statusCode, remote.headers);
          remote.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.pipe(upstream);
    } catch (e) {
      if (!res.headersSent) res.writeHead(502);
      res.end("演示工作区暂时不可用。");
    }
  });
  host.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/collaboration" ||
      req.headers.host !== new URL(site).host ||
      req.headers.origin !== site
    ) {
      socket.destroy();
      return;
    }
    const upstream = httpRequest(origin, {
      path: req.url,
      headers: { ...req.headers, host: new URL(origin).host, origin },
    });
    upstream.on("upgrade", (res, other, bytes) => {
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          ...Object.entries(res.headers).map(([k, v]) => k + ": " + v),
          "",
          "",
        ].join("\r\n"),
      );
      if (head.length) other.write(head);
      if (bytes.length) socket.write(bytes);
      socket.on("error", () => other.destroy());
      other.on("error", () => socket.destroy());
      socket.on("close", () => other.destroy());
      other.on("close", () => socket.destroy());
      socket.pipe(other).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.on("response", () => socket.destroy());
    upstream.end();
  });
  host.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  host.listen(hostPort, bind);
  await once(host, "listening");
  console.log(
    "业务系统 " +
      site +
      "/workbench/\n选区 MCP " +
      origin +
      "/workspace/mcp/selection\n演示目录 " +
      root,
  );
}
const stop = () => {
  for (const socket of sockets) socket.destroy();
  host?.close();
  service?.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
  stop();
});
