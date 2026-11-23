import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomic, check, hash } from "./store.mts";

export const releaseSchema = "officecli-workspace-release/1";
export const releaseManifest = "release.json";
const releaseFiles = ["workspace", "runtime/node", "app/cli.mjs", "app/dist/officecli", "app/dist/admin/index.html",
  "app/dist/editor/index.html", "app/dist/embed-example/index.html", "app/dist/sidecar.cjs", "app/dist/selection-mcp.cjs",
  "app/dist/blank/blank.docx", "app/dist/blank/blank.xlsx", "app/dist/blank/blank.pptx", "licenses/Node.js.txt", "licenses/OfficeCLI.txt"];
const bundledExecutables = new Set(["workspace", "runtime/node", "app/dist/officecli"]);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const releaseId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}-[a-f0-9]{16}$/.test(value);
const validPath = path => typeof path === "string" && !/[\\\x00-\x1f\x7f]/.test(path) &&
  path.split("/").every(name => name && name !== "." && name !== "..");

export async function* payload(root, dir = "") {
  const base = join(root, dir);
  for (const name of (await readdir(base)).sort()) {
    const path = dir ? `${dir}/${name}` : name;
    if (path === releaseManifest) continue;
    check(validPath(path), 409, "发行包含无效路径。");
    const stat = await lstat(join(base, name));
    if (stat.isDirectory()) yield* payload(root, path);
    else {
      check(stat.isFile(), 409, "发行包只允许普通文件。");
      yield { path, bytes: stat.size, executable: (stat.mode & 0o100) !== 0 };
    }
  }
}

async function fileHash(path) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

function identity(body) {
  return `${body.version}-${hash(JSON.stringify(body)).slice(0, 16)}`;
}

export async function sealRelease(root, { version, node, engine, workspaceSchema }) {
  check(typeof version === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(version), 400, "发行版本标签无效。");
  const files = [];
  for await (const item of payload(root)) files.push({ ...item, sha256: await fileHash(join(root, item.path)) });
  const body = { schemaVersion: releaseSchema, version, platform: process.platform, arch: process.arch,
    node, engine, workspaceSchema, files };
  const manifest = { ...body, id: identity(body) };
  await verifyEntries(root, manifest, false);
  atomic(join(root, releaseManifest), JSON.stringify(manifest) + "\n", { exclusive: true });
  return manifest;
}

async function verifyEntries(root, manifest, verifyHashes) {
  const { id, ...body } = manifest;
  check(body.schemaVersion === releaseSchema && releaseId(id) && identity(body) === id &&
    body.platform === process.platform && body.arch === process.arch &&
    typeof body.node === "string" && /^v\d+\.\d+\.\d+$/.test(body.node) &&
    typeof body.engine?.version === "string" && sha(body.engine.protocolFingerprint) &&
    /^officecli-workspace\/\d+$/.test(body.workspaceSchema) && Array.isArray(body.files), 409,
  "发行清单无效，或发行包平台与此主机不符。");
  const entries = new Map();
  for (const item of body.files) {
    check(validPath(item?.path) && item.path !== releaseManifest && !entries.has(item.path) &&
      Number.isSafeInteger(item.bytes) && item.bytes >= 0 && typeof item.executable === "boolean" && sha(item.sha256),
    409, "发行清单含无效文件记录。");
    entries.set(item.path, item);
  }
  check(releaseFiles.every(path => entries.has(path)) && [...bundledExecutables].every(path => entries.get(path).executable),
    409, "发行包缺少运行所需的文件或执行权限。");
  let count = 0;
  for await (const file of payload(root)) {
    const item = entries.get(file.path);
    check(item && file.bytes === item.bytes && file.executable === item.executable &&
      (!verifyHashes || await fileHash(join(root, file.path)) === item.sha256), 409, `发行文件校验失败（${file.path}）。`);
    count++;
  }
  check(count === entries.size, 409, "发行包缺少清单记录的文件。");
}

export async function verifyRelease(input) {
  const root = await realpath(input), path = join(root, releaseManifest);
  const stat = await lstat(path);
  check(stat.isFile() && stat.size > 0 && stat.size < 32 * 1024 * 1024, 409, "发行清单文件无效。");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await verifyEntries(root, manifest, true);
  return { root, manifest };
}

export async function installRelease(deployment, verified) {
  const { root, manifest } = verified;
  const parent = join(deployment, "releases"), destination = join(parent, manifest.id);
  const existing = await lstat(destination).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing) {
    const installed = await verifyRelease(destination);
    check(installed.manifest.id === manifest.id, 409, "已安装发行目录与清单不一致。");
    return installed;
  }
  const temporary = join(parent, `.install-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    const folders = new Set([temporary]);
    for (const item of manifest.files) {
      const target = join(temporary, item.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      for (let dir = dirname(target); !folders.has(dir); dir = dirname(dir)) folders.add(dir);
      await copyFile(join(root, item.path), target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      await chmod(target, item.executable ? 0o700 : 0o600);
      await sync(target);
    }
    atomic(join(temporary, releaseManifest), JSON.stringify(manifest) + "\n", { exclusive: true });
    await verifyEntries(temporary, manifest, true);
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) await sync(folder);
    await rename(temporary, destination);
    await sync(parent);
    return { root: destination, manifest };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function sync(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
