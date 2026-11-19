import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, iso, now, random } from "./store.mjs";
import { Sharing } from "./sharing.mjs";
import { createProvider, documentId } from "./provider.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "workspace-sharing-")), store = new Store(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { tenantId: "test", appId: "workspace", publicUrl: "http://127.0.0.1:7400" };
  const keys = { objects: random() }, ownerId = randomUUID();
  store.run("INSERT INTO users VALUES(?,?,?,?,?,?,?)", ownerId, "owner", "Owner", "unused", "member", 0, iso());
  const owner = store.user(ownerId);
  const file = store.createFile(owner, "shared.txt", "txt", "text/plain", Buffer.from("Shared content"));
  const sharing = new Sharing(store, config, keys);
  function policy(visibility = "link", permission = "read", extra = {}) {
    return sharing.update(owner, file, { visibility, permission, expiresAt: now() + 3600, ...extra });
  }
  function secret() { return new URL(sharing.settings(file).url).hash.slice(1); }
  function launch(account) {
    const id = randomUUID();
    store.run("INSERT INTO launches(id,browser_hash,user_id,file_id,expires) VALUES(?,?,?,?,?)", id, account.hash, account.user.id, file.id, account.expires);
    const payload = Buffer.from(JSON.stringify({ integration_session: id })).toString("base64url");
    return { id, authorization: `Bearer x.${payload}.x` };
  }
  return { store, config, keys, owner, file, sharing, policy, secret, launch };
}

test("private files and link shares never appear in the public directory", t => {
  const { store, owner, file, sharing, policy } = fixture(t);
  assert.equal(sharing.settings(file).visibility, "private");
  assert.deepEqual(sharing.publicFiles(), []);
  assert.throws(() => sharing.join(file, null), error => error.status === 404);
  policy();
  assert.deepEqual(sharing.publicFiles(), []);
  const stranger = { ...owner, id: randomUUID() };
  assert.throws(() => sharing.update(stranger, file, { visibility: "public", permission: "write", expiresAt: null }), error => error.status === 403);
  assert.equal(store.get("SELECT COUNT(*) AS count FROM guest_identities").count, 0);
});

test("anonymous visitors receive distinct server-assigned identities and browser recovery preserves identity", t => {
  const { store, file, sharing, policy, secret } = fixture(t);
  policy();
  assert.throws(() => sharing.join(file, random()), error => error.status === 404);
  assert.equal(store.get("SELECT COUNT(*) AS count FROM guest_identities").count, 0);
  const first = sharing.join(file, secret()), second = sharing.join(file, secret());
  assert.notEqual(first.account.user.id, second.account.user.id);
  assert.equal(first.account.user.is_guest, true);
  assert.match(first.account.user.display_name, /^访客 /);
  const reopened = sharing.join(file, secret(), first.cookie);
  assert.equal(reopened.account.user.id, first.account.user.id);
  assert.equal(reopened.cookie, undefined);
  assert.deepEqual(store.permissions(first.account.user, file), ["document.view", "document.copy"]);
});

test("guest editing uses Provider permissions without acquiring publish, restore or management access", async t => {
  const { store, config, keys, file, sharing, policy, secret, launch } = fixture(t);
  policy("link", "write");
  const { account } = sharing.join(file, secret()), active = launch(account);
  const provider = createProvider(store, config, keys);
  const access = await provider.callback("/officecli-provider/v1/permissions/resolve", {
    externalFileId: file.id,
    context: { ...config, actorId: account.user.id, sessionId: active.id },
    operations: ["document.view", "document.edit", "document.publish", "history.restore", "theme.assign"],
  });
  assert.deepEqual(access.granted, ["document.view", "document.edit"]);
  assert.throws(() => store.manage(account.user, file), error => error.status === 403);
  store.run("INSERT INTO acl VALUES(?,?,?,?)", file.id, account.user.id, "manager", JSON.stringify(["document.view", "document.publish", "theme.assign"]));
  assert.equal(store.permissions(account.user, file).includes("document.publish"), false);
  sharing.authorizeProxy(account, active.authorization, documentId(config, file.id));
  assert.equal(sharing.guestToken(active.authorization), true);
  assert.equal(sharing.guestToken("Bearer ." + Buffer.from(JSON.stringify({ integration_session: {} })).toString("base64url") + "."), false);
  assert.throws(() => sharing.authorizeProxy(account, active.authorization, "another-document"), error => error.status === 403);
});

test("permission downgrade fences old editing sessions before a reader rejoins", async t => {
  const { store, config, keys, owner, file, sharing, policy, secret, launch } = fixture(t);
  policy("link", "write");
  const guest = sharing.join(file, secret()), active = launch(guest.account);
  const changed = policy("link", "read");
  assert.deepEqual(changed.revokedSessions, [active.id]);
  assert.equal(store.get("SELECT closed FROM launches WHERE id=?", active.id).closed, 1);
  const reopened = sharing.join(file, secret(), guest.cookie);
  assert.equal(reopened.account.user.id, guest.account.user.id);
  assert.deepEqual(store.permissions(reopened.account.user, file), ["document.view", "document.copy"]);
  assert.throws(() => sharing.authorizeProxy(reopened.account, active.authorization, documentId(config, file.id)), error => error.status === 403);
  const provider = createProvider(store, config, keys);
  await assert.rejects(provider.callback("/officecli-provider/v1/permissions/resolve", {
    externalFileId: file.id, context: { ...config, actorId: guest.account.user.id, sessionId: active.id }, operations: ["document.edit"],
  }), error => error.status === 403);
  assert.ok(store.permissions(owner, file).includes("document.publish"));
});

test("rotation, stopping and expiration invalidate old links and grants", t => {
  const { store, file, sharing, policy, secret } = fixture(t);
  policy("link", "write");
  const old = secret(), guest = sharing.join(file, old);
  policy("link", "write", { resetLink: true });
  assert.notEqual(secret(), old);
  assert.throws(() => sharing.join(file, old, guest.cookie), error => error.status === 404);
  sharing.join(file, secret(), guest.cookie);
  policy("private", "read");
  assert.deepEqual(store.permissions(guest.account.user, file), []);
  assert.throws(() => sharing.join(file, old), error => error.status === 404);
  policy("public", "read");
  store.run("UPDATE shares SET expires=? WHERE file_id=?", now() - 1, file.id);
  assert.deepEqual(sharing.publicFiles(), []);
  assert.throws(() => sharing.join(file, null), error => error.status === 404);
});

test("public access requires no link secret and expired temporary identities cannot resume", t => {
  const { store, file, sharing, policy } = fixture(t);
  policy("public", "read");
  assert.equal(sharing.publicFiles()[0].url, `/p/${file.id}`);
  const first = sharing.join(file, null);
  store.run("UPDATE guest_identities SET expires=? WHERE user_id=?", now() - 1, first.account.user.id);
  assert.equal(sharing.account(first.cookie), null);
  assert.throws(() => store.user(first.account.user.id), error => error.status === 403);
  const next = sharing.join(file, null, first.cookie);
  assert.notEqual(next.account.user.id, first.account.user.id);
});
