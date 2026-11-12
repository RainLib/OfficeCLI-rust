import * as React from "react";
import { FileText, Info } from "lucide-react";

import { EmptyState, LoadState, PageHeader, Toolbar } from "@/components/Page";
import { IdChip } from "@/components/IdChip";
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
import { useCatalog } from "@/state/CatalogProvider";

type Filter = "all" | "pinned" | "unpinned";

export function DocumentsView() {
  const { documents, themes, loaded, error, refresh } = useCatalog();
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");

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

  return (
    <>
      <PageHeader
        title="文档"
        description="内容侧的钉版状态：只列这台机器上本服务文档目录里的 bundle，用来核对管理台的改动落到哪些文档。"
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((document) => (
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
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">未钉主题</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>钉版要在文档侧做</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-xs text-muted-foreground">
          <p>
            管理令牌只授权目录读写，不能写具体文档；把主题钉到文档要用该文档的写令牌：
          </p>
          <pre className="tabular overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11px]">
{`officecli hdoc issue-token --document-id <documentId> --scope write --ttl-seconds 3600
curl -X PUT "http://127.0.0.1:8791/v1/documents/<documentId>/theme" \\
  -H "Authorization: Bearer <写令牌>" -H 'Content-Type: application/json' \\
  -d '{"themeRevisionId":"<themeRevisionId>"}'`}
          </pre>
          <p>
            钉版只改当前修订记录上的 themeRevisionId，不产生新的内容修订；历史修订仍指向当时钉的主题。
          </p>
        </CardContent>
      </Card>
    </>
  );
}
