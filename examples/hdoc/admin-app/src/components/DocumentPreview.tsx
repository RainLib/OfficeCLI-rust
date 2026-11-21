import * as React from "react";
import { LoaderCircle } from "lucide-react";
import { request } from "@/lib/api";
import { documentJson, useDocumentToken } from "@/lib/workspace";
import { Notice } from "./Workspace";

export function DocumentPreview({
  documentId,
  revision,
  format,
}: {
  documentId: string;
  revision: number;
  format: string;
}) {
  const token = useDocumentToken(documentId);
  const [html, setHtml] = React.useState("");
  const [error, setError] = React.useState("");
  const [more, setMore] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    setHtml("");
    setError("");
    setMore(false);
    const path = `/v1/documents/${encodeURIComponent(documentId)}`;
    const text = async (route: string) =>
      (
        await request(`${path}${route}`, { signal: controller.signal }, token)
      ).text();
    const run = async () => {
      let markup: string;
      if (format === "docx")
        markup = await text(`/presentation?revision=${revision}`);
      else {
        const manifest = await documentJson<{ chunkCount: number }>(
          documentId,
          `?revision=${revision}`,
          { signal: controller.signal },
        );
        const count = Math.min(manifest.chunkCount, 6);
        const [css, ...chunks] = await Promise.all([
          text(`/styles?revision=${revision}`),
          ...Array.from({ length: count }, (_, i) =>
            documentJson<{ html: string }>(
              documentId,
              `/chunks/${i}?revision=${revision}`,
              { signal: controller.signal },
            ).then((chunk) => chunk.html),
          ),
        ]);
        markup = `<html><head><style>${css.replace(/<\/style/gi, "")}</style></head><body>${chunks.join("<hr>")}</body></html>`;
        if (!controller.signal.aborted) setMore(manifest.chunkCount > count);
      }
      const parsed = new DOMParser().parseFromString(markup, "text/html");
      parsed
        .querySelectorAll(
          "script,iframe,object,embed,link,base,meta[http-equiv]",
        )
        .forEach((node) => node.remove());
      parsed
        .querySelectorAll("[href]")
        .forEach((node) => node.removeAttribute("href"));
      parsed
        .querySelectorAll("[contenteditable]")
        .forEach((node) => node.removeAttribute("contenteditable"));
      parsed
        .querySelectorAll("input,textarea,select,button")
        .forEach((node) => node.setAttribute("disabled", ""));
      const images = Array.from(parsed.querySelectorAll("img"));
      await Promise.all(
        images.slice(0, 24).map(async (image) => {
          const match = image
            .getAttribute("src")
            ?.match(/(?:sha256\/|assets\/)([a-f0-9]{64})/);
          if (!match) {
            if (!image.getAttribute("src")?.startsWith("data:image/"))
              image.removeAttribute("src");
            return;
          }
          const response = await request(
            `${path}/assets/${match[1]}?revision=${revision}`,
            { signal: controller.signal },
            token,
          );
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          image.src = url;
        }),
      );
      images.slice(24).forEach((image) => image.removeAttribute("src"));
      const policy = parsed.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.content =
        "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src blob: data:; form-action 'none'; base-uri 'none'";
      parsed.head.prepend(policy);
      const base = parsed.createElement("style");
      base.textContent =
        "html{background:#f7f8fb;color:#272d3b}body{margin:0;padding:28px;font:14px/1.8 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #e7eaf0;padding:6px}hr{border:0;border-top:1px solid #e7eaf0;margin:24px 0}";
      parsed.head.appendChild(base);
      if (!controller.signal.aborted)
        setHtml("<!doctype html>" + parsed.documentElement.outerHTML);
    };
    void run().catch((cause) => {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [documentId, revision, token, format]);
  return (
    <div className="flex h-full min-h-96 min-w-0 flex-col gap-3 rounded-[20px] bg-muted p-4 lg:p-6">
      <p className="flex items-center justify-between text-xs text-muted-foreground">
        <span>修订预览</span>
        <span>rev. {revision} · 只读</span>
      </p>
      {error ? (
        <Notice title="预览未能加载" warning>
          {error}
        </Notice>
      ) : html ? (
        <iframe
          className="min-h-[500px] w-full flex-1 border-0 bg-white"
          sandbox=""
          referrerPolicy="no-referrer"
          title={`文档修订 ${revision} 只读预览`}
          srcDoc={html}
        />
      ) : (
        <div
          role="status"
          className="flex min-h-96 flex-1 items-center justify-center gap-3 text-xs text-muted-foreground"
        >
          <LoaderCircle className="size-5 animate-spin" />
          正在读取所选修订…
        </div>
      )}
      {more && (
        <p className="text-[11px] leading-5 text-muted-foreground">
          此处展示前 6 个内容分片，完整文档请在编辑器中查看。
        </p>
      )}
    </div>
  );
}
