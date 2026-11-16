import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { Store, hash, iso, now, random } from "./store.mjs";
import {
  createProvider,
  documentId,
  verifySignature,
  seal,
  unseal,
} from "./provider.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workspace-provider-test-"));
  const store = new Store(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = {
    tenantId: "test",
    appId: "workspace",
    callbackUrl: "http://127.0.0.1:7400",
  };
  const keys = { objects: random() };
  const actorId = randomUUID(),
    sessionId = randomUUID(),
    browserHash = hash(random());
  store.run(
    "INSERT INTO users VALUES(?,?,?,?,?,0,?)",
    actorId,
    "owner",
    "Owner",
    "unused",
    "member",
    iso(),
  );
  store.run(
    "INSERT INTO sessions VALUES(?,?,?,?,?)",
    browserHash,
    actorId,
    random(),
    now() + 3600,
    now(),
  );
  const file = store.createFile(
    store.user(actorId),
    "source.txt",
    "txt",
    "text/plain",
    Buffer.from("Original source"),
  );
  store.run(
    "INSERT INTO launches(id,browser_hash,user_id,file_id,expires) VALUES(?,?,?,?,?)",
    sessionId,
    browserHash,
    actorId,
    file.id,
    now() + 3600,
  );
  const context = { ...config, actorId, sessionId };
  const provider = createProvider(store, config, keys);
  return { store, config, keys, context, file, provider };
}

test("competing publications preserve the immutable source and reject a stale business head", async (t) => {
  const { store, config, context, file, provider } = fixture(t);
  const path = (action) =>
    `/officecli-provider/v1/files/${file.id}/publications/${action}`;
  const bytes = Buffer.from("Published document");
  const intent = () => ({
    publicationId: randomUUID(),
    documentId: documentId(config, file.id),
    revision: 1,
    expectedVersion: "v1",
    trigger: "manual",
    output: {
      name: file.name,
      format: "txt",
      mediaType: "text/plain",
      sha256: hash(bytes),
      sizeBytes: bytes.length,
      exportMode: "semantic",
    },
  });
  const first = intent(),
    competing = intent();
  for (const item of [first, competing]) {
    const prepared = await provider.callback(path("prepare"), {
      context,
      intent: item,
    });
    await provider.object(
      { method: "PUT" },
      new URL(prepared.transfer.url),
      bytes,
    );
  }
  const request = {
    context,
    publicationId: first.publicationId,
    uploadId: first.publicationId,
  };
  const receipt = await provider.callback(path("commit"), request);
  assert.equal(receipt.externalVersion, "v2");
  assert.deepEqual(await provider.callback(path("commit"), request), receipt);
  await assert.rejects(
    provider.callback(path("commit"), {
      context,
      publicationId: competing.publicationId,
      uploadId: competing.publicationId,
    }),
    (error) => error.status === 409,
  );
  assert.equal(store.file(file.id).head, 2);
  assert.equal(
    provider.descriptor(file, 1).sha256,
    hash(Buffer.from("Original source")),
  );
  assert.equal(
    store.all("SELECT * FROM versions WHERE file_id=?", file.id).length,
    2,
  );
  await assert.rejects(
    provider.callback(path("prepare"), {
      context,
      intent: { ...first, revision: 2 },
    }),
    (error) => error.status === 409,
  );
});

test("commit rechecks authorization after prepare and upload", async (t) => {
  const { store, config, context, file, provider } = fixture(t);
  const memberId = randomUUID();
  store.run(
    "INSERT INTO users VALUES(?,?,?,?,?,0,?)",
    memberId,
    "member",
    "Member",
    "unused",
    "member",
    iso(),
  );
  store.run(
    "UPDATE launches SET user_id=? WHERE id=?",
    memberId,
    context.sessionId,
  );
  context.actorId = memberId;
  store.run(
    "INSERT INTO acl VALUES(?,?,?,?)",
    file.id,
    memberId,
    "editor",
    JSON.stringify(["document.view", "document.edit", "document.publish"]),
  );
  const bytes = Buffer.from("Do not commit after revocation"),
    id = randomUUID();
  const path = (action) =>
    `/officecli-provider/v1/files/${file.id}/publications/${action}`;
  const prepared = await provider.callback(path("prepare"), {
    context,
    intent: {
      publicationId: id,
      documentId: documentId(config, file.id),
      revision: 3,
      expectedVersion: "v1",
      trigger: "manual",
      output: {
        name: file.name,
        format: "txt",
        mediaType: "text/plain",
        sha256: hash(bytes),
        sizeBytes: bytes.length,
        exportMode: "source-backed",
      },
    },
  });
  await provider.object(
    { method: "PUT" },
    new URL(prepared.transfer.url),
    bytes,
  );
  store.run("DELETE FROM acl WHERE file_id=? AND user_id=?", file.id, memberId);
  await assert.rejects(
    provider.callback(path("commit"), {
      context,
      publicationId: id,
      uploadId: id,
    }),
    (error) => error.status === 403,
  );
  assert.equal(store.file(file.id).head, 1);
});

test("signed callbacks bind exact bytes and path, and nonce replay is rejected", (t) => {
  const { store } = fixture(t);
  const secret = random(),
    bytes = Buffer.from('{"a":1}'),
    stamp = String(now()),
    nonce = randomUUID();
  const url = "/officecli-provider/v1/permissions/resolve";
  const mac = createHmac("sha256", secret)
    .update(`POST\n${url}\n${stamp}\n${nonce}\n${hash(bytes)}`)
    .digest("hex");
  const request = {
    url,
    headers: {
      "x-hcd-timestamp": stamp,
      "x-hcd-nonce": nonce,
      "x-hcd-signature": `v1;kid=test;mac=${mac}`,
    },
  };
  assert.throws(
    () =>
      verifySignature(store, request, Buffer.from('{"a":2}'), secret, "test"),
    (error) => error.status === 401,
  );
  assert.throws(
    () =>
      verifySignature(
        store,
        { ...request, url: url + "?other=true" },
        bytes,
        secret,
        "test",
      ),
    (error) => error.status === 401,
  );
  verifySignature(store, request, bytes, secret, "test");
  assert.throws(
    () => verifySignature(store, request, bytes, secret, "test"),
    (error) => error.status === 409,
  );
});

test("logout invalidates live document authorization while preserving committed status recovery", async (t) => {
  const { store, context, file, provider } = fixture(t);
  const permissions = {
    context,
    externalFileId: file.id,
    operations: ["document.view"],
  };
  assert.deepEqual(
    (
      await provider.callback(
        "/officecli-provider/v1/permissions/resolve",
        permissions,
      )
    ).granted,
    ["document.view"],
  );
  store.run(
    "DELETE FROM sessions WHERE hash=(SELECT browser_hash FROM launches WHERE id=?)",
    context.sessionId,
  );
  await assert.rejects(
    provider.callback(
      "/officecli-provider/v1/permissions/resolve",
      permissions,
    ),
    (error) => error.status === 403,
  );
  const status = await provider.callback(
    `/officecli-provider/v1/files/${file.id}/publications/status`,
    { context, publicationId: randomUUID() },
  );
  assert.equal(status.state, "unknown");
});

test("encrypted exchange recovery rejects altered ciphertext and another deployment key", () => {
  const secret = random(),
    request = { exchangeId: randomUUID(), launchCode: random() };
  const sealed = seal(secret, request),
    bytes = Buffer.from(sealed, "base64url");
  bytes[bytes.length - 1] ^= 1;
  assert.deepEqual(unseal(secret, sealed), request);
  assert.throws(() => unseal(secret, bytes.toString("base64url")));
  assert.throws(() => unseal(random(), sealed));
});
