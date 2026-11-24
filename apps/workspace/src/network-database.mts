import { check, HttpError, type NetworkDatabaseConfig } from "./contracts.mts";
import { connectionOptions, type DatabaseConnection, type DatabaseParameter, type DatabaseRow } from "./database.mts";

function safeInteger(value: string) {
  const number = Number(value);
  check(Number.isSafeInteger(number), 503, "数据库整数超出可读取范围。");
  return number;
}

function postgresQuery(sql: string) {
  let index = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:[^"]|"")*"|\?/g, token => token === "?" ? "$" + ++index : token);
}

export async function connectNetworkDatabase(config: NetworkDatabaseConfig, onFailure: () => void) {
  const options = connectionOptions(config);
  let db: DatabaseConnection | undefined;
  let failed = false, connected = false, closing = false;
  const disconnected = () => {
    if (!connected || closing || failed) return;
    failed = true;
    onFailure();
  };
  try {
    if (config.kind === "postgres") {
      const { Client, types } = await import("pg");
      const client = new Client({
        ...options, connectionTimeoutMillis: 7000, statement_timeout: 25000,
        keepAlive: true, keepAliveInitialDelayMillis: 10000,
        types: {
          getTypeParser: (oid, format) => oid === 20 && format !== "binary" ? safeInteger : types.getTypeParser(oid, format),
        },
      });
      client.on("error", disconnected);
      client.on("end", disconnected);
      db = {
        kind: "postgres",
        async all(sql, args) { return (await client.query<DatabaseRow>(postgresQuery(sql), args)).rows; },
        async run(sql, args) { await client.query(postgresQuery(sql), args); },
        async exec(sql) { await client.query(sql); },
        async close() { closing = true; await client.end(); },
      };
      await client.connect();
      const [version] = await db.all("SELECT current_setting('server_encoding') AS encoding,current_setting('server_version_num') AS version", []);
      check(version.encoding === "UTF8" && Number(version.version) >= 150000, 400, "工作区需要 PostgreSQL 15 或以上和 UTF-8 数据库。");
      await db.exec("SET search_path TO public, pg_catalog");
      await db.exec("SET standard_conforming_strings TO on");
      const [lock] = await db.all("SELECT pg_try_advisory_lock(1547495297,2143183860) AS locked", []);
      check(lock?.locked, 409, "此 PostgreSQL 数据库已有运行中的工作区，请使用独立的数据库。");
    } else {
      const { createConnection } = await import("mysql2/promise");
      const client = await createConnection({
        ...options, ...(options.ssl && { ssl: { ...options.ssl, verifyIdentity: true } }),
        connectTimeout: 7000, enableKeepAlive: true, keepAliveInitialDelay: 10000,
        maxPreparedStatements: 128, charset: "UTF8MB4_BIN",
        supportBigNumbers: true, bigNumberStrings: true,
        typeCast(field, next) {
          const value = next();
          return field.type === "LONGLONG" && typeof value === "string" ? safeInteger(value) : value;
        },
      });
      client.on("error", disconnected);
      client.on("end", disconnected);
      const execute = (sql: string, args: DatabaseParameter[]) => client.execute({ sql, timeout: 25000 }, args);
      db = {
        kind: "mysql",
        async all(sql, args) { return (await execute(sql, args))[0] as DatabaseRow[]; },
        async run(sql, args) { await execute(sql, args); },
        async exec(sql) { await client.query({ sql, timeout: 25000 }); },
        async close() { closing = true; await client.end(); },
      };
      const [version] = await db.all("SELECT VERSION() AS version", []);
      const match = /^(\d+)\.(\d+)\./.exec(String(version.version));
      check(match && !/mariadb/i.test(String(version.version)) &&
        (Number(match[1]) > 8 || Number(match[1]) === 8 && Number(match[2]) >= 4), 400, "工作区需要 MySQL 8.4 或以上。");
      await db.exec("SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin");
      await db.exec("SET SESSION sql_mode='STRICT_ALL_TABLES,ANSI_QUOTES,NO_BACKSLASH_ESCAPES,NO_ENGINE_SUBSTITUTION'");
      const [lock] = await db.all("SELECT GET_LOCK(SHA2(CONCAT('foldly:',DATABASE()),256),0) AS locked", []);
      check(lock?.locked === 1, 409, "此 MySQL 数据库已有运行中的工作区，请使用独立的数据库。");
    }
    connected = true;
    return db;
  } catch (error) {
    await Promise.resolve(db?.close()).catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, `无法连接 ${config.kind} 数据库，请检查连接地址、凭据及连通性。`);
  }
}

export async function listNetworkTables(db: DatabaseConnection) {
  const sql = db.kind === "postgres"
    ? "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
    : "SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()";
  return (await db.all(sql, [])).map(row => row.table_name);
}
