import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic } from "./store.mjs";
import { publicOrigin, readTenantRegistry } from "./tenants.mjs";

function fixtures(t) {
  const root = mkdtempSync(join(tmpdir(), "officecli-tenant-registry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = join(root, "tenants.json");
  writeFileSync(
    registry,
    JSON.stringify({ workspaces: [{ root: "alpha", ai: true }, { root: "beta" }] }),
  );
  for (const [index, tenant] of ["alpha", "beta"].entries()) {
    const dir = join(root, tenant),
      port = 7500 + index * 10;
    mkdirSync(dir);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        schemaVersion: "officecli-workspace/1",
        tenantId: tenant,
        appId: "editor",
        publicUrl: "https://" + tenant + ".example",
        port,
        bindHost: "127.0.0.1",
        callbackUrl: "http://127.0.0.1:" + port,
        engineUrl: "http://127.0.0.1:" + (port + 1),
        collabUrl: "http://127.0.0.1:" + (port + 2),
      }),
    );
    writeFileSync(
      join(dir, "keys.json"),
      JSON.stringify(
        Object.fromEntries(
          ["jwt", "service", "provider", "objects", "events"].map((k) => [k, randomUUID()]),
        ),
      ),
    );
    writeFileSync(join(dir, "business.sqlite"), "");
  }
  return { root, read: () => readTenantRegistry(registry, 7400) };
}

test("workspaces on separate hostnames can use the same application name and select AI independently", (t) => {
  const { read } = fixtures(t);
  assert.deepEqual(
    read().map((w) => [w.config.tenantId, w.config.appId, w.allowAI]),
    [
      ["alpha", "editor", true],
      ["beta", "editor", false],
    ],
  );
  assert.equal(publicOrigin("http://studio.localhost:7400").origin, "http://studio.localhost:7400");
  assert.throws(() => publicOrigin("http://studio.example"));
});

test("a cookie hostname, tenant identity or internal listener cannot be assigned twice", (t) => {
  const { root, read } = fixtures(t);
  const path = join(root, "beta/config.json");
  const original = JSON.parse(readFileSync(path));
  for (const change of [
    { publicUrl: "https://alpha.example:8443" },
    { tenantId: "alpha" },
    { collabUrl: "http://127.0.0.1:7501" },
    { collabUrl: "http://localhost:7501" },
    { bindHost: "0.0.0.0" },
    { port: 7555 },
  ]) {
    writeFileSync(path, JSON.stringify({ ...original, ...change }));
    assert.throws(read);
  }
});

test("legacy localhost listeners resolve to the same numeric address for the provider, engine and collaboration", (t) => {
  const { root, read } = fixtures(t);
  const path = join(root, "alpha/config.json");
  const config = JSON.parse(readFileSync(path));
  for (const field of ["callbackUrl", "engineUrl", "collabUrl"]) {
    config[field] = config[field].replace("127.0.0.1", "localhost");
  }
  writeFileSync(path, JSON.stringify({ ...config, bindHost: "localhost" }));
  const active = read()[0].config;
  assert.equal(active.bindHost, "127.0.0.1");
  assert.equal(active.callbackUrl, "http://127.0.0.1:7500");
  assert.equal(active.engineUrl, "http://127.0.0.1:7501");
  assert.equal(active.collabUrl, "http://127.0.0.1:7502");
});

test("copied signing credentials or a shared SQLite file cannot join the registry", (t) => {
  const { root, read } = fixtures(t);
  const src = join(root, "alpha/keys.json"),
    dest = join(root, "beta/keys.json");
  const backup = readFileSync(dest);
  writeFileSync(dest, readFileSync(src));
  assert.throws(read, /密钥/);
  writeFileSync(dest, backup);
  const b = join(root, "beta/business.sqlite");
  rmSync(b);
  linkSync(join(root, "alpha/business.sqlite"), b);
  assert.throws(read, /业务库/);
});

test("exclusive initialization preserves an existing identity", (t) => {
  const { root } = fixtures(t);
  const path = join(root, "new-identity");
  atomic(path, "original", { exclusive: true });
  assert.throws(() => atomic(path, "replacement", { exclusive: true }));
  assert.equal(readFileSync(path, "utf8"), "original");
});
