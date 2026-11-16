import * as React from "react";
import { ArrowUpRight, RefreshCw, Sparkles, Square } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/Page";
import {
  DocumentConnection,
  Notice,
  SectionHeading,
  StatusBadge,
} from "@/components/Workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCatalog } from "@/state/CatalogProvider";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import {
  activeStates,
  documentApi,
  formatTime,
  openEditor,
} from "@/lib/workspace";
import { cn } from "@/lib/utils";

function eventText(event: Record<string, unknown>): string {
  if (typeof event.message === "string") return event.message;
  const labels: Record<string, string> = {
    thinking: "分析任务",
    tool: "执行文档操作",
    tool_result: "操作结果",
    replan: "检测到协作冲突，重新读取并规划",
    verify: "核验已提交内容",
    started: "任务开始",
    completed: "任务完成",
    error: "执行遇到问题",
    interrupted: "服务重启，任务已中断",
  };
  const label =
    labels[String(event.type)] || String(event.type || "任务状态更新");
  return `${label}${typeof event.name === "string" ? ` · ${event.name}` : ""}${typeof event.revision === "number" ? ` · rev. ${event.revision}` : ""}${typeof event.error === "string" ? ` · ${event.error}` : ""}${event.ok === false ? " · 未完成" : ""}`;
}

export function AgentRunsView({
  initialFilter = "all",
  onNavigate,
}: {
  initialFilter?: string;
  onNavigate: (route: string) => void;
}) {
  const { runs, service, taskWarning, refreshTasks } = useCatalog();
  const [filter, setFilter] = React.useState(initialFilter);
  const [search, setSearch] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const rows = runs.filter(
    (run) =>
      (filter === "all" ||
        (filter === "active"
          ? activeStates.has(run.status)
          : run.status === filter)) &&
      `${run.name} ${run.task} ${run.documentId}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const selected = runs.find((run) => run.runId === selectedId) || rows[0];
  const stop = () => {
    if (!selected) return;
    const run = selected;
    confirm({
      title: "停止这个 AI 任务？",
      description:
        "已提交的修订会保留，停止后续模型调用和写入。需要任务发起人的文档写入令牌。",
      confirmLabel: "停止后续执行",
      onConfirm: async () => {
        const auth = await documentApi.auth(run.documentId);
        if (auth.scope !== "write")
          throw new Error("请连接任务发起人的文档写入令牌。");
        await documentApi.cancelRun(run.documentId, run.runId);
        toast.push("已请求停止；已提交的修订保留。", "ok");
        await refreshTasks();
      },
    });
  };
  return (
    <>
      <PageHeader
        title="AI 任务"
        description="查看执行步骤、任务成员与实际提交的文档修订。"
        actions={
          <>
            <Button variant="outline" onClick={() => void refreshTasks()}>
              <RefreshCw />
              刷新
            </Button>
            <Button onClick={() => void openEditor().catch(toast.err)}>
              <Sparkles />
              前往编辑器发起
            </Button>
          </>
        }
      />
      <Notice
        title={
          service?.agentAvailable
            ? `AI 服务已配置${service.agentModel ? ` · ${service.agentModel}` : ""}`
            : "AI 服务尚未配置"
        }
      >
        {service?.agentAvailable
          ? "任务与执行记录保存在服务目录中，当前展示最近任务。服务重启后执行中的任务会标为已中断，保留已提交修订；请核对后仅发起剩余工作。"
          : "在服务端配置模型与 API 凭证后，可从文档编辑器发起任务。"}
      </Notice>
      <div className="flex flex-wrap gap-2">
        {[
          ["all", "全部任务"],
          ["active", "进行中"],
          ["completed", "已完成"],
          ["failed", "失败"],
          ["cancelled", "已停止"],
          ["interrupted", "已中断"],
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
        <Input
          aria-label="搜索 AI 任务"
          className="w-full sm:ml-auto sm:w-64"
          placeholder="搜索任务或文档"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {taskWarning && (
        <Notice title="记录读取提示" warning>
          {taskWarning}
        </Notice>
      )}
      {rows.length ? (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.4fr)]">
          <div className="grid gap-3">
            {rows.map((run) => (
              <button
                type="button"
                key={run.runId}
                onClick={() => setSelectedId(run.runId)}
                aria-pressed={selected?.runId === run.runId}
                className={cn(
                  "min-w-0 space-y-3 rounded-[18px] p-5 text-left",
                  selected?.runId === run.runId ? "bg-accent" : "bg-muted",
                )}
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-sm">{run.name || "文档任务"}</strong>
                  <StatusBadge state={run.status} />
                </span>
                <span className="line-clamp-2 block text-xs leading-6 text-muted-foreground">
                  {run.task}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {run.documentId} · {formatTime(run.updatedAtEpochMs)}
                </span>
              </button>
            ))}
          </div>
          {selected && (
            <section className="min-w-0 space-y-5 rounded-[20px] bg-muted p-5 lg:p-6">
              <SectionHeading
                title={selected.name || "任务详情"}
                action={<StatusBadge state={selected.status} />}
              />
              <p className="whitespace-pre-wrap break-words text-xs leading-7">
                {selected.task}
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-3 text-xs">
                <dt className="text-muted-foreground">目标文档</dt>
                <dd className="break-all">{selected.documentId}</dd>
                <dt className="text-muted-foreground">执行模型</dt>
                <dd>{selected.model}</dd>
                <dt className="text-muted-foreground">任务成员</dt>
                <dd>{selected.agentCount} 位</dd>
                <dt className="text-muted-foreground">开始时间</dt>
                <dd>{formatTime(selected.createdAtEpochMs)}</dd>
              </dl>
              {selected.team?.units?.map((member, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between rounded-xl bg-card p-3 text-xs"
                >
                  <span>{member.title}</span>
                  {member.status && <StatusBadge state={member.status} />}
                </div>
              ))}
              <SectionHeading title="执行记录" />
              <ol className="space-y-3">
                {selected.events.map((event, index) => (
                  <li key={index} className="flex gap-3 text-xs leading-6">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-accent text-[10px] text-accent-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="break-words">{eventText(event)}</p>
                      {typeof event.at === "number" && (
                        <p className="text-[10px] text-muted-foreground">
                          {formatTime(event.at)}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {!selected.events.length && (
                <p className="text-xs text-muted-foreground">尚无执行步骤。</p>
              )}
              {selected.result && (
                <Notice title="执行结果">
                  <p className="whitespace-pre-wrap">{selected.result}</p>
                </Notice>
              )}
              <SectionHeading title="实际提交修订" />
              <div className="flex flex-wrap gap-2">
                {selected.committedRevisions.length ? (
                  selected.committedRevisions.map((revision) => (
                    <Button
                      key={revision}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onNavigate(
                          `documents/${encodeURIComponent(selected.documentId)}?revision=${revision}`,
                        )
                      }
                    >
                      rev. {revision}
                      <ArrowUpRight />
                    </Button>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    本任务尚未提交文档修订。
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 border-t pt-5">
                <Button
                  variant="outline"
                  onClick={() =>
                    onNavigate(
                      `documents/${encodeURIComponent(selected.documentId)}`,
                    )
                  }
                >
                  <ArrowUpRight />
                  查看文档核验
                </Button>
                {activeStates.has(selected.status) && (
                  <>
                    <DocumentConnection documentId={selected.documentId} />
                    <Button variant="outline" onClick={stop}>
                      <Square />
                      停止任务
                    </Button>
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      ) : (
        <EmptyState
          icon={Sparkles}
          title="还没有符合条件的 AI 任务"
          description="从文档编辑器发起任务后，这里会显示真实执行记录和提交修订。"
          action={{ label: "查看文档", onClick: () => onNavigate("documents") }}
        />
      )}
      {node}
    </>
  );
}
