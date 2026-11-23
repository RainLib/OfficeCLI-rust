import { randomUUID } from "node:crypto";
import { check, equal, hash, HttpError, iso, now, random, uuid } from "./store.mts";
import type { FileRow, Store, WorkspaceUser } from "./store.mts";
import type { WorkspaceConfig, WorkspaceKeys } from "./contracts.mts";
import { documentId, seal, unseal } from "./provider.mjs";

export const GUEST_COOKIE = "officecli_workspace_guest";
const GUEST_LIFETIME = 24 * 3600;

type ShareVisibility = "private" | "link" | "public";
type SharePermission = "read" | "write";

interface ShareRow {
  visibility: ShareVisibility;
  permission: SharePermission;
  expires: number | null;
  generation: number;
  secret_hash: string;
  secret_cipher: string;
}

interface ShareInput {
  visibility?: unknown;
  permission?: unknown;
  expiresAt?: unknown;
  resetLink?: unknown;
}

interface SessionRow {
  hash: string;
  user_id: string;
  expires: number;
  csrf: string;
  created: number;
}

type GuestAccount = SessionRow & { user: Awaited<ReturnType<Store["user"]>> };

function integrationSession(authorization: string) {
  try {
    const payload: unknown = JSON.parse(Buffer.from(authorization.replace(/^Bearer /, "").split(".")[1], "base64url").toString());
    if (payload && typeof payload === "object" && "integration_session" in payload && uuid(payload.integration_session))
      return payload.integration_session;
  } catch {}
}

/** Sharing grants remain business permissions. The engine still receives its
 * normal signed, document-bound integration session for every visitor. */
export class Sharing {
  readonly store: Store;
  readonly config: WorkspaceConfig;
  readonly keys: WorkspaceKeys;

  constructor(store: Store, config: WorkspaceConfig, keys: WorkspaceKeys) {
    this.store = store;
    this.config = config;
    this.keys = keys;
  }

  #secret(cipher: string) {
    const value: unknown = unseal(this.keys.objects, cipher);
    check(value && typeof value === "object" && "secret" in value && typeof value.secret === "string", 503, "无法读取分享链接。");
    return value.secret;
  }

  async settings(file: FileRow) {
    const row = await this.store.get<ShareRow>("SELECT * FROM shares WHERE file_id=?", file.id);
    const visibility = row?.visibility || "private";
    const link = row?.visibility === "link"
      ? `/s/${file.id}#${this.#secret(row.secret_cipher)}`
      : visibility === "public" ? `/p/${file.id}` : `/editor/?workspaceFile=${file.id}`;
    return {
      visibility, permission: row?.permission || "read", expiresAt: row?.expires ?? null,
      generation: row?.generation || 0,
      expired: !!row?.expires && row.expires <= now(),
      url: new URL(link, this.config.publicUrl).href,
    };
  }

  async update(user: WorkspaceUser, file: FileRow, value: ShareInput | null) {
    check(value && (value.visibility === "private" || value.visibility === "link" || value.visibility === "public")
      && (value.permission === "read" || value.permission === "write")
      && (value.resetLink === undefined || typeof value.resetLink === "boolean"), 400, "分享设置无效。");
    const { visibility, permission, resetLink } = value;
    const expires = visibility === "private" ? null : value.expiresAt;
    check(expires === null || typeof expires === "number" && Number.isSafeInteger(expires) && expires > now()
      && expires <= now() + 366 * 86400, 400, "请选择有效的链接到期时间。");
    return this.store.transaction(async () => {
      await this.store.manage(user, file);
      const prior = await this.store.get<ShareRow>("SELECT * FROM shares WHERE file_id=?", file.id);
      if (prior && !resetLink && prior.visibility === visibility
        && prior.permission === permission && prior.expires === expires)
        return { sharing: await this.settings(file), revokedSessions: [] };
      const secret = !prior || resetLink ? random() : this.#secret(prior.secret_cipher);
      const revokedSessions = (await this.store.all<{ id: string }>(
        "SELECT l.id FROM launches l JOIN guest_identities g ON g.user_id=l.user_id WHERE l.file_id=? AND l.closed=0", file.id,
      )).map(row => row.id);
      await this.store.run(
        "UPDATE launches SET closed=1 WHERE file_id=? AND user_id IN (SELECT user_id FROM guest_identities)", file.id,
      );
      await this.store.run("DELETE FROM share_grants WHERE file_id=?", file.id);
      await this.store.upsert("shares", ["file_id"], {
        file_id: file.id, visibility, permission, secret_hash: hash(secret), secret_cipher: seal(this.keys.objects, { secret }),
        generation: (prior?.generation || 0) + 1, expires, updated_at: iso(),
      });
      await this.store.audit(user.id, visibility === "private" ? "sharing.closed" : "sharing.updated", file.id);
      return { sharing: await this.settings(file), revokedSessions };
    });
  }

  async resolve(file: FileRow, secret: unknown) {
    const policy = await this.store.get<ShareRow>("SELECT * FROM shares WHERE file_id=?", file.id);
    check(policy && policy.visibility !== "private" && (!policy.expires || policy.expires > now())
      && (policy.visibility === "public" || typeof secret === "string"
        && /^[A-Za-z0-9_-]{43}$/.test(secret) && equal(policy.secret_hash, hash(secret))),
    404, "分享已关闭、已过期或链接无效。请联系分享者获取新链接。");
    return policy;
  }

  async account(cookie: unknown): Promise<GuestAccount | null> {
    if (typeof cookie !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
    return this.store.read(async () => {
      const account = await this.store.get<SessionRow>("SELECT * FROM sessions WHERE hash=?", hash(cookie));
      if (!account || account.expires <= now()) return null;
      try {
        const user = await this.store.user(account.user_id);
        return user.is_guest ? { ...account, user } : null;
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) return null;
        throw error;
      }
    });
  }

  join(file: FileRow, secret: unknown, cookie: unknown) {
    return this.store.transaction(async () => {
      const policy = await this.resolve(file, secret);
      let issuedCookie: string | undefined;
      let current = await this.account(cookie);
      if (!current) {
        const userId = randomUUID(), expires = now() + GUEST_LIFETIME;
        issuedCookie = random();
        await this.store.run("INSERT INTO users VALUES(?,?,?,?,?,?,?)",
          userId, `guest_${userId}`, `访客 ${userId.slice(0, 4).toUpperCase()}`, "!", "member", 0, iso());
        await this.store.run("INSERT INTO guest_identities VALUES(?,?)", userId, expires);
        await this.store.run("INSERT INTO sessions VALUES(?,?,?,?,?)", hash(issuedCookie), userId, random(), expires, now());
        current = await this.account(issuedCookie);
      }
      check(current, 503, "无法建立访客会话。");
      const grant = await this.store.get<{ generation: number, expires: number }>("SELECT generation,expires FROM share_grants WHERE user_id=? AND file_id=?", current.user.id, file.id);
      const expires = Math.min(current.expires, policy.expires || current.expires);
      if (!grant || grant.generation !== policy.generation || grant.expires !== expires) {
        await this.store.upsert("share_grants", ["user_id", "file_id"], {
          user_id: current.user.id, file_id: file.id, generation: policy.generation, expires,
        });
        await this.store.audit(current.user.id, "sharing.joined", file.id);
      }
      return { account: current, cookie: issuedCookie, policy };
    });
  }

  /** Claims are only used here to restrict the proxy. Signature validation and
   * operation authorization remain the engine's responsibility. */
  async guestToken(authorization: unknown) {
    if (typeof authorization !== "string" || authorization.length >= 32_768) return false;
    const session = integrationSession(authorization);
    return !!session && !!await this.store.get("SELECT 1 FROM launches l JOIN guest_identities g ON g.user_id=l.user_id WHERE l.id=?", session);
  }

  async authorizeProxy(account: GuestAccount, authorization: unknown, selectedDocument: unknown) {
    check(typeof authorization === "string" && authorization.length < 32_768, 401, "访客会话已失效，请重新打开链接。");
    const session = integrationSession(authorization);
    check(session, 403, "访客访问需要文档会话。");
    const launch = await this.store.get<{ closed: number, expires: number, browser_hash: string, user_id: string, file_id: string }>(
      "SELECT closed,expires,browser_hash,user_id,file_id FROM launches WHERE id=?", session,
    );
    check(launch && !launch.closed && launch.expires > now() && launch.browser_hash === account.hash
      && launch.user_id === account.user.id, 403, "分享权限已更新，请重新打开文档。");
    const file = await this.store.file(launch.file_id);
    check(documentId(this.config, file.id) === selectedDocument, 403, "访客会话不能访问其他文档。");
    await this.store.permit(account.user, file, "document.view");
  }

  async publicFiles() {
    return (await this.store.all<Pick<FileRow, "id" | "name" | "format" | "modified_at"> & { permission: SharePermission }>(
      "SELECT f.id,f.name,f.format,f.modified_at,s.permission FROM files f JOIN shares s ON s.file_id=f.id WHERE s.visibility='public' AND (s.expires IS NULL OR s.expires>?) ORDER BY f.modified_at DESC LIMIT 200", now(),
    )).map(row => ({ id: row.id, name: row.name, format: row.format, modifiedAt: row.modified_at, permission: row.permission, url: `/p/${row.id}` }));
  }
}
