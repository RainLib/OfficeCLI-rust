import * as React from "react";
import { Copy, RefreshCw } from "lucide-react";

import { PageHeader, Toolbar } from "@/components/Page";
import { IdChip } from "@/components/IdChip";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import type { ResolvedTheme } from "@/lib/types";
import { useCatalog } from "@/state/CatalogProvider";

const STYLE_ID = "hcd-preview-style";
/** Preview faces bigger than this are left to the document's own fallback. */
const INLINE_LIMIT = 8 * 1024 * 1024;

export function PreviewView() {
  const { themes, loaded } = useCatalog();
  const toast = useToast();
  const [selected, setSelected] = React.useState("");
  const [resolved, setResolved] = React.useState<ResolvedTheme | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!selected && themes.length) setSelected(themes[0].themeRevisionId);
  }, [themes, selected]);

  // The injected @font-face block only belongs to this page.
  React.useEffect(
    () => () => {
      document.getElementById(STYLE_ID)?.remove();
    },
    [],
  );

  const resolve = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const theme = await api.resolveTheme(selected);
      let css = theme.css;
      const previewable = theme.faces.filter((face) => face.webPreview);
      for (const face of previewable) {
        const url = await api.faceObjectUrl(face.href);
        css = css.split(face.href).join(url);
      }
      const style =
        (document.getElementById(STYLE_ID) as HTMLStyleElement | null) ??
        Object.assign(document.createElement("style"), { id: STYLE_ID });
      style.textContent = css;
      document.head.appendChild(style);
      setResolved(theme);
      toast.push(
        `已解析 ${theme.name}：${previewable.length} 个可预览字面。`,
        "ok",
      );
    } catch (error) {
      toast.err(error);
    } finally {
      setBusy(false);
    }
  };

  const inlineable = resolved?.faces.filter(
    (face) => face.webPreview && face.byteLength <= INLINE_LIMIT,
  ).length;
  const skipped = resolved
    ? resolved.faces.filter((face) => face.webPreview && face.byteLength > INLINE_LIMIT)
    : [];

  return (
    <>
      <PageHeader
        title="主题预览"
        description="按文档令牌同样的规则解析主题：可预览的字面下载后换成 data/blob 地址，写进这一页的样式表，不改文档包。"
      />

      <Toolbar>
        <Select
          aria-label="已存主题"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="h-7 w-72 text-xs"
          disabled={!loaded || themes.length === 0}
        >
          {themes.length === 0 ? <option value="">（暂无主题）</option> : null}
          {themes.map((theme) => (
            <option key={theme.themeRevisionId} value={theme.themeRevisionId}>
              {theme.name} · {theme.themeRevisionId.slice(0, 12)}…
            </option>
          ))}
        </Select>
        <Button size="sm" onClick={() => void resolve()} disabled={busy || !selected}>
          <RefreshCw className={busy ? "animate-spin" : undefined} />
          解析并预览
        </Button>
        {resolved ? (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(resolved.themeRevisionId);
                toast.push("themeRevisionId 已复制，用于钉到文档。", "ok");
              } catch {
                toast.push(resolved.themeRevisionId, "info");
              }
            }}
          >
            <Copy />
            复制 themeRevisionId
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {resolved
            ? `${inlineable} / ${resolved.faces.length} 个字面会内联`
            : "未解析"}
        </span>
      </Toolbar>

      {resolved?.warnings?.length ? (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle>解析提示</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-xs text-muted-foreground">
              {resolved.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {resolved ? (
        <Card>
          <CardHeader>
            <CardTitle>字样</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>{resolved.name}</span>
              <IdChip value={resolved.themeRevisionId} copy={false} />
            </div>
            <div
              className="rounded-lg border bg-background p-5"
              style={{ fontFamily: "var(--hcd-minor-latin, sans-serif)" }}
            >
              <h2
                className="text-2xl font-semibold"
                style={{ fontFamily: "var(--hcd-major-latin, var(--hcd-minor-latin))" }}
              >
                标题 major · {resolved.name}
              </h2>
              <p className="mt-2 text-sm leading-7">
                正文 minor：字体目录把不可变的 themeRevisionId 钉在文档上，编辑页与导出读同一份主题。
                The quick brown fox jumps over the lazy dog. 0123456789
              </p>
              <p className="mt-2 text-sm italic">italic · oblique 取样</p>
              <p className="mt-1 font-bold">bold 700 取样</p>
            </div>
            {skipped.length ? (
              <p className="text-xs text-warning">
                超过 8 MiB 而跳过内联的字面：
                {skipped.map((face) => `${face.fontId}/${face.subfamily}`).join("、")}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {resolved ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>槽位</TableHead>
                <TableHead>fontId</TableHead>
                <TableHead>字面</TableHead>
                <TableHead>字重 / 样式</TableHead>
                <TableHead>格式</TableHead>
                <TableHead className="text-right">字节</TableHead>
                <TableHead>许可</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resolved.faces.map((face, index) => (
                <TableRow key={`${face.slot}-${face.sha256}-${index}`}>
                  <TableCell>
                    <code className="font-mono text-xs">{face.slot}</code>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <code className="text-xs">{face.fontId}</code>
                      <IdChip value={face.fontRevisionId} keep={8} copy={false} />
                    </div>
                  </TableCell>
                  <TableCell>{face.subfamily}</TableCell>
                  <TableCell className="tabular">
                    {face.weight} · {face.style}
                    {face.stretch === "normal" ? "" : ` · ${face.stretch}`}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{face.format}</Badge>
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatBytes(face.byteLength)}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Badge variant={face.webPreview ? "success" : "muted"}>网页</Badge>
                      <Badge variant={face.ooxmlEmbed ? "success" : "muted"}>OOXML</Badge>
                      <Badge variant={face.pdfEmbed ? "success" : "muted"}>PDF</Badge>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </>
  );
}
