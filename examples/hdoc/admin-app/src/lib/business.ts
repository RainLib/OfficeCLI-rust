import { setWorkspaceCredential } from "./api";
export type BusinessUser = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  disabled: boolean;
  isGuest?: boolean;
  createdAt: string;
};
export type BusinessSession = {
  user: BusinessUser;
  csrf: string;
  expiresAt: number;
  workspace?: {
    tenantId: string;
    appId: string;
    publicUrl: string;
    aiEnabled: boolean;
    selectionMcp?: boolean;
  };
};
export type BusinessFile = {
  id: string;
  name: string;
  format: string;
  ownerId: string;
  ownerName: string;
  version: string;
  size: number;
  createdAt: string;
  modifiedAt: string;
  operations: string[];
  canManage: boolean;
  lastPublishedRevision: number | null;
  documentId: string | null;
};
let csrf = "";
export class BusinessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BusinessError";
  }
}
export function businessSession(value: BusinessSession | null) {
  csrf = value?.csrf || "";
  setWorkspaceCredential(csrf);
}
export async function businessRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/workspace/api${path}`, {
    ...init,
    headers: { ...(csrf ? { "X-Workspace-CSRF": csrf } : {}), ...init.headers },
    credentials: "same-origin",
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/login")
      window.dispatchEvent(new Event("officecli:workspace-session-expired"));
    throw new BusinessError(
      body.error || `请求失败（${response.status}）`,
      response.status,
    );
  }
  return body as T;
}
export const businessJson = <T>(path: string, data: unknown, method = "POST") =>
  businessRequest<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
export const roleLabels: Record<string, string> = {
  viewer: "只读成员",
  editor: "编辑成员",
  manager: "文件管理员",
};
export const operationLabels: Record<string, string> = {
  "document.view": "查看",
  "document.edit": "编辑",
  "document.ai": "AI 协作",
  "document.publish": "业务回写",
  "document.download": "下载原格式",
  "document.export": "转换导出",
  "document.copy": "复制",
  "document.print": "打印",
  "history.view": "查看历史",
  "history.restore": "恢复历史",
  "theme.assign": "指定字体主题",
};
export const businessProfiles: Record<string, string[]> = {
  viewer: [
    "document.view",
    "document.download",
    "document.print",
    "document.copy",
    "history.view",
  ],
  editor: Object.keys(operationLabels).filter((op) => op !== "theme.assign"),
  manager: Object.keys(operationLabels),
};
export const dateText = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
