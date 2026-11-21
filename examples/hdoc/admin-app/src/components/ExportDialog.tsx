import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Notice } from "./Workspace";
import { documentApi } from "@/lib/workspace";
import type { ExportCapabilities } from "@/lib/types";
import { useCatalog } from "@/state/CatalogProvider";

const modes: Record<string, string> = {
  source: "保留源文件格式",
  semantic: "按内容重建",
  canonical: "标准 HTML",
  visual: "按画面导出",
  archive: "包含历史的 HCD 包",
  raster: "图片导出",
};
const warnings: Record<string, string> = {
  semantic_rebuild: "按语义内容重建，版式可能与原稿不同。",
  workbook_features_lost: "部分工作簿特性无法保留。",
  pdf_no_ocr: "不执行 OCR；扫描图片不会转换为文字。",
  canonical_pagination: "按当前 HTML 内容重新分页。",
  pdf_visual_flattened: "按视觉画面导出，可能合并原有文本结构。",
  archive_history: "HCD 包包含当前文档与历史修订。",
  source_pdf_approximate: "PDF 源格式写回可能与原始版面存在差异。",
  lossless_webp: "使用无损 WebP 编码。",
};
export function ExportDialog({
  documentId,
  revision,
}: {
  documentId: string;
  revision: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [capabilities, setCapabilities] =
    React.useState<ExportCapabilities | null>(null);
  const [format, setFormat] = React.useState("");
  const [mode, setMode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const { refreshTasks } = useCatalog();
  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setCapabilities(null);
    setError("");
    setLoading(true);
    void documentApi
      .capabilities(documentId, revision)
      .then((value) => {
        if (!active) return;
        setCapabilities(value);
        setFormat(value.defaultFormat);
        setMode(
          value.formats.find((item) => item.format === value.defaultFormat)
            ?.recommendedMode || "",
        );
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, documentId, revision]);
  const selected = capabilities?.formats.find((item) => item.format === format);
  const choice = selected?.modes.find((item) => item.id === mode);
  const download = async () => {
    if (!choice?.available || busy) return;
    setBusy(true);
    setError("");
    try {
      const artifact = await documentApi.download(
        documentId,
        format,
        revision,
        choice.source,
      );
      if (!artifact.url.startsWith("/v1/downloads/"))
        throw new Error("服务返回了无效的下载地址。");
      const anchor = document.createElement("a");
      anchor.href = artifact.url;
      anchor.download = artifact.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      void refreshTasks();
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Download />
          导出
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>导出文档</DialogTitle>
          <DialogDescription className="break-all">
            {documentId} · 固定 rev. {revision}
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            正在检查所选修订的导出能力…
          </p>
        )}
        {capabilities && (
          <>
            <label className="grid gap-2 text-xs">
              输出格式
              <Select
                value={format}
                onChange={(event) => {
                  const next = event.target.value;
                  setFormat(next);
                  setMode(
                    capabilities.formats.find((item) => item.format === next)
                      ?.recommendedMode || "",
                  );
                }}
              >
                {capabilities.formats.map((item) => (
                  <option
                    key={item.format}
                    value={item.format}
                    disabled={!item.available}
                  >
                    {item.format.toUpperCase()}
                    {item.available ? "" : " · 不可用"}
                  </option>
                ))}
              </Select>
            </label>
            <label className="grid gap-2 text-xs">
              导出方式
              <Select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                {selected?.modes.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={!item.available}
                  >
                    {modes[item.id] || item.id}
                    {item.available ? "" : " · 不可用"}
                  </option>
                ))}
              </Select>
            </label>
            {choice && (
              <Notice
                title={choice.available ? "检查交付方式" : "当前方式不可用"}
                warning={!choice.available || !!choice.fontWarnings.length}
              >
                {choice.reason && <p>{choice.reason}</p>}
                {choice.warnings.map((warning) => (
                  <p key={warning}>{warnings[warning] || warning}</p>
                ))}
                {choice.fontWarnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </Notice>
            )}
          </>
        )}
        {error && (
          <p
            role="alert"
            className="break-words text-xs leading-6 text-destructive"
          >
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            取消
          </Button>
          <Button
            disabled={!choice?.available || busy || loading}
            onClick={() => void download()}
          >
            <Download />
            {busy ? "正在准备文件…" : "导出并下载"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
