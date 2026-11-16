import * as React from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  List,
  Palette,
  ScanSearch,
  Search,
  Upload,
} from "lucide-react";
import { EmptyState, LoadState, PageHeader } from "@/components/Page";
import { FormatIcon, Notice, StatusBadge } from "@/components/Workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/Toast";
import { useCatalog } from "@/state/CatalogProvider";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/workspace";
import { FontPlanDialog } from "./FontPlanDialog";

export function DocumentsView({
  search = "",
  initialTheme = "",
  onNavigate,
}: {
  search?: string;
  initialTheme?: string;
  onNavigate: (route: string) => void;
}) {
  const { documents, themes, retired, loaded, busy, refresh } = useCatalog();
  const toast = useToast();
  const [query, setQuery] = React.useState(search);
  const [filter, setFilter] = React.useState("all");
  const [format, setFormat] = React.useState("all");
  const [theme, setTheme] = React.useState(initialTheme || "all");
  const [sort, setSort] = React.useState("updated");
  const [grid, setGrid] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [target, setTarget] = React.useState("");
  const [applying, setApplying] = React.useState(false);
  const [results, setResults] = React.useState<Record<string, string>>({});
  const [planFor, setPlanFor] = React.useState<string | null>(null);
  React.useEffect(() => setQuery(search), [search]);
  React.useEffect(() => setPage(1), [query, filter, format, theme, sort]);
  const rows = [...(documents || [])]
    .filter(
      (doc) =>
        `${doc.title || ""} ${doc.documentId}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (format === "all" || doc.format === format) &&
        (theme === "all" || doc.themeRevisionId === theme) &&
        (filter !== "recent" ||
          Date.now() - (doc.updatedAtEpochMs || 0) <= 7 * 86400000) &&
        (filter !== "unpinned" || !doc.themeRevisionId) &&
        (filter !== "issues" || doc.state !== "COMPLETE"),
    )
    .sort((a, b) =>
      sort === "name"
        ? (a.title || a.documentId).localeCompare(
            b.title || b.documentId,
            "zh-CN",
          )
        : (b.updatedAtEpochMs || 0) - (a.updatedAtEpochMs || 0),
    );
  const pageCount = Math.max(1, Math.ceil(rows.length / 8));
  const currentPage = Math.min(page, pageCount);
  const visible = rows.slice((currentPage - 1) * 8, currentPage * 8);
  const selected = rows.filter((doc) => selection.has(doc.documentId));
  const eligible = selected.filter(
    (doc) => !doc.themeRevisionId && doc.state === "COMPLETE",
  );
  const pinnable = themes.filter(
    (item) => !retired.includes(item.themeRevisionId),
  );
  const themeName = (id?: string) =>
    id
      ? themes.find((item) => item.themeRevisionId === id)?.name ||
        "目录外的主题"
      : "未指定";
  const toggle = (id: string) =>
    setSelection((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const apply = async () => {
    if (!target || applying || !eligible.length) return;
    setApplying(true);
    setResults({});
    let completed = 0;
    try {
      const latest = (await api.workspace()).documents;
      for (const item of selected) {
        const live = latest.find((doc) => doc.documentId === item.documentId);
        let result = "";
        if (!live) result = "跳过 · 文档已不在目录中";
        else if (live.themeRevisionId) result = "跳过 · 已有主题";
        else if (live.state !== "COMPLETE") result = "跳过 · 导入未完成";
        else {
          try {
            const response = await api.pinDocumentTheme(
              item.documentId,
              target,
              live.revision,
            );
            result = `已完成 · rev. ${response.revision}`;
            completed++;
          } catch (cause) {
            result = `失败 · ${cause instanceof Error ? cause.message : String(cause)}`;
          }
        }
        setResults((previous) => ({ ...previous, [item.documentId]: result }));
      }
      toast.push(
        `批量处理结束：${completed} 份文档已指定主题，其他结果见清单。`,
        completed ? "ok" : "warn",
      );
      await refresh();
    } catch (cause) {
      toast.err(cause);
    } finally {
      setApplying(false);
    }
  };
  return (
    <>
      <PageHeader
        title="文档管理"
        description="集中查看所有格式的文档，继续编辑或检查交付状态。"
        actions={
          <Button onClick={() => onNavigate("jobs?import=1")}>
            <Upload />
            导入文档
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        {[
          ["all", `全部文档  ${documents?.length ?? "—"}`],
          ["recent", "最近编辑"],
          [
            "unpinned",
            `主题未指定  ${(documents || []).filter((doc) => !doc.themeRevisionId).length}`,
          ],
          ["issues", "需要处理"],
        ].map(([key, label]) => (
          <Button
            key={key}
            variant="ghost"
            className={cn(filter === key && "bg-accent text-accent-foreground")}
            onClick={() => setFilter(key)}
          >
            {label}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="列表视图"
            aria-pressed={!grid}
            onClick={() => setGrid(false)}
          >
            <List />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="缩略图视图"
            aria-pressed={grid}
            onClick={() => setGrid(true)}
          >
            <LayoutGrid />
          </Button>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            setBulkOpen(true);
            setResults({});
          }}
        >
          <Palette />
          批量指定主题
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-40 flex-1">
          <Search className="absolute left-3 top-3.5 size-4 text-muted-foreground" />
          <Input
            aria-label="搜索文档"
            placeholder="搜索文档名称或 ID"
            className="pl-10"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          className="w-32"
          aria-label="文档格式"
          value={format}
          onChange={(event) => setFormat(event.target.value)}
        >
          <option value="all">所有格式</option>
          {[...new Set((documents || []).map((doc) => doc.format))]
            .sort()
            .map((f) => (
              <option key={f} value={f}>
                {f.toUpperCase()}
              </option>
            ))}
        </Select>
        <Select
          className="w-40"
          aria-label="文档主题"
          value={theme}
          onChange={(event) => setTheme(event.target.value)}
        >
          <option value="all">所有主题</option>
          {themes.map((item) => (
            <option key={item.themeRevisionId} value={item.themeRevisionId}>
              {item.name}
            </option>
          ))}
        </Select>
        <Select
          className="w-32"
          aria-label="文档排序"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="updated">最近修改</option>
          <option value="name">名称排序</option>
        </Select>
      </div>
      {!loaded && busy && <LoadState text="正在读取文档目录…" />}
      {loaded && !rows.length && (
        <EmptyState
          title={documents?.length ? "没有符合条件的文档" : "还没有文档"}
          description="导入文档，或调整搜索与筛选条件。"
          action={{
            label: "导入文档",
            onClick: () => onNavigate("jobs?import=1"),
          }}
        />
      )}
      {rows.length > 0 && (
        <>
          <div className={cn("hidden", !grid && "md:block")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="选择本页文档"
                      checked={
                        visible.length > 0 &&
                        visible.every((doc) => selection.has(doc.documentId))
                      }
                      onChange={(event) =>
                        setSelection((previous) => {
                          const next = new Set(previous);
                          visible.forEach((doc) =>
                            event.target.checked
                              ? next.add(doc.documentId)
                              : next.delete(doc.documentId),
                          );
                          return next;
                        })
                      }
                    />
                  </TableHead>
                  <TableHead>文档名称</TableHead>
                  <TableHead>格式</TableHead>
                  <TableHead>当前修订</TableHead>
                  <TableHead>主题</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((doc) => (
                  <TableRow
                    key={doc.documentId}
                    className={selection.has(doc.documentId) ? "bg-accent" : ""}
                  >
                    <TableCell>
                      <Checkbox
                        aria-label={`选择 ${doc.title || doc.documentId}`}
                        checked={selection.has(doc.documentId)}
                        onChange={() => toggle(doc.documentId)}
                      />
                    </TableCell>
                    <TableCell className="max-w-72">
                      <button
                        className="flex w-full items-center gap-3 text-left"
                        onClick={() =>
                          onNavigate(
                            `documents/${encodeURIComponent(doc.documentId)}`,
                          )
                        }
                      >
                        <FormatIcon format={doc.format} />
                        <span className="min-w-0">
                          <strong className="block truncate text-xs font-medium">
                            {doc.title || doc.documentId}
                          </strong>
                          <small className="mt-1 block truncate text-[10px] text-muted-foreground">
                            {formatTime(doc.updatedAtEpochMs)}
                          </small>
                        </span>
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {doc.format.toUpperCase()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      rev. {doc.revision}
                    </TableCell>
                    <TableCell
                      className="max-w-48 truncate text-muted-foreground"
                      title={themeName(doc.themeRevisionId)}
                    >
                      {themeName(doc.themeRevisionId)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge state={doc.state} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() =>
                            onNavigate(
                              `documents/${encodeURIComponent(doc.documentId)}`,
                            )
                          }
                        >
                          详情
                          <ArrowUpRight />
                        </Button>
                        {["docx", "pptx", "xlsx", "pdf"].includes(
                          doc.format,
                        ) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`检查 ${doc.documentId} 导出字体`}
                            onClick={() => setPlanFor(doc.documentId)}
                          >
                            <ScanSearch />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div
            className={cn(
              "grid gap-4",
              grid ? "sm:grid-cols-2 xl:grid-cols-3" : "md:hidden",
            )}
          >
            {visible.map((doc) => (
              <article
                key={doc.documentId}
                className="space-y-3 rounded-2xl bg-muted p-4"
              >
                <div className="flex items-center gap-2">
                  <Checkbox
                    aria-label={`选择 ${doc.title || doc.documentId}`}
                    checked={selection.has(doc.documentId)}
                    onChange={() => toggle(doc.documentId)}
                  />
                  <FormatIcon format={doc.format} />
                  <strong className="min-w-0 flex-1 truncate text-xs">
                    {doc.title || doc.documentId}
                  </strong>
                </div>
                <p className="truncate text-[10px] text-muted-foreground">
                  {doc.format.toUpperCase()} · rev. {doc.revision} ·{" "}
                  {themeName(doc.themeRevisionId)}
                </p>
                <div className="flex items-center justify-between">
                  <StatusBadge state={doc.state} />
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() =>
                      onNavigate(
                        `documents/${encodeURIComponent(doc.documentId)}`,
                      )
                    }
                  >
                    打开
                    <ArrowUpRight />
                  </Button>
                </div>
              </article>
            ))}
          </div>
          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4 text-[11px] text-muted-foreground">
            <span>
              共 {rows.length} 份文档 · 已选 {selected.length} 份
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft />
                上一页
              </Button>
              <span>
                {currentPage} / {pageCount}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={currentPage === pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
      <Dialog
        open={bulkOpen}
        onOpenChange={(next) => {
          if (!applying) setBulkOpen(next);
        }}
      >
        <DialogContent className="w-[min(820px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>批量指定文档主题</DialogTitle>
            <DialogDescription>
              只处理当前筛选范围中选定、未指定主题且已导入完成的文档。
            </DialogDescription>
          </DialogHeader>
          <Select
            aria-label="批量目标主题"
            value={target}
            disabled={applying}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">选择目标主题</option>
            {pinnable.map((item) => (
              <option key={item.themeRevisionId} value={item.themeRevisionId}>
                {item.name}
              </option>
            ))}
          </Select>
          <Notice
            title={`已选择 ${selected.length} 份 · 可处理 ${eligible.length} 份`}
          >
            已有主题或导入未完成的文档将跳过。管理员可指定主题；每次成功写入创建新的文档修订。
          </Notice>
          {!selected.length && (
            <p className="text-xs text-muted-foreground">
              请先在文档列表勾选要处理的文档。
            </p>
          )}
          <div className="max-h-64 space-y-2 overflow-auto">
            {selected.map((doc) => (
              <div
                key={doc.documentId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted p-3 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  {doc.title || doc.documentId}
                </span>
                <span className="max-w-80 break-words text-[11px] text-muted-foreground">
                  {results[doc.documentId] ||
                    (doc.themeRevisionId
                      ? "跳过 · 已有主题"
                      : doc.state !== "COMPLETE"
                        ? "跳过 · 导入中"
                        : "可以指定主题")}
                </span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={applying}
              onClick={() => setBulkOpen(false)}
            >
              关闭
            </Button>
            <Button
              disabled={
                applying ||
                !target ||
                !eligible.length ||
                Object.keys(results).length > 0
              }
              onClick={() => void apply()}
            >
              <Check />
              {applying
                ? "逐份处理中…"
                : `为 ${eligible.length} 份文档指定主题`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {planFor && (
        <FontPlanDialog
          documentId={planFor}
          headRevision={
            documents?.find((doc) => doc.documentId === planFor)?.revision ?? 0
          }
          open={true}
          onOpenChange={(open) => {
            if (!open) setPlanFor(null);
          }}
        />
      )}
    </>
  );
}
