import { useEffect, useRef, useState } from "react";
import { EmbeddedHcdEditor } from "./embed.tsx";

type Launch = {
  documentId: string;
  token: string;
  expiresAt: number;
  fileName: string;
  collabUrl: string;
};
/** The business cookie never becomes an engine credential. The backend exchanges
 * a short, document-bound token through the same Provider contract as a host. */
export function BusinessEditor({ fileId }: { fileId: string }) {
  const [launch, setLaunch] = useState<Launch | null>(null),
    [error, setError] = useState("");
  const sessionId = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const renew = async () => {
      try {
        const auth = await fetch("/workspace/api/session", {
          credentials: "same-origin",
        });
        if (!auth.ok)
          throw new Error("业务登录已过期，请返回工作空间重新登录。");
        const account = (await auth.json()) as { csrf: string };
        const response = await fetch(
          `/workspace/api/files/${encodeURIComponent(fileId)}/editor-session`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "X-Workspace-CSRF": account.csrf,
            },
            body: JSON.stringify({ sessionId: sessionId.current }),
          },
        );
        const value = (await response.json()) as Launch & { error?: string };
        if (!response.ok) throw new Error(value.error || "无法创建编辑会话。");
        if (!active) return;
        setLaunch((previous) =>
          previous?.token === value.token ? previous : value,
        );
        setError("");
        timer = setTimeout(
          () => void renew(),
          Math.max(10_000, value.expiresAt * 1000 - Date.now() - 90_000),
        );
      } catch (cause) {
        if (!active) return;
        setError(String(cause));
        timer = setTimeout(() => void renew(), 15_000);
      }
    };
    void renew();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [fileId]);
  const websocket = new URL("/collaboration", location.href);
  websocket.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return (
    <div
      className="business-editor"
      style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
    >
      {error && (
        <div
          role="alert"
          style={{
            padding: "10px 16px",
            background: "#fbf5eb",
            color: "#77521e",
            font: "12px/1.6 sans-serif",
          }}
        >
          {error} <a href="/">返回工作空间</a>；已挂载的文档与草稿会保留。
        </div>
      )}
      {launch ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <EmbeddedHcdEditor
            documentId={launch.documentId}
            token={launch.token}
            apiUrl="/v1/documents"
            collabUrl={websocket.href}
            locale="zh-CN"
            onClose={() => {
              location.href = `/#/documents/${encodeURIComponent(fileId)}`;
            }}
          />
        </div>
      ) : (
        !error && (
          <div style={{ padding: 32, font: "14px sans-serif" }}>
            正在打开业务文件…
          </div>
        )
      )}
    </div>
  );
}
