import * as React from "react";
import { ChevronDown, ChevronRight, Upload } from "lucide-react";

import { EmptyState, LoadState, PageHeader, Toolbar } from "@/components/Page";
import { IdChip } from "@/components/IdChip";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  LICENSE_WARN_WINDOW_DAYS,
  formatBytes,
  formatExactBytes,
  licenseDaysLeft,
  licenseExpired,
} from "@/lib/format";
import type { CatalogFont, FontRevision, ThemeRevision } from "@/lib/types";
import { useCatalog } from "@/state/CatalogProvider";
import { cn } from "@/lib/utils";

type Scope = "all" | "ooxml" | "pdf" | "web" | "due" | "expired" | "unreferenced";
type Sort = "fontId" | "revisions" | "bytes";

/** themeRevisionId → the fontIds its six slots cite. */
function themeRefs(themes: ThemeRevision[]) {
  const refs = new Map<string, Set<string>>();
  for (const theme of themes) {
    const fonts = new Set<string>();
    for (const slots of [theme.major, theme.minor]) {
      for (const ref of [slots.latin, slots.eastAsia, slots.bidi]) {
        if (ref) fonts.add(ref.fontId);
      }
    }
    refs.set(theme.themeRevisionId, fonts);
  }
  return refs;
}

function referencingThemes(
  fontId: string,
  refs: Map<string, Set<string>>,
  names: Map<string, string>,
): string[] {
  const usedBy: string[] = [];
  for (const [themeRevisionId, fonts] of refs) {
    if (fonts.has(fontId)) {
      usedBy.push(names.get(themeRevisionId) ?? `${themeRevisionId.slice(0, 8)}…`);
    }
  }
  return usedBy;
}

function revisionBytes(revision: FontRevision): number {
  return revision.faces.reduce((total, face) => total + face.byteLength, 0);
}

export function FontsView({ onNavigate }: { onNavigate: (route: string) => void }) {
  const { fonts, themes, loaded, error, refresh } = useCatalog();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const [scope, setScope] = React.useState<Scope>("all");
  const [sort, setSort] = React.useState<Sort>("fontId");
  const [query, setQuery] = React.useState("");
  const [openFonts, setOpenFonts] = React.useState<Set<string>>(new Set());

  const refs = React.useMemo(() => themeRefs(themes), [themes]);
  const names = React.useMemo(
    () => new Map(themes.map((theme) => [theme.themeRevisionId, theme.name])),
    [themes],
  );

  const rows = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = fonts.filter((font) => {
      if (needle) {
        const haystack = [
          font.fontId,
          font.family,
          ...font.revisions.flatMap((revision) =>
            revision.faces.map((face) => `${face.subfamily} ${face.sha256}`),
          ),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      const revisions = font.revisions;
      switch (scope) {
        case "all":
          return true;
        case "unreferenced":
          return ![...refs.values()].some((fonts) => fonts.has(font.fontId));
        case "due":
          return revisions.some((revision) => {
            const left = licenseDaysLeft(revision.license);
            return left !== null && left > 0 && left <= LICENSE_WARN_WINDOW_DAYS;
          });
        case "expired":
          return revisions.some((revision) => licenseExpired(revision.license));
        case "ooxml":
          return revisions.some((revision) => revision.license.ooxmlEmbed);
        case "pdf":
          return revisions.some((revision) => revision.license.pdfEmbed);
        case "web":
          return revisions.some((revision) => revision.license.webPreview);
      }
    });
    return matches.sort((left, right) => {
      if (sort === "revisions") {
        return right.revisions.length - left.revisions.length;
      }
      if (sort === "bytes") {
        const size = (font: CatalogFont) =>
          font.revisions.reduce((total, revision) => total + revisionBytes(revision), 0);
        return size(right) - size(left);
      }
      return left.fontId.localeCompare(right.fontId);
    });
  }, [fonts, query, scope, sort, refs]);

  const toggle = (fontId: string) =>
    setOpenFonts((current) => {
      const next = new Set(current);
      if (next.has(fontId)) next.delete(fontId);
      else next.add(fontId);
      return next;
    });

  const removeFont = (font: CatalogFont) =>
    confirm({
      title: `删除字体 ${font.fontId}`,
      destructive: true,
      confirmLabel: "删除全部修订",
      description: (
        <div className="grid gap-2">
          <p>
            该字体共有 {font.revisions.length} 个修订。只要有任何主题引用它，这一步就会失败，
            服务端会点名引用它的主题里的字体槽；字库字节只在最后一个引用消失后才回收。
          </p>
          {font.revisions.map((revision) => (
            <p key={revision.fontRevisionId} className="tabular text-muted-foreground">
              {revision.fontRevisionId.slice(0, 16)}… · {revision.faces.length} 个字面 ·{" "}
              {formatBytes(revisionBytes(revision))}
            </p>
          ))}
        </div>
      ),
      onConfirm: async () => {
        const report = await api.deleteFont(font.fontId);
        toast.push(
          `已删除 ${report.removedRevisions.length} 个修订，回收 ${report.removedBlobs.length} 个字库。`,
          "ok",
        );
        await refresh();
      },
    });

  const removeRevision = (font: CatalogFont, revision: FontRevision) =>
    confirm({
      title: `删除修订 ${font.fontId}`,
      destructive: true,
      confirmLabel: "删除这一修订",
      description: (
        <p>
          被主题引用时这一步会失败。与其它修订共享的字库字节会保留，只摘掉这一条修订记录。
        </p>
      ),
      onConfirm: async () => {
        const report = await api.deleteRevision(font.fontId, revision.fontRevisionId);
        toast.push(`已删除修订，回收 ${report.removedBlobs.length} 个字库。`, "ok");
        await refresh();
      },
    });

  return (
    <>
      <PageHeader
        title="字体"
        description="每个修订都是一次登记：字面、许可证、脚本槽位。被主题引用的字体删不掉。"
        actions={
          <Button size="sm" onClick={() => onNavigate("upload")}>
            <Upload />
            上传登记
          </Button>
        }
      />

      <Toolbar>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 fontId、字族、字面名、sha256"
          className="h-7 w-64 text-xs"
        />
        <Select
          aria-label="筛选"
          value={scope}
          onChange={(event) => setScope(event.target.value as Scope)}
          className="h-7 w-40 text-xs"
        >
          <option value="all">全部字体</option>
          <option value="unreferenced">未被主题引用</option>
          <option value="ooxml">可 OOXML 嵌入</option>
          <option value="pdf">可 PDF 嵌入</option>
          <option value="web">可网页预览</option>
          <option value="due">许可证即将到期</option>
          <option value="expired">许可证已过期</option>
        </Select>
        <Select
          aria-label="排序"
          value={sort}
          onChange={(event) => setSort(event.target.value as Sort)}
          className="h-7 w-32 text-xs"
        >
          <option value="fontId">按 fontId</option>
          <option value="revisions">按修订数</option>
          <option value="bytes">按字面字节</option>
        </Select>
        <span className="tabular ml-auto text-xs text-muted-foreground">
          {loaded ? `${rows.length} / ${fonts.length} 个字体` : "加载中…"}
        </span>
        {query || scope !== "all" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQuery("");
              setScope("all");
            }}
          >
            清除筛选
          </Button>
        ) : null}
      </Toolbar>

      {!loaded && !error ? <LoadState text="正在加载字体目录…" /> : null}

      {loaded && rows.length === 0 ? (
        <div className="rounded-xl border bg-card shadow-xs">
          <EmptyState
            title={fonts.length ? "没有符合筛选的字体" : "目录里还没有字体"}
            description={
              fonts.length
                ? "换个筛选条件，或清除搜索词。"
                : "上传一个字库并登记成字体修订，之后才能在主题里钉住它。"
            }
            action={{ label: "去上传登记", onClick: () => onNavigate("upload") }}
          />
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>fontId</TableHead>
                <TableHead>字族</TableHead>
                <TableHead className="text-right">修订</TableHead>
                <TableHead className="text-right">字面</TableHead>
                <TableHead className="text-right">字节</TableHead>
                <TableHead>许可证</TableHead>
                <TableHead>被主题引用</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((font) => {
                const expanded = openFonts.has(font.fontId);
                const usedBy = referencingThemes(font.fontId, refs, names);
                const totalBytes = font.revisions.reduce(
                  (total, revision) => total + revisionBytes(revision),
                  0,
                );
                const faceCount = font.revisions.reduce(
                  (total, revision) => total + revision.faces.length,
                  0,
                );
                const licenses = new Set(
                  font.revisions.map((revision) => revision.license.name),
                );
                // The row badge names the soonest revision, because that is the
                // one an operator has to act on first. A revision already past
                // its date is the 已过期 badge's business, not this one.
                const dueIn = font.revisions.reduce((soonest, revision) => {
                  const left = licenseDaysLeft(revision.license);
                  if (left === null || left <= 0) return soonest;
                  return soonest === null ? left : Math.min(soonest, left);
                }, null as number | null);
                return (
                  <React.Fragment key={font.fontId}>
                    <TableRow>
                      <TableCell className="pr-0">
                        <button
                          type="button"
                          aria-label={expanded ? "收起修订" : "展开修订"}
                          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                          onClick={() => toggle(font.fontId)}
                        >
                          {expanded ? (
                            <ChevronDown className="size-4" />
                          ) : (
                            <ChevronRight className="size-4" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell>
                        <code className="font-mono text-xs">{font.fontId}</code>
                      </TableCell>
                      <TableCell>{font.family}</TableCell>
                      <TableCell className="tabular text-right">
                        {font.revisions.length}
                      </TableCell>
                      <TableCell className="tabular text-right">{faceCount}</TableCell>
                      <TableCell className="tabular text-right">
                        {formatBytes(totalBytes)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {[...licenses].map((name) => (
                            <Badge key={name} variant="outline">
                              {name}
                            </Badge>
                          ))}
                          {dueIn !== null && dueIn <= LICENSE_WARN_WINDOW_DAYS ? (
                            <Badge
                              variant="warning"
                              title={`还有 ${dueIn} 天到期，到期后导出只登记字体名`}
                            >
                              {dueIn} 天内到期
                            </Badge>
                          ) : null}
                          {font.revisions.some((revision) =>
                            licenseExpired(revision.license),
                          ) ? (
                            <Badge variant="warning">已过期</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        {usedBy.length ? (
                          <div className="flex flex-wrap gap-1">
                            {usedBy.map((name) => (
                              <Badge key={name} variant="secondary">
                                {name}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">无</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => removeFont(font)}
                        >
                          删除字体
                        </Button>
                      </TableCell>
                    </TableRow>
                    {expanded
                      ? font.revisions.map((revision) => (
                          <RevisionRow
                            key={revision.fontRevisionId}
                            revision={revision}
                            onDelete={() => removeRevision(font, revision)}
                          />
                        ))
                      : null}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {node}
    </>
  );
}

function RevisionRow({
  revision,
  onDelete,
}: {
  revision: FontRevision;
  onDelete: () => void;
}) {
  const license = revision.license;
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/60">
      <TableCell />
      <TableCell colSpan={7} className="align-top">
        <div className="grid gap-2 py-1">
          <div className="flex flex-wrap items-center gap-2">
            <IdChip value={revision.fontRevisionId} />
            <span className="tabular text-xs text-muted-foreground">
              {formatBytes(revisionBytes(revision))}
            </span>
            <Badge variant={license.webPreview ? "success" : "muted"}>网页预览</Badge>
            <Badge variant={license.ooxmlEmbed ? "success" : "muted"}>OOXML 嵌入</Badge>
            <Badge variant={license.pdfEmbed ? "success" : "muted"}>PDF 嵌入</Badge>
            <Badge variant={license.redistribution ? "success" : "muted"}>
              允许再分发
            </Badge>
            {license.expiresAtEpochMs !== undefined ? (
              <Badge variant={licenseExpired(license) ? "destructive" : "warning"}>
                到期 {new Date(license.expiresAtEpochMs).toLocaleDateString("zh-CN")}
              </Badge>
            ) : null}
          </div>
          <ul className="grid gap-1">
            {revision.faces.map((face) => (
              <li
                key={`${face.sha256}-${face.subfamily}-${face.weight}-${face.style}`}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span
                  className={cn(
                    "min-w-24 font-medium",
                    face.weight >= 600 && "font-bold",
                  )}
                  style={{ fontStyle: face.style === "normal" ? undefined : "italic" }}
                >
                  {face.subfamily}
                </span>
                <span className="tabular text-muted-foreground">
                  {face.weight} · {face.style} · {face.stretch}
                </span>
                <span className="flex gap-1">
                  {face.scripts.map((script) => (
                    <Badge key={script} variant="outline" className="font-mono">
                      {script}
                    </Badge>
                  ))}
                </span>
                <Badge variant="secondary">{face.format}</Badge>
                <span
                  className="tabular text-muted-foreground"
                  title={formatExactBytes(face.byteLength)}
                >
                  {formatBytes(face.byteLength)}
                </span>
                <IdChip value={face.sha256} keep={8} copy={false} />
              </li>
            ))}
          </ul>
        </div>
      </TableCell>
      <TableCell className="text-right align-top">
        <Button size="sm" variant="outline" onClick={onDelete}>
          删除修订
        </Button>
      </TableCell>
    </TableRow>
  );
}
