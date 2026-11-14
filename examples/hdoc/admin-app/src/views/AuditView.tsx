import * as React from "react";
import { Download, History, Info, ScrollText } from "lucide-react";

import { EmptyState, LoadState, PageHeader, Toolbar } from "@/components/Page";
import { IdChip } from "@/components/IdChip";
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
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api, ApiError } from "@/lib/api";
import { auditCsv, auditCsvName, downloadText } from "@/lib/csv";
import {
  AUDIT_GROUP_NAMES,
  type AuditGroup,
  auditActionName,
  auditGroup,
  auditTone,
  formatDateTime,
  utcDay,
} from "@/lib/format";
import type { AuditPage } from "@/lib/types";

const LIMITS = [50, 100, 500];

/**
 * Inclusive UTC-day windows worth a click. The counts match the label: 近 7 天
 * is today plus the six days before it, because the log rotates by whole UTC
 * days and a caller asking for "this week" means seven of them.
 */
const RANGES = [
  { key: "today", label: "今天", from: 0, to: 0 },
  { key: "week", label: "近 7 天", from: 6, to: 0 },
  { key: "month", label: "近 30 天", from: 29, to: 0 },
  { key: "all", label: "全部", from: null, to: null },
];

type Filter = "all" | AuditGroup;

/** Catalog targets are ids; a digest gets the copy chip, a name stays readable. */
const DIGEST = /^[0-9a-f]{64}$/;

function TargetCell({ value }: { value: string }) {
  const slash = value.indexOf("/");
  const fontId = slash > 0 ? value.slice(0, slash) : null;
  const rest = fontId === null ? value : value.slice(slash + 1);
  if (!DIGEST.test(rest)) {
    return <code className="text-xs">{value}</code>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {fontId !== null ? <code className="text-xs">{fontId}/</code> : null}
      <IdChip value={rest} keep={10} />
    </span>
  );
}

export function AuditView() {
  const toast = useToast();
  const [page, setPage] = React.useState<AuditPage | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  // Set when this `hdoc serve` has no log route at all, which is different from
  // a log that happens to be empty.
  const [missing, setMissing] = React.useState(false);
  const [limit, setLimit] = React.useState(100);
  // Inclusive UTC days, "" for open. Deliberately not a Date: the route takes
  // the day name as written, and a half-typed picker value must not become a
  // request.
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      setPage(await api.audit({ limit, from, to }));
      setMissing(false);
    } catch (cause) {
      // 404 is a build with no log route at all. A 400 only means the same when
      // nothing was asked for beyond a limit; with a window in play it is the
      // server refusing a bound, and that message names the bound, so it has to
      // reach the operator instead of being filed as "no log here".
      if (cause instanceof ApiError && cause.status === 404) {
        setMissing(true);
        setPage(null);
      } else if (cause instanceof ApiError && cause.status === 400 && !from && !to) {
        setMissing(true);
        setPage(null);
      } else {
        toast.err(cause);
      }
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, [toast, limit, from, to]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * True when a window was asked for and the answer does not show one. An older
   * `hdoc serve` ignores `from` and `to` and returns the newest lines, which
   * must not be read as the requested week.
   */
  const windowIgnored =
    Boolean(from.trim() || to.trim()) &&
    page !== null &&
    ((page.from ?? null) !== (from.trim() || null) ||
      (page.to ?? null) !== (to.trim() || null));

  const rows = React.useMemo(() => {
    const entries = page?.entries ?? [];
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filter !== "all" && auditGroup(entry.action) !== filter) return false;
      if (!needle) return true;
      return [entry.action, entry.target, entry.actor, entry.detail ?? ""]
        .join("\n")
        .toLowerCase()
        .includes(needle);
    });
  }, [page, filter, query]);

  const counts = React.useMemo(() => {
    const byGroup: Record<AuditGroup, number> = { font: 0, theme: 0, document: 0 };
    for (const entry of page?.entries ?? []) {
      const group = auditGroup(entry.action);
      if (group) byGroup[group] += 1;
    }
    return byGroup;
  }, [page]);

  return (
    <>
      <PageHeader
        title="操作记录"
        description="这台机器上的目录变更留痕：谁上传了字库、谁退役或删除了主题、谁把主题钉到了哪个文档上，按时间倒序。"
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!rows.length}
              title="导出页面上筛选后的这些行，含被日期区间挡在外面的部分不导出"
              onClick={() => {
                downloadText(auditCsvName(from, to, rows.length), auditCsv(rows));
                toast.push(
                  page?.truncated
                    ? `已导出 ${rows.length} 行；区间里还有更早的记录没列出，缩小日期再导一次`
                    : `已导出 ${rows.length} 行，和页面筛选一致`,
                  page?.truncated ? "warn" : "ok",
                );
              }}
            >
              <Download />
              导出 CSV
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
              <History className={busy ? "animate-spin" : undefined} />
              重新读取
            </Button>
          </>
        }
      />

      {missing ? (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <Info className="size-4" />
                这份 hdoc serve 还没有操作记录接口
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            升级到这个仓库的构建后，<code className="font-mono">GET /v1/catalog/audit</code>{" "}
            会按天倒序读出 <code className="font-mono">{"{目录}/audit/"}</code> 里追加的记录；
            老的构建不会写这个日志，也不会在页面上显示。
          </CardContent>
        </Card>
      ) : null}

      {page && page.unreadable > 0 ? (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <Info className="size-4" />
                另有 {page.unreadable} 行没能读成记录
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            可能是写入中断留下的半行，也可能某一天的记录超过了 4 MiB、被截掉了最前面一段。
            所以这一页列出的不是完整历史；原始行仍然留在{" "}
            <code className="font-mono">{"audit/<UTC 日期>.jsonl"}</code> 里，可以自己去查。
          </CardContent>
        </Card>
      ) : null}

      {page?.truncated ? (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <Info className="size-4" />
                区间里还有更早的记录没列出
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            服务端一次最多读 {Math.max(...LIMITS)} 条，这一页在读满 {page.limit} 条时停下，停下之处仍在
            当前日期区间内：下面的列表不是这个区间的全部。把区间缩小到几天，或者用
            <code className="font-mono"> curl </code>
            直接查 <code className="font-mono">{"audit/<UTC 日期>.jsonl"}</code>。
            导出的 CSV 同样只含这一页。
          </CardContent>
        </Card>
      ) : null}

      {windowIgnored ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>
              <span className="inline-flex items-center gap-2">
                <Info className="size-4" />
                这份 hdoc serve 不认日期区间
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            页面要求了 <code className="font-mono">{from.trim() || "不限"}</code> 到{" "}
            <code className="font-mono">{to.trim() || "不限"}</code>，但回答里没有带回来，
            所以这多半是老构建：它会忽略 <code className="font-mono">from</code> 和{" "}
            <code className="font-mono">to</code>，只给出最近的 {page?.limit} 条。
            这些记录不能当成你选的那段时间。升级到接受区间的路由后重新读取。
          </CardContent>
        </Card>
      ) : null}

      <Toolbar>
        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground" htmlFor="audit-from">
            起
          </Label>
          <Input
            id="audit-from"
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="h-7 w-40 text-xs"
          />
          <Label className="text-xs text-muted-foreground" htmlFor="audit-to">
            止
          </Label>
          <Input
            id="audit-to"
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="h-7 w-40 text-xs"
          />
        </div>
        <div className="flex items-center gap-1">
          {RANGES.map((range) => {
            const bounds =
              range.from === null
                ? { from: "", to: "" }
                : { from: utcDay(range.from), to: utcDay(range.to) };
            return (
              <Button
                key={range.key}
                size="sm"
                variant={from === bounds.from && to === bounds.to ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setFrom(bounds.from);
                  setTo(bounds.to);
                }}
              >
                {range.label}
              </Button>
            );
          })}
        </div>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索对象、操作者或详情"
          className="h-7 w-64 text-xs"
        />
        <Select
          aria-label="记录类别"
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
          className="h-7 w-36 text-xs"
        >
          <option value="all">全部记录</option>
          <option value="font">{AUDIT_GROUP_NAMES.font}（{counts.font}）</option>
          <option value="theme">{AUDIT_GROUP_NAMES.theme}（{counts.theme}）</option>
          <option value="document">{AUDIT_GROUP_NAMES.document}（{counts.document}）</option>
        </Select>
        <Select
          aria-label="读取条数"
          value={String(limit)}
          onChange={(event) => setLimit(Number(event.target.value))}
          className="h-7 w-32 text-xs"
        >
          {LIMITS.map((value) => (
            <option key={value} value={value}>
              {from || to ? `本页最多 ${value} 条` : `最近 ${value} 条`}
            </option>
          ))}
        </Select>
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {!loaded
            ? "读取中…"
            : page === null
              ? "读不到记录"
              : `${rows.length} / ${page.entries.length} 条 · ${
                  from || to
                    ? `${from.trim() || "最早"} 日起到 ${to.trim() || "今天"} 止（UTC）· 本页 ${page.limit} 条`
                    : `服务端上限 ${page.limit} 条`
                }`}
        </span>
      </Toolbar>

      {!loaded ? <LoadState text="正在读取操作记录…" /> : null}

      {loaded && page !== null && rows.length === 0 ? (
        <div className="rounded-xl border bg-card shadow-xs">
          <EmptyState
            icon={ScrollText}
            title={
              page.entries.length
                ? "没有符合条件的记录"
                : from || to
                  ? "这个日期区间里没有记录"
                  : "还没有操作记录"
            }
            description={
              page.entries.length
                ? "换个类别，或清空搜索词。"
                : from || to
                  ? `按 UTC 整天算，${
                      from.trim() || "最早"
                    } 到 ${
                      to.trim() || "今天"
                    } 之间这台机器没有做完的目录变更。区间是闭区间，两端那天都算。`
                  : "上传字库、保存主题或给文档钉版之后，回到这一页就看得见。被拒绝的请求不写记录。"
            }
          />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">时间</TableHead>
                <TableHead>动作</TableHead>
                <TableHead>对象</TableHead>
                <TableHead>操作者</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((entry, index) => (
                <TableRow key={`${entry.at}-${index}`}>
                  <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">
                    {formatDateTime(entry.at)}
                  </TableCell>
                  <TableCell>
                    {/* The raw id stays in the tooltip: the log file is the record,
                        and this page only names it. */}
                    <Badge variant={auditTone(entry.action)} title={entry.action}>
                      {auditActionName(entry.action)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <TargetCell value={entry.target} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{entry.actor}</TableCell>
                  <TableCell className="whitespace-normal text-xs text-muted-foreground">
                    {entry.detail || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>记录写了什么，什么时候不写</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-xs text-muted-foreground">
          <p>
            记的是这个服务通过接口做完的变更：存入字库、登记或删除字体修订、保存主题、退役或
            取消退役、彻底删除主题、给文档钉上主题或取消钉版。每条都带操作者：令牌里写了{" "}
            <code className="font-mono">--display-name</code> 和 <code className="font-mono">--user-id</code>{" "}
            就显示名字，否则显示凭证类型，例如 <code className="font-mono">admin:*</code>。
          </p>
          <p>
            被拒绝的请求（没有令牌、权限不对、字体还被主题引用）不写记录：什么都没改。
            重复钉同一个主题、重复退役已经退役的主题，修订没有动，也不写；
            但「再退役一次」这类仍会留一条，并在详情里写明本次没有改变。
          </p>
          <p>
            记录是追加写的，按 UTC 日期分成 <code className="font-mono">{"audit/<日期>.jsonl"}</code>，
            没有改和删的接口。写入失败时这个请求会被报成失败（500），所以「改了目录却没留痕」
            不会悄悄发生。唯一的例外是导入时按 <code className="font-mono">--default-theme</code>{" "}
            自动钉版：主题已经钉上了，记录写不进去只在这个导入任务的 warnings 里说一句。
          </p>
          <p>
            日期区间按 <strong className="font-medium">UTC 整天</strong>计，闭区间：起和止那天都算进去，
            因为日志文件就是按 UTC 日期切的。止填了未来的一天不会多读出什么，起晚于止会被服务端拒绝
            （400），不会当成空区间回答「那几天什么都没发生」。空着的边界就是不设限。
          </p>
          <p>
            导出的 CSV 是页面上筛出来的这些行，顺序和表格一致，不是重新读一次：列是时间（UTC ISO
            8601）、动作原始名、动作中文名、对象、操作者、详情，带 BOM 以便 Excel 和 WPS 不乱码。
            以 <code className="font-mono">= + - @</code> 或制表符开头的值会加一个前导单引号，
            免得电子表格把它当公式执行；用文本工具直接读会看见这个引号。区间被本页上限截断时，
            CSV 同样只是这一页 —— 上面那张警告卡会说。
          </p>
          <pre className="tabular overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11px]">
{`curl -H "Authorization: Bearer <管理令牌>" \\
  "http://127.0.0.1:8791/v1/catalog/audit?limit=50"

# 上周（UTC 闭区间，两端都算）
curl -H "Authorization: Bearer <管理令牌>" \\
  "http://127.0.0.1:8791/v1/catalog/audit?from=2026-11-02&to=2026-11-08"`}
          </pre>
        </CardContent>
      </Card>
    </>
  );
}
