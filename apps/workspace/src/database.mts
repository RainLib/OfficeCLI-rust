import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { check, type DatabaseKind, type NetworkDatabaseConfig, type WorkspaceConfig } from "./contracts.mts";

export type DatabaseParameter = string | number | null;
export type DatabaseRow = Record<string, DatabaseParameter | boolean>;
type Awaitable<T> = T | Promise<T>;

export interface DatabaseConnection {
  readonly kind: DatabaseKind;
  all(sql: string, args: DatabaseParameter[]): Awaitable<DatabaseRow[]>;
  run(sql: string, args: DatabaseParameter[]): Awaitable<void>;
  exec(sql: string): Awaitable<void>;
  close(): Awaitable<void>;
}

export const defaultDatabaseEnv = "FOLDLY_DATABASE_URL";
export const databaseEnvKeys = (name = defaultDatabaseEnv) => [name, name + "_FILE", name + "_CA_FILE"];
const envName = /^[A-Z][A-Z0-9_]{0,127}$/;

export function configureDatabase(config: WorkspaceConfig, kind?: string, urlEnv?: string): WorkspaceConfig {
  if (!kind || kind === "sqlite") {
    check(!urlEnv, 400, "只有 PostgreSQL 或 MySQL 需要数据库连接变量。");
    return config;
  }
  check(kind === "postgres" || kind === "mysql", 400, "database 请选择 sqlite、postgres 或 mysql。");
  check(config.mode !== "desktop", 409, "桌面工作区使用本机 SQLite。");
  check(!urlEnv || envName.test(urlEnv), 400, "数据库连接变量名无效。");
  return {
    ...config,
    schemaVersion: "officecli-workspace/2",
    database: { kind, urlEnv: urlEnv || defaultDatabaseEnv, id: randomUUID() },
  };
}

export function validateDatabaseConfig(config: WorkspaceConfig) {
  const database = config.database;
  if (config.schemaVersion === "officecli-workspace/1") {
    check(database === undefined, 409, "业务库配置需要用 restore 创建新工作区。");
  } else {
    check(config.schemaVersion === "officecli-workspace/2" && config.mode !== "desktop" && database &&
      (database.kind === "postgres" || database.kind === "mysql") &&
      typeof database.urlEnv === "string" && envName.test(database.urlEnv) &&
      typeof database.id === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(database.id),
    409, "业务数据库配置无效。");
  }
}

export function sqliteSnapshotConfig(config: WorkspaceConfig): WorkspaceConfig {
  const { database: _, ...local } = config;
  return { ...local, schemaVersion: "officecli-workspace/1" };
}

export function openSqlite(path: string, { create = false, readOnly = false } = {}) {
  check(create || existsSync(path), 503, "工作区 SQLite 数据库缺失，请确认数据目录或恢复备份。");
  const db = new DatabaseSync(path, { readOnly });
  const statements = new Map<string, StatementSync>();
  const statementLimit = 128;
  try {
    if (!readOnly) {
      chmodSync(path, 0o600);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    }
  } catch (error) {
    db.close();
    throw error;
  }
  function prepare(sql: string) {
    const cached = statements.get(sql);
    if (cached) {
      statements.delete(sql);
      statements.set(sql, cached);
      return cached;
    }
    const statement = db.prepare(sql);
    if (statements.size >= statementLimit) {
      const oldest = statements.keys().next();
      if (!oldest.done) statements.delete(oldest.value);
    }
    statements.set(sql, statement);
    return statement;
  }
  return {
    kind: "sqlite" as const,
    all(sql: string, args: DatabaseParameter[]) { return prepare(sql).all(...args) as DatabaseRow[]; },
    run(sql: string, args: DatabaseParameter[]) { prepare(sql).run(...args); },
    exec(sql: string) { db.exec(sql); },
    async snapshot(destination: string) { await backup(db, destination); },
    close() { statements.clear(); db.close(); },
  };
}

export function connectionOptions({ kind, urlEnv }: NetworkDatabaseConfig) {
  let value: string | undefined;
  try {
    check(!(process.env[urlEnv] && process.env[urlEnv + "_FILE"]), 400, "数据库连接字符串与文件只能配置一个。");
    value = process.env[urlEnv];
    if (process.env[urlEnv + "_FILE"]) value = readFileSync(process.env[urlEnv + "_FILE"]!, "utf8").trim();
  } catch {
    check(false, 400, `无法读取 ${urlEnv} 或 ${urlEnv}_FILE 的数据库连接配置。`);
  }
  check(value, 400, `缺少 ${urlEnv} 或 ${urlEnv}_FILE 的数据库连接配置。`);

  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    const tls = url.searchParams.get("tls");
    const caFile = process.env[urlEnv + "_CA_FILE"];
    check((kind === "postgres" ? ["postgres:", "postgresql:"].includes(url.protocol) : url.protocol === "mysql:") &&
      url.hostname && url.username && database && !/[\/\p{Cc}]/u.test(database) &&
      !url.hash && [...url.searchParams.keys()].every(key => key === "tls") &&
      url.searchParams.getAll("tls").length <= 1 && (tls === null || tls === "true") && (!caFile || tls === "true"),
    400, "数据库连接地址无效。");
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (kind === "postgres" ? 5432 : 3306)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      ...(tls && { ssl: { rejectUnauthorized: true, ...(caFile && { ca: readFileSync(caFile, "utf8") }) } }),
    };
  } catch {
    // URL parsing errors can include the input URL and credentials.
    check(false, 400, `${urlEnv} 的数据库地址、协议或 TLS 配置无效。`);
  }
}
