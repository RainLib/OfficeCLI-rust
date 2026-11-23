import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store, atomic, check, iso, passwordHash, random } from "./store.mts";
import type { WorkspaceConfig, WorkspaceRole } from "./contracts.mts";

interface InitialAccount {
  username: string;
  displayName: string;
  password: string | undefined;
  role: WorkspaceRole;
}

export async function initializeWorkspace(root: string, config: WorkspaceConfig, { username, displayName, password, role }: InitialAccount) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  check(
    ["config.json", "business.sqlite", "keys.json"].every(file => !existsSync(join(root, file))),
    409,
    "此目录已初始化，请使用 start；已有数据不会覆盖。",
  );
  const keys = {
    jwt: random(),
    provider: random(),
    service: random(),
    events: random(),
    objects: random(),
    dummyPassword: await passwordHash(random()),
  };
  const digest = await passwordHash(password);
  // Publish the configuration only after the signing identity and account exist.
  const keysPath = join(root, "keys.json");
  atomic(keysPath, JSON.stringify(keys, null, 2) + "\n", { exclusive: true });
  let store;
  try {
    store = await Store.open(root, { database: config.database, initialize: async store => {
      const id = randomUUID();
      await store.run("INSERT INTO users VALUES(?,?,?,?,?,0,?)", id, username, displayName, digest, role, iso());
      await store.audit(id, "workspace.initialized");
    } });
    atomic(join(root, "config.json"), JSON.stringify(config, null, 2) + "\n", { exclusive: true });
  } catch (error) {
    if (!store) {
      for (const file of config.database ? ["keys.json"] : ["keys.json", "business.sqlite", "business.sqlite-shm", "business.sqlite-wal"]) {
        rmSync(join(root, file), { force: true });
      }
    }
    throw error;
  } finally {
    await store?.close();
  }
}
