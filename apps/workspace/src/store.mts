import { AsyncLocalStorage } from "node:async_hooks";
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
  scrypt,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";
import { check, type NetworkDatabaseConfig, type WorkspaceRole } from "./contracts.mts";
import { openSqlite, type DatabaseConnection, type DatabaseParameter, type DatabaseRow } from "./database.mts";
import { bindingKey, copyBusinessRows, createSchema, identifier, verifyEmptySchema, verifySchema } from "./business-schema.mts";

export { check, HttpError } from "./contracts.mts";
export { workspaceSchemaVersion } from "./business-schema.mts";

export const now = () => Math.floor(Date.now() / 1000);
export const iso = () => new Date().toISOString();
export const hash = (value: BinaryLike) => createHash("sha256").update(value).digest("hex");
export const random = () => randomBytes(32).toString("base64url");
export const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );
export const equal = (a: unknown, b: unknown) => {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
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
] as const;
export type Operation = (typeof operations)[number];
export type ProjectRole = "manager" | "editor" | "viewer";

export interface WorkspaceUser {
  id: string;
  role: WorkspaceRole;
  disabled: number;
  is_guest?: boolean;
}

interface UserRow extends WorkspaceUser {
  username: string;
  display_name: string;
  password: string;
  created_at: string;
}

export interface FileRow {
  id: string;
  owner_id: string;
  name: string;
  format: string;
  media_type: string;
  head: number;
  created_at: string;
  modified_at: string;
}

export interface FileLocation {
  projectId: string;
  folderId: string | null;
}

export const profiles: Record<ProjectRole, readonly Operation[]> = {
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
const projectEditorOperations: readonly Operation[] = [...profiles.viewer, "document.edit", "document.ai", "document.export"];
export const publicUser = (user: Omit<UserRow, "password">) => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name,
  role: user.role,
  disabled: !!user.disabled,
  createdAt: user.created_at,
  isGuest: !!user.is_guest,
});
export function atomic(path: string, bytes: string | NodeJS.ArrayBufferView, { exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
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
  password: unknown,
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
    const key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
    return `scrypt:32768:8:1:${salt}:${key.toString("hex")}`;
  } finally {
    passwordWorkers--;
  }
}
export async function verifyPassword(password: unknown, encoded: string) {
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
interface OpenOptions {
  database?: NetworkDatabaseConfig;
  initialize?: (store: Store) => Promise<void>;
  onFailure?: () => void;
}

interface AccessRow extends FileRow {
  role: WorkspaceRole;
  disabled: number;
  guest_expires: number | null;
  grant_permission: "read" | "write" | null;
  acl_operations: string | null;
  acl_profile: ProjectRole | null;
  project_owner: string | null;
  project_role: ProjectRole | null;
  project_id: string | null;
  folder_id: string | null;
  owner_name: string;
  version_size: number;
  version_receipt: string | null;
  has_launch: number | boolean;
}

export interface FileAccess {
  file: FileRow;
  operations: Operation[];
  canManage: boolean;
  location: FileLocation | null;
  ownerName: string;
  size: number;
  receipt: string | null;
  hasLaunch: boolean;
}

function fileAccess(row: AccessRow, user: WorkspaceUser): FileAccess {
  const { id, owner_id, name, format, media_type, head, created_at, modified_at } = row;
  const file = { id, owner_id, name, format, media_type, head, created_at, modified_at };
  const isGuest = row.guest_expires !== null;
  const canManage = !row.disabled && !isGuest &&
    (row.role === "admin" || owner_id === user.id || row.acl_profile === "manager");
  const projectRole = !row.project_id || row.disabled || isGuest ? null
    : row.role === "admin" || row.project_owner === user.id ? "manager" : row.project_role;
  let granted: Operation[] = [];
  if (!row.disabled) {
    if (isGuest) {
      if (row.guest_expires! > now() && row.grant_permission) {
        granted = ["document.view", "document.copy"];
        if (row.grant_permission === "write") granted.push("document.edit");
      }
    } else if (row.role === "admin" || owner_id === user.id) {
      granted = [...operations];
    } else {
      const direct: Operation[] = row.acl_operations ? JSON.parse(row.acl_operations) : [];
      const inherited = projectRole === "viewer" ? profiles.viewer : projectRole ? projectEditorOperations : [];
      granted = [...new Set([...direct, ...inherited])];
    }
  }
  return {
    file, operations: granted, canManage,
    location: projectRole && row.project_id ? { projectId: row.project_id, folderId: row.folder_id } : null,
    ownerName: row.owner_name, size: row.version_size, receipt: row.version_receipt, hasLaunch: !!row.has_launch,
  };
}

export class Store {
  readonly root: string;
  readonly kind;
  #db: DatabaseConnection;
  #snapshotSqlite?: (path: string) => Promise<void>;
  #onFailure: () => void;
  #scope = new AsyncLocalStorage<{ active: boolean; transaction: boolean }>();
  #tail = Promise.resolve();
  #closing?: Promise<void>;

  private constructor(root: string, db: DatabaseConnection, onFailure: () => void) {
    this.root = root;
    this.kind = db.kind;
    this.#db = db;
    this.#onFailure = onFailure;
  }

  static async open(root: string, { database, initialize, onFailure = () => {} }: OpenOptions = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    for (const folder of ["objects", "staging"]) mkdirSync(join(root, folder), { recursive: true, mode: 0o700 });
    const path = join(root, "business.sqlite");
    if (!database) {
      const sqlite = openSqlite(path, { create: !!initialize });
      const store = new Store(root, sqlite, onFailure);
      store.#snapshotSqlite = sqlite.snapshot;
      try {
        await store.transaction(async () => {
          const metadata = await store.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='metadata'");
          if (metadata) await verifySchema(sqlite, true);
          else check(initialize, 503, "工作区 SQLite 数据库缺少业务架构，请恢复备份。");
          await createSchema(sqlite);
          if (initialize) await initialize(store);
        });
        return store;
      } catch (error) {
        await store.close();
        throw error;
      }
    }

    const { connectNetworkDatabase, listNetworkTables } = await import("./network-database.mts");
    const connection = await connectNetworkDatabase(database, onFailure);
    const store = new Store(root, connection, onFailure);
    try {
      const names = await listNetworkTables(connection);
      if (initialize) {
        // DDL on MySQL commits implicitly. Data and the binding are written in
        // one later transaction after the empty destination has been checked.
        if (!names.length) await createSchema(connection);
        else check(names.includes("metadata"), 409, "目标数据库已有其他表，需要专用的空数据库。");
        await store.transaction(async () => {
          await verifyEmptySchema(connection, names);
          await initialize(store);
          await store.run("INSERT INTO metadata VALUES(?,?)", bindingKey, database.id);
        });
      } else {
        check(names.includes("metadata"), 409, "远程数据库尚未初始化，请使用原有连接或从备份恢复。");
        const metadata = await verifySchema(connection);
        check(metadata.get(bindingKey) === database.id, 409, "数据库与工作区不匹配，请检查连接配置。");
      }
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  // Each workspace owns one connection. A transaction keeps the connection
  // until commit, including across asynchronous driver calls.
  read<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.#scope.getStore()?.active) return Promise.resolve().then(work);
    check(!this.#closing, 503, "业务数据库已关闭。");
    const next = this.#tail.then(() => {
      const scope = { active: true, transaction: false };
      return this.#scope.run(scope, async () => {
        try { return await work(); }
        finally { scope.active = false; }
      });
    });
    this.#tail = next.then(() => {}, () => {});
    return next;
  }

  async transaction<T>(work: () => T | Promise<T>, { snapshot = false } = {}): Promise<T> {
    return this.read(async () => {
      const scope = this.#scope.getStore()!;
      check(!scope.transaction, 503, "业务数据库不支持嵌套事务。");
      if (snapshot && this.kind === "mysql") {
        await this.#db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await this.#db.exec("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      } else {
        await this.#db.exec(this.kind === "sqlite" ? "BEGIN IMMEDIATE"
          : snapshot ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      }
      scope.transaction = true;
      try {
        const result = await work();
        await this.#db.exec("COMMIT");
        return result;
      } catch (error) {
        try { await this.#db.exec("ROLLBACK"); }
        catch { this.#onFailure(); }
        throw error;
      } finally { scope.transaction = false; }
    });
  }

  async get<T extends object = DatabaseRow>(sql: string, ...args: DatabaseParameter[]): Promise<T | undefined> {
    return this.read(async () => (await this.#db.all(sql, args))[0] as T | undefined);
  }

  async all<T extends object = DatabaseRow>(sql: string, ...args: DatabaseParameter[]): Promise<T[]> {
    return this.read(async () => await this.#db.all(sql, args) as T[]);
  }

  async run(sql: string, ...args: DatabaseParameter[]) {
    return this.read(() => this.#db.run(sql, args));
  }

  upsert(table: string, keys: readonly string[], row: Record<string, DatabaseParameter>) {
    const fields = Object.keys(row);
    const columns = fields.map(identifier);
    const updates = fields.filter(field => !keys.includes(field)).map(identifier);
    const sql = `INSERT INTO ${identifier(table)} (${columns.join(",")}) VALUES (${fields.map(() => "?").join(",")})`;
    const suffix = this.kind === "mysql"
      ? " AS incoming ON DUPLICATE KEY UPDATE " + updates.map(field => `${field}=incoming.${field}`).join(",")
      : ` ON CONFLICT (${keys.map(identifier).join(",")}) DO UPDATE SET ` + updates.map(field => `${field}=excluded.${field}`).join(",");
    return this.run(sql + suffix, ...Object.values(row));
  }

  audit(actor: string | null, action: string, target: string | null = null) {
    return this.run("INSERT INTO audit(actor_id,action,target_id,created_at) VALUES(?,?,?,?)", actor, action, target, iso());
  }

  object(digest: string) {
    check(/^[a-f0-9]{64}$/.test(digest), 400, "文件校验值无效。");
    return join(this.root, "objects", digest);
  }

  put(bytes: Uint8Array) {
    const digest = hash(bytes), target = this.object(digest);
    if (!existsSync(target)) atomic(target, bytes);
    else check(hash(readFileSync(target)) === digest, 503, "文件存储校验失败，请恢复备份。");
    return digest;
  }

  async user(id: string) {
    const user = await this.get<UserRow & { guest_expires: number | null }>(
      "SELECT u.*,g.expires AS guest_expires FROM users u LEFT JOIN guest_identities g ON g.user_id=u.id WHERE u.id=?", id,
    );
    check(user && !user.disabled, 403, "用户已停用或不存在。");
    const { guest_expires, ...current } = user;
    check(guest_expires === null || guest_expires > now(), 403, "访客身份已过期，请重新打开分享链接。");
    return { ...current, is_guest: guest_expires !== null };
  }

  async file(id: string) {
    check(uuid(id), 400, "文件 ID 无效。");
    const file = await this.get<FileRow>("SELECT * FROM files WHERE id=?", id);
    check(file, 404, "文件不存在。");
    return file;
  }

  async projectRole(user: WorkspaceUser, projectId: string): Promise<ProjectRole | null> {
    const row = await this.get<{ owner_id: string; role: ProjectRole | null; actor_role: WorkspaceRole }>(
      `SELECT p.owner_id,m.role,u.role AS actor_role FROM projects p
       JOIN users u ON u.id=? AND u.disabled=0
       LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=u.id
       WHERE p.id=? AND NOT EXISTS (SELECT 1 FROM guest_identities g WHERE g.user_id=u.id)`, user.id, projectId,
    );
    if (!row) return null;
    return row.actor_role === "admin" || user.id === row.owner_id ? "manager" : row.role;
  }

  async fileLocation(fileId: string) {
    return await this.get<FileLocation>('SELECT project_id AS "projectId",folder_id AS "folderId" FROM project_files WHERE file_id=?', fileId) ?? null;
  }

  #accessRows(userId: string, fileId?: string, withHistory = false) {
    const time = now();
    return this.all<AccessRow>(
      `SELECT f.*,u.role,u.disabled,g.expires AS guest_expires,s.permission AS grant_permission,
         a.operations AS acl_operations,a.profile AS acl_profile,p.owner_id AS project_owner,
         m.role AS project_role,pf.project_id,pf.folder_id,
         ${withHistory ? `owner.display_name AS owner_name,v.size AS version_size,v.receipt AS version_receipt,
            EXISTS (SELECT 1 FROM launches l WHERE l.file_id=f.id) AS has_launch`
           : "NULL AS owner_name,NULL AS version_size,NULL AS version_receipt,0 AS has_launch"}
       FROM files f
       JOIN users u ON u.id=?
       ${withHistory ? "JOIN users owner ON owner.id=f.owner_id JOIN versions v ON v.file_id=f.id AND v.version=f.head" : ""}
       LEFT JOIN guest_identities g ON g.user_id=u.id
       LEFT JOIN share_grants sg ON sg.user_id=u.id AND sg.file_id=f.id AND sg.expires>?
       LEFT JOIN shares s ON s.file_id=f.id AND s.generation=sg.generation
         AND s.visibility IN ('link','public') AND (s.expires IS NULL OR s.expires>?)
       LEFT JOIN acl a ON a.file_id=f.id AND a.user_id=u.id
       LEFT JOIN project_files pf ON pf.file_id=f.id
       LEFT JOIN projects p ON p.id=pf.project_id
       LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=u.id
       ${fileId ? "WHERE f.id=?" : "ORDER BY f.modified_at DESC"}`, userId, time, time, ...(fileId ? [fileId] : []),
    );
  }

  async listFiles(user: WorkspaceUser) {
    return (await this.#accessRows(user.id, undefined, true))
      .map(row => fileAccess(row, user)).filter(item => item.operations.includes("document.view"));
  }

  async access(user: WorkspaceUser, fileId: string) {
    const [row] = await this.#accessRows(user.id, fileId, true);
    check(row, 404, "文件不存在。");
    return fileAccess(row, user);
  }

  async permissions(user: WorkspaceUser, file: Pick<FileRow, "id">) {
    const [row] = await this.#accessRows(user.id, file.id);
    return row ? fileAccess(row, user).operations : [];
  }

  async permit(user: WorkspaceUser, file: Pick<FileRow, "id">, ...required: Operation[]) {
    const granted = await this.permissions(user, file);
    check(required.every(op => granted.includes(op)), 403, "没有此文件的操作权限。");
    return granted;
  }

  async canManage(user: WorkspaceUser, file: Pick<FileRow, "id">) {
    const [row] = await this.#accessRows(user.id, file.id);
    return !!row && fileAccess(row, user).canManage;
  }

  async manage(user: WorkspaceUser, file: Pick<FileRow, "id">) {
    check(await this.canManage(user, file), 403, "仅文件负责人或管理员可以管理访问权限。");
  }

  async createFile(user: WorkspaceUser, name: string, format: string, mediaType: string, bytes: Uint8Array,
    location: FileLocation | null | (() => Promise<FileLocation | null>) = null, publicationCopy: string | null = null) {
    const id = randomUUID(), at = iso(), digest = this.put(bytes);
    const savedId = await this.transaction(async () => {
      check(!(await this.user(user.id)).is_guest, 403, "创建文件需要工作空间成员权限。");
      if (publicationCopy) {
        const existing = await this.get<{ file_id: string }>("SELECT file_id FROM publication_copies WHERE publication_id=?", publicationCopy);
        if (existing) return existing.file_id;
      }
      const target = typeof location === "function" ? await location() : location;
      await this.run("INSERT INTO files VALUES(?,?,?,?,?,?,?,?)", id, name, format, mediaType, user.id, 1, at, at);
      await this.run("INSERT INTO versions VALUES(?,?,?,?,?,?,NULL)", id, 1, digest, bytes.length, user.id, at);
      if (target) await this.run("INSERT INTO project_files VALUES(?,?,?)", id, target.projectId, target.folderId);
      await this.audit(user.id, "file.created", id);
      if (publicationCopy) {
        await this.run("INSERT INTO publication_copies VALUES(?,?)", publicationCopy, id);
        await this.audit(user.id, "publication.copied", publicationCopy);
      }
      return id;
    });
    return this.file(savedId);
  }

  async exportDatabase(path: string, signal: AbortSignal) {
    if (this.#snapshotSqlite) return this.read(() => this.#snapshotSqlite!(path));
    const target = openSqlite(path, { create: true });
    try {
      await target.exec("BEGIN IMMEDIATE");
      await createSchema(target);
      await this.transaction(() => copyBusinessRows(this.#db, target, signal), { snapshot: true });
      await target.exec("COMMIT");
    } finally { target.close(); }
  }

  async importDatabase(path: string, signal: AbortSignal) {
    check(this.#scope.getStore()?.transaction, 503, "迁移业务数据需要目标事务。");
    const source = openSqlite(path, { readOnly: true });
    try { await copyBusinessRows(source, this.#db, signal); }
    finally { source.close(); }
  }

  close() {
    this.#closing ??= this.#tail.then(() => this.#db.close());
    return this.#closing;
  }
}
