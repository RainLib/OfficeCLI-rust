import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { sealRelease } from "../src/release.mjs";
import { workspaceSchemaVersion } from "../src/store.mjs";

const { values } = parseArgs({ options: {
  version: { type: "string" }, "node-runtime": { type: "string" }, output: { type: "string" }, assets: { type: "string" },
} });
const app = resolve(import.meta.dirname, ".."), repo = resolve(app, "../.."), node = values["node-runtime"] && resolve(values["node-runtime"]);
if (!node || !values.version || !values.output) throw new Error("使用 --version <版本> --node-runtime <Node.js 解包目录> --output <新目录>。");
const output = resolve(values.output), assets = resolve(values.assets || process.env.OFFICECLI_WORKSPACE_DIST || join(app, "dist"));
if (existsSync(output)) throw new Error("发行包目标已存在，请指定新目录。");
const nodeBin = join(node, "bin", "node");
const runtime = JSON.parse(execFileSync(nodeBin, ["-p", "JSON.stringify([process.version, process.platform, process.arch])"], { encoding: "utf8" }));
const [major, minor] = runtime[0].slice(1).split(".").map(Number);
if (runtime[1] !== process.platform || runtime[2] !== process.arch || major < 24 || major === 24 && minor < 13)
  throw new Error("请提供当前平台的 Node.js 24.13 或更高版本。");
const capabilities = JSON.parse(execFileSync(join(assets, "officecli"), ["capabilities"], { encoding: "utf8" })).data;
const engine = { version: capabilities.build.version, protocolFingerprint: capabilities.protocolFingerprint };

const stage = join(dirname(output), `.${basename(output)}-${randomUUID()}`);
await mkdir(stage, { mode: 0o700 });

async function copy(source, path) {
  const destination = join(stage, path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

async function notices(root, group, name, records) {
  const files = (await readdir(root)).filter(file => /^(license|licence|copying|copyright|notice|ofl)([-_.]|$)/i.test(file));
  for (const file of files) {
    const target = `licenses/${group}/${name}/${file}`;
    if (!existsSync(join(stage, target))) await copy(join(root, file), target);
  }
  records.add(`${group}/${name}\t${files.join(", ")}`);
}

try {
  await copy(nodeBin, "runtime/node");
  await copy(join(node, "LICENSE"), "licenses/Node.js.txt");
  await copy(join(repo, "LICENSE"), "licenses/OfficeCLI.txt");
  for (const file of ["GlyphLessFont-LICENSE.txt", "GlyphLessFont-NOTICE.txt"])
    await copy(join(repo, "crates/pdf-handler/assets", file), `licenses/PDF/${file}`);
  await copy(join(app, "cli.mjs"), "app/cli.mjs");
  await copy(join(app, "README.zh.md"), "README.zh.md");
  for (const file of (await readdir(join(app, "src"))).filter(file => file.endsWith(".mjs") && !file.endsWith(".test.mjs")))
    await copy(join(app, "src", file), `app/src/${file}`);
  for (const file of ["officecli", "sidecar.cjs", "selection-mcp.cjs", "blank", "admin", "editor", "embed-example"])
    await copy(join(assets, file), `app/dist/${file}`);
  await writeFile(join(stage, "workspace"), '#!/bin/sh\nset -eu\nrelease_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec "$release_dir/runtime/node" "$release_dir/app/cli.mjs" "$@"\n', { mode: 0o755, flag: "wx" });

  const records = new Set();
  for (const directory of ["editor", "admin-app", "embed-host", "xlsx-univer-viewer"]) {
    const project = join(repo, "examples/hdoc", directory);
    const { packages } = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
    for (const [relative, item] of Object.entries(packages)) {
      if (!relative.startsWith("node_modules/") || !item.version || !existsSync(join(project, relative, "package.json"))) continue;
      const name = relative.slice(relative.lastIndexOf("node_modules/") + "node_modules/".length).replaceAll("/", "+");
      await notices(join(project, relative), "npm", `${name}@${item.version}`, records);
    }
  }
  // Use the locked build graph. Workspace test dependencies do not belong in
  // the release and need not have been downloaded by cargo build.
  const cargo = spawnSync("cargo", ["tree", "--locked", "--offline", "-p", "officecli", "-e", "normal,build", "--prefix", "none", "--format", "{p}"],
    { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (cargo.status !== 0) throw new Error("无法从锁定的 Rust 依赖收集许可文件。\n" + cargo.stderr);
  const registry = join(process.env.CARGO_HOME || join(homedir(), ".cargo"), "registry", "src");
  const caches = (await readdir(registry)).sort();
  const rust = new Set();
  for (const line of cargo.stdout.split("\n")) {
    const item = /^([a-zA-Z0-9_-]+) v([a-zA-Z0-9+._-]+)(?: \(proc-macro\))?(?: \(\*\))?$/.exec(line);
    if (!item) continue;
    const [, name, version] = item, qualified = `${name}@${version}`;
    if (rust.has(qualified)) continue;
    rust.add(qualified);
    const source = caches.map(cache => join(registry, cache, `${name}-${version}`))
      .find(path => existsSync(join(path, "Cargo.toml")));
    if (!source) throw new Error(`发行依赖的缓存源文件缺失（${qualified}）。`);
    await notices(source, "rust", qualified, records);
  }
  await writeFile(join(stage, "licenses", "components.tsv"), "组件\t随包许可文件\n" + [...records].sort().join("\n") + "\n");
  const manifest = await sealRelease(stage, { version: values.version, node: runtime[0], engine, workspaceSchema: workspaceSchemaVersion });
  await rename(stage, output);
  console.log(JSON.stringify({ id: manifest.id, path: output, node: manifest.node, engine, files: manifest.files.length }, null, 2));
} catch (error) {
  await rm(stage, { recursive: true, force: true });
  throw error;
}
