import * as React from "react";
import { ArrowLeft, Eye, List, Plus, Type, Upload } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/Page";
import { Notice, SectionHeading } from "@/components/Workspace";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useCatalog } from "@/state/CatalogProvider";
import { formatBytes, licenseDaysLeft, licenseExpired } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FontsView } from "./FontsView";
import { ThemesView } from "./ThemesView";
import { ThemeFormDialog } from "./ThemeFormDialog";

type Props = { search?: string; onNavigate: (route: string) => void };
export function FontLibraryView({ search = "", onNavigate }: Props) {
  const { fonts, themes, loaded } = useCatalog();
  const [query, setQuery] = React.useState(search);
  const [scope, setScope] = React.useState("all");
  const [selectedId, setSelectedId] = React.useState("");
  const [revisionId, setRevisionId] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  React.useEffect(() => setQuery(search), [search]);
  const rows = fonts.filter(
    (font) =>
      `${font.fontId} ${font.family}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (scope === "all" ||
        font.revisions.some((revision) =>
          scope === "expired"
            ? licenseExpired(revision.license)
            : scope === "due"
              ? (licenseDaysLeft(revision.license) ?? Infinity) <= 30
              : revision.license.webPreview,
        )),
  );
  const selected = fonts.find((font) => font.fontId === selectedId) || rows[0];
  const revision =
    selected?.revisions.find((item) => item.fontRevisionId === revisionId) ||
    selected?.revisions[0];
  const references = themes.filter((theme) =>
    [theme.major, theme.minor].some((slots) =>
      Object.values(slots).some(
        (ref) =>
          ref?.fontId === selected?.fontId &&
          ref.fontRevisionId === revision?.fontRevisionId,
      ),
    ),
  );
  if (advanced)
    return (
      <>
        <Button
          className="self-start"
          variant="ghost"
          onClick={() => setAdvanced(false)}
        >
          <ArrowLeft />
          返回字体目录
        </Button>
        <FontsView onNavigate={onNavigate} />
      </>
    );
  return (
    <>
      <PageHeader
        title="字体目录"
        description="统一管理品牌字族、不可变修订与字体授权。"
        actions={
          <>
            <Button variant="outline" onClick={() => setAdvanced(true)}>
              <List />
              修订与引用管理
            </Button>
            <Button onClick={() => onNavigate("upload")}>
              <Upload />
              上传登记
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="搜索字体"
          className="w-full sm:w-80"
          placeholder="搜索字族名称或字体 ID"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          aria-label="字体授权筛选"
          className="w-40"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="all">全部字体</option>
          <option value="web">可网页预览</option>
          <option value="due">30 天内到期</option>
          <option value="expired">授权已到期</option>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} 个字族
        </span>
      </div>
      {rows.length ? (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid gap-4 sm:grid-cols-2">
            {rows.map((font) => (
              <button
                type="button"
                key={font.fontId}
                aria-pressed={selected?.fontId === font.fontId}
                onClick={() => {
                  setSelectedId(font.fontId);
                  setRevisionId("");
                }}
                className={cn(
                  "min-w-0 rounded-[20px] p-5 text-left ring-1 ring-transparent",
                  selected?.fontId === font.fontId
                    ? "bg-accent ring-accent-foreground/20"
                    : "bg-muted",
                )}
              >
                <span className="flex items-center justify-between gap-3">
                  <Type className="size-5 text-accent-foreground" />
                  <Badge variant="outline">
                    {font.revisions.length} 个修订
                  </Badge>
                </span>
                <strong className="mt-6 block truncate text-lg font-semibold">
                  {font.family}
                </strong>
                <span className="mt-2 block truncate text-[11px] text-muted-foreground">
                  {font.fontId}
                </span>
                <span className="mt-5 flex flex-wrap gap-2">
                  {[
                    ...new Set(
                      font.revisions.flatMap((item) =>
                        item.faces.map((face) => face.format.toUpperCase()),
                      ),
                    ),
                  ].map((format) => (
                    <Badge key={format} variant="muted">
                      {format}
                    </Badge>
                  ))}
                  {font.revisions.some((item) =>
                    licenseExpired(item.license),
                  ) && <Badge variant="warning">存在到期授权</Badge>}
                </span>
              </button>
            ))}
          </div>
          {selected && revision && (
            <aside className="space-y-5 rounded-[20px] bg-muted p-5">
              <SectionHeading title={selected.family} />
              <Select
                aria-label="字体修订"
                value={revision.fontRevisionId}
                onChange={(event) => setRevisionId(event.target.value)}
              >
                {selected.revisions.map((item) => (
                  <option key={item.fontRevisionId} value={item.fontRevisionId}>
                    {item.fontRevisionId.slice(0, 16)}…
                  </option>
                ))}
              </Select>
              <div className="space-y-3 rounded-2xl bg-card p-4">
                {revision.faces.map((face, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span>
                      {face.subfamily} · {face.weight}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {face.style} · {formatBytes(face.byteLength)}
                    </span>
                  </div>
                ))}
              </div>
              <SectionHeading title="授权范围" />
              <p className="text-xs">{revision.license.name}</p>
              <dl className="grid grid-cols-2 gap-4 text-xs">
                {[
                  ["网页预览", revision.license.webPreview],
                  ["OOXML 嵌入", revision.license.ooxmlEmbed],
                  ["PDF 嵌入", revision.license.pdfEmbed],
                  ["再分发", revision.license.redistribution],
                ].map(([label, allowed]) => (
                  <React.Fragment key={String(label)}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd
                      className={
                        allowed ? "text-success" : "text-muted-foreground"
                      }
                    >
                      {allowed ? "允许" : "未授权"}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
              <p className="text-[11px] text-muted-foreground">
                {revision.license.expiresAtEpochMs
                  ? `授权截至 ${new Date(revision.license.expiresAtEpochMs).toLocaleDateString("zh-CN")}`
                  : "未设置授权到期日"}
              </p>
              <SectionHeading title="引用此修订的主题" />
              {references.length ? (
                references.map((theme) => (
                  <Button
                    key={theme.themeRevisionId}
                    variant="outline"
                    className="w-full justify-between"
                    onClick={() =>
                      onNavigate(`preview?theme=${theme.themeRevisionId}`)
                    }
                  >
                    {theme.name}
                    <Eye />
                  </Button>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">
                  暂无主题引用此修订。
                </p>
              )}
              <Notice title="授权更新会创建新修订">
                历史主题继续固定原有修订。字面效果可在引用主题中解析预览。
              </Notice>
            </aside>
          )}
        </div>
      ) : (
        <EmptyState
          title={loaded ? "没有符合条件的字体" : "连接后加载字体目录"}
          action={{ label: "上传字体", onClick: () => onNavigate("upload") }}
        />
      )}
    </>
  );
}

export function ThemeLibraryView({ search = "", onNavigate }: Props) {
  const { themes, fonts, retired, documents, loaded } = useCatalog();
  const [query, setQuery] = React.useState(search);
  const [selectedId, setSelectedId] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [create, setCreate] = React.useState(false);
  const [status, setStatus] = React.useState("active");
  React.useEffect(() => setQuery(search), [search]);
  const rows = themes.filter(
    (theme) =>
      `${theme.name} ${theme.themeRevisionId}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (status === "all" ||
        retired.includes(theme.themeRevisionId) === (status === "retired")),
  );
  const selected =
    rows.find((theme) => theme.themeRevisionId === selectedId) || rows[0];
  if (advanced)
    return (
      <>
        <Button
          className="self-start"
          variant="ghost"
          onClick={() => setAdvanced(false)}
        >
          <ArrowLeft />
          返回主题目录
        </Button>
        <ThemesView onNavigate={onNavigate} />
      </>
    );
  return (
    <>
      <PageHeader
        title="主题与预览"
        description="固定品牌字体组合，让文档与导出保持一致。"
        actions={
          <>
            <Button variant="outline" onClick={() => setAdvanced(true)}>
              <List />
              引用与退役管理
            </Button>
            <Button onClick={() => setCreate(true)}>
              <Plus />
              新建主题
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="搜索主题"
          className="w-full sm:w-80"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索主题名称或修订"
        />
        <Select
          aria-label="主题状态"
          className="w-40"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="active">使用中的主题</option>
          <option value="all">全部主题</option>
          <option value="retired">已退役</option>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} 套主题
        </span>
      </div>
      {rows.length ? (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid gap-4 sm:grid-cols-2">
            {rows.map((theme) => (
              <button
                type="button"
                key={theme.themeRevisionId}
                aria-pressed={
                  selected?.themeRevisionId === theme.themeRevisionId
                }
                onClick={() => setSelectedId(theme.themeRevisionId)}
                className={cn(
                  "min-w-0 space-y-4 rounded-[20px] p-5 text-left ring-1 ring-transparent",
                  selected?.themeRevisionId === theme.themeRevisionId
                    ? "bg-accent ring-accent-foreground/20"
                    : "bg-muted",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-base font-semibold">
                    {theme.name}
                  </strong>
                  <Badge
                    variant={
                      retired.includes(theme.themeRevisionId)
                        ? "muted"
                        : "success"
                    }
                  >
                    {retired.includes(theme.themeRevisionId)
                      ? "已退役"
                      : "可指定"}
                  </Badge>
                </span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {theme.themeRevisionId.slice(0, 24)}…
                </span>
                <span className="block rounded-xl bg-card p-4 text-xs leading-7">
                  <span className="block text-muted-foreground">
                    Major / Minor
                  </span>
                  {Object.values(theme.major).length +
                    Object.values(theme.minor).length}{" "}
                  个字体槽位 ·{" "}
                  {documents?.filter(
                    (doc) => doc.themeRevisionId === theme.themeRevisionId,
                  ).length || 0}{" "}
                  份当前文档
                </span>
              </button>
            ))}
          </div>
          {selected && (
            <aside className="space-y-5 rounded-[20px] bg-muted p-5">
              <SectionHeading title={selected.name} />
              {(["major", "minor"] as const).map((group) => (
                <div key={group} className="space-y-3">
                  <h3 className="text-xs font-semibold">
                    {group === "major"
                      ? "Major · 标题字体"
                      : "Minor · 正文字体"}
                  </h3>
                  {(["latin", "eastAsia", "bidi"] as const).map((slot) => {
                    const ref = selected[group][slot];
                    return (
                      <div
                        key={slot}
                        className="flex items-center justify-between gap-4 rounded-xl bg-card p-3 text-xs"
                      >
                        <span className="text-muted-foreground">
                          {slot === "latin"
                            ? "西文"
                            : slot === "eastAsia"
                              ? "东亚文字"
                              : "复杂文字"}
                        </span>
                        <span className="truncate">
                          {ref
                            ? fonts.find((font) => font.fontId === ref.fontId)
                                ?.family || ref.fontId
                            : "系统回退"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
              <SectionHeading title="回退字族" />
              <p className="break-words text-xs leading-6 text-muted-foreground">
                {selected.fallbackFamilies.join("、") || "使用系统默认字族"}
              </p>
              <Button
                className="w-full"
                onClick={() =>
                  onNavigate(`preview?theme=${selected.themeRevisionId}`)
                }
              >
                <Eye />
                解析主题并预览字面
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() =>
                  onNavigate(`documents?theme=${selected.themeRevisionId}`)
                }
              >
                查看指定此主题的文档
              </Button>
              <Notice title="主题修订保持固定">
                新建与退役不会自动替换文档已经指定的主题。
              </Notice>
            </aside>
          )}
        </div>
      ) : (
        <EmptyState
          title={loaded ? "还没有符合条件的主题" : "连接后加载主题目录"}
          action={{ label: "新建主题", onClick: () => setCreate(true) }}
        />
      )}
      <ThemeFormDialog open={create} onOpenChange={setCreate} />
    </>
  );
}
