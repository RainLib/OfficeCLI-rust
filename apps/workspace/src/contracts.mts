export type DatabaseKind = "sqlite" | "postgres" | "mysql";

export interface NetworkDatabaseConfig {
  kind: Exclude<DatabaseKind, "sqlite">;
  urlEnv: string;
  id: string;
}

export interface WorkspaceConfig {
  schemaVersion: "officecli-workspace/1" | "officecli-workspace/2";
  database?: NetworkDatabaseConfig;
  name: string;
  mode?: "desktop";
  tenantId: string;
  appId: string;
  publicUrl: string;
  bindHost: string;
  port: number;
  callbackUrl: string;
  engineUrl: string;
  collabUrl: string;
  selectionMcp?: boolean;
}

export interface WorkspaceKeys {
  jwt: string;
  provider: string;
  service: string;
  events: string;
  objects: string;
  dummyPassword?: string;
}

export interface Workspace {
  root: string;
  config: WorkspaceConfig;
  keys: WorkspaceKeys;
  allowAI?: boolean;
}

export type WorkspaceRole = "admin" | "member";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function check(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new HttpError(status, message);
}

export const deploymentChildFlag = "OFFICECLI_DEPLOYMENT_CHILD";

export function isDeploymentChild(): boolean {
  return process.env[deploymentChildFlag] === "1" && process.connected === true && typeof process.send === "function";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
