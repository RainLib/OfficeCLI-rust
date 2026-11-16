import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const now = () => Math.floor(Date.now() / 1000);
export const iso = () => new Date().toISOString();
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const random = () => randomBytes(32).toString("base64url");
export const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
export const equal = (a, b) => {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const check = (condition, status, message) => {
  if (!condition) throw new HttpError(status, message);
};
export const operations = [
  "document.view",
  "document.edit",
  "document.publish",
  "document.download",
  "document.export",
  "document.print",
  "document.copy",
  "history.view",
  "history.restore",
  "theme.assign",
];
export const profiles = {
  viewer: [
    "document.view",
    "document.download",
    "document.print",
    "document.copy",
    "history.view",
  ],
  editor: operations.filter((op) => op !== "theme.assign"),
  manager: operations,
};
export const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name,
  role: user.role,
  disabled: !!user.disabled,
  createdAt: user.created_at,
});
export function atomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}
let passwordWorkers = 0;
export async function passwordHash(
  password,
  salt = randomBytes(16).toString("hex"),
) {
  check(
    typeof password === "string" &&
      password.length >= 12 &&
      Buffer.byteLength(password) <= 1024,
    400,
    "密码至少 12 个字符，UTF-8 不超过 1024 字节。",
  );
  check(passwordWorkers < 4, 429, "登录请求较多，请稍后重试。");
  passwordWorkers++;
  try {
    return `scrypt:32768:8:1:${salt}:${(await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString("hex")}`;
  } finally {
    passwordWorkers--;
  }
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || Buffer.byteLength(password) > 1024)
    return false;
  const pieces = encoded.split(":");
  check(
    pieces.length === 6 && pieces.slice(0, 4).join(":") === "scrypt:32768:8:1",
    503,
    "账号密码记录无法读取。",
  );
  return (
    equal(
      await passwordHash(
        password.length < 12 ? password.padEnd(12, "\0") : password,
        pieces[4],
      ),
      encoded,
    ) && password.length >= 12
  );
}
export class Store {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    mkdirSync(join(root, "objects"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "staging"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, "business.sqlite"));
    chmodSync(join(root, "business.sqlite"), 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL, media_type TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), head INTEGER NOT NULL, created_at TEXT NOT NULL, modified_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(file_id TEXT NOT NULL REFERENCES files(id), version INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, receipt TEXT, PRIMARY KEY(file_id, version));
      CREATE TABLE IF NOT EXISTS acl(file_id TEXT NOT NULL REFERENCES files(id), user_id TEXT NOT NULL REFERENCES users(id), profile TEXT NOT NULL, operations TEXT NOT NULL, PRIMARY KEY(file_id,user_id));
      CREATE TABLE IF NOT EXISTS launches(id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), file_id TEXT NOT NULL REFERENCES files(id), expires INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, response TEXT, request TEXT, purpose TEXT NOT NULL DEFAULT 'open');
      CREATE TABLE IF NOT EXISTS exchanges(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES launches(id), credential_hash TEXT NOT NULL, purpose TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), actor_id TEXT NOT NULL REFERENCES users(id), intent TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0, receipt TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), sequence INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces(id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, failures INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS launches_browser ON launches(browser_hash);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    `);
    const schema = this.get(
      "SELECT value FROM metadata WHERE key=?",
      "schemaVersion",
    );
    check(
      !schema || schema.value === "officecli-workspace/1",
      503,
      "业务库版本不兼容，请使用对应版本恢复。",
    );
    this.run(
      "INSERT OR IGNORE INTO metadata VALUES(?,?)",
      "schemaVersion",
      "officecli-workspace/1",
    );
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  audit(actor, action, target = null) {
    this.run(
      "INSERT INTO audit(actor_id,action,target_id,created_at) VALUES(?,?,?,?)",
      actor,
      action,
      target,
      iso(),
    );
  }
  object(digest) {
    check(/^[a-f0-9]{64}$/.test(digest), 400, "文件校验值无效。");
    return join(this.root, "objects", digest);
  }
  put(bytes) {
    const digest = hash(bytes),
      target = this.object(digest);
    if (!existsSync(target)) atomic(target, bytes);
    else
      check(
        hash(readFileSync(target)) === digest,
        503,
        "文件存储校验失败，请恢复备份。",
      );
    return digest;
  }
  user(id) {
    const user = this.get("SELECT * FROM users WHERE id=?", id);
    check(user && !user.disabled, 403, "用户已停用或不存在。");
    return user;
  }
  file(id) {
    check(uuid(id), 400, "文件 ID 无效。");
    const file = this.get("SELECT * FROM files WHERE id=?", id);
    check(file, 404, "文件不存在。");
    return file;
  }
  permissions(user, file) {
    if (user.role === "admin" || file.owner_id === user.id)
      return [...operations];
    const row = this.get(
      "SELECT operations FROM acl WHERE file_id=? AND user_id=?",
      file.id,
      user.id,
    );
    return row ? JSON.parse(row.operations) : [];
  }
  permit(user, file, ...required) {
    const granted = this.permissions(user, file);
    check(
      required.every((op) => granted.includes(op)),
      403,
      "没有此文件的操作权限。",
    );
    return granted;
  }
  manage(user, file) {
    check(
      user.role === "admin" ||
        file.owner_id === user.id ||
        this.get(
          "SELECT profile FROM acl WHERE file_id=? AND user_id=?",
          file.id,
          user.id,
        )?.profile === "manager",
      403,
      "仅文件负责人或管理员可以管理访问权限。",
    );
  }
  createFile(user, name, format, mediaType, bytes) {
    const id = randomUUID(),
      at = iso(),
      digest = this.put(bytes);
    this.transaction(() => {
      this.run(
        "INSERT INTO files VALUES(?,?,?,?,?,?,?,?)",
        id,
        name,
        format,
        mediaType,
        user.id,
        1,
        at,
        at,
      );
      this.run(
        "INSERT INTO versions VALUES(?,?,?,?,?,?,NULL)",
        id,
        1,
        digest,
        bytes.length,
        user.id,
        at,
      );
      this.audit(user.id, "file.created", id);
    });
    return this.file(id);
  }
  close() {
    this.db.close();
  }
}
