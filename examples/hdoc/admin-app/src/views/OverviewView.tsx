import * as React from "react";
import {
  Activity,
  ArrowUpRight,
  CircleAlert,
  Files,
  Palette,
  Upload,
} from "lucide-react";
import { PageHeader, EmptyState, LoadState } from "@/components/Page";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  FormatIcon,
  Notice,
  SectionHeading,
  StatusBadge,
} from "@/components/Workspace";
import { useCatalog } from "@/state/CatalogProvider";
import { licenseDaysLeft } from "@/lib/format";
import { activeStates, formatTime } from "@/lib/workspace";

export function OverviewView({
  onNavigate,
}: {
  onNavigate: (route: string) => void;
}) {
  const { fonts, themes, documents, jobs, runs, loaded, busy, taskWarning } =
    useCatalog();
  const [days, setDays] = React.useState(30);
  const licenses = fonts
    .flatMap((font) =>
      font.revisions.map((revision) => ({
        font,
        revision,
        left: licenseDaysLeft(revision.license),
      })),
    )
    .filter((item) => item.left !== null && item.left <= days);
  const failed = jobs.filter((job) =>
    ["failed", "interrupted"].includes(job.state),
  );
  const conflicts = runs.filter((run) =>
    ["failed", "conflict"].includes(run.status),
  );
  const activeJobs = jobs.filter((job) => activeStates.has(job.state));
  const activeRuns = runs.filter((run) => activeStates.has(run.status));
  const recent = [...(documents || [])]
    .sort((a, b) => (b.updatedAtEpochMs || 0) - (a.updatedAtEpochMs || 0))
    .slice(0, 3);
  const tasks = [
    ...activeJobs.map((job) => ({
      id: job.jobId,
      title:
        job.kind === "import"
          ? "导入文档"
          : `导出 ${job.format?.toUpperCase() || "文件"}`,
      documentId: job.documentId,
      state: job.state,
      at: job.updatedAtEpochMs,
      actor: job.actor || "—",
      route: "jobs",
    })),
    ...activeRuns.map((run) => ({
      id: run.runId,
      title: run.task,
      documentId: run.documentId,
      state: run.status,
      at: run.updatedAtEpochMs,
      actor: run.name,
      route: "agents",
    })),
  ].sort((a, b) => b.at - a.at);
  const name = (id: string) =>
    documents?.find((doc) => doc.documentId === id)?.title || id;
  return (
    <>
      <PageHeader
        title="工作空间概览"
        description="查看文档、资源和正在进行的工作。"
        actions={
          <Button onClick={() => onNavigate("jobs?import=1")}>
            <Upload />
            导入文档
          </Button>
        }
      />
      {!loaded && busy && <LoadState text="正在读取工作空间…" />}
      <section
        aria-label="工作空间指标"
        className="grid grid-cols-2 gap-y-6 py-2 lg:grid-cols-4"
      >
        {[
          {
            label: "文档总数",
            value: documents?.length ?? "—",
            hint: "DOCX / XLSX / PPTX / PDF 等",
            icon: Files,
          },
          {
            label: "进行中的任务",
            value: tasks.length,
            hint: `${activeJobs.length} 项导入导出 · ${activeRuns.length} 项 AI 任务`,
            icon: Activity,
          },
          {
            label: "品牌资源",
            value: fonts.length + themes.length,
            hint: `${fonts.length} 个字体家族 · ${themes.length} 套主题`,
            icon: Palette,
          },
          {
            label: "需要处理",
            value: licenses.length + failed.length + conflicts.length,
            hint: "许可证、导出与修订问题",
            icon: CircleAlert,
          },
        ].map((item) => (
          <div key={item.label} className="min-w-0 border-r px-5 last:border-0">
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{item.label}</span>
              <item.icon className="size-[18px] text-accent-foreground" />
            </div>
            <strong className="tabular my-3 block text-[32px] font-semibold tracking-tight">
              {item.value}
            </strong>
            <p className="text-[11px] leading-5 text-muted-foreground">
              {item.hint}
            </p>
          </div>
        ))}
      </section>
      <div className="grid gap-6 py-1 xl:grid-cols-[minmax(0,1fr)_386px]">
        <section className="min-w-0 space-y-4">
          <SectionHeading
            title="继续处理文档"
            action={
              <Button variant="ghost" onClick={() => onNavigate("documents")}>
                <ArrowUpRight />
                全部文档
              </Button>
            }
          />
          {recent.length ? (
            recent.map((doc) => (
              <button
                key={doc.documentId}
                onClick={() =>
                  onNavigate(`documents/${encodeURIComponent(doc.documentId)}`)
                }
                className="flex w-full items-center gap-3 rounded-xl py-2 text-left hover:bg-muted"
              >
                <FormatIcon format={doc.format} />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-[13px] font-medium">
                    {doc.title || doc.documentId}
                  </strong>
                  <small className="mt-1.5 block text-[11px] text-muted-foreground">
                    {formatTime(doc.updatedAtEpochMs)} · rev. {doc.revision}
                  </small>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs">
                  <ArrowUpRight className="size-4" />
                  打开
                </span>
              </button>
            ))
          ) : (
            <EmptyState
              title="还没有文档"
              description="导入第一份文档，开始你的工作。"
              action={{
                label: "导入文档",
                onClick: () => onNavigate("jobs?import=1"),
              }}
            />
          )}
        </section>
        <aside className="space-y-4 rounded-[20px] bg-muted p-5">
          <SectionHeading title="需要你留意" />
          <label className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            授权到期提醒
            <Select
              aria-label="授权提醒天数"
              className="h-8 w-28"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={30}>30 天内</option>
              <option value={60}>60 天内</option>
              <option value={90}>90 天内</option>
            </Select>
          </label>
          {licenses.slice(0, 2).map((item) => (
            <button
              key={item.revision.fontRevisionId}
              onClick={() =>
                onNavigate(
                  `fonts?search=${encodeURIComponent(item.font.fontId)}`,
                )
              }
              className="flex w-full items-start gap-2.5 text-left"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="min-w-0">
                <strong className="block text-xs font-medium">
                  {item.font.family} 授权
                  {item.left! <= 0 ? "已到期" : "即将到期"}
                </strong>
                <small className="mt-1.5 block text-[10px] text-muted-foreground">
                  {item.left! <= 0 ? "请检查授权范围" : `还有 ${item.left} 天`}
                </small>
              </span>
            </button>
          ))}
          {failed.length > 0 && (
            <button
              onClick={() => onNavigate("jobs?state=failed")}
              className="flex w-full gap-2.5 text-left text-xs"
            >
              <CircleAlert className="size-4 shrink-0 text-destructive" />
              <span>{failed.length} 项导入导出需要处理</span>
            </button>
          )}
          {conflicts.length > 0 && (
            <button
              onClick={() => onNavigate("agents?state=failed")}
              className="flex w-full gap-2.5 text-left text-xs"
            >
              <CircleAlert className="size-4 shrink-0 text-warning" />
              <span>{conflicts.length} 项 AI 任务需要检查</span>
            </button>
          )}
          {!licenses.length && !failed.length && !conflicts.length && (
            <p className="py-3 text-xs leading-6 text-muted-foreground">
              当前没有需要处理的事项。
            </p>
          )}
        </aside>
      </div>
      <hr className="my-1" />
      <SectionHeading
        title="当前任务"
        action={
          <Button variant="ghost" onClick={() => onNavigate("jobs")}>
            <ArrowUpRight />
            任务中心
          </Button>
        }
      />
      {taskWarning && (
        <Notice title="部分任务数据未能完整读取" warning>
          {taskWarning}
        </Notice>
      )}
      {tasks.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>任务</TableHead>
              <TableHead>文档</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>发起人</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.slice(0, 5).map((task) => (
              <TableRow key={task.id}>
                <TableCell className="max-w-60">
                  <span className="block truncate font-medium">
                    {task.title}
                  </span>
                  <small className="mt-1 block text-[10px] text-muted-foreground">
                    {formatTime(task.at)}
                  </small>
                </TableCell>
                <TableCell className="max-w-60 truncate text-muted-foreground">
                  {name(task.documentId)}
                </TableCell>
                <TableCell>
                  <StatusBadge state={task.state} />
                </TableCell>
                <TableCell>{task.actor}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() => onNavigate(task.route)}
                  >
                    查看
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <EmptyState
          title="当前没有进行中的任务"
          description="导入、导出或 AI 处理开始后，状态会显示在这里。"
        />
      )}
    </>
  );
}
