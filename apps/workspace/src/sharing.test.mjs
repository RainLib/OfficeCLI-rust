import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, iso, now, random } from "./store.mts";
import { Sharing } from "./sharing.mts";
import { createProvider, documentId } from "./provider.mjs";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workspace-sharing-")), store = await Store.open(root, { initialize: async () => {} });
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { tenantId: "test", appId: "workspace", publicUrl: "http://127.0.0.1:7400" };
  const keys = { objects: random() }, ownerId = randomUUID();
  await store.run("INSERT INTO users VALUES(?,?,?,?,?,?,?)", ownerId, "owner", "Owner", "unused", "member", 0, iso());
  const owner = await store.user(ownerId);
  const file = await store.createFile(owner, "shared.txt", "txt", "text/plain", Buffer.from("Shared content"));
  const sharing = new Sharing(store, config, keys);
  function policy(visibility = "link", permission = "read", extra = {}) {
    return sharing.update(owner, file, { visibility, permission, expiresAt: now() + 3600, ...extra });
  }
  async function secret() { return new URL((await sharing.settings(file)).url).hash.slice(1); }
  async function launch(account) {
    const id = randomUUID();
    await store.run("INSERT INTO launches(id,browser_hash,user_id,file_id,expires) VALUES(?,?,?,?,?)", id, account.hash, account.user.id, file.id, account.expires);
    const payload = Buffer.from(JSON.stringify({ integration_session: id })).toString("base64url");
    return { id, authorization: `Bearer x.${payload}.x` };
  }
  return { store, config, keys, owner, file, sharing, policy, secret, launch };
}

test("private files and link shares never appear in the public directory", async t => {
  const { store, owner, file, sharing, policy } = await fixture(t);
  assert.equal((await sharing.settings(file)).visibility, "private");
  assert.deepEqual(await sharing.publicFiles(), []);
  await assert.rejects(() => sharing.join(file, null), error => error.status === 404);
  await policy();
  assert.deepEqual(await sharing.publicFiles(), []);
  const stranger = { ...owner, id: randomUUID() };
  await assert.rejects(() => sharing.update(stranger, file, { visibility: "public", permission: "write", expiresAt: null }), error => error.status === 403);
  assert.equal((await store.get("SELECT COUNT(*) AS count FROM guest_identities")).count, 0);
});

test("anonymous visitors receive distinct server-assigned identities and browser recovery preserves identity", async t => {
  const { store, file, sharing, policy, secret } = await fixture(t);
  await policy();
  await assert.rejects(() => sharing.join(file, random()), error => error.status === 404);
  assert.equal((await store.get("SELECT COUNT(*) AS count FROM guest_identities")).count, 0);
  const first = await sharing.join(file, await secret()), second = await sharing.join(file, await secret());
  assert.notEqual(first.account.user.id, second.account.user.id);
  assert.equal(first.account.user.is_guest, true);
  assert.match(first.account.user.display_name, /^访客 /);
  const reopened = await sharing.join(file, await secret(), first.cookie);
  assert.equal(reopened.account.user.id, first.account.user.id);
  assert.equal(reopened.cookie, undefined);
  assert.deepEqual(await store.permissions(first.account.user, file), ["document.view", "document.copy"]);
});

test("guest editing uses Provider permissions without acquiring publish, restore or management access", async t => {
  const { store, config, keys, file, sharing, policy, secret, launch } = await fixture(t);
  await policy("link", "write");
  const { account } = await sharing.join(file, await secret()), active = await launch(account);
  const provider = createProvider(store, config, keys);
  const access = await provider.callback("/officecli-provider/v1/permissions/resolve", {
    externalFileId: file.id,
    context: { ...config, actorId: account.user.id, sessionId: active.id },
    operations: ["document.view", "document.edit", "document.publish", "history.restore", "theme.assign"],
  });
  assert.deepEqual(access.granted, ["document.view", "document.edit"]);
  await assert.rejects(() => store.manage(account.user, file), error => error.status === 403);
  await store.run("INSERT INTO acl VALUES(?,?,?,?)", file.id, account.user.id, "manager", JSON.stringify(["document.view", "document.publish", "theme.assign"]));
  assert.equal((await store.permissions(account.user, file)).includes("document.publish"), false);
  await sharing.authorizeProxy(account, active.authorization, documentId(config, file.id));
  assert.equal(await sharing.guestToken(active.authorization), true);
  assert.equal(await sharing.guestToken("Bearer ." + Buffer.from(JSON.stringify({ integration_session: {} })).toString("base64url") + "."), false);
  await assert.rejects(() => sharing.authorizeProxy(account, active.authorization, "another-document"), error => error.status === 403);
});

test("permission downgrade fences old editing sessions before a reader rejoins", async t => {
  const { store, config, keys, owner, file, sharing, policy, secret, launch } = await fixture(t);
  await policy("link", "write");
  const guest = await sharing.join(file, await secret()), active = await launch(guest.account);
  const changed = await policy("link", "read");
  assert.deepEqual(changed.revokedSessions, [active.id]);
  assert.equal((await store.get("SELECT closed FROM launches WHERE id=?", active.id)).closed, 1);
  const reopened = await sharing.join(file, await secret(), guest.cookie);
  assert.equal(reopened.account.user.id, guest.account.user.id);
  assert.deepEqual(await store.permissions(reopened.account.user, file), ["document.view", "document.copy"]);
  await assert.rejects(() => sharing.authorizeProxy(reopened.account, active.authorization, documentId(config, file.id)), error => error.status === 403);
  const provider = createProvider(store, config, keys);
  await assert.rejects(provider.callback("/officecli-provider/v1/permissions/resolve", {
    externalFileId: file.id, context: { ...config, actorId: guest.account.user.id, sessionId: active.id }, operations: ["document.edit"],
  }), error => error.status === 403);
  assert.ok((await store.permissions(owner, file)).includes("document.publish"));
});

test("rotation, stopping and expiration invalidate old links and grants", async t => {
  const { store, file, sharing, policy, secret } = await fixture(t);
  await policy("link", "write");
  const old = await secret(), guest = await sharing.join(file, old);
  await policy("link", "write", { resetLink: true });
  assert.notEqual(await secret(), old);
  await assert.rejects(() => sharing.join(file, old, guest.cookie), error => error.status === 404);
  await sharing.join(file, await secret(), guest.cookie);
  await policy("private", "read");
  assert.deepEqual(await store.permissions(guest.account.user, file), []);
  await assert.rejects(() => sharing.join(file, old), error => error.status === 404);
  await policy("public", "read");
  await store.run("UPDATE shares SET expires=? WHERE file_id=?", now() - 1, file.id);
  assert.deepEqual(await sharing.publicFiles(), []);
  await assert.rejects(() => sharing.join(file, null), error => error.status === 404);
});

test("public access requires no link secret and expired temporary identities cannot resume", async t => {
  const { store, file, sharing, policy } = await fixture(t);
  await policy("public", "read");
  assert.equal((await sharing.publicFiles())[0].url, `/p/${file.id}`);
  const first = await sharing.join(file, null);
  await store.run("UPDATE guest_identities SET expires=? WHERE user_id=?", now() - 1, first.account.user.id);
  assert.equal(await sharing.account(first.cookie), null);
  await assert.rejects(() => store.user(first.account.user.id), error => error.status === 403);
  const next = await sharing.join(file, null, first.cookie);
  assert.notEqual(next.account.user.id, first.account.user.id);
});
