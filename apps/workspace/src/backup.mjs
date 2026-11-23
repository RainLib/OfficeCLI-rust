import { backup, DatabaseSync } from "node:sqlite";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";
import { Store, atomic, check, uuid, workspaceSchemaVersion } from "./store.mts";
import { configureDatabase, sqliteSnapshotConfig } from "./database.mts";
import { readWorkspace } from "./tenants.mts";

const schema = "officecli-workspace-backup/1";
const metadata = "snapshot.json";
const folders = ["engine", "objects", "staging"];
const coreFiles = ["config.json", "keys.json", "business.sqlite"];
const snapshots = ".backup-staging";
const reflink = constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL;

function nested(parent, child) {
  const path = relative(parent, child);
  return !path || path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

async function destination(input, source) {
  const path = resolve(input);
  const canonical = resolve(await realpath(dirname(path)), relative(dirname(path), path));
  check(!nested(source, canonical) && !nested(canonical, source), 400, "备份与恢复目录必须和源目录分开。");
  return canonical;
}

async function regular(path) {
  const stat = await lstat(path);
  check(stat.isFile(), 409, "快照含有非普通文件。");
  return stat;
}

async function sync(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function copyTree(source, target, signal) {
  signal.throwIfAborted();
  const stat = await lstat(source);
  if (stat.isDirectory()) {
    await mkdir(target, { mode: 0o700 });
    for (const name of await readdir(source)) await copyTree(join(source, name), join(target, name), signal);
  } else {
    check(stat.isFile(), 409, "工作区数据目录含有非普通文件。");
    await copyFile(source, target, reflink);
    await chmod(target, 0o600);
  }
}

async function* walk(root, prefix = "") {
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (!prefix && path === metadata) continue;
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) {
      check(folders.includes(path.split("/")[0]), 409, "快照含有未知目录。");
      yield* walk(root, path);
    } else {
      check(stat.isFile() && validPath(path), 409, "快照含有未知或非普通文件。");
      yield path;
    }
  }
}

function validPath(path) {
  if (typeof path !== "string" || /[\\\x00-\x1f\x7f]/.test(path)) return false;
  const parts = path.split("/");
  return coreFiles.includes(path) || parts.length > 1 && folders.includes(parts[0]) &&
    parts.every(part => part && part !== ".." && part !== ".");
}

async function fingerprint(path) {
  const checksum = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    checksum.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: checksum.digest("hex") };
}

function verifyDatabase(root, files) {
  const db = new DatabaseSync(join(root, "business.sqlite"), { readOnly: true });
  try {
    check(db.prepare("PRAGMA journal_mode").get()?.journal_mode === "delete" &&
      db.prepare("PRAGMA quick_check").get()?.quick_check === "ok" && !db.prepare("PRAGMA foreign_key_check").get(),
      409, "备份中的业务数据库未通过一致性检查。");
    check(db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()?.value === workspaceSchemaVersion,
      409, "备份使用了不兼容的业务库版本。");
    for (const object of db.prepare("SELECT DISTINCT sha256,size FROM versions").iterate()) {
      const entry = files.get(`objects/${object.sha256}`);
      check(entry?.sha256 === object.sha256 && entry.bytes === object.size, 409, "备份缺少业务版本所引用的对象。");
    }
    for (const publication of db.prepare("SELECT id,intent FROM publications WHERE uploaded=1 AND receipt IS NULL").iterate()) {
      const output = JSON.parse(publication.intent).output;
      const entry = files.get(`staging/${publication.id}.bin`);
      check(entry && output && entry.sha256 === output.sha256 && entry.bytes === output.sizeBytes, 409, "备份缺少待回写任务的上传内容。");
    }
  } finally { db.close(); }
}

const sameFile = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256;
const summary = ({ id, capturedAt, files, collaborationRooms }) => ({ id, capturedAt, collaborationRooms,
  files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) });

export async function captureWorkspace({ root, copyDatabase, config, id, hold, signal }) {
  const staging = join(root, snapshots, id);
  await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  try {
    const cut = await hold(async () => {
      for (const name of [...folders, "keys.json"])
        await copyTree(join(root, name), join(staging, name), signal);
      if (config.database)
        atomic(join(staging, "config.json"), JSON.stringify(sqliteSnapshotConfig(config), null, 2) + "\n", { exclusive: true });
      else await copyTree(join(root, "config.json"), join(staging, "config.json"), signal);
      signal.throwIfAborted();
      const database = join(staging, "business.sqlite");
      await copyDatabase(database);
      await chmod(database, 0o600);
    });
    // SQLite backup can retain the source's WAL mode bit. Seal a standalone
    // copy so even read-only verification can't create new WAL/SHM files.
    const db = new DatabaseSync(join(staging, "business.sqlite"));
    try {
      check(db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode === "delete", 503, "无法封存备份数据库。");
    } finally { db.close(); }
    const files = [];
    for await (const path of walk(staging)) {
      signal.throwIfAborted();
      const file = join(staging, path);
      await sync(file);
      files.push({ path, ...(await fingerprint(file)) });
    }
    verifyDatabase(staging, new Map(files.map(item => [item.path, item])));
    const manifest = { schemaVersion: schema, id, capturedAt: cut.capturedAt, collaborationRooms: cut.collaborationRooms,
      tenantId: config.tenantId, appId: config.appId, files };
    atomic(join(staging, metadata), JSON.stringify(manifest) + "\n", { exclusive: true });
    return summary(manifest);
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

async function readManifest(root) {
  const stat = await regular(join(root, metadata));
  check(stat.size > 0 && stat.size <= 128 * 1024 * 1024, 409, "备份清单大小无效。");
  const manifest = JSON.parse(await readFile(join(root, metadata), "utf8"));
  check(manifest?.schemaVersion === schema && uuid(manifest.id) && Number.isFinite(Date.parse(manifest.capturedAt)) &&
    Number.isSafeInteger(manifest.collaborationRooms) && manifest.collaborationRooms >= 0 && Array.isArray(manifest.files),
    409, "备份清单版本或记载无效。");
  const files = new Map();
  for (const item of manifest.files) {
    check(validPath(item?.path) && /^[a-f0-9]{64}$/.test(item.sha256) &&
      Number.isSafeInteger(item.bytes) && item.bytes >= 0 && !files.has(item.path), 409, "备份清单含无效文件记录。");
    files.set(item.path, item);
  }
  check([...coreFiles, "engine/integration/identity.json"].every(path => files.has(path)), 409, "备份缺少配置、密钥或工作区数据。");
  let count = 0;
  for await (const path of walk(root)) {
    check(files.has(path), 409, "快照包含清单之外的文件。");
    count++;
  }
  check(count === files.size, 409, "快照缺少文件。");
  return { manifest, files };
}

export async function verifyBackup(path) {
  const root = await realpath(path);
  const { manifest, files } = await readManifest(root);
  for (const item of files.values())
    check(sameFile(item, await fingerprint(join(root, item.path))), 409, `备份文件校验失败（${item.path}）。`);
  verifyDatabase(root, files);
  const { config } = readWorkspace(root);
  check(!config.database && config.tenantId === manifest.tenantId && config.appId === manifest.appId, 409, "备份的工作区身份或数据库格式不匹配。");
  return summary(manifest);
}

async function installBackup(source, target, restore, options) {
  source = await realpath(source);
  const path = await destination(target, source);
  const { manifest, files } = await readManifest(source);
  // Reserve an unused private path. Startup only recognizes config.json,
  // which is published after the restored files have been verified.
  await mkdir(path, { mode: 0o700 });
  let databaseCommitted = false;
  try {
    const directories = new Set(folders.map(folder => join(path, folder)));
    for (const folder of directories) await mkdir(folder, { mode: 0o700 });
    for (const item of files.values()) {
      const target = join(path, restore && item.path === "config.json" ? ".restore-config" : item.path);
      const parent = dirname(target);
      if (parent !== path && !directories.has(parent)) {
        await mkdir(parent, { mode: 0o700, recursive: true });
        for (let current = parent; current !== path; current = dirname(current)) directories.add(current);
      }
      await copyFile(join(source, item.path), target, reflink);
      await chmod(target, 0o600);
      check(sameFile(item, await fingerprint(target)), 409, `备份文件校验失败（${item.path}）。`);
      await sync(target);
    }
    verifyDatabase(path, files);
    const { config } = readWorkspace(path, restore ? ".restore-config" : "config.json");
    check(!config.database && config.tenantId === manifest.tenantId && config.appId === manifest.appId, 409, "备份的工作区身份或数据库格式不匹配。");
    for (const dir of [...directories].sort((a, b) => b.length - a.length)) await sync(dir);
    if (restore) {
      const selected = configureDatabase(config, options?.database, options?.urlEnv);
      const pending = join(path, ".restore-config");
      if (selected.database) {
        atomic(pending, JSON.stringify(selected, null, 2) + "\n");
        const sourceDb = join(path, "business.sqlite");
        const store = await Store.open(path, { database: selected.database,
          initialize: target => target.importDatabase(sourceDb, AbortSignal.timeout(15 * 60 * 1000)),
        });
        databaseCommitted = true;
        await store.close();
        await rm(sourceDb);
      }
      await rename(pending, join(path, "config.json"));
    } else atomic(join(path, metadata), JSON.stringify(manifest) + "\n", { exclusive: true });
    await sync(path);
    await sync(dirname(path));
    return { ...summary(manifest), path };
  } catch (error) {
    if (databaseCommitted) {
      throw new Error(`数据库已迁移，工作区文件保留在 ${path}。发布本地配置时发生错误。`, { cause: error });
    }
    await rm(path, { force: true, recursive: true });
    throw error;
  }
}

/** @param {string} source @param {string} target @param {{database?: string, urlEnv?: string}} [options] */
export function restoreBackup(source, target, options) {
  return installBackup(source, target, true, options);
}

// The deployment supervisor calls this only after its drained child has exited.
export async function snapshotAfterShutdown({ root, config }, output, cut) {
  check(!config.database, 409, "托管版本切换使用本机 SQLite。远程数据库使用 Compose 的在线备份与恢复。");
  const path = await destination(output, root);
  const id = randomUUID();
  const db = new DatabaseSync(join(root, "business.sqlite"), { readOnly: true });
  try {
    await captureWorkspace({ root, config, copyDatabase: path => backup(db, path), id, signal: new AbortController().signal,
      hold: async copy => { await copy(); return cut; } });
  } finally { db.close(); }
  const staging = join(root, snapshots, id);
  const installed = await installBackup(staging, path, false);
  await rm(staging, { recursive: true, force: true });
  return installed;
}

export async function requestOnlineBackup({ root, config, keys }, output) {
  const path = await destination(output, root);
  const existing = await lstat(path).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  check(!existing, 409, "备份目标已经存在，请指定新目录。");
  const id = randomUUID();
  const response = await new Promise((resolve, reject) => {
    const req = request({ hostname: config.bindHost === "::1" ? "::1" : "127.0.0.1", port: config.port,
      path: `/workspace/internal/backup/${id}`, method: "POST",
      headers: { Authorization: `Bearer ${keys.service}`, Host: new URL(config.publicUrl).host },
      signal: AbortSignal.timeout(15 * 60 * 1000),
    }, resolve);
    req.once("error", () => reject(new Error("无法请求在线备份，请确认本机工作区服务正常运行。")));
    req.end();
  });
  response.setEncoding("utf8");
  let payload = "";
  for await (const chunk of response) payload += chunk;
  const result = JSON.parse(payload);
  check(response.statusCode === 201 && result.id === id, response.statusCode, result.error || "备份未完成，请确认本机工作区服务正常运行。");
  const staged = join(root, snapshots, id);
  let installed;
  try { installed = await installBackup(staged, path, false); }
  catch (error) { throw new Error(`快照已封存于 ${staged}。复制到目标目录失败（${error.message}）。`, { cause: error }); }
  await rm(staged, { force: true, recursive: true });
  return installed;
}
