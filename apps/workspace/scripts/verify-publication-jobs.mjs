import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { Store, iso } from "../src/store.mts";
import { expect } from "../../../examples/hdoc/editor/node_modules/@playwright/test/index.mjs";

/** A loopback Provider proxy for the isolated acceptance workspace. */
export async function faultPublicationCallbacks(root) {
  const configPath = join(root, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const target = config.callbackUrl;
  const faults = new Map();
  const server = createServer((incoming, reply) => {
    const key = /\/files\/([a-f0-9-]+)\/publications\/(prepare|commit)$/.exec(incoming.url);
    const mode = key && faults.get(key[1]);
    if (mode === "prepare" && key[2] === "prepare") {
      faults.delete(key[1]);
      incoming.resume();
      reply.writeHead(503, { "Content-Type": "application/json" });
      reply.end(JSON.stringify({ error: "temporary Provider outage in acceptance" }));
      return;
    }
    const forward = request(target + incoming.url, { method: incoming.method, headers: incoming.headers }, upstream => {
      if (mode === "loseCommit" && key[2] === "commit" && upstream.statusCode === 200) {
        faults.delete(key[1]);
        upstream.resume();
        upstream.once("end", () => reply.destroy());
        return;
      }
      reply.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(reply);
    });
    forward.once("error", () => reply.destroy());
    reply.once("close", () => forward.destroy());
    incoming.pipe(forward);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  config.callbackUrl = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return { set: (id, mode) => faults.set(id, mode), close: () => new Promise(resolve => server.close(resolve)) };
}

export async function verifyPublicationJobs({ base, root, ownerPage, call, launch, admin, publisher, artifacts, checks, restart, fault }) {
  const prefix = "/workspace/api";
  const create = async (name, text, account = admin) => {
    const uploaded = await call(`${prefix}/files?filename=${encodeURIComponent(name)}`, {
      account: admin, method: "POST", bytes: Buffer.from("Original publication body.\n"), headers: { "Content-Type": "application/octet-stream" },
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.value));
    const file = uploaded.value.file;
    if (account.user.id !== admin.user.id) {
      assert.equal((await call(`${prefix}/files/${file.id}/acl`, { account: admin, method: "PUT",
        data: { userId: account.user.id, profile: "manager" } })).status, 204);
    }
    const session = await launch(account, file.id);
    const path = `/v1/documents/${session.documentId}`, credentials = { account, token: session.token };
    const search = await call(path + "/search?q=Original", credentials);
    assert.equal(search.status, 200, JSON.stringify(search.value));
    const id = search.value.hits[0]?.nodeId;
    assert(id);
    const node = (await call(`${path}/nodes/${id}`, credentials)).value;
    const auth = (await call(path + "/auth", credentials)).value;
    const manifest = (await call(path, credentials)).value;
    const headers = { "X-HCD-Collaboration-Epoch": String(auth.collaborationEpoch) };
    const edited = await call(path + "/node-patch", { ...credentials, method: "POST", headers, data: {
      schemaVersion: "hcd-patch/1", documentId: session.documentId, patchId: randomUUID(), baseRevision: manifest.revision,
      operations: [{ op: "text.splice", nodeId: id, start: 0, deleteCount: Array.from(node.text).length, insertText: text,
        precondition: { nodeHash: node.nodeHash } }],
    } });
    assert.equal(edited.status, 200, JSON.stringify(edited.value));
    return { file, revision: edited.value.revision, publicationId: randomUUID(), path, credentials };
  };
  const publish = async job => {
    const auth = await call(job.path + "/auth", job.credentials);
    assert.equal(auth.status, 200, JSON.stringify(auth.value));
    // A semantic edit replaces the collaboration generation. Publish its saved revision with the current epoch.
    const headers = { "X-HCD-Collaboration-Epoch": String(auth.value.collaborationEpoch) };
    return call(job.path + "/publications", { ...job.credentials, method: "POST", headers, data: {
      publicationId: job.publicationId, expectedRevision: job.revision, exportMode: "source-backed",
    } });
  };
  const versions = async job => {
    const result = await call(`${prefix}/files/${job.file.id}/versions`, { account: admin });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value.versions.length;
  };
  const getBytes = async path => {
    const result = await call(prefix + path, { account: admin });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value;
  };

  const lost = await create("丢失回执.txt", "Business committed the exact review text.", publisher);
  fault.set(lost.file.id, "loseCommit");
  const uncertain = await publish(lost);
  assert.equal(uncertain.status, 202, JSON.stringify(uncertain.value));
  assert.equal(await versions(lost), 2);
  assert.equal((await call(`${prefix}/publication-jobs`, { account: publisher })).status, 403);
  assert.equal((await call(`${prefix}/logout`, { account: publisher, method: "POST", data: {} })).status, 204);

  const retry = await create("暂时失败.txt", "Fixed saved revision retried by the original author.");
  fault.set(retry.file.id, "prepare");
  const paused = await publish(retry);
  assert.equal(paused.status, 202, JSON.stringify(paused.value));
  assert.equal(await versions(retry), 1);

  const conflict = await create("独立版本.txt", "Workplace content retained in an independent recovery copy.");
  const businessBytes = Buffer.from("Independent edit committed directly in the business system.\n");
  const store = await Store.open(root);
  try {
    const digest = store.put(businessBytes), at = iso();
    await store.transaction(async () => {
      await store.run("INSERT INTO versions VALUES(?,?,?,?,?,?,NULL)", conflict.file.id, 2, digest, businessBytes.length, admin.user.id, at);
      await store.run("UPDATE files SET head=2,modified_at=? WHERE id=?", at, conflict.file.id);
    });
  } finally { await store.close(); }
  assert.equal((await publish(conflict)).status, 409);
  await restart();

  const page = await ownerPage.context().newPage();
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const row = job => page.getByRole("article", { name: job.file.name, exact: true });
  try {
    await page.goto(base + "/admin#publication-jobs");
    await page.getByRole("link", { name: "回写任务", exact: true }).click();
    await expect(page.getByRole("heading", { name: "回写任务", exact: true })).toBeVisible();
    await expect(row(lost)).toContainText("待核对");
    await expect(row(conflict)).toContainText("版本冲突");
    await expect(row(lost).getByRole("button", { name: "重试原任务" })).toHaveCount(0);
    await page.screenshot({ path: join(artifacts, "publication-jobs.png") });
    await row(lost).getByRole("button", { name: "核对回执" }).click();
    await expect(row(lost).getByRole("status")).toHaveText("已确认业务版本 v2。");
    assert.equal(await versions(lost), 2);
    assert.match(await getBytes(`/files/${lost.file.id}/download`), /Business committed the exact review text/);

    await row(retry).getByRole("button", { name: "重试原任务" }).click();
    await expect(row(retry).getByRole("status")).toHaveText("已确认业务版本 v2。");
    assert.equal(await versions(retry), 2);
    assert.match(await getBytes(`/files/${retry.file.id}/download`), /Fixed saved revision retried by the original author/);
    const jobs = (await call(`${prefix}/publication-jobs`, { account: admin })).value.items;
    const job = jobs.find(item => item.publicationId === retry.publicationId);
    assert.equal(job.receipt.publicationId, retry.publicationId);

    const expectedSource = await getBytes(`/publication-jobs/${conflict.publicationId}/artifact`);
    assert.match(expectedSource, /Workplace content retained/);
    assert.equal(await getBytes(`/files/${conflict.file.id}/download`), businessBytes.toString());
    await row(conflict).getByRole("button", { name: "另存工作区副本" }).click();
    await expect(row(conflict).getByRole("button", { name: "查看已另存副本" })).toBeVisible();
    const duplicate = () => call(`${prefix}/publication-jobs/${conflict.publicationId}/copy`, { account: admin, method: "POST", data: {} });
    const [first, second] = await Promise.all([duplicate(), duplicate()]);
    assert.equal(first.status, 200, JSON.stringify(first.value));
    assert.equal(first.value.job.copy.id, second.value.job.copy.id);
    const copy = first.value.job.copy;
    assert.equal(await getBytes(`/files/${copy.id}/download`), expectedSource);
    assert.equal(await getBytes(`/files/${conflict.file.id}/download`), businessBytes.toString());
    assert.equal(await versions(conflict), 2);
    await row(conflict).getByRole("button", { name: "查看已另存副本" }).click();
    await expect(page.getByRole("heading", { name: copy.name, exact: true })).toBeVisible();
    assert.deepEqual(errors, []);
    checks.push("The admin recovery queue reconciles a genuinely lost Provider commit response after logout and restart, retries an interrupted original publication once, and preserves both versions through an idempotent conflict copy.");
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "publication-jobs-failure.png") }).catch(() => {});
    throw error;
  } finally { await page.close(); }
}
