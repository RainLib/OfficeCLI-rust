import * as React from "react";
import { Eye, Plus, ShieldOff, FileSearch, Trash2 } from "lucide-react";

import { EmptyState, LoadState, PageHeader, Toolbar } from "@/components/Page";
import { IdChip } from "@/components/IdChip";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { ThemeFormDialog } from "@/views/ThemeFormDialog";
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
import { SLOT_KEYS, SLOT_NAMES } from "@/lib/format";
import type { ThemeDocumentRef, ThemeFontSlots, ThemeRevision } from "@/lib/types";
import { useCatalog } from "@/state/CatalogProvider";

type Status = "all" | "active" | "retired";

function slotChips(slots: ThemeFontSlots) {
  return SLOT_KEYS.map((key) => {
    const ref = slots[key];
    if (!ref) return null;
    return (
      <Badge key={key} variant="secondary" title={ref.fontRevisionId}>
        {ref.fontId}
      </Badge>
    );
  }).filter(Boolean);
}

export function ThemesView({ onNavigate }: { onNavigate: (route: string) => void }) {
  const { themes, retired, loaded, error, refresh } = useCatalog();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<Status>("all");
  const [reach, setReach] = React.useState<{
    theme: ThemeRevision;
    refs: ThemeDocumentRef[];
  } | null>(null);
  const [reachBusy, setReachBusy] = React.useState(false);
  const [target, setTarget] = React.useState("");
  const [moved, setMoved] = React.useState<{ documentId: string; status: string }[]>([]);
  const [moving, setMoving] = React.useState(false);

  const retiredSet = React.useMemo(() => new Set(retired), [retired]);

  const rows = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return themes
      .filter((theme) => {
        if (needle && !`${theme.name} ${theme.themeRevisionId}`.toLowerCase().includes(needle)) {
          return false;
        }
        const isRetired = retiredSet.has(theme.themeRevisionId);
        if (status === "active") return !isRetired;
        if (status === "retired") return isRetired;
        return true;
      })
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }, [themes, query, status, retiredSet]);

  const showReachability = async (theme: ThemeRevision) => {
    setReachBusy(true);
    setMoved([]);
    setTarget("");
    try {
      const refs = await api.themeDocuments(theme.themeRevisionId);
      setReach({ theme, refs });
    } catch (cause) {
      toast.err(cause);
    } finally {
      setReachBusy(false);
    }
  };

  // Only a document whose head pins this theme can move off it. One that shows up
  // through a historical revision is on something else now, and "retarget" would
  // quietly pin a theme it had walked away from.
  const movable = React.useMemo(
    () => (reach?.refs ?? []).filter((ref) => ref.headPinned),
    [reach],
  );

  const retargetable = React.useMemo(
    () =>
      themes.filter(
        (theme) =>
          theme.themeRevisionId !== reach?.theme.themeRevisionId &&
          !retiredSet.has(theme.themeRevisionId),
      ),
    [themes, retiredSet, reach],
  );

  const runRetarget = () => {
    if (!reach || !target || movable.length === 0) return;
    const chosen = retargetable.find((theme) => theme.themeRevisionId === target);
    confirm({
      title: `批量换主题`,
      destructive: true,
      confirmLabel: `把 ${movable.length} 个文档换到 ${chosen?.name ?? target}`,
      description: (
        <p>
          逐个文档调用 <code className="font-mono">PUT /v1/documents/&lt;id&gt;/theme</code>，
          每个文档写一次自己的内容修订：{movable.length} 个文档就是 {movable.length} 次修订。
          中途失败只影响那一个文档，结果按文档列出来，可以只重试它。
        </p>
      ),
      onConfirm: async () => {
        setMoving(true);
        // The whole list is written up front, so the operator sees what is still
        // queued while the run works through it one document at a time.
        const results = movable.map((ref) => ({
          documentId: ref.documentId,
          status: "排队中",
        }));
        setMoved([...results]);
        let ok = 0;
        for (let index = 0; index < movable.length; index += 1) {
          const ref = movable[index];
          try {
            const result = await api.pinDocumentTheme(ref.documentId, target);
            ok += 1;
            results[index] = { documentId: ref.documentId, status: `已换到 r${result.revision}` };
          } catch (cause) {
            results[index] = {
              documentId: ref.documentId,
              status: cause instanceof Error ? cause.message : "失败",
            };
          }
          setMoved([...results]);
        }
        setMoving(false);
        toast.push(
          ok === results.length
            ? `${ok} 个文档已换到 ${chosen?.name ?? target}`
            : `${ok} / ${results.length} 个文档换成功，失败的点名在列表里`,
          ok === results.length ? "ok" : "warn",
        );
        try {
          // Re-scan the source theme: the documents that moved stay in the list as
          // history-only references, which is what tells the operator the old theme
          // can now be retired. A failed re-scan must not hide the run's own result.
          setReach({
            theme: reach.theme,
            refs: await api.themeDocuments(reach.theme.themeRevisionId),
          });
          await refresh();
        } catch {
          toast.push("换版已完成，但重新扫描引用失败：点「刷新」再看一次。", "warn");
        }
      },
    });
  };

  return (
    <>
      <PageHeader
        title="主题"
        description="主题钉的是不可变的 themeRevisionId。退役只挡新钉版；彻底删除要求本服务的文档目录里没有任何文档钉住它。"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => onNavigate("preview")}>
              <Eye />
              主题预览
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus />
              新建主题
            </Button>
          </>
        }
      />

      <Toolbar>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索主题名或 themeRevisionId"
          className="h-7 w-64 text-xs"
        />
        <Select
          aria-label="状态"
          value={status}
          onChange={(event) => setStatus(event.target.value as Status)}
          className="h-7 w-32 text-xs"
        >
          <option value="all">全部主题</option>
          <option value="active">在用</option>
          <option value="retired">已退役</option>
        </Select>
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {loaded ? `${rows.length} / ${themes.length} 个主题 · ${retired.length} 个已退役` : "加载中…"}
        </span>
      </Toolbar>

      {!loaded && !error ? <LoadState text="正在加载主题…" /> : null}

      {loaded && rows.length === 0 ? (
        <div className="rounded-xl border bg-card shadow-xs">
          <EmptyState
            title={themes.length ? "没有符合条件的主题" : "还没有主题"}
            description={
              themes.length
                ? "换个状态筛选，或清空搜索词。"
                : "主题是字体槽位的组合；先在「上传登记」登记字体，再新建主题。"
            }
            action={{ label: "新建主题", onClick: () => setCreateOpen(true) }}
          />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>themeRevisionId</TableHead>
                <TableHead>标题槽位</TableHead>
                <TableHead>正文槽位</TableHead>
                <TableHead>回退</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((theme) => {
                const isRetired = retiredSet.has(theme.themeRevisionId);
                return (
                  <TableRow key={theme.themeRevisionId}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{theme.name}</span>
                        {isRetired ? <Badge variant="warning">已退役</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <IdChip value={theme.themeRevisionId} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex max-w-64 flex-wrap gap-1">
                        {slotChips(theme.major)}
                        {theme.major.latin || theme.major.eastAsia || theme.major.bidi ? null : (
                          <span className="text-xs text-muted-foreground">未钉</span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {SLOT_KEYS.map((key) =>
                          theme.major[key] ? SLOT_NAMES[key] : null,
                        )
                          .filter(Boolean)
                          .join(" / ") || "—"}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex max-w-64 flex-wrap gap-1">
                        {slotChips(theme.minor)}
                        {theme.minor.latin || theme.minor.eastAsia || theme.minor.bidi ? null : (
                          <span className="text-xs text-muted-foreground">未钉</span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {SLOT_KEYS.map((key) =>
                          theme.minor[key] ? SLOT_NAMES[key] : null,
                        )
                          .filter(Boolean)
                          .join(" / ") || "—"}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex max-w-48 flex-wrap gap-1">
                        {theme.fallbackFamilies.length ? (
                          theme.fallbackFamilies.map((family) => (
                            <Badge key={family} variant="outline">
                              {family}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={reachBusy}
                          title="扫描本服务的文档目录，含只钉在历史修订里的文档"
                          onClick={() => void showReachability(theme)}
                        >
                          <FileSearch />
                          引用文档
                        </Button>
                        {isRetired ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              confirm({
                                title: `取消退役 ${theme.name}`,
                                confirmLabel: "取消退役",
                                description: (
                                  <p>取消后，这个主题可以重新被钉到文档上。</p>
                                ),
                                onConfirm: async () => {
                                  await api.unretireTheme(theme.themeRevisionId);
                                  toast.push(`已取消退役：${theme.name}`, "ok");
                                  await refresh();
                                },
                              })
                            }
                          >
                            取消退役
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              confirm({
                                title: `退役 ${theme.name}`,
                                destructive: true,
                                confirmLabel: "退役",
                                description: (
                                  <p>
                                    退役后不能再把该主题钉到新文档上，已经钉住它的文档仍可正常解析，
                                    历史修订不变。退役不会释放主题本体。
                                  </p>
                                ),
                                onConfirm: async () => {
                                  await api.retireTheme(theme.themeRevisionId);
                                  toast.push(`已退役：${theme.name}`, "ok");
                                  await refresh();
                                },
                              })
                            }
                          >
                            <ShieldOff />
                            退役
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            confirm({
                              title: `彻底删除 ${theme.name}`,
                              destructive: true,
                              confirmLabel: "删除主题",
                              description: (
                                <p>
                                  只要有文档钉住该主题（包括只看得到历史修订的文档），这一步就会失败并点名文档。
                                  删除只移除主题记录，它引用的字体与字库保持不变。
                                </p>
                              ),
                              onConfirm: async () => {
                                await api.deleteTheme(theme.themeRevisionId);
                                toast.push(
                                  `已删除主题 ${theme.name}，它引用的字体与字库保持不变。`,
                                  "ok",
                                );
                                await refresh();
                              },
                            })
                          }
                        >
                          <Trash2 />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <ThemeFormDialog open={createOpen} onOpenChange={setCreateOpen} />

      <Dialog
        open={reach !== null}
        onOpenChange={(open) => {
          if (!open) setReach(null);
        }}
      >
        <DialogContent className="w-[min(720px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>引用 {reach?.theme.name} 的文档</DialogTitle>
            <DialogDescription>
              只扫描这台机器上本服务的文档目录，不含其它机器上的副本；「没有引用」不等于全世界没人用。
            </DialogDescription>
          </DialogHeader>
          {reach && reach.refs.length === 0 ? (
            <p className="text-sm text-success">
              没有文档钉住该主题，可以彻底删除。
            </p>
          ) : null}
          {reach && reach.refs.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>documentId</TableHead>
                    <TableHead>当前钉住</TableHead>
                    <TableHead>钉住它的修订</TableHead>
                    {moved.length ? <TableHead>换版结果</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reach.refs.map((ref) => {
                    const result = moved.find((item) => item.documentId === ref.documentId);
                    return (
                      <TableRow key={ref.documentId}>
                        <TableCell>
                          <code className="text-xs">{ref.documentId}</code>
                        </TableCell>
                        <TableCell>
                          {ref.headPinned ? (
                            <Badge variant="success">是</Badge>
                          ) : (
                            <Badge variant="muted">仅历史</Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          {ref.pinnedRevisions.length ? (
                            <div className="flex flex-wrap gap-1">
                              {ref.pinnedRevisions.map((revision) => (
                                <Badge key={revision} variant="outline">
                                  r{revision}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        {moved.length ? (
                          <TableCell className="whitespace-normal text-xs">
                            {result?.status ?? "—"}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <Select
                  aria-label="换到的目标主题"
                  value={target}
                  disabled={moving || retargetable.length === 0}
                  onChange={(event) => setTarget(event.target.value)}
                  className="h-7 w-48 text-xs"
                >
                  <option value="" disabled>
                    {retargetable.length ? "换到的主题" : "目录里没有可钉的目标主题"}
                  </option>
                  {retargetable.map((theme) => (
                    <option key={theme.themeRevisionId} value={theme.themeRevisionId}>
                      {theme.name}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={moving || target === "" || movable.length === 0}
                  onClick={runRetarget}
                >
                  {moving ? "换版中…" : `把 ${movable.length} 个在用的文档换过去`}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {movable.length === 0
                    ? "没有文档在当前 head 上钉着这个主题，只有历史记录提到它。"
                    : reach.refs.length > movable.length
                      ? `其中 ${reach.refs.length - movable.length} 个只在历史修订里钉过，当前用的是别的主题或没有钉，批量换版不会碰它们。`
                      : "逐个文档写一次内容修订，正文和节点不变。"}
                </span>
              </div>
            </>
          ) : null}
          <DialogFooter>
            <span className="mr-auto text-xs text-muted-foreground">
              {reach ? <IdChip value={reach.theme.themeRevisionId} copy={false} /> : null}
            </span>
            <Button variant="outline" onClick={() => setReach(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {node}
    </>
  );
}
