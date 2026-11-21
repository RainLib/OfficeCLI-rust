import * as React from "react";
import {
  ArrowUpRight,
  Download,
  FileUp,
  RefreshCw,
  Upload,
} from "lucide-react";
import { EmptyState, PageHeader } from "@/components/Page";
import { Notice, StatusBadge } from "@/components/Workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
import { useCatalog } from "@/state/CatalogProvider";
import { request } from "@/lib/api";
import { activeStates, formatTime } from "@/lib/workspace";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { WorkspaceJob } from "@/lib/types";

export function JobsView({
  query,
  onNavigate,
}: {
  query: URLSearchParams;
  onNavigate: (route: string) => void;
}) {
  const { jobs, documents, taskWarning, refresh, refreshTasks } = useCatalog();
  const [filter, setFilter] = React.useState(
    query.get("state") === "failed" ? "failed" : "all",
  );
  const [days, setDays] = React.useState("all");
  const [selected, setSelected] = React.useState<WorkspaceJob | null>(null);
  const [uploadOpen, setUploadOpen] = React.useState(
    query.get("import") === "1",
  );
  const [file, setFile] = React.useState<File | null>(null);
  const [credential, setCredential] = React.useState(() => {
    try {
      return sessionStorage.getItem("hcdAdminUploadToken") || "";
    } catch {
      return "";
    }
  });
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState("");
  React.useEffect(() => {
    if (query.get("import") === "1") setUploadOpen(true);
  }, [query.toString()]);
  const rows = jobs.filter(
    (job) =>
      (filter === "all" ||
        filter === job.kind ||
        (filter === "failed" &&
          ["failed", "interrupted"].includes(job.state))) &&
      (days === "all" ||
        Date.now() - job.updatedAtEpochMs < Number(days) * 86400000),
  );
  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || !credential.trim() || uploading) return;
    if (file.size > 512 * 1024 * 1024 || file.size === 0) {
      setError("请选择非空且不超过 512 MiB 的文件。");
      return;
    }
    setUploading(true);
    setError("");
    setResult("");
    try {
      const response = await request(
        `/v1/import?filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        },
        credential.trim(),
      );
      const value = (await response.json()) as {
        documentId: string;
        jobId: string;
        state: string;
      };
      try {
        sessionStorage.setItem("hcdAdminUploadToken", credential.trim());
      } catch {
        /* Optional storage. */
      }
      setResult(
        `文件已接收，任务 ${value.jobId} 已创建。请在任务列表跟进处理结果。`,
      );
      setFile(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  };
  const live = selected
    ? jobs.find((job) => job.jobId === selected.jobId) || selected
    : null;
  return (
    <>
      <PageHeader
        title="导入与导出"
        description="跟进处理进度，查看输出结果和需要处理的问题。"
        actions={
          <Button
            onClick={() => {
              setUploadOpen(true);
              setResult("");
            }}
          >
            <Upload />
            导入文档
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [
            String(jobs.filter((job) => activeStates.has(job.state)).length),
            "正在处理",
          ],
          [
            String(
              jobs.filter((job) =>
                ["failed", "interrupted"].includes(job.state),
              ).length,
            ),
            "需要处理",
          ],
          [
            String(
              jobs.filter(
                (job) =>
                  job.state === "completed" &&
                  Date.now() - job.updatedAtEpochMs < 86400000,
              ).length,
            ),
            "最近 24 小时完成",
          ],
        ].map(([value, label]) => (
          <div
            key={label}
            className="flex items-center gap-4 rounded-2xl bg-muted px-5 py-4"
          >
            <strong className="tabular text-[26px] font-semibold">
              {value}
            </strong>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {[
          ["all", "全部任务"],
          ["import", "导入"],
          ["export", "导出"],
          ["failed", "异常"],
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
        <Select
          aria-label="任务时间范围"
          className="ml-auto w-36"
          value={days}
          onChange={(event) => setDays(event.target.value)}
        >
          <option value="all">全部时间</option>
          <option value="1">最近 24 小时</option>
          <option value="7">最近 7 天</option>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新任务"
          onClick={() => void refreshTasks()}
        >
          <RefreshCw />
        </Button>
      </div>
      {taskWarning && (
        <Notice title="任务记录提示" warning>
          {taskWarning}
        </Notice>
      )}
      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>任务与来源</TableHead>
              <TableHead>输出格式</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((job) => (
              <TableRow key={job.jobId}>
                <TableCell className="max-w-80">
                  <strong className="block truncate text-xs font-medium">
                    {job.filename ||
                      documents?.find(
                        (doc) => doc.documentId === job.documentId,
                      )?.title ||
                      job.documentId}
                  </strong>
                  <small className="mt-1.5 block text-[10px] text-muted-foreground">
                    {job.kind === "import" ? "导入" : "导出"}
                    {job.revision === undefined
                      ? ""
                      : ` · rev. ${job.revision}`}
                  </small>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {(
                    job.format ||
                    documents?.find((doc) => doc.documentId === job.documentId)
                      ?.format ||
                    "—"
                  ).toUpperCase()}
                </TableCell>
                <TableCell>
                  <StatusBadge state={job.state} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTime(job.updatedAtEpochMs)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setSelected(job)}
                  >
                    查看详情
                    <ArrowUpRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          title="还没有符合条件的任务"
          description="导入文件或在文档详情中导出后，实际处理记录会显示在这里。"
          action={{ label: "导入文档", onClick: () => setUploadOpen(true) }}
        />
      )}
      <p className="mt-auto pt-3 text-[11px] leading-6 text-muted-foreground">
        共 {rows.length} 项任务 ·
        导入导出记录保存在服务工作目录中。正在处理的任务显示实际状态。
      </p>
      <Dialog
        open={uploadOpen}
        onOpenChange={(next) => {
          if (!uploading) setUploadOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导入文档</DialogTitle>
            <DialogDescription>
              支持 Office、PDF、Markdown、HTML、TXT、HCD 与 PNG / JPEG / WebP。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void upload(event)} className="space-y-5">
            <label className="grid gap-2 text-xs">
              选择文件
              <Input
                type="file"
                accept=".docx,.xlsx,.pptx,.pdf,.md,.markdown,.html,.htm,.txt,.hcd,.png,.jpg,.jpeg,.webp"
                onChange={(event) => {
                  setFile(event.target.files?.[0] || null);
                  setError("");
                  setResult("");
                }}
                disabled={uploading}
              />
            </label>
            {file && (
              <p className="text-xs text-muted-foreground">
                {file.name} · {formatBytes(file.size)}
              </p>
            )}
            <label className="grid gap-2 text-xs">
              上传令牌
              <Input
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
                placeholder="scope=upload，document-id=*"
                disabled={uploading}
              />
            </label>
            <Notice title="使用独立的上传权限">
              <code className="break-all">
                officecli hdoc issue-token --document-id '*' --scope upload
                --ttl-seconds 3600
              </code>
            </Notice>
            {error && (
              <p role="alert" className="text-xs leading-6 text-destructive">
                {error}
              </p>
            )}
            {result && <Notice title="已接收文件">{result}</Notice>}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                disabled={uploading}
                onClick={() => setUploadOpen(false)}
              >
                关闭
              </Button>
              <Button
                type="submit"
                disabled={!file || !credential.trim() || uploading}
              >
                <FileUp />
                {uploading ? "正在发送文件…" : "导入文件"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={live !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>任务详情</DialogTitle>
            <DialogDescription className="break-all">
              {live?.jobId}
            </DialogDescription>
          </DialogHeader>
          {live && (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="break-all text-xs">
                  {live.filename || live.documentId}
                </span>
                <StatusBadge state={live.state} />
              </div>
              <dl className="grid grid-cols-2 gap-4 rounded-2xl bg-muted p-4 text-xs">
                <dt className="text-muted-foreground">类型</dt>
                <dd>{live.kind === "import" ? "导入" : "导出"}</dd>
                <dt className="text-muted-foreground">修订</dt>
                <dd>
                  {live.revision === undefined ? "—" : `rev. ${live.revision}`}
                </dd>
                <dt className="text-muted-foreground">更新时间</dt>
                <dd>{formatTime(live.updatedAtEpochMs)}</dd>
              </dl>
              {live.error && (
                <Notice title="处理未完成" warning>
                  {live.error}
                </Notice>
              )}
              {live.warnings?.length ? (
                <Notice title="处理提示" warning>
                  {live.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </Notice>
              ) : null}
              {live.state === "completed" && (
                <Notice title="处理已完成">
                  {live.kind === "export"
                    ? "打开所选文档修订，可以重新准备下载文件。"
                    : "文档已加入工作空间，可以连接令牌后打开。"}
                </Notice>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setSelected(null)}>
                  关闭
                </Button>
                {live.state === "failed" && live.kind === "import" && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSelected(null);
                      setUploadOpen(true);
                    }}
                  >
                    重新选择文件
                  </Button>
                )}
                <Button
                  onClick={() => {
                    setSelected(null);
                    onNavigate(
                      `documents/${encodeURIComponent(live.documentId)}${live.revision === undefined ? "" : `?revision=${live.revision}`}`,
                    );
                  }}
                >
                  {live.kind === "export" ? <Download /> : <ArrowUpRight />}
                  {live.kind === "export" ? "打开修订与导出" : "打开文档"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
