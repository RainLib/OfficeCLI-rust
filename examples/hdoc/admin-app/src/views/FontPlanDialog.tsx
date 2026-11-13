import * as React from "react";
import { AlertTriangle, ScanSearch } from "lucide-react";

import { EmptyState, LoadState } from "@/components/Page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, api } from "@/lib/api";
import { EXPORT_KIND_NAMES, EXPORT_KINDS, formatBytes, slotName } from "@/lib/format";
import type { ExportKind, FontPlan } from "@/lib/types";

/**
 * What an export would carry, face by face, before anyone runs the export.
 *
 * The server answers from the catalog records and never streams a font, so this
 * stays cheap enough to open from a table row — and it keeps answering when the
 * bytes themselves cannot be read, which is when the question usually gets
 * asked. Every `reason` is the sentence the export report writes, and so is the
 * note for a license that is about to run out: the file is fine today, and the
 * banner says for how long.
 */
export function FontPlanDialog({
  open,
  onOpenChange,
  documentId,
  headRevision,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
  headRevision: number;
}) {
  const [kind, setKind] = React.useState<ExportKind>("docx");
  const [revisionText, setRevisionText] = React.useState("");
  const [plan, setPlan] = React.useState<FontPlan | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  // Asking the same question again is a thing operators do: they pin a theme,
  // close the dialog, and want the same answer re-read. The effect below
  // watches values, so a repeat needs a number that moves.
  const [nonce, setNonce] = React.useState(0);

  // An empty box means the head. A number means that revision, which is the one
  // a file already downloaded was produced from.
  const trimmed = revisionText.trim();
  const revision = trimmed === "" ? undefined : Number(trimmed);
  const badRevision = revision !== undefined && (!Number.isInteger(revision) || revision < 0);

  React.useEffect(() => {
    if (!open || badRevision) return;
    let cancelled = false;
    setLoading(true);
    api
      .fontPlan(documentId, kind, revision)
      .then((answer) => {
        if (cancelled) return;
        setPlan(answer);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setPlan(null);
        setError(
          cause instanceof ApiError && cause.status === 404
            ? "这份 hdoc serve 还没有字体体检接口；升级到本仓库的构建后 GET /v1/documents/<id>/font-plan 才有。"
            : cause instanceof Error
              ? cause.message
              : "体检失败",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, documentId, kind, revision, badRevision, nonce]);

  const embedded = plan?.entries.filter((entry) => entry.embeds).length ?? 0;
  // One license covers every face of a revision, so the same sentence can come
  // back for Regular and Bold alike; the operator needs to hear it once.
  const due = React.useMemo(() => {
    const seen: string[] = [];
    for (const entry of plan?.entries ?? []) {
      if (entry.warning && !seen.includes(entry.warning)) seen.push(entry.warning);
    }
    return seen;
  }, [plan]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(880px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>字体落地体检</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{documentId}</code>{" "}
            导出成下面的格式时，每个字面是把字节写进文件，还是只登记字体名。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="plan-kind">导出格式</Label>
            <Select
              id="plan-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as ExportKind)}
              className="w-44"
            >
              {EXPORT_KINDS.map((option) => (
                <option key={option} value={option}>
                  {EXPORT_KIND_NAMES[option]}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="plan-revision">修订号</Label>
            <Input
              id="plan-revision"
              value={revisionText}
              placeholder={`head（r${headRevision}）`}
              onChange={(event) => setRevisionText(event.target.value)}
              className="w-36"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={loading || badRevision}
            onClick={() => setNonce((current) => current + 1)}
          >
            重新体检
          </Button>
        </div>

        {badRevision ? <p className="text-xs text-destructive">修订号要写非负整数，留空表示 head。</p> : null}

        {loading && !plan ? <LoadState text="正在按目录记录回答…" /> : null}

        {error ? (
          <EmptyState icon={ScanSearch} title="体检没有答上来" description={error} />
        ) : null}

        {plan && !loading && plan.entries.length === 0 ? (
          <EmptyState
            icon={ScanSearch}
            title={
              plan.themeRevisionId
                ? "这个修订钉了主题，但解析不出字面"
                : `r${plan.revision} 没有钉主题`
            }
            description={
              plan.themeRevisionId
                ? "主题的槽位全留空，导出用文档自己的字体。回主题页把槽位钉上，再存一个新主题。"
                : "这个修订不指向任何目录主题：导出用文档自带的字体，不写目录字库。要按品牌走就在「文档」里钉上主题。"
            }
          />
        ) : null}

        {plan && plan.entries.length > 0 ? (
          <>
            {due.length ? (
              <div className="grid gap-1 rounded-lg border border-warning/40 bg-warning/5 p-3">
                <p className="flex items-center gap-2 text-xs font-medium text-warning">
                  <AlertTriangle className="size-4" />
                  {due.length} 个字面的许可证将在 {plan.licenseWarnWindowDays} 天内到期
                </p>
                {due.map((warning) => (
                  <p key={warning} className="text-[11px] text-muted-foreground">
                    {warning}
                  </p>
                ))}
                <p className="text-[11px] text-muted-foreground">
                  这几天里导出照常写入字库字节，过了那一天就只登记字体名。趁还能嵌，换字面或续许可证。
                </p>
              </div>
            ) : null}
            <div className="max-h-[50vh] overflow-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>槽位</TableHead>
                    <TableHead>字族 · 字面</TableHead>
                    <TableHead>格式</TableHead>
                    <TableHead className="text-right">大小</TableHead>
                    <TableHead>落地方式</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.entries.map((entry) => (
                    <TableRow
                      key={`${entry.sha256}-${entry.weight}-${entry.style}-${entry.subfamily}`}
                    >
                      <TableCell className="whitespace-normal text-xs">
                        {entry.slots.map(slotName).join("、")}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <span className="text-xs">{entry.family}</span>{" "}
                        <span className="text-xs text-muted-foreground">
                          {entry.subfamily} {entry.weight} {entry.style}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{entry.format}</Badge>
                      </TableCell>
                      <TableCell
                        className="tabular text-right text-xs"
                        title={`${entry.byteLength.toLocaleString("en-US")} 字节 · ${entry.sha256}`}
                      >
                        {formatBytes(entry.byteLength)}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {entry.embeds ? (
                          <Badge variant="success">写入字库字节</Badge>
                        ) : (
                          <Badge variant="warning">只登记名字</Badge>
                        )}
                        {entry.reason ? (
                          <p className="mt-1 text-xs text-muted-foreground">{entry.reason}</p>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              {EXPORT_KIND_NAMES[plan.kind]} 从 r{plan.revision} 导出时，{embedded} /{" "}
              {plan.entries.length} 个字面会把字节写进文件，其余只登记名字，正文按回退族显示。
            </p>
          </>
        ) : null}

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <p className="max-w-[52ch] text-xs text-muted-foreground">
            原因来自导出用的同一个判断，两处不会各说一套。体检不读字库字节，所以字库暂时读不出来时这里照样回答；那种情况导出会直接报错，不会静默少一个字体。
          </p>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
