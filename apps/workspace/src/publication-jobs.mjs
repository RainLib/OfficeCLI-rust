import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { check, uuid } from "./store.mts";

const base = "/integration/v1/publications";
const maxBytes = 256 * 1024 * 1024;

export function createPublicationJobs({ store, engine, config, serviceKey, launch }) {
  async function describe(job, user) {
    const file = await store.file(job.fileId);
    const currentVersion = `v${file.head}`;
    const host = await store.get("SELECT receipt FROM publications WHERE id=? AND file_id=?", job.publicationId, file.id);
    const copy = await store.get("SELECT f.id,f.name FROM publication_copies p JOIN files f ON f.id=p.file_id WHERE p.publication_id=?", job.publicationId) ?? null;
    const complete = job.state === "committed";
    const conflict = !complete && !host?.receipt && (job.state === "conflict" || currentVersion !== job.expectedVersion);
    return { ...job, currentVersion, fileName: file.name, copy, conflict,
      author: (await store.get("SELECT display_name FROM users WHERE id=?", job.actorId))?.display_name ?? job.actorId,
      canRetry: !complete && job.pending && job.actorId === user.id && (currentVersion === job.expectedVersion || !!host?.receipt),
      canCopy: !copy && conflict && job.hasArtifact,
    };
  }

  async function list(user, before) {
    check(!before || uuid(before), 400, "任务位置无效。");
    const page = await engine(base + (before ? `?before=${before}` : ""));
    return { items: await Promise.all(page.items.map(job => describe(job, user))), next: page.next };
  }

  async function artifact(id) {
    const response = await fetch(`${config.engineUrl}${base}/${id}/artifact`, {
      headers: { Authorization: `Bearer ${serviceKey}` }, redirect: "error", signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      check(false, response.status >= 500 ? 502 : response.status, failure.error || "回写稿暂时无法读取。");
    }
    const length = response.headers.get("content-length");
    const size = Number(length);
    check(length !== null && Number.isSafeInteger(size) && size >= 0 && size <= maxBytes, 502, "回写稿大小不符合预期。");
    return { response, size };
  }

  async function download(id, current) {
    const record = await engine(`${base}/${id}`);
    const job = await describe(record, (await current()).user);
    check(job.hasArtifact, 404, "此任务没有可下载的回写稿。");
    const output = await artifact(id);
    await current();
    return { ...output, fileName: job.fileName };
  }

  async function action(id, operation, current) {
    if (operation === "reconcile") {
      await current();
      const result = await engine(`${base}/${id}/reconcile`, { method: "POST" });
      const account = await current();
      await store.audit(account.user.id, "publication.reconciled", id);
      return { job: await describe(result.job, account.user), providerState: result.providerState };
    }
    if (operation === "event-retry") {
      await current();
      const job = await engine(`${base}/${id}/event-retry`, { method: "POST" });
      const account = await current();
      await store.audit(account.user.id, "publication.event_retried", id);
      return { job: await describe(job, account.user) };
    }
    const record = await engine(`${base}/${id}`);
    const account = await current();
    const job = await describe(record, account.user);
    const file = await store.file(job.fileId);
    if (operation === "copy") {
      if (job.copy) return { job };
      check(job.canCopy, 409, "此任务没有可另存的冲突稿。");
      const { response, size } = await artifact(id);
      const bytes = Buffer.from(await response.arrayBuffer());
      check(bytes.length === size, 502, "回写稿未完整读取，请重试。");
      const author = (await current()).user;
      const refreshed = await describe(record, author);
      if (refreshed.copy) return { job: refreshed };
      check(refreshed.canCopy, 409, "业务状态已变化，请重新核对。");
      const ext = extname(file.name);
      const name = `${file.name.slice(0, -ext.length).slice(0, 200)} · 工作区 r${job.revision}${ext}`;
      await store.createFile(author, name, file.format, file.media_type, bytes, null, id);
      return { job: await describe(record, author) };
    }
    check(operation === "retry" && job.canRetry, 409, "只有发起人可以重试仍在等待的原任务。");
    if (job.currentVersion !== job.expectedVersion) {
      // A durable host receipt can exist before the engine has recorded it.
      const result = await engine(`${base}/${id}/reconcile`, { method: "POST" });
      return { job: await describe(result.job, (await current()).user), providerState: result.providerState };
    }
    await store.permit(account.user, file, "document.view", "document.edit", "document.publish");
    const session = await launch(account, file, randomUUID());
    await current();
    await store.audit(account.user.id, "publication.retried", id);
    await engine(`/v1/documents/${job.documentId}/publications`, { method: "POST", token: session.token, data: {
      publicationId: id, expectedRevision: job.revision, exportMode: job.exportMode,
    } });
    return { job: await describe(await engine(`${base}/${id}`), (await current()).user) };
  }

  return { list, action, download };
}
