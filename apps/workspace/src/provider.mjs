import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  check,
  hash,
  equal,
  now,
  iso,
  uuid,
  atomic,
  operations,
} from "./store.mjs";

const stable = (value) =>
  JSON.stringify(value, function (_key, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item;
  });
export const documentId = (config, fileId) =>
  `host-${hash(JSON.stringify([config.tenantId, config.appId, fileId])).slice(0, 48)}`;
export function seal(secret, value) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(hash(secret), "hex"),
      iv,
    );
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
}
export function unseal(secret, value) {
  const bytes = Buffer.from(value, "base64url"),
    cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(hash(secret), "hex"),
      bytes.subarray(0, 12),
    );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString(),
  );
}
export function verifySignature(store, request, body, secret, keyId) {
  const stamp = request.headers["x-hcd-timestamp"],
    nonce = request.headers["x-hcd-nonce"];
  check(
    typeof stamp === "string" &&
      /^\d{1,12}$/.test(stamp) &&
      Math.abs(Number(stamp) - now()) <= 300 &&
      uuid(nonce),
    401,
    "请求签名或时间无效。",
  );
  const expected = createHmac("sha256", secret)
    .update(`POST\n${request.url}\n${stamp}\n${nonce}\n${hash(body)}`)
    .digest("hex");
  check(
    equal(
      request.headers["x-hcd-signature"],
      `v1;kid=${keyId};mac=${expected}`,
    ),
    401,
    "请求签名无效。",
  );
  store.transaction(() => {
    store.run("DELETE FROM nonces WHERE expires<?", now());
    check(
      !store.get("SELECT id FROM nonces WHERE id=?", nonce),
      409,
      "请求 nonce 已使用。",
    );
    store.run("INSERT INTO nonces VALUES(?,?)", nonce, now() + 600);
  });
}
export function createProvider(store, config, keys) {
  const binding = (data) =>
    check(
      data?.tenantId === config.tenantId && data?.appId === config.appId,
      403,
      "应用归属不匹配。",
    );
  function identity(context, fileId, allowExpired = false) {
    binding(context);
    const session = store.get(
      "SELECT * FROM launches WHERE id=?",
      context.sessionId,
    );
    check(
      session &&
        session.user_id === context.actorId &&
        (!fileId || session.file_id === fileId),
      403,
      "编辑会话归属不匹配。",
    );
    const user = store.get("SELECT * FROM users WHERE id=?", session.user_id);
    const browser = store.get(
      "SELECT * FROM sessions WHERE hash=?",
      session.browser_hash,
    );
    if (!allowExpired)
      check(
        !session.closed &&
          session.expires > now() &&
          browser?.expires > now() &&
          user &&
          !user.disabled,
        403,
        "业务会话已结束，请重新登录。",
      );
    return { session, user, file: store.file(session.file_id) };
  }
  function descriptor(file, version = file.head) {
    check(
      typeof version === "number" && Number.isSafeInteger(version),
      400,
      "业务版本无效。",
    );
    const item = store.get(
      "SELECT * FROM versions WHERE file_id=? AND version=?",
      file.id,
      version,
    );
    check(item, 404, "业务版本不存在。");
    return {
      id: file.id,
      version: `v${item.version}`,
      name: file.name,
      mediaType: file.media_type,
      sizeBytes: item.size,
      sha256: item.sha256,
      createdAt: file.created_at,
      modifiedAt: item.created_at,
      creatorId: file.owner_id,
      modifierId: item.actor_id,
    };
  }
  const parseVersion = (value) => {
    check(
      typeof value === "string" && /^v[1-9]\d{0,12}$/.test(value),
      400,
      "业务版本无效。",
    );
    return Number(value.slice(1));
  };
  function transfer(path, method) {
    const expires = now() + 120,
      token = createHmac("sha256", keys.objects)
        .update(`${method}\n${path}\n${expires}`)
        .digest("hex");
    return {
      url: `${config.callbackUrl}${path}?expires=${expires}&token=${token}`,
      method,
      headers: {},
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }
  async function object(request, url, bytes) {
    const stamp = url.searchParams.get("expires"),
      token = url.searchParams.get("token");
    check(
      stamp &&
        /^\d{1,12}$/.test(stamp) &&
        Number(stamp) > now() &&
        Number(stamp) <= now() + 180,
      403,
      "传输链接已过期。",
    );
    check(
      equal(
        token,
        createHmac("sha256", keys.objects)
          .update(`${request.method}\n${url.pathname}\n${stamp}`)
          .digest("hex"),
      ),
      403,
      "传输链接无效。",
    );
    const parts = url.pathname.split("/").slice(3);
    if (parts[0] === "source") {
      check(
        request.method === "GET" && parts.length === 3,
        405,
        "传输方法无效。",
      );
      const file = store.file(parts[1]),
        version = store.get(
          "SELECT * FROM versions WHERE file_id=? AND version=?",
          file.id,
          parseVersion(parts[2]),
        );
      check(version, 404, "业务版本不存在。");
      const content = readFileSync(store.object(version.sha256));
      check(
        hash(content) === version.sha256 && content.length === version.size,
        503,
        "源文件校验失败。",
      );
      return { bytes: content, type: file.media_type };
    }
    check(
      parts[0] === "staging" &&
        parts.length === 2 &&
        uuid(parts[1]) &&
        request.method === "PUT",
      405,
      "传输方法无效。",
    );
    const record = store.get("SELECT * FROM publications WHERE id=?", parts[1]);
    check(record, 404, "发布动作不存在。");
    const intent = JSON.parse(record.intent);
    check(
      !record.receipt &&
        bytes.length === intent.output.sizeBytes &&
        hash(bytes) === intent.output.sha256,
      409,
      "暂存文件与发布意图不一致。",
    );
    atomic(join(store.root, "staging", `${record.id}.bin`), bytes);
    store.run("UPDATE publications SET uploaded=1 WHERE id=?", record.id);
    return { status: 204 };
  }
  async function callback(path, data) {
    if (path === "/officecli-provider/v1/sessions/resolve") {
      binding(data);
      check(
        uuid(data.sessionId) &&
          uuid(data.exchangeId) &&
          typeof data.launchCode === "string",
        400,
        "兑换参数无效。",
      );
      const session = store.get(
        "SELECT * FROM launches WHERE id=?",
        data.sessionId,
      );
      check(
        session &&
          session.file_id === data.externalFileId &&
          !session.closed &&
          session.expires > now(),
        403,
        "一次性业务凭证已失效。",
      );
      const browser = store.get(
        "SELECT * FROM sessions WHERE hash=?",
        session.browser_hash,
      );
      const user = store.user(session.user_id);
      check(browser?.expires > now(), 403, "请重新登录业务系统。");
      const prior = store.get(
        "SELECT * FROM exchanges WHERE id=?",
        data.exchangeId,
      );
      if (prior) {
        check(
          prior.session_id === data.sessionId &&
            prior.credential_hash === hash(data.launchCode) &&
            prior.purpose === data.purpose,
          409,
          "兑换动作不一致。",
        );
        return JSON.parse(prior.result);
      }
      check(session.request, 403, "一次性业务凭证不存在。");
      const pending = unseal(keys.objects, session.request);
      check(
        pending.launchCode === data.launchCode &&
          pending.exchangeId === data.exchangeId &&
          session.purpose === data.purpose,
        403,
        "一次性业务凭证不匹配。",
      );
      const result = {
        tenantId: config.tenantId,
        appId: config.appId,
        externalFileId: session.file_id,
        sessionId: session.id,
        actor: { id: user.id, displayName: user.display_name },
        expiresAt: new Date(session.expires * 1000).toISOString(),
      };
      store.run(
        "INSERT INTO exchanges VALUES(?,?,?,?,?)",
        data.exchangeId,
        session.id,
        hash(data.launchCode),
        data.purpose,
        JSON.stringify(result),
      );
      return result;
    }
    if (path === "/officecli-provider/v1/permissions/resolve") {
      const { user, file, session } = identity(
        data.context,
        data.externalFileId,
      );
      check(
        Array.isArray(data.operations) &&
          data.operations.length <= 64 &&
          data.operations.every((op) => typeof op === "string"),
        400,
        "权限请求无效。",
      );
      const granted = store.permissions(user, file);
      return {
        granted: data.operations.filter((op) => granted.includes(op)),
        permissionVersion: `acl-${hash(JSON.stringify(granted)).slice(0, 16)}`,
        expiresAt: new Date(
          Math.min(now() + 30, session.expires) * 1000,
        ).toISOString(),
        constraints: {
          exportFormats: [
            "docx",
            "xlsx",
            "pptx",
            "pdf",
            "html",
            "md",
            "txt",
            "png",
            "jpeg",
            "webp",
            "hcd",
          ],
          modelIds: [],
        },
      };
    }
    if (path === "/officecli-provider/v1/users/resolve") {
      identity(data.context);
      check(
        Array.isArray(data.userIds) && data.userIds.length <= 100,
        400,
        "用户查询无效。",
      );
      return {
        users: data.userIds.map((id) => {
          const user = store.get("SELECT * FROM users WHERE id=?", id);
          return user
            ? {
                id: user.id,
                displayName: user.display_name,
                deleted: !!user.disabled,
              }
            : { id, displayName: "已删除用户", deleted: true };
        }),
      };
    }
    const match =
      /^\/officecli-provider\/v1\/files\/([^/]+)\/(describe|download|publications\/(?:prepare|commit|status))$/.exec(
        path,
      );
    check(match, 404, "Provider 接口不存在。");
    const fileId = decodeURIComponent(match[1]),
      action = match[2];
    const { user, file } = identity(
      data.context,
      fileId,
      action === "publications/status",
    );
    if (action === "describe" || action === "download") {
      store.permit(user, file, "document.view");
      const version =
        data.version === undefined ? file.head : parseVersion(data.version);
      // Exact source versions are required by the editing engine even when the
      // user is viewing the current document without history permission.
      const item = descriptor(file, version);
      return action === "describe"
        ? item
        : {
            file: item,
            transfer: transfer(
              `/workspace/objects/source/${file.id}/v${version}`,
              "GET",
            ),
          };
    }
    if (action === "publications/status") {
      check(uuid(data.publicationId), 400, "发布 ID 无效。");
      const record = store.get(
        "SELECT * FROM publications WHERE id=?",
        data.publicationId,
      );
      if (record)
        check(
          record.file_id === file.id && record.actor_id === user.id,
          403,
          "发布动作不属于当前用户和文件。",
        );
      return {
        publicationId: data.publicationId,
        state: record?.receipt ? "committed" : record ? "prepared" : "unknown",
        ...(record?.receipt ? { receipt: JSON.parse(record.receipt) } : {}),
      };
    }
    store.permit(
      user,
      file,
      "document.view",
      "document.edit",
      "document.publish",
    );
    if (action === "publications/prepare") {
      const intent = data.intent;
      check(
        intent &&
          uuid(intent.publicationId) &&
          intent.documentId === documentId(config, file.id) &&
          Number.isSafeInteger(intent.revision) &&
          intent.revision >= 0 &&
          typeof intent.expectedVersion === "string",
        400,
        "发布意图无效。",
      );
      const output = intent.output;
      check(
        output &&
          output.name === file.name &&
          output.format === file.format &&
          output.mediaType === file.media_type &&
          /^[a-f0-9]{64}$/.test(output.sha256) &&
          Number.isSafeInteger(output.sizeBytes) &&
          output.sizeBytes >= 0 &&
          output.sizeBytes <= 256 * 1024 * 1024 &&
          ["source-backed", "semantic", "visual"].includes(output.exportMode) &&
          intent.trigger === "manual",
        400,
        "发布输出与业务文件不匹配。",
      );
      const prior = store.get(
        "SELECT * FROM publications WHERE id=?",
        intent.publicationId,
      );
      if (prior) {
        check(
          prior.file_id === file.id &&
            prior.actor_id === user.id &&
            prior.intent === JSON.stringify(intent),
          409,
          "发布 ID 已绑定其他意图。",
        );
        check(!prior.receipt, 409, "发布已提交，请查询原始回执。");
      }
      check(
        intent.expectedVersion === `v${file.head}`,
        409,
        "业务版本已变化，未覆盖文件。",
      );
      if (!prior)
        store.run(
          "INSERT INTO publications VALUES(?,?,?,?,0,NULL,?)",
          intent.publicationId,
          file.id,
          user.id,
          JSON.stringify(intent),
          iso(),
        );
      return {
        publicationId: intent.publicationId,
        uploadId: intent.publicationId,
        transfer: transfer(
          `/workspace/objects/staging/${intent.publicationId}`,
          "PUT",
        ),
      };
    }
    check(
      uuid(data.publicationId) && data.uploadId === data.publicationId,
      400,
      "发布提交参数无效。",
    );
    const record = store.get(
      "SELECT * FROM publications WHERE id=?",
      data.publicationId,
    );
    check(
      record && record.file_id === file.id && record.actor_id === user.id,
      403,
      "发布动作归属不匹配。",
    );
    if (record.receipt) return JSON.parse(record.receipt);
    const intent = JSON.parse(record.intent);
    check(record.uploaded, 409, "发布文件尚未完整上传。");
    const bytes = readFileSync(join(store.root, "staging", `${record.id}.bin`));
    check(
      hash(bytes) === intent.output.sha256 &&
        bytes.length === intent.output.sizeBytes,
      409,
      "发布文件校验失败。",
    );
    const digest = store.put(bytes);
    return store.transaction(() => {
      const current = store.file(file.id);
      store.permit(
        store.user(user.id),
        current,
        "document.view",
        "document.edit",
        "document.publish",
      );
      check(
        intent.expectedVersion === `v${current.head}`,
        409,
        "业务版本已变化，未覆盖文件。",
      );
      const version = current.head + 1,
        at = iso();
      const receipt = {
        publicationId: record.id,
        externalFileId: file.id,
        documentId: intent.documentId,
        revision: intent.revision,
        externalVersion: `v${version}`,
        sha256: digest,
        committedAt: at,
      };
      store.run(
        "INSERT INTO versions VALUES(?,?,?,?,?,?,?)",
        file.id,
        version,
        digest,
        bytes.length,
        user.id,
        at,
        JSON.stringify(receipt),
      );
      store.run(
        "UPDATE files SET head=?,modified_at=? WHERE id=?",
        version,
        at,
        file.id,
      );
      store.run(
        "UPDATE publications SET receipt=? WHERE id=?",
        JSON.stringify(receipt),
        record.id,
      );
      store.audit(user.id, "publication.committed", record.id);
      return receipt;
    });
  }
  function event(data) {
    binding(data);
    check(
      data.schemaVersion === "officecli-event/1" &&
        uuid(data.eventId) &&
        data.type === "publication.committed" &&
        uuid(data.externalFileId) &&
        Number.isSafeInteger(data.sequence) &&
        data.sequence > 0,
      400,
      "事件格式无效。",
    );
    const record = store.get(
      "SELECT * FROM publications WHERE id=?",
      data.payload?.receipt?.publicationId,
    );
    check(
      record?.receipt &&
        record.file_id === data.externalFileId &&
        data.documentId === documentId(config, record.file_id) &&
        stable(JSON.parse(record.receipt)) === stable(data.payload.receipt),
      409,
      "事件尚无已确认业务回执。",
    );
    const prior = store.get("SELECT * FROM events WHERE id=?", data.eventId);
    if (prior) {
      check(
        prior.body === JSON.stringify(data),
        409,
        "相同事件 ID 的内容不一致。",
      );
      return;
    }
    store.run(
      "INSERT INTO events VALUES(?,?,?,?,?,?)",
      data.eventId,
      data.externalFileId,
      data.sequence,
      data.type,
      JSON.stringify(data),
      iso(),
    );
  }
  return { callback, object, event, descriptor, identity };
}
