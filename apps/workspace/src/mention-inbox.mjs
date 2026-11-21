import { randomUUID } from "node:crypto";
import { documentId } from "./provider.mjs";
import { check, hash, iso, uuid } from "./store.mjs";

const subject = (id) => "host-" + hash(id).slice(0, 32);
const batchSize = 6;
const pageSize = 30;

export function createMentionInbox({ store, engine, config }) {
  let refreshing;
  let lastRefresh = 0;
  let incomplete = false;

  async function refreshBoard(board) {
    const known = board.revision === null ? "" : `?known=${board.revision}`;
    const path = `/integration/v1/boards/${documentId(config, board.id)}/mentions${known}`;
    const snapshot = await engine(path, { signal: AbortSignal.timeout(5000) });
    if (snapshot.revision === board.revision) return;
    check(Number.isSafeInteger(snapshot.revision) && Array.isArray(snapshot.targets), 502, "白板提及读取失败。");
    const receivedAt = iso();
    store.transaction(() => {
      const indexed = store.get("SELECT revision FROM canvas_mention_heads WHERE file_id=?", board.id);
      if ((indexed?.revision ?? null) !== board.revision) return;
      // A recipient and an object identify an active mention. Moving it, or
      // editing surrounding text, keeps both its receipt and its read state.
      const old = new Map(store.all("SELECT id,element_id,recipient FROM canvas_mentions WHERE file_id=?", board.id)
        .map(row => [JSON.stringify([row.element_id, row.recipient]), row.id]));
      for (const target of snapshot.targets) {
        for (const recipient of target.recipients) {
          const key = JSON.stringify([target.elementId, recipient]);
          const existing = old.get(key);
          if (existing) {
            store.run("UPDATE canvas_mentions SET kind=?,preview=? WHERE id=? AND (kind<>? OR preview<>?)",
              target.kind, target.preview, existing, target.kind, target.preview);
            old.delete(key);
          } else {
            store.run("INSERT INTO canvas_mentions VALUES(?,?,?,?,?,?,?,NULL)",
              randomUUID(), board.id, target.elementId, recipient, target.kind, target.preview, receivedAt);
          }
        }
      }
      for (const id of old.values()) store.run("DELETE FROM canvas_mentions WHERE id=?", id);
      store.run(`INSERT INTO canvas_mention_heads VALUES(?,?)
        ON CONFLICT(file_id) DO UPDATE SET revision=excluded.revision`, board.id, snapshot.revision);
    });
  }

  function refresh() {
    if (refreshing) return refreshing;
    if (Date.now() - lastRefresh < 5000) return Promise.resolve(incomplete);
    const boards = store.all(`SELECT f.id, h.revision FROM files f
      LEFT JOIN canvas_mention_heads h ON h.file_id=f.id
      WHERE f.format='excalidraw' AND EXISTS (SELECT 1 FROM launches l WHERE l.file_id=f.id AND l.response IS NOT NULL)`);
    refreshing = (async () => {
      let partial = false;
      for (let at = 0; at < boards.length; at += batchSize) {
        const results = await Promise.allSettled(boards.slice(at, at + batchSize).map(refreshBoard));
        partial ||= results.some(result => result.status === "rejected");
      }
      incomplete = partial;
      lastRefresh = Date.now();
      return partial;
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  function accessible(user) {
    const permissions = new Map();
    return store.all(`SELECT m.*,f.name,f.owner_id FROM canvas_mentions m
      JOIN files f ON f.id=m.file_id WHERE m.recipient=? ORDER BY m.received_at DESC,m.id DESC`, subject(user.id))
      .filter(row => {
        if (!permissions.has(row.file_id)) {
          permissions.set(row.file_id, store.permissions(user, { id: row.file_id, owner_id: row.owner_id }).includes("document.view"));
        }
        return permissions.get(row.file_id);
      });
  }

  function entry(row) {
    return { id: row.id, fileId: row.file_id, fileName: row.name, elementId: row.element_id,
      kind: row.kind, preview: row.preview, receivedAt: row.received_at, read: row.read_at !== null };
  }

  function list(user, before) {
    check(!before || uuid(before), 400, "提醒位置无效。");
    const rows = accessible(user);
    const at = before ? rows.findIndex(row => row.id === before) + 1 : 0;
    check(!before || at, 404, "提醒已更新，请重新打开列表。");
    const page = rows.slice(at, at + pageSize);
    return { items: page.map(entry), unread: rows.filter(row => row.read_at === null).length,
      next: rows.length > at + page.length ? page.at(-1).id : null };
  }

  function markRead(user, id) {
    const row = accessible(user).find(item => item.id === id);
    check(row, 404, "提醒已移除或文件不可访问。");
    store.run("UPDATE canvas_mentions SET read_at=? WHERE id=? AND read_at IS NULL", iso(), id);
    return { ...entry(row), read: true };
  }

  function markAllRead(user) {
    const now = iso();
    store.transaction(() => {
      for (const row of accessible(user)) {
        if (row.read_at === null) store.run("UPDATE canvas_mentions SET read_at=? WHERE id=?", now, row.id);
      }
    });
  }

  return { refresh, list, markRead, markAllRead };
}
