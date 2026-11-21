import { randomUUID } from "node:crypto";
import { check, equal, hash, iso, now, random, uuid } from "./store.mjs";
import { documentId, seal, unseal } from "./provider.mjs";

export const GUEST_COOKIE = "officecli_workspace_guest";
const GUEST_LIFETIME = 24 * 3600;

/** Sharing grants remain business permissions. The engine still receives its
 * normal signed, document-bound integration session for every visitor. */
export class Sharing {
  constructor(store, config, keys) {
    this.store = store;
    this.config = config;
    this.keys = keys;
  }

  settings(file) {
    const row = this.store.get("SELECT * FROM shares WHERE file_id=?", file.id);
    const visibility = row?.visibility || "private";
    const link = visibility === "link"
      ? `/s/${file.id}#${unseal(this.keys.objects, row.secret_cipher).secret}`
      : visibility === "public" ? `/p/${file.id}` : `/editor/?workspaceFile=${file.id}`;
    return {
      visibility, permission: row?.permission || "read", expiresAt: row?.expires ?? null,
      generation: row?.generation || 0,
      expired: !!row?.expires && row.expires <= now(),
      url: new URL(link, this.config.publicUrl).href,
    };
  }

  update(user, file, value) {
    this.store.manage(user, file);
    check(value && ["private", "link", "public"].includes(value.visibility)
      && ["read", "write"].includes(value.permission)
      && (value.resetLink === undefined || typeof value.resetLink === "boolean"), 400, "分享设置无效。");
    const expires = value.visibility === "private" ? null : value.expiresAt;
    check(expires === null || Number.isSafeInteger(expires) && expires > now()
      && expires <= now() + 366 * 86400, 400, "请选择有效的链接到期时间。");
    const prior = this.store.get("SELECT * FROM shares WHERE file_id=?", file.id);
    if (prior && !value.resetLink && prior.visibility === value.visibility
      && prior.permission === value.permission && prior.expires === expires)
      return { sharing: this.settings(file), revokedSessions: [] };
    const secret = !prior || value.resetLink
      ? random() : unseal(this.keys.objects, prior.secret_cipher).secret;
    let revokedSessions = [];
    this.store.transaction(() => {
      revokedSessions = this.store.all(
        "SELECT l.id FROM launches l JOIN guest_identities g ON g.user_id=l.user_id WHERE l.file_id=? AND l.closed=0", file.id,
      ).map(row => row.id);
      this.store.run(
        "UPDATE launches SET closed=1 WHERE file_id=? AND user_id IN (SELECT user_id FROM guest_identities)", file.id,
      );
      this.store.run("DELETE FROM share_grants WHERE file_id=?", file.id);
      this.store.run(
        "INSERT INTO shares VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET visibility=excluded.visibility,permission=excluded.permission,secret_hash=excluded.secret_hash,secret_cipher=excluded.secret_cipher,generation=excluded.generation,expires=excluded.expires,updated_at=excluded.updated_at",
        file.id, value.visibility, value.permission, hash(secret), seal(this.keys.objects, { secret }),
        (prior?.generation || 0) + 1, expires, iso(),
      );
      this.store.audit(user.id, value.visibility === "private" ? "sharing.closed" : "sharing.updated", file.id);
    });
    return { sharing: this.settings(file), revokedSessions };
  }

  resolve(file, secret) {
    const policy = this.store.get("SELECT * FROM shares WHERE file_id=?", file.id);
    check(policy && policy.visibility !== "private" && (!policy.expires || policy.expires > now())
      && (policy.visibility === "public" || typeof secret === "string"
        && /^[A-Za-z0-9_-]{43}$/.test(secret) && equal(policy.secret_hash, hash(secret))),
    404, "分享已关闭、已过期或链接无效。请联系分享者获取新链接。");
    return policy;
  }

  account(cookie) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(cookie || "")) return null;
    const account = this.store.get("SELECT * FROM sessions WHERE hash=?", hash(cookie));
    if (!account || account.expires <= now()) return null;
    try {
      const user = this.store.user(account.user_id);
      return user.is_guest ? { ...account, user } : null;
    } catch { return null; }
  }

  join(file, secret, cookie) {
    const policy = this.resolve(file, secret);
    let account = this.account(cookie), issuedCookie;
    this.store.transaction(() => {
      if (!account) {
        const userId = randomUUID(), expires = now() + GUEST_LIFETIME;
        issuedCookie = random();
        this.store.run("INSERT INTO users VALUES(?,?,?,?,?,?,?)",
          userId, `guest_${userId}`, `访客 ${userId.slice(0, 4).toUpperCase()}`, "!", "member", 0, iso());
        this.store.run("INSERT INTO guest_identities VALUES(?,?)", userId, expires);
        this.store.run("INSERT INTO sessions VALUES(?,?,?,?,?)", hash(issuedCookie), userId, random(), expires, now());
        account = this.account(issuedCookie);
      }
      const grant = this.store.get("SELECT generation,expires FROM share_grants WHERE user_id=? AND file_id=?", account.user.id, file.id);
      const expires = Math.min(account.expires, policy.expires || account.expires);
      if (!grant || grant.generation !== policy.generation || grant.expires !== expires) {
        this.store.run("INSERT INTO share_grants VALUES(?,?,?,?) ON CONFLICT(user_id,file_id) DO UPDATE SET generation=excluded.generation,expires=excluded.expires",
          account.user.id, file.id, policy.generation, expires);
        this.store.audit(account.user.id, "sharing.joined", file.id);
      }
    });
    return { account, cookie: issuedCookie, policy };
  }

  /** Claims are only used here to restrict the proxy. Signature validation and
   * operation authorization remain the engine's responsibility. */
  guestToken(authorization) {
    if (typeof authorization !== "string" || authorization.length >= 32_768) return false;
    let payload;
    try { payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /, "").split(".")[1], "base64url").toString()); } catch {}
    return uuid(payload?.integration_session) && !!this.store.get("SELECT 1 FROM launches l JOIN guest_identities g ON g.user_id=l.user_id WHERE l.id=?", payload.integration_session);
  }

  authorizeProxy(account, authorization, selectedDocument) {
    check(typeof authorization === "string" && authorization.length < 32_768, 401, "访客会话已失效，请重新打开链接。");
    let payload;
    try { payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /, "").split(".")[1], "base64url").toString()); } catch {}
    check(uuid(payload?.integration_session), 403, "访客访问需要文档会话。");
    const launch = this.store.get("SELECT * FROM launches WHERE id=?", payload.integration_session);
    check(launch && !launch.closed && launch.expires > now() && launch.browser_hash === account.hash
      && launch.user_id === account.user.id, 403, "分享权限已更新，请重新打开文档。");
    const file = this.store.file(launch.file_id);
    check(documentId(this.config, file.id) === selectedDocument, 403, "访客会话不能访问其他文档。");
    this.store.permit(account.user, file, "document.view");
  }

  publicFiles() {
    return this.store.all(
      "SELECT f.id,f.name,f.format,f.modified_at,s.permission FROM files f JOIN shares s ON s.file_id=f.id WHERE s.visibility='public' AND (s.expires IS NULL OR s.expires>?) ORDER BY f.modified_at DESC LIMIT 200", now(),
    ).map(row => ({ id: row.id, name: row.name, format: row.format, modifiedAt: row.modified_at, permission: row.permission, url: `/p/${row.id}` }));
  }
}
