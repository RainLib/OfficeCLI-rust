import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Download, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/Page";
import { businessJson, businessRequest, dateText } from "@/lib/business";

type Job = {
  publicationId: string;
  fileId: string;
  fileName: string;
  author: string;
  state: string;
  revision: number;
  expectedVersion: string;
  currentVersion: string;
  createdAt: number;
  error: string | null;
  hasArtifact: boolean;
  canRetry: boolean;
  canCopy: boolean;
  conflict: boolean;
  pending: boolean;
  receipt: { externalVersion: string } | null;
  copy: { id: string; name: string } | null;
  eventDelivery: { configured: boolean; delivered: boolean; deadLetter: boolean; attempts: number };
};
type Page = { items: Job[]; next: string | null };
type Action = "reconcile" | "retry" | "copy" | "event-retry";

const states: Record<string, string> = {
  queued: "待处理", exporting: "正在导出", preparing: "准备上传", uploading: "正在上传", committing: "等待提交结果",
  committed: "已回写", retrying: "待核对", conflict: "版本冲突", rejected: "权限或接入失败", failed: "失败",
};
const providerStates: Record<string, string> = {
  notSent: "当前任务尚未送达业务系统。", unknown: "业务系统尚未确认此任务。", prepared: "业务系统已收到准备请求。",
  expired: "暂存上传已过期。", conflict: "业务系统报告版本冲突。", rejected: "业务系统已拒绝此任务。",
};

export function PublicationJobsView({ openFile }: { openFile: (id: string) => void }) {
  const [page, setPage] = useState<Page>({ items: [], next: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ id: string; message: string } | null>(null);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (before: string | null = null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const value = await businessRequest<Page>("/publication-jobs" + (before ? `?before=${encodeURIComponent(before)}` : ""), { signal: controller.signal });
      if (controller.signal.aborted) return;
      setPage(previous => before ? { ...value, items: [...previous.items, ...value.items] } : value);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

  async function act(job: Job, action: Action) {
    setBusy(job.publicationId);
    setStatus(null);
    setError("");
    try {
      const result = await businessJson<{ job: Job; providerState?: string }>(`/publication-jobs/${job.publicationId}/${action}`, {});
      setPage(previous => ({ ...previous, items: previous.items.map(item => item.publicationId === job.publicationId ? result.job : item) }));
      const message = action === "copy" ? "已另存为独立文件。" : action === "event-retry" ? "原事件已重新排入投递队列。"
        : result.job.receipt ? `已确认业务版本 ${result.job.receipt.externalVersion}。`
        : providerStates[result.providerState || ""] || states[result.job.state] || "已更新任务状态。";
      setStatus({ id: job.publicationId, message });
    } catch (cause) {
      await load();
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return <>
    <PageHeader title="回写任务" description="核对工作区修订对应的业务版本，处理提交结果和通知投递。" actions={
      <Button variant="outline" disabled={loading || !!busy} onClick={() => void load()}><RefreshCw />刷新任务</Button>
    } />
    {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {loading && page.items.length === 0 && <p role="status" className="text-sm text-muted-foreground">正在读取回写任务…</p>}
    {!loading && !error && page.items.length === 0 && <EmptyState title="暂无回写任务" />}
    <div className="grid gap-3" aria-busy={loading}>
      {page.items.map(job => {
        const delivery = job.eventDelivery;
        const path = `/workspace/api/publication-jobs/${job.publicationId}`;
        const failed = job.conflict || ["failed", "rejected"].includes(job.state);
        const disabled = loading || !!busy;
        return <article key={job.publicationId} aria-label={job.fileName} className="grid gap-3 rounded-[18px] border border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-all text-sm font-semibold">{job.fileName}</h2>
            <Badge variant={job.receipt ? "success" : failed ? "warning" : "muted"}>{job.conflict ? "版本冲突" : states[job.state] || job.state}</Badge>
            <time className="text-xs text-muted-foreground sm:ml-auto">{dateText(new Date(job.createdAt * 1000).toISOString())}</time>
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
            <div><dt className="text-muted-foreground">发起人</dt><dd>{job.author}</dd></div>
            <div><dt className="text-muted-foreground">工作区修订</dt><dd>r{job.revision}</dd></div>
            <div><dt className="text-muted-foreground">预期业务版本</dt><dd>{job.expectedVersion}</dd></div>
            <div><dt className="text-muted-foreground">当前业务版本</dt><dd>{job.currentVersion}</dd></div>
            {job.receipt && <div><dt className="text-muted-foreground">回执版本</dt><dd>{job.receipt.externalVersion}</dd></div>}
          </dl>
          {job.conflict && <p className="text-xs text-muted-foreground">业务文件有独立改动。可下载两份内容核对，或另存回写稿继续编辑。</p>}
          {job.error && !job.conflict && <p className="break-words text-xs text-muted-foreground">{job.error}</p>}
          {job.pending && !job.canRetry && !job.conflict && <p className="text-xs text-muted-foreground">发起人可从文档的回写菜单重试。</p>}
          {delivery.configured && <p className="text-xs text-muted-foreground">通知{delivery.delivered ? "已送达" : delivery.deadLetter ? "待人工处理" : "待送达"} · 投递 {delivery.attempts} 次</p>}
          {status?.id === job.publicationId && <p role="status" className="text-xs text-success">{status.message}</p>}
          <div className="flex flex-wrap gap-2">
            {!job.receipt && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(job, "reconcile")}>核对回执</Button>}
            {job.canRetry && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(job, "retry")}>重试原任务</Button>}
            {job.hasArtifact && <Button asChild size="sm" variant="outline"><a href={`${path}/artifact`}><Download />下载回写稿</a></Button>}
            {job.conflict && <Button asChild size="sm" variant="outline"><a href={`/workspace/api/files/${job.fileId}/download?version=${encodeURIComponent(job.currentVersion)}`}><Download />下载当前业务版</a></Button>}
            {job.canCopy && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(job, "copy")}>另存工作区副本</Button>}
            {job.copy && <Button size="sm" variant="outline" onClick={() => openFile(job.copy!.id)}><ArrowUpRight />查看已另存副本</Button>}
            {delivery.configured && !delivery.delivered && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void act(job, "event-retry")}>重试通知</Button>}
          </div>
        </article>;
      })}
    </div>
    {page.next && <Button className="self-start" variant="outline" disabled={loading || !!busy} onClick={() => void load(page.next)}>更多任务</Button>}
  </>;
}
