import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  linkSync,
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
export const workspaceSchemaVersion = "officecli-workspace/1";
const workspaceSchemaRevision = "1";

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
  "document.ai",
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
const projectEditorOperations = [...profiles.viewer, "document.edit", "document.ai", "document.export"];
export const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name,
  role: user.role,
  disabled: !!user.disabled,
  createdAt: user.created_at,
  isGuest: !!user.is_guest,
});
export function atomic(path, bytes, { exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (exclusive) {
      // Two simultaneous initializations must never replace the winning identity.
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else renameSync(temporary, path);
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
    try {
      if (this.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='metadata'")) {
        const schema = this.get("SELECT value FROM metadata WHERE key='schemaVersion'");
        const revision = this.get("SELECT value FROM metadata WHERE key='schemaRevision'");
        check((!schema || schema.value === workspaceSchemaVersion) && (!revision || revision.value === workspaceSchemaRevision),
          503, "业务库版本不兼容，请使用对应版本恢复。");
      }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      this.transaction(() => {
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
      CREATE TABLE IF NOT EXISTS workbench_jobs(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workbench_jobs_owner ON workbench_jobs(owner_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, failures INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS launches_browser ON launches(browser_hash);
      CREATE INDEX IF NOT EXISTS launches_imported_file ON launches(file_id) WHERE response IS NOT NULL;
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS shares(file_id TEXT PRIMARY KEY REFERENCES files(id), visibility TEXT NOT NULL CHECK(visibility IN ('private','link','public')), permission TEXT NOT NULL CHECK(permission IN ('read','write')), secret_hash TEXT NOT NULL, secret_cipher TEXT NOT NULL, generation INTEGER NOT NULL, expires INTEGER, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guest_identities(user_id TEXT PRIMARY KEY REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS share_grants(user_id TEXT NOT NULL REFERENCES guest_identities(user_id), file_id TEXT NOT NULL REFERENCES files(id), generation INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(user_id,file_id));
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_members(project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('manager','editor','viewer')), PRIMARY KEY(project_id,user_id));
      CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id,project_id);
      CREATE TABLE IF NOT EXISTS project_folders(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), parent_id TEXT, name TEXT NOT NULL,
        UNIQUE(id,project_id), FOREIGN KEY(parent_id,project_id) REFERENCES project_folders(id,project_id));
      CREATE UNIQUE INDEX IF NOT EXISTS project_folder_names ON project_folders(project_id,COALESCE(parent_id,''),name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS project_files(
        file_id TEXT PRIMARY KEY REFERENCES files(id), project_id TEXT NOT NULL REFERENCES projects(id), folder_id TEXT,
        FOREIGN KEY(folder_id,project_id) REFERENCES project_folders(id,project_id));
      CREATE INDEX IF NOT EXISTS project_files_location ON project_files(project_id,folder_id);
      CREATE TABLE IF NOT EXISTS canvas_mention_heads(file_id TEXT PRIMARY KEY REFERENCES files(id), revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS canvas_mentions(
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), element_id TEXT NOT NULL,
        recipient TEXT NOT NULL, kind TEXT NOT NULL, preview TEXT NOT NULL, received_at TEXT NOT NULL, read_at TEXT,
        UNIQUE(file_id,element_id,recipient));
      CREATE INDEX IF NOT EXISTS canvas_mentions_recipient ON canvas_mentions(recipient,received_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS publication_copies(publication_id TEXT PRIMARY KEY,file_id TEXT NOT NULL REFERENCES files(id));
        `);
        this.run("INSERT OR IGNORE INTO metadata VALUES(?,?)", "schemaVersion", workspaceSchemaVersion);
        this.run("INSERT OR IGNORE INTO metadata VALUES(?,?)", "schemaRevision", workspaceSchemaRevision);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
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
    const guest = this.get("SELECT expires FROM guest_identities WHERE user_id=?", id);
    check(!guest || guest.expires > now(), 403, "访客身份已过期，请重新打开分享链接。");
    return { ...user, is_guest: !!guest };
  }
  file(id) {
    check(uuid(id), 400, "文件 ID 无效。");
    const file = this.get("SELECT * FROM files WHERE id=?", id);
    check(file, 404, "文件不存在。");
    return file;
  }
  projectRole(user, projectId) {
    if (user.is_guest || user.disabled) return null;
    const row = this.get(`SELECT p.owner_id,m.role FROM projects p
      LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=? WHERE p.id=?`, user.id, projectId);
    if (!row) return null;
    return user.role === "admin" || user.id === row.owner_id ? "manager" : row.role;
  }
  fileLocation(fileId) {
    return this.get("SELECT project_id AS projectId,folder_id AS folderId FROM project_files WHERE file_id=?", fileId) ?? null;
  }
  permissions(user, file) {
    const guest = this.get("SELECT expires FROM guest_identities WHERE user_id=?", user.id);
    if (guest) {
      const grant = this.get(
        "SELECT s.permission FROM share_grants g JOIN shares s ON s.file_id=g.file_id WHERE g.user_id=? AND g.file_id=? AND g.generation=s.generation AND g.expires>? AND s.visibility IN ('link','public') AND (s.expires IS NULL OR s.expires>?)",
        user.id, file.id, now(), now(),
      );
      if (!grant || guest.expires <= now() || user.disabled) return [];
      return ["document.view", "document.copy", ...(grant.permission === "write" ? ["document.edit"] : [])];
    }
    if (user.role === "admin" || file.owner_id === user.id)
      return [...operations];
    const row = this.get(
      "SELECT operations FROM acl WHERE file_id=? AND user_id=?",
      file.id,
      user.id,
    );
    const direct = row ? JSON.parse(row.operations) : [];
    const location = this.fileLocation(file.id);
    const role = location && this.projectRole(user, location.projectId);
    const inherited = role === "viewer" ? profiles.viewer : role ? projectEditorOperations : [];
    return [...new Set([...direct, ...inherited])];
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
  canManage(user, file) {
    return !user.is_guest && (user.role === "admin" ||
        file.owner_id === user.id ||
        this.get(
          "SELECT profile FROM acl WHERE file_id=? AND user_id=?",
          file.id,
          user.id,
        )?.profile === "manager");
  }
  manage(user, file) {
    check(this.canManage(user, file), 403, "仅文件负责人或管理员可以管理访问权限。");
  }
  createFile(user, name, format, mediaType, bytes, location = null, publicationCopy = null) {
    const id = randomUUID(),
      at = iso(),
      digest = this.put(bytes);
    const savedId = this.transaction(() => {
      if (publicationCopy) {
        const existing = this.get("SELECT file_id FROM publication_copies WHERE publication_id=?", publicationCopy);
        if (existing) return existing.file_id;
      }
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
      if (location) this.run("INSERT INTO project_files VALUES(?,?,?)", id, location.projectId, location.folderId);
      this.audit(user.id, "file.created", id);
      if (publicationCopy) {
        this.run("INSERT INTO publication_copies VALUES(?,?)", publicationCopy, id);
        this.audit(user.id, "publication.copied", publicationCopy);
      }
      return id;
    });
    return this.file(savedId);
  }
  close() {
    this.db.close();
  }
}
