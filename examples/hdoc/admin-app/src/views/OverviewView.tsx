import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Palette,
  Type,
  Upload,
} from "lucide-react";

import { PageHeader } from "@/components/Page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  LICENSE_WARN_WINDOW_DAYS,
  LICENSE_WINDOWS,
  formatDate,
  formatBytes,
  licenseDaysLeft,
  licenseExpired,
} from "@/lib/format";
import { tokenStore } from "@/lib/api";
import { unreferencedFonts } from "@/state/catalogSelectors";
import { useCatalog } from "@/state/CatalogProvider";

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border bg-card px-3 py-2.5 shadow-xs">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={
          tone === "warn"
            ? "tabular text-xl font-semibold text-warning"
            : "tabular text-xl font-semibold"
        }
      >
        {value}
      </span>
      {hint ? (
        <span className="truncate text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}

export function OverviewView({
  onNavigate,
}: {
  onNavigate: (route: string) => void;
}) {
  const { fonts, themes, retired, documents, loaded } = useCatalog();
  // How far ahead "about to expire" reaches. The exporter warns on 30, so that
  // is where the picker starts; the wider windows are for planning a renewal
  // before the warning ever fires.
  const [windowDays, setWindowDays] = React.useState(LICENSE_WARN_WINDOW_DAYS);

  const totals = React.useMemo(() => {
    let revisions = 0;
    let faces = 0;
    let bytes = 0;
    const expired: string[] = [];
    const due: string[] = [];
    for (const font of fonts) {
      revisions += font.revisions.length;
      for (const revision of font.revisions) {
        faces += revision.faces.length;
        for (const face of revision.faces) bytes += face.byteLength;
        if (licenseExpired(revision.license)) {
          expired.push(
            `${font.fontId} · ${revision.fontRevisionId.slice(0, 10)}…（${
              revision.license.name
            }）`,
          );
          continue;
        }
        const left = licenseDaysLeft(revision.license);
        const expires = revision.license.expiresAtEpochMs;
        if (left !== null && expires !== undefined && left <= windowDays) {
          due.push(
            `${font.fontId} · ${revision.family}（${
              revision.license.name
            } · ${formatDate(expires)} · 还有 ${left} 天）`,
          );
        }
      }
    }
    due.sort((left, right) => left.localeCompare(right, "zh-CN"));
    return { revisions, faces, bytes, expired, due };
  }, [fonts, windowDays]);

  const unreferenced = unreferencedFonts(fonts, themes);
  const unpinned = (documents ?? []).filter((doc) => !doc.themeRevisionId);
  const hasRisks =
    totals.expired.length > 0 ||
    totals.due.length > 0 ||
    unreferenced.length > 0 ||
    unpinned.length > 0 ||
    retired.length > 0;

  return (
    <>
      <PageHeader
        title="概览"
        description="这台机器上的字体目录规模、钉版覆盖，以及需要先处理的许可证与引用问题。"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => onNavigate("themes")}>
              <Palette />
              主题
            </Button>
            <Button size="sm" onClick={() => onNavigate("upload")}>
              <Upload />
              上传登记
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-3">
        <Stat label="字体" value={String(fonts.length)} hint={`${totals.revisions} 个修订`} />
        <Stat label="字面" value={String(totals.faces)} hint={formatBytes(totals.bytes)} />
        <Stat
          label="主题"
          value={String(themes.length)}
          hint={retired.length ? `${retired.length} 个已退役` : "全部在用"}
          tone={retired.length ? "warn" : "default"}
        />
        <Stat
          label="文档"
          value={documents === null ? "—" : String(documents.length)}
          hint={
            documents === null
              ? "本服务未提供文档列表"
              : `${unpinned.length} 个未钉主题`
          }
          tone={documents === null || unpinned.length ? "warn" : "default"}
        />
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>要处理的事</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              许可证到期提醒的窗口
              <Select
                aria-label="许可证到期提醒的窗口"
                value={String(windowDays)}
                onChange={(event) => setWindowDays(Number(event.target.value))}
                className="h-7 w-28 text-xs"
              >
                {LICENSE_WINDOWS.map((days) => (
                  <option key={days} value={String(days)}>
                    {days} 天内
                  </option>
                ))}
              </Select>
            </label>
            {!loaded ? (
              <p className="text-xs text-muted-foreground">目录还在加载…</p>
            ) : null}
            {loaded && !hasRisks ? (
              <p className="flex items-center gap-2 text-xs text-success">
                <CheckCircle2 className="size-4" />
                没有过期或即将到期的许可证、没有孤立字体、文档都已钉主题。
              </p>
            ) : null}
            {totals.due.length ? (
              <Risk
                tone="warning"
                title={`${totals.due.length} 个修订的许可证将在 ${windowDays} 天内到期`}
                detail="到期后预览和导出都不再写入字面，只登记字体名。趁现在续许可证或换字面；文档「体检」里那句提醒来自导出自己。"
                items={totals.due}
                action={() => onNavigate("fonts")}
                actionLabel="查看字体"
              />
            ) : null}
            {totals.expired.length ? (
              <Risk
                tone="destructive"
                title={`${totals.expired.length} 个修订的许可证已过期`}
                detail="到期后预览与导出都不再写入字面，只登记字体名。"
                items={totals.expired}
                action={() => onNavigate("fonts")}
                actionLabel="查看字体"
              />
            ) : null}
            {unreferenced.length ? (
              <Risk
                tone="warning"
                title={`${unreferenced.length} 个字体没有被任何主题引用`}
                detail="它们仍可被引用；确认不再需要时可以在字体页删除，被引用的删除会被服务端拒绝。"
                items={unreferenced}
                action={() => onNavigate("fonts")}
                actionLabel="查看字体"
              />
            ) : null}
            {unpinned.length ? (
              <Risk
                tone="warning"
                title={`${unpinned.length} 个文档没有钉主题`}
                detail="未钉版的文档继续用文档包里自带的样式；服务配了 --default-theme 时新导入会自动钉。"
                items={unpinned.map((doc) => `${doc.documentId}（r${doc.revision}）`)}
                action={() => onNavigate("documents")}
                actionLabel="查看文档"
              />
            ) : null}
            {retired.length ? (
              <Risk
                tone="muted"
                title={`${retired.length} 个主题已退役`}
                detail="退役只挡新钉版；已钉文档与历史修订仍可解析。"
                items={retired.map((id) => `${id.slice(0, 16)}…`)}
                action={() => onNavigate("themes")}
                actionLabel="查看主题"
              />
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>这一页能做什么</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs">
            <Entry
              icon={<Type />}
              title="字体"
              detail="按主题引用情况筛选修订，删除前会先让服务端做引用检查。"
              onClick={() => onNavigate("fonts")}
            />
            <Entry
              icon={<Palette />}
              title="主题"
              detail="六个槽位（标题/正文 × 西文/东亚/双向）、回退族、退役与彻底删除。"
              onClick={() => onNavigate("themes")}
            />
            <Entry
              icon={<Upload />}
              title="上传登记"
              detail="字库 → blob → 字体修订，许可证决定预览与嵌入。"
              onClick={() => onNavigate("upload")}
            />
            <Entry
              icon={<FileText />}
              title="文档"
              description="内容侧核对：每个 bundle 的 head 修订与钉住的主题。"
              onClick={() => onNavigate("documents")}
            />
            <Separator />
            <div className="grid gap-1 text-[11px] text-muted-foreground">
              <p>
                目录接口：
                <code className="ml-1 font-mono">/v1/catalog/fonts</code>
                <code className="ml-1 font-mono">/v1/catalog/themes</code>
              </p>
              <p>
                令牌：
                {tokenStore.get()
                  ? "已设置（仅存在本页 sessionStorage）"
                  : "未设置 — 点右上角「管理令牌」粘贴 --scope admin 的 JWT"}
              </p>
              <p>
                上限：单库 32 MiB，预览内联 8 MiB · 页面构建 {__BUILD_AT__}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Risk({
  tone,
  title,
  detail,
  items,
  action,
  actionLabel,
}: {
  tone: "destructive" | "warning" | "muted";
  title: string;
  detail: string;
  items: string[];
  action: () => void;
  actionLabel: string;
}) {
  return (
    <div className="grid gap-1.5 rounded-lg border p-3">
      <p className="flex items-center gap-2 text-xs font-medium">
        <AlertTriangle
          className={
            tone === "destructive"
              ? "size-4 text-destructive"
              : tone === "warning"
                ? "size-4 text-warning"
                : "size-4 text-muted-foreground"
          }
        />
        {title}
      </p>
      <p className="text-[11px] text-muted-foreground">{detail}</p>
      <ul className="grid gap-0.5">
        {items.slice(0, 5).map((item) => (
          <li key={item} className="tabular truncate font-mono text-[11px]">
            {item}
          </li>
        ))}
        {items.length > 5 ? (
          <li className="text-[11px] text-muted-foreground">
            还有 {items.length - 5} 项…
          </li>
        ) : null}
      </ul>
      <div>
        <Button size="sm" variant="outline" onClick={action}>
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}

function Entry({
  icon,
  title,
  detail,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          <Badge variant="muted">打开</Badge>
        </span>
        <span className="block text-[11px] text-muted-foreground">
          {detail ?? description}
        </span>
      </span>
    </button>
  );
}
