import * as React from "react";
import { FileText, Info, ShieldOff } from "lucide-react";

import { EmptyState, LoadState, PageHeader, Toolbar } from "@/components/Page";
import { IdChip } from "@/components/IdChip";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import type { DocumentSummary } from "@/lib/types";
import { useCatalog } from "@/state/CatalogProvider";

type Filter = "all" | "pinned" | "unpinned";

export function DocumentsView() {
  const { documents, themes, retired, loaded, error, refresh } = useCatalog();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [choice, setChoice] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  const retiredSet = React.useMemo(() => new Set(retired), [retired]);

  // A retired theme can no longer be pinned onto a document, so it never appears
  // in the picker; the row still shows it if the document pinned it earlier.
  const pinnable = React.useMemo(
    () =>
      themes
        .filter((theme) => !retiredSet.has(theme.themeRevisionId))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    [themes, retiredSet],
  );

  const themeNames = React.useMemo(
    () => new Map(themes.map((theme) => [theme.themeRevisionId, theme.name])),
    [themes],
  );

  const rows = React.useMemo(() => {
    const list = documents ?? [];
    const needle = query.trim().toLowerCase();
    return list.filter((document) => {
      if (needle && !document.documentId.toLowerCase().includes(needle)) return false;
      if (filter === "pinned") return Boolean(document.themeRevisionId);
      if (filter === "unpinned") return !document.themeRevisionId;
      return true;
    });
  }, [documents, query, filter]);

  const pinnedCount = (documents ?? []).filter((doc) => doc.themeRevisionId).length;

  const commitTheme = (
    document: DocumentSummary,
    themeRevisionId: string | null,
    headline: string,
  ) => {
    const current = document.themeRevisionId
      ? themeNames.get(document.themeRevisionId) ?? "目录外的主题"
      : null;
    const target = themeRevisionId ? themeNames.get(themeRevisionId) ?? themeRevisionId : null;
    confirm({
      title: headline,
      destructive: themeRevisionId === null,
      confirmLabel: headline,
      description: (
        <p>
          {document.documentId}（当前 r{document.revision}）
          {themeRevisionId ? (
            <>
              {current ? ` 现在钉的是 ${current}，` : " 现在没有钉主题，"}
              改为钉 {target}。
            </>
          ) : (
            <>现在钉的是 {current}，取消后回到文档自己的样式。</>
          )}
          <br />
          这会写入该文档的托管样式区，产生一次内容修订；正文和节点 id 不变，历史修订仍指向当时的主题。
        </p>
      ),
      onConfirm: async () => {
        setBusy(document.documentId);
        try {
          const result = await api.pinDocumentTheme(document.documentId, themeRevisionId);
          toast.push(
            themeRevisionId
              ? `已钉上 ${target}：${document.documentId} → r${result.revision}`
              : `已取消钉版：${document.documentId} → r${result.revision}`,
            "ok",
          );
          setChoice((previous) => ({ ...previous, [document.documentId]: "" }));
          await refresh();
        } catch (cause) {
          toast.err(cause);
        } finally {
          setBusy(null);
        }
      },
    });
  };

  return (
    <>
      <PageHeader
        title="文档"
        description="内容侧的钉版状态：只列这台机器上本服务文档目录里的 bundle，可以直接钉版、换主题或取消钉版。"
        actions={
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            重新扫描
          </Button>
        }
      />

      <Toolbar>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 documentId"
          className="h-7 w-64 text-xs"
        />
        <Select
          aria-label="钉版状态"
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
          className="h-7 w-36 text-xs"
        >
          <option value="all">全部文档</option>
          <option value="pinned">已钉主题</option>
          <option value="unpinned">未钉主题</option>
        </Select>
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {loaded
            ? documents === null
              ? "该服务未提供文档列表"
              : `${rows.length} / ${documents.length} 个文档 · ${pinnedCount} 个已钉主题`
            : "加载中…"}
        </span>
      </Toolbar>

      {documents === null ? (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <Info className="size-4" />
                这份 hdoc serve 还没有文档列表接口
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            升级到这个仓库的构建后，<code className="font-mono">GET /v1/documents</code>{" "}
            会列出文档目录里每个 bundle 的钉版情况。
          </CardContent>
        </Card>
      ) : null}

      {!loaded && !error ? <LoadState text="正在扫描文档目录…" /> : null}

      {loaded && documents !== null && rows.length === 0 ? (
        <div className="rounded-xl border bg-card shadow-xs">
          <EmptyState
            icon={FileText}
            title={documents.length ? "没有符合条件的文档" : "文档目录里还没有文档"}
            description={
              documents.length
                ? "换个筛选条件，或清空 documentId 搜索。"
                : "用 POST /v1/import 导入一个文档；服务配了 --default-theme 的话会自动钉上主题。"
            }
          />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>documentId</TableHead>
                <TableHead>格式</TableHead>
                <TableHead>profile</TableHead>
                <TableHead className="text-right">head 修订</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>钉住的主题</TableHead>
                <TableHead className="text-right">钉版操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((document) => {
                const selected = choice[document.documentId] ?? "";
                const sameAsCurrent =
                  selected !== "" && selected === document.themeRevisionId;
                return (
                  <TableRow key={document.documentId}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <code className="text-xs">{document.documentId}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{document.format}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{document.profile}</TableCell>
                    <TableCell className="tabular text-right">
                      r{document.revision}
                    </TableCell>
                    <TableCell>
                      <Badge variant={document.state === "active" ? "success" : "muted"}>
                        {document.state}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {document.themeRevisionId ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <IdChip value={document.themeRevisionId} keep={10} />
                          <span className="text-xs text-muted-foreground">
                            {themeNames.get(document.themeRevisionId) ?? "目录外的主题"}
                            {retiredSet.has(document.themeRevisionId) ? " · 已退役" : ""}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">未钉主题</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Select
                          aria-label={`给 ${document.documentId} 选主题`}
                          value={selected}
                          disabled={busy === document.documentId || pinnable.length === 0}
                          onChange={(event) =>
                            setChoice((previous) => ({
                              ...previous,
                              [document.documentId]: event.target.value,
                            }))
                          }
                          className="h-7 w-40 text-xs"
                        >
                          <option value="" disabled>
                            {pinnable.length ? "选择主题" : "没有可钉的主题"}
                          </option>
                          {pinnable.map((theme) => (
                            <option key={theme.themeRevisionId} value={theme.themeRevisionId}>
                              {theme.name}
                            </option>
                          ))}
                        </Select>
                        <Button
                          size="sm"
                          disabled={
                            busy === document.documentId || selected === "" || sameAsCurrent
                          }
                          title={
                            sameAsCurrent
                              ? "该主题已经钉在这个文档上"
                              : document.themeRevisionId
                                ? "换成选中的主题"
                                : "把选中的主题钉到这个文档上"
                          }
                          onClick={() =>
                            commitTheme(
                              document,
                              selected,
                              document.themeRevisionId ? "换主题" : "钉上主题",
                            )
                          }
                        >
                          {document.themeRevisionId ? "换到" : "钉上"}
                        </Button>
                        {document.themeRevisionId ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === document.documentId}
                            title="取消钉版，文档回到自己的样式"
                            onClick={() =>
                              commitTheme(document, null, "取消钉版")
                            }
                          >
                            <ShieldOff />
                            取消钉版
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>钉版是一次文档修订</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-xs text-muted-foreground">
          <p>
            <code className="font-mono">PUT /v1/documents/&lt;documentId&gt;/theme</code>{" "}
            接受管理令牌，也接受该文档的写令牌；页面右上角粘贴的令牌就能直接钉版。取消钉版把{" "}
            <code className="font-mono">themeRevisionId</code> 显式写成 null（缺字段会被拒绝，避免一次空请求悄悄取消钉版）：
          </p>
          <pre className="tabular overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11px]">
{`officecli hdoc issue-token --document-id <documentId> --scope write --ttl-seconds 3600
curl -X PUT "http://127.0.0.1:8791/v1/documents/<documentId>/theme" \\
  -H "Authorization: Bearer <写令牌>" -H 'Content-Type: application/json' \\
  -d '{"themeRevisionId":"<themeRevisionId>"}'
curl -X PUT ".../theme" -H "Authorization: Bearer <管理令牌>" \\
  -H 'Content-Type: application/json' -d '{"themeRevisionId":null}'`}
          </pre>
          <p>
            钉版和取消钉版都会把托管样式区写进 <code className="font-mono">styles/rev-NNNN.css</code>，
            因此推进 head 修订号（补丁记录形如 <code className="font-mono">{"theme-{rev}"}</code> /{" "}
            <code className="font-mono">{"theme-clear-{rev}"}</code>）；正文、节点 id 与内容哈希不变，
            历史修订仍指向当时钉的主题。已退役的主题不能再钉上，但已钉住它的文档仍可正常解析。
          </p>
        </CardContent>
      </Card>

      {node}
    </>
  );
}
