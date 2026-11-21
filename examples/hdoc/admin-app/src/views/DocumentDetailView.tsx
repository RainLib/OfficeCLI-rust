import * as React from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Eye,
  RefreshCw,
  RotateCcw,
  ScanSearch,
} from "lucide-react";
import { PageHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";
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
  DocumentConnection,
  Notice,
  SectionHeading,
  StatusBadge,
} from "@/components/Workspace";
import { DocumentPreview } from "@/components/DocumentPreview";
import { ExportDialog } from "@/components/ExportDialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useCatalog } from "@/state/CatalogProvider";
import { api, ApiError } from "@/lib/api";
import {
  documentApi,
  formatTime,
  openEditor,
  useDocumentToken,
} from "@/lib/workspace";
import type { DocumentAccess, RevisionRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FontPlanDialog } from "./FontPlanDialog";

export function DocumentDetailView({
  documentId,
  initialRevision,
  onNavigate,
}: {
  documentId: string;
  initialRevision?: number;
  onNavigate: (route: string) => void;
}) {
  const { documents, themes, retired, refresh } = useCatalog();
  const doc = documents?.find((item) => item.documentId === documentId);
  const token = useDocumentToken(documentId);
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const [access, setAccess] = React.useState<DocumentAccess | null>(null);
  const [revisions, setRevisions] = React.useState<RevisionRecord[]>([]);
  const [head, setHead] = React.useState(doc?.revision ?? 0);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [before, setBefore] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [tab, setTab] = React.useState("revisions");
  const [theme, setTheme] = React.useState("");
  const [plan, setPlan] = React.useState(false);
  const [restore, setRestore] = React.useState(false);
  const [expected, setExpected] = React.useState(0);
  const [confirmed, setConfirmed] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [restoreError, setRestoreError] = React.useState("");
  const sequence = React.useRef(0);
  React.useEffect(
    () => setSelected(initialRevision ?? null),
    [initialRevision],
  );
  const load = React.useCallback(async () => {
    const current = ++sequence.current;
    if (!token) {
      setAccess(null);
      setRevisions([]);
      setSelected(null);
      setError("");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [auth, history] = await Promise.all([
        documentApi.auth(documentId),
        documentApi.revisions(documentId),
      ]);
      if (current !== sequence.current) return;
      setAccess(auth);
      setRevisions([...history.revisions].reverse());
      setHead(history.headRevision);
      setBefore(history.nextBefore);
      setSelected(
        (previous) =>
          previous ??
          (initialRevision !== undefined &&
          initialRevision <= history.headRevision
            ? initialRevision
            : history.headRevision),
      );
    } catch (cause) {
      if (current === sequence.current) {
        setAccess(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [documentId, token, initialRevision]);
  React.useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  const loadMore = async () => {
    if (before === null || loading) return;
    setLoading(true);
    try {
      const result = await documentApi.revisions(documentId, before);
      setRevisions((previous) =>
        [
          ...new Map(
            [...previous, ...result.revisions].map((item) => [
              item.revision,
              item,
            ]),
          ).values(),
        ].sort((a, b) => b.revision - a.revision),
      );
      setBefore(result.nextBefore);
    } catch (cause) {
      toast.err(cause);
    } finally {
      setLoading(false);
    }
  };
  const changeTheme = () =>
    confirm({
      title: theme === "__none" ? "取消文档主题？" : "指定这套文档主题？",
      confirmLabel: "确认并创建新修订",
      description:
        "主题固定到所选修订，正文和节点保持原样。管理员可执行此操作。",
      onConfirm: async () => {
        const result = await api.pinDocumentTheme(
          documentId,
          theme === "__none" ? null : theme,
          doc?.revision,
        );
        toast.push(`主题已更新 · rev. ${result.revision}`, "ok");
        setTheme("");
        setSelected(result.revision);
        await refresh();
        await load();
      },
    });
  const doRestore = async () => {
    if (selected === null || !confirmed || restoring) return;
    setRestoring(true);
    setRestoreError("");
    try {
      const auth = await documentApi.auth(documentId);
      if (auth.scope !== "write")
        throw new Error("恢复修订需要此文档的写入令牌。");
      const result = await documentApi.restore(
        documentId,
        selected,
        expected,
        auth.collaborationEpoch,
      );
      toast.push(
        `已恢复并创建 rev. ${result.revision}，历史修订均保留。`,
        "ok",
      );
      setRestore(false);
      setSelected(result.revision);
      await refresh();
      await load();
    } catch (cause) {
      setRestoreError(
        cause instanceof ApiError && cause.status === 409
          ? "文档已有新修订。请查看最新状态后重新决定；当前选择已保留。"
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    } finally {
      setRestoring(false);
    }
  };
  return (
    <>
      <PageHeader
        title="文档详情与修订"
        description={
          <span className="break-all">
            文档管理 / {doc?.title || documentId}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => onNavigate("documents")}>
              <ArrowLeft />
              返回文档
            </Button>
            <DocumentConnection documentId={documentId} />
            {access && (
              <Button
                onClick={() => void openEditor(documentId).catch(toast.err)}
              >
                <ArrowUpRight />
                打开编辑器
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-foreground">
          {doc?.format.toUpperCase() || "文档"}
        </span>
        <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
          {documentId}
        </span>
        {doc && <StatusBadge state={doc.state} />}
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新修订"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
        {access && selected !== null && (
          <ExportDialog documentId={documentId} revision={selected} />
        )}
      </div>
      {!token && (
        <Notice title="连接文档令牌，查看内容与修订">
          后台管理令牌可查看目录和指定主题。查看文档内容需要此文档的只读或写入令牌，恢复历史需要写入权限。
        </Notice>
      )}
      {error && (
        <Notice title="文档访问未能加载" warning>
          {error}
        </Notice>
      )}
      <div className="grid min-h-[620px] flex-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_370px]">
        <div className="min-w-0 self-stretch">
          {access && selected !== null ? (
            <DocumentPreview
              documentId={documentId}
              revision={selected}
              format={doc?.format || ""}
            />
          ) : (
            <div className="flex h-full min-h-96 flex-col items-center justify-center gap-5 rounded-[20px] bg-muted p-8 text-center">
              <Eye className="size-9 text-muted-foreground" />
              <p className="text-sm font-medium">
                {loading ? "正在读取文档权限…" : "预览与内容访问独立授权"}
              </p>
              <p className="max-w-sm text-xs leading-6 text-muted-foreground">
                连接后，可以在这里预览当前内容和历史版本，不会创建内容修订。
              </p>
              <DocumentConnection documentId={documentId} />
            </div>
          )}
        </div>
        <aside className="flex h-full min-w-0 flex-col gap-5">
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            {[
              ["revisions", "修订记录"],
              ["info", "文档信息"],
            ].map(([key, label]) => (
              <Button
                key={key}
                variant="ghost"
                className={cn(
                  "flex-1",
                  tab === key && "bg-card text-accent-foreground shadow-xs",
                )}
                onClick={() => setTab(key)}
              >
                {label}
              </Button>
            ))}
          </div>
          {tab === "revisions" ? (
            <>
              <SectionHeading title="修订历史" />
              {revisions.map((record) => (
                <button
                  key={record.revision}
                  type="button"
                  onClick={() => setSelected(record.revision)}
                  aria-pressed={selected === record.revision}
                  className={cn(
                    "space-y-2 rounded-[14px] p-4 text-left",
                    selected === record.revision ? "bg-accent" : "bg-muted",
                  )}
                >
                  <span className="flex items-center justify-between">
                    <strong
                      className={cn(
                        "text-xs",
                        selected === record.revision &&
                          "text-accent-foreground",
                      )}
                    >
                      rev. {record.revision}
                    </strong>
                    <span className="text-[10px] text-muted-foreground">
                      {record.revision === head ? "当前版本" : "查看版本 ↗"}
                    </span>
                  </span>
                  <span className="block text-xs">
                    {record.patchId?.startsWith("restore")
                      ? "恢复历史内容"
                      : record.patchId
                        ? "内容或主题更新"
                        : "文档初始版本"}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">
                    {record.authorName || record.authorId || "未记录作者"} ·{" "}
                    {formatTime(record.createdAtEpochMs)}
                  </span>
                </button>
              ))}
              {access && before !== null && (
                <Button
                  variant="ghost"
                  disabled={loading}
                  onClick={() => void loadMore()}
                >
                  加载更多修订
                </Button>
              )}
              {!access && (
                <p className="text-xs leading-6 text-muted-foreground">
                  连接文档后加载修订记录。
                </p>
              )}
              <div className="mt-auto space-y-4 pt-3">
                <Notice title="恢复时保留完整历史">
                  恢复旧版本会创建一个新修订；执行前会检查文档最新状态。
                </Notice>
                {access && selected !== null && selected !== head && (
                  <Button
                    className="w-full"
                    disabled={access.scope !== "write"}
                    onClick={() => {
                      setExpected(head);
                      setConfirmed(false);
                      setRestoreError("");
                      setRestore(true);
                    }}
                  >
                    <RotateCcw />
                    {access.scope === "write"
                      ? `恢复 rev. ${selected}`
                      : "只读权限无法恢复"}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <SectionHeading title="文档与主题" />
              <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-5 rounded-2xl bg-muted p-5 text-xs">
                <dt className="text-muted-foreground">格式</dt>
                <dd>{doc?.format.toUpperCase() || "—"}</dd>
                <dt className="text-muted-foreground">最新修订</dt>
                <dd>rev. {doc?.revision ?? head}</dd>
                <dt className="text-muted-foreground">最近更新</dt>
                <dd>{formatTime(doc?.updatedAtEpochMs)}</dd>
                <dt className="text-muted-foreground">文档权限</dt>
                <dd>
                  {access
                    ? access.scope === "write"
                      ? "可编辑"
                      : "只读"
                    : "未连接"}
                </dd>
                <dt className="text-muted-foreground">当前主题</dt>
                <dd className="break-words">
                  {themes.find(
                    (item) => item.themeRevisionId === doc?.themeRevisionId,
                  )?.name || "未指定"}
                </dd>
              </dl>
              <Select
                aria-label="指定文档主题"
                value={theme}
                onChange={(event) => setTheme(event.target.value)}
              >
                <option value="">选择主题</option>
                <option value="__none">取消指定主题</option>
                {themes
                  .filter((item) => !retired.includes(item.themeRevisionId))
                  .map((item) => (
                    <option
                      key={item.themeRevisionId}
                      value={item.themeRevisionId}
                    >
                      {item.name}
                    </option>
                  ))}
              </Select>
              <Button
                disabled={
                  !theme ||
                  doc?.state !== "COMPLETE" ||
                  theme === doc?.themeRevisionId ||
                  (theme === "__none" && !doc?.themeRevisionId)
                }
                onClick={changeTheme}
              >
                <Check />
                更新文档主题
              </Button>
              {doc && ["docx", "xlsx", "pptx", "pdf"].includes(doc.format) && (
                <Button variant="outline" onClick={() => setPlan(true)}>
                  <ScanSearch />
                  字体导出检查
                </Button>
              )}
              <Notice title="主题固定到所选修订">
                后续的主题更新不会自动修改此文档。退役主题不可作为新的目标。
              </Notice>
            </>
          )}
        </aside>
      </div>
      <Dialog
        open={restore}
        onOpenChange={(next) => {
          if (!restoring) setRestore(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>恢复到这个版本？</DialogTitle>
            <DialogDescription className="break-all">
              {doc?.title || documentId}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-5 rounded-[14px] bg-muted p-5">
            <div>
              <p className="mb-2 text-[11px] text-muted-foreground">当前版本</p>
              <strong className="text-2xl">rev. {expected}</strong>
            </div>
            <span className="text-muted-foreground">→</span>
            <div>
              <p className="mb-2 text-[11px] text-muted-foreground">恢复来源</p>
              <strong className="text-2xl text-accent-foreground">
                rev. {selected}
              </strong>
            </div>
          </div>
          <p className="text-xs leading-6 text-muted-foreground">
            恢复将创建 rev. {expected + 1}，内容取自 rev. {selected}
            。当前及中间所有修订均会保留。
          </p>
          <Notice title="先核对最新状态，再恢复">
            其他人修改文档后，这次恢复会被拒绝，请先查看最新修订。
          </Notice>
          <label className="flex items-center gap-3 text-xs">
            <Checkbox
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已查看 rev. {selected} 的内容
          </label>
          {restoreError && (
            <div
              role="alert"
              className="space-y-2 text-xs leading-6 text-destructive"
            >
              <p>{restoreError}</p>
              <Button
                variant="ghost"
                onClick={() => {
                  setRestore(false);
                  setSelected(null);
                  void load();
                }}
              >
                查看最新状态
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={restoring}
              onClick={() => setRestore(false)}
            >
              取消
            </Button>
            <Button
              disabled={!confirmed || restoring || !!restoreError}
              onClick={() => void doRestore()}
            >
              <RotateCcw />
              {restoring ? "正在恢复…" : "恢复并创建新修订"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {plan && (
        <FontPlanDialog
          documentId={documentId}
          headRevision={doc?.revision ?? head}
          open={plan}
          onOpenChange={setPlan}
        />
      )}
      {node}
    </>
  );
}
