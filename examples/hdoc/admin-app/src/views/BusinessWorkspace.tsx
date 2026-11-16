import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  FilePlus2,
  Files,
  Layers2,
  LogOut,
  Menu,
  Moon,
  Palette,
  RefreshCw,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Type,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader, EmptyState } from "@/components/Page";
import { FormatIcon, Notice } from "@/components/Workspace";
import { ToastProvider } from "@/components/Toast";
import { formatBytes } from "@/lib/format";
import { useRoute } from "@/lib/router";
import { cn } from "@/lib/utils";
import {
  businessRequest,
  businessJson,
  businessSession,
  dateText,
  operationLabels,
  roleLabels,
  businessProfiles,
  type BusinessFile,
  type BusinessSession,
  type BusinessUser,
} from "@/lib/business";
import { CatalogProvider } from "@/state/CatalogProvider";
import { FontLibraryView, ThemeLibraryView } from "./LibraryViews";
import { UploadView } from "./UploadView";
import { PreviewView } from "./PreviewView";
import { JobsView } from "./JobsView";
import { BusinessSettings } from "./BusinessSettings";

type Navigate = (route: string) => void;
function ErrorMessage({ value }: { value: string }) {
  return value ? (
    <p
      role="alert"
      className="rounded-xl bg-destructive/10 p-3 text-xs leading-6 text-destructive"
    >
      {value}
    </p>
  ) : null;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-2 text-xs">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string }>, { id })
        : children}
    </div>
  );
}
function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("rounded-[18px] border border-border p-5", className)}
    >
      {children}
    </section>
  );
}
function Login({
  onLogin,
  name,
}: {
  onLogin: (value: BusinessSession) => void;
  name: string;
}) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(
        await businessJson<BusinessSession>("/login", { username, password }),
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid min-h-dvh place-items-center bg-background p-5">
      <main className="w-full max-w-[430px] space-y-7 rounded-[28px] bg-card p-8 sm:p-10">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Layers2 className="text-accent-foreground" />
          office.
        </div>
        <div>
          <h1 className="text-2xl font-semibold">登录工作空间</h1>
          <p className="mt-3 text-xs text-muted-foreground">
            {name} · 继续处理你的文档与品牌资源
          </p>
        </div>
        <form onSubmit={(event) => void submit(event)} className="space-y-5">
          <Field label="账号">
            <Input
              autoComplete="username"
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label="密码">
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <ErrorMessage value={error} />
          <Button className="w-full" disabled={busy}>
            {busy ? "正在登录…" : "登录工作空间"}
          </Button>
        </form>
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-4" />
          由当前部署管理账号、权限和文档
        </p>
      </main>
    </div>
  );
}
const navigation = [
  { route: "documents", label: "文档管理", icon: Files, group: "工作空间" },
  {
    route: "users",
    label: "用户与角色",
    icon: Users,
    group: "工作空间",
    admin: true,
  },
  {
    route: "fonts",
    label: "字体目录",
    icon: Type,
    group: "品牌资源",
    admin: true,
  },
  {
    route: "themes",
    label: "主题与预览",
    icon: Palette,
    group: "品牌资源",
    admin: true,
  },
  {
    route: "events",
    label: "业务事件",
    icon: CheckCircle2,
    group: "服务管理",
    admin: true,
  },
  {
    route: "audit",
    label: "操作记录",
    icon: ScrollText,
    group: "服务管理",
    admin: true,
  },
  {
    route: "settings",
    label: "服务设置",
    icon: Settings2,
    group: "服务管理",
    admin: true,
  },
];
export function BusinessWorkspace({ name }: { name: string }) {
  const [account, setAccount] = useState<BusinessSession | null>(null),
    [loading, setLoading] = useState(true);
  const [route, navigate] = useRoute(),
    [dark, setDark] = useState(
      () => localStorage.getItem("hcdAdminTheme") === "dark",
    ),
    [mobile, setMobile] = useState(false),
    [error, setError] = useState("");
  const login = useCallback((value: BusinessSession) => {
    businessSession(value);
    setAccount(value);
  }, []);
  useEffect(() => {
    let alive = true;
    void businessRequest<BusinessSession>("/session")
      .then((value) => {
        if (alive) login(value);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [login]);
  useEffect(() => {
    const expired = () => {
      businessSession(null);
      setAccount(null);
    };
    window.addEventListener("officecli:workspace-session-expired", expired);
    return () =>
      window.removeEventListener(
        "officecli:workspace-session-expired",
        expired,
      );
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("hcdAdminTheme", dark ? "dark" : "light");
  }, [dark]);
  const logout = async () => {
    try {
      await businessJson("/logout", {});
      businessSession(null);
      setAccount(null);
    } catch (cause) {
      setError(String(cause));
    }
  };
  if (loading)
    return (
      <div className="grid h-dvh place-items-center bg-background text-xs text-muted-foreground">
        正在连接工作空间…
      </div>
    );
  if (!account) return <Login onLogin={login} name={name} />;
  const allowed = navigation.filter(
    (item) => !item.admin || account.user.role === "admin",
  );
  const path = route.split("?")[0],
    selected =
      path.split("/")[0] === "overview"
        ? "documents"
        : ["preview", "upload"].includes(path)
          ? "themes"
          : path.split("/")[0];
  const go = (value: string) => {
    setMobile(false);
    navigate(value);
  };
  const sidebar = (
    <>
      <div className="flex items-center gap-2 text-lg font-semibold">
        <Layers2 className="text-accent-foreground" />
        office.
        <span className="ml-auto rounded-md bg-accent px-1.5 py-1 text-[9px] text-accent-foreground">
          Workspace
        </span>
      </div>
      <div className="rounded-[13px] bg-secondary p-3 text-xs">{name}</div>
      <nav
        aria-label="工作空间导航"
        className="flex-1 space-y-1 overflow-y-auto"
      >
        {allowed.map((item, index) => (
          <div key={item.route}>
            {index === 0 || allowed[index - 1].group !== item.group ? (
              <p className="mb-2 mt-5 text-[10px] text-muted-foreground">
                {item.group}
              </p>
            ) : null}
            <a
              href={`#/${item.route}`}
              onClick={() => setMobile(false)}
              aria-current={selected === item.route ? "page" : undefined}
              className={cn(
                "flex h-[42px] items-center gap-3 rounded-[11px] px-3 text-xs hover:bg-accent",
                selected === item.route &&
                  "bg-accent font-medium text-accent-foreground",
              )}
            >
              <item.icon className="size-[18px]" />
              {item.label}
            </a>
          </div>
        ))}
      </nav>
      <div className="rounded-[14px] bg-muted p-3 text-[11px]">
        <p className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-success" />
          {account.user.role === "admin" ? "工作空间管理员" : "工作空间成员"}
        </p>
        <p className="mt-2 truncate text-muted-foreground">
          {account.user.displayName} · {account.user.username}
        </p>
      </div>
    </>
  );
  const restricted =
    (navigation.find((item) => item.route === selected)?.admin ||
      path === "jobs") &&
    account.user.role !== "admin";
  return (
    <ToastProvider>
      <div className="flex h-dvh gap-[14px] overflow-hidden bg-background p-3 lg:p-4">
        <aside className="hidden w-56 shrink-0 flex-col gap-5 rounded-[28px] bg-card p-[18px] lg:flex">
          {sidebar}
        </aside>
        <Dialog open={mobile} onOpenChange={setMobile}>
          <DialogContent className="left-3 top-3 flex h-[calc(100dvh-24px)] w-[min(300px,calc(100vw-24px))] translate-x-0 translate-y-0 flex-col gap-5 rounded-[24px] border-0 p-[18px]">
            <DialogTitle className="sr-only">工作空间导航</DialogTitle>
            <DialogDescription className="sr-only">
              选择文档与管理页面
            </DialogDescription>
            {sidebar}
          </DialogContent>
        </Dialog>
        <div className="flex min-w-0 flex-1 flex-col gap-[14px]">
          <header className="flex h-12 shrink-0 items-center gap-3 px-1 lg:h-14 lg:px-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="打开导航"
              onClick={() => setMobile(true)}
            >
              <Menu />
            </Button>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              工作空间 <span className="px-2">/</span>
              {allowed.find((item) => item.route === selected)?.label ||
                "文档详情"}
            </span>
            <span className="hidden text-xs sm:block">
              {account.user.displayName}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? "切换浅色" : "切换深色"}
              onClick={() => setDark((value) => !value)}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
            <Button variant="ghost" onClick={() => void logout()}>
              <LogOut />
              <span className="hidden sm:inline">退出登录</span>
            </Button>
          </header>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto rounded-[24px] bg-card p-5 lg:rounded-[28px] lg:p-8">
            <ErrorMessage value={error} />
            {restricted ? (
              <EmptyState title="需要管理员权限" />
            ) : path.startsWith("documents/") ? (
              <FileDetails key={path} id={path.slice(10)} navigate={go} />
            ) : selected === "documents" || selected === "overview" ? (
              <BusinessFiles navigate={go} userId={account.user.id} />
            ) : selected === "users" ? (
              <BusinessUsers />
            ) : selected === "events" ? (
              <BusinessEvents />
            ) : selected === "audit" ? (
              <BusinessAudit />
            ) : selected === "settings" ? (
              <BusinessSettings />
            ) : ["fonts", "themes", "upload", "preview", "jobs"].includes(
                path,
              ) ? (
              <CatalogProvider>
                {path === "fonts" ? (
                  <FontLibraryView onNavigate={go} />
                ) : path === "themes" ? (
                  <ThemeLibraryView onNavigate={go} />
                ) : path === "upload" ? (
                  <UploadView onNavigate={go} />
                ) : path === "preview" ? (
                  <PreviewView
                    initialTheme={
                      new URLSearchParams(route.split("?")[1]).get("theme") ||
                      ""
                    }
                  />
                ) : path === "jobs" ? (
                  <JobsView query={new URLSearchParams()} onNavigate={go} />
                ) : (
                  <EmptyState title="页面不存在" />
                )}
              </CatalogProvider>
            ) : (
              <EmptyState
                title="页面不存在"
                action={{ label: "返回文档", onClick: () => go("documents") }}
              />
            )}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
function BusinessFiles({
  navigate,
  userId,
}: {
  navigate: Navigate;
  userId: string;
}) {
  const [files, setFiles] = useState<BusinessFile[]>([]),
    [query, setQuery] = useState(""),
    [format, setFormat] = useState("all"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [name, setName] = useState("新文档"),
    [kind, setKind] = useState("txt");
  const upload = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    try {
      setFiles(
        (await businessRequest<{ files: BusinessFile[] }>("/files")).files,
      );
    } catch (cause) {
      setError(String(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const sendFile = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      await businessRequest(
        "/files?filename=" + encodeURIComponent(file.name),
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        },
      );
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  };
  const newDocument = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await businessJson<{ file: BusinessFile }>("/files", {
        name: `${name.replace(/\.(txt|md|html)$/i, "")}.${kind}`,
      });
      setCreate(false);
      await refresh();
      navigate(`documents/${result.file.id}`);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const visible = files.filter(
    (file) =>
      file.name.toLowerCase().includes(query.toLowerCase()) &&
      (format === "all" || file.format === format),
  );
  return (
    <>
      <PageHeader
        title="文档管理"
        description="在一个工作空间中管理业务文件，继续编辑并保存最终版本。"
        actions={
          <>
            <Button variant="outline" onClick={() => setCreate(true)}>
              <FilePlus2 />
              新建文档
            </Button>
            <Button disabled={busy} onClick={() => upload.current?.click()}>
              <Upload />
              {busy ? "正在上传…" : "上传文件"}
            </Button>
            <input
              ref={upload}
              className="hidden"
              type="file"
              aria-label="上传业务文件"
              accept=".docx,.xlsx,.pptx,.pdf,.html,.htm,.md,.txt,.png,.jpg,.jpeg,.webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void sendFile(file);
              }}
            />
          </>
        }
      />
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        {[
          ["可访问文档", files.length],
          ["我负责的", files.filter((file) => file.ownerId === userId).length],
          [
            "已有业务回写",
            files.filter((file) => file.lastPublishedRevision !== null).length,
          ],
        ].map(([label, count]) => (
          <div
            key={label}
            className="min-w-0 rounded-[18px] bg-muted p-3 sm:p-5"
          >
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <strong className="mt-2 block text-[22px] font-semibold sm:text-[27px]">
              {count}
            </strong>
          </div>
        ))}
      </div>
      <ErrorMessage value={error} />
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-[180px] flex-1">
          <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label="搜索业务文件"
            placeholder="搜索文件名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Select
          className="w-36"
          aria-label="筛选文件类型"
          value={format}
          onChange={(event) => setFormat(event.target.value)}
        >
          <option value="all">所有格式</option>
          {[...new Set(files.map((file) => file.format))].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新文件"
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </Button>
      </div>
      {visible.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] text-muted-foreground">
              <tr>
                <th className="p-3 font-normal">文档名称</th>
                <th className="p-3 font-normal">业务版本</th>
                <th className="hidden p-3 font-normal sm:table-cell">负责人</th>
                <th className="hidden p-3 font-normal md:table-cell">
                  更新时间
                </th>
                <th className="p-3 font-normal">访问权限</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((file) => (
                <tr
                  key={file.id}
                  className="border-t border-border hover:bg-muted"
                >
                  <td className="p-3">
                    <button
                      className="flex max-w-[420px] items-center gap-3 text-left"
                      onClick={() => navigate(`documents/${file.id}`)}
                    >
                      <FormatIcon format={file.format} />
                      <span className="min-w-0">
                        <strong className="block break-all text-xs font-medium">
                          {file.name}
                        </strong>
                        <small className="mt-1 block text-[10px] text-muted-foreground">
                          {file.format.toUpperCase()} · {formatBytes(file.size)}
                        </small>
                      </span>
                    </button>
                  </td>
                  <td className="p-3">
                    <Badge variant="secondary">{file.version}</Badge>
                  </td>
                  <td className="hidden p-3 text-muted-foreground sm:table-cell">
                    {file.ownerName}
                  </td>
                  <td className="hidden whitespace-nowrap p-3 text-muted-foreground md:table-cell">
                    {dateText(file.modifiedAt)}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {file.canManage
                      ? "可管理"
                      : file.operations.includes("document.edit")
                        ? "可编辑"
                        : "只读"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={query ? "未找到匹配文件" : "开始你的第一份文档"}
          description="上传已有文件，或新建一份文档。"
        />
      )}
      <Dialog open={create} onOpenChange={setCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建业务文档</DialogTitle>
            <DialogDescription>
              创建后可进入编辑器，所有修改先保存为 HCD 修订。
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(event) => void newDocument(event)}
          >
            <Field label="文档名称">
              <Input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="文件格式">
              <Select
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="txt">TXT 纯文本</option>
                <option value="md">Markdown</option>
                <option value="html">HTML</option>
              </Select>
            </Field>
            <ErrorMessage value={error} />
            <Button disabled={busy || !name.trim()}>创建文档</Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
type Grant = { userId: string; profile: string; operations: string[] };
type Access = {
  ownerId: string;
  users: { id: string; username: string; displayName: string }[];
  grants: Grant[];
};
type Version = {
  version: string;
  size: number;
  created_at: string;
  receipt: { revision: number } | null;
};
function FileDetails({ id, navigate }: { id: string; navigate: Navigate }) {
  const [file, setFile] = useState<BusinessFile | null>(null),
    [versions, setVersions] = useState<Version[]>([]),
    [access, setAccess] = useState<Access | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState(""),
    [profile, setProfile] = useState("viewer"),
    [granted, setGranted] = useState(businessProfiles.viewer);
  const [themes, setThemes] = useState<
      { themeRevisionId: string; name: string }[]
    >([]),
    [theme, setTheme] = useState("");
  const load = useCallback(async () => {
    try {
      const value = (
        await businessRequest<{ file: BusinessFile }>(`/files/${id}`)
      ).file;
      setFile(value);
      if (value.operations.includes("history.view"))
        setVersions(
          (
            await businessRequest<{ versions: Version[] }>(
              `/files/${id}/versions`,
            )
          ).versions,
        );
      if (value.canManage)
        setAccess(await businessRequest<Access>(`/files/${id}/acl`));
      if (value.operations.includes("theme.assign"))
        setThemes(
          (
            await businessRequest<{
              themes: { themeRevisionId: string; name: string }[];
            }>(`/files/${id}/themes`)
          ).themes,
        );
    } catch (cause) {
      setError(String(cause));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const task = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!file)
    return (
      <>
        <Button
          variant="ghost"
          className="self-start"
          onClick={() => navigate("documents")}
        >
          <ArrowLeft />
          返回文档
        </Button>
        <ErrorMessage value={error} />
        <EmptyState title={error ? "无法打开此文件" : "正在读取文件…"} />
      </>
    );
  return (
    <>
      <Button
        variant="ghost"
        className="self-start"
        onClick={() => navigate("documents")}
      >
        <ArrowLeft />
        返回文档
      </Button>
      <PageHeader
        title={file.name}
        description={`${file.format.toUpperCase()} · ${formatBytes(file.size)} · ${file.ownerName} 负责`}
        actions={
          <>
            <Button variant="outline" onClick={() => void load()}>
              <RefreshCw />
              刷新状态
            </Button>
            <Button asChild>
              <a
                href={`/editor/?workspaceFile=${id}&locale=zh-CN`}
                target="_blank"
                rel="noopener"
              >
                <ArrowUpRight />
                {file.operations.includes("document.edit")
                  ? "进入编辑器"
                  : "打开只读预览"}
              </a>
            </Button>
          </>
        }
      />
      <ErrorMessage value={error} />
      {message && <Notice title={message} />}
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ["当前业务版本", file.version],
          [
            "最近回写的工作区修订",
            file.lastPublishedRevision === null
              ? "尚未回写"
              : `r${file.lastPublishedRevision}`,
          ],
          ["最近业务更新时间", dateText(file.modifiedAt)],
        ].map(([label, value]) => (
          <Panel key={label}>
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <strong className="mt-3 block break-words text-base font-medium">
              {value}
            </strong>
          </Panel>
        ))}
      </div>
      <Notice title="编辑保存与业务回写分别记录">
        进入编辑器可查看 HCD
        当前修订和历史；编辑内容保存后，使用“回写业务系统”生成新的业务版本。此处显示已确认的业务文件。
      </Notice>
      {file.operations.includes("history.view") && (
        <Panel>
          <h2 className="mb-4 text-base font-semibold">业务版本历史</h2>
          <div className="space-y-2">
            {versions.map((version) => (
              <div
                key={version.version}
                className="flex flex-wrap items-center gap-3 rounded-xl bg-muted p-3 text-xs"
              >
                <strong>{version.version}</strong>
                <span className="text-muted-foreground">
                  {version.receipt
                    ? `来自工作区 r${version.receipt.revision}`
                    : "原始导入文件"}
                </span>
                <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                  {dateText(version.created_at)}
                </span>
                {file.operations.includes("document.download") && (
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={`/workspace/api/files/${id}/download?version=${version.version}`}
                    >
                      下载此版本
                    </a>
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}
      {file.operations.includes("theme.assign") && (
        <Panel>
          <h2 className="text-base font-semibold">文档字体主题</h2>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            指定后形成工作区修订；在编辑器检查效果并回写业务文件。
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Select
              aria-label="文档字体主题"
              className="min-w-40 flex-1"
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
            >
              <option value="">选择主题</option>
              <option value="__none">取消当前主题</option>
              {themes.map((item) => (
                <option key={item.themeRevisionId} value={item.themeRevisionId}>
                  {item.name}
                </option>
              ))}
            </Select>
            <Button
              disabled={busy || !theme}
              onClick={() =>
                void task(async () => {
                  await businessJson(`/files/${id}/theme`, {
                    themeRevisionId: theme === "__none" ? null : theme,
                  });
                  setMessage("文档主题已更新，请在编辑器检查并回写。");
                })
              }
            >
              应用主题
            </Button>
          </div>
        </Panel>
      )}
      {access && (
        <Panel>
          <h2 className="text-base font-semibold">文件访问权限</h2>
          <p className="mt-2 text-xs leading-6 text-muted-foreground">
            负责人和工作空间管理员始终可以管理此文件；其他成员按下方授权访问。
          </p>
          <div className="mt-4 space-y-2">
            {access.grants.map((grant) => (
              <div
                key={grant.userId}
                className="flex flex-wrap items-center gap-3 rounded-xl bg-muted p-3 text-xs"
              >
                <strong>
                  {access.users.find((user) => user.id === grant.userId)
                    ?.displayName || grant.userId}
                </strong>
                <Badge variant="secondary">{roleLabels[grant.profile]}</Badge>
                <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                  {grant.operations.map((op) => operationLabels[op]).join("、")}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void task(() =>
                      businessRequest(`/files/${id}/acl/${grant.userId}`, {
                        method: "DELETE",
                      }),
                    )
                  }
                >
                  移除授权
                </Button>
              </div>
            ))}
          </div>
          <form
            className="mt-5 space-y-4 border-t border-border pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              void task(async () => {
                await businessJson(
                  `/files/${id}/acl`,
                  { userId, profile, operations: granted },
                  "PUT",
                );
                setMessage("文件权限已更新，对已有编辑会话生效。");
              });
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="授权成员">
                <Select
                  required
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                >
                  <option value="">选择工作空间成员</option>
                  {access.users
                    .filter((user) => user.id !== access.ownerId)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName} · {user.username}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="文件角色">
                <Select
                  value={profile}
                  onChange={(event) => {
                    setProfile(event.target.value);
                    setGranted(businessProfiles[event.target.value]);
                  }}
                >
                  {Object.entries(roleLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <fieldset>
              <legend className="mb-3 text-xs">允许的操作</legend>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Object.entries(operationLabels).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-[11px]"
                  >
                    <input
                      type="checkbox"
                      checked={granted.includes(key)}
                      disabled={key === "document.view"}
                      onChange={(event) =>
                        setGranted((old) =>
                          event.target.checked
                            ? [...old, key]
                            : old.filter((op) => op !== key),
                        )
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <Button disabled={busy || !userId}>保存文件权限</Button>
          </form>
        </Panel>
      )}
    </>
  );
}
function BusinessUsers() {
  const [users, setUsers] = useState<BusinessUser[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [reset, setReset] = useState<BusinessUser | null>(null);
  const [username, setUsername] = useState(""),
    [displayName, setDisplayName] = useState(""),
    [password, setPassword] = useState(""),
    [role, setRole] = useState("member");
  const load = useCallback(async () => {
    try {
      setUsers(
        (await businessRequest<{ users: BusinessUser[] }>("/users")).users,
      );
    } catch (cause) {
      setError(String(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const update = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    await update(async () => {
      if (reset)
        await businessJson(`/users/${reset.id}`, { password }, "PATCH");
      else
        await businessJson("/users", { username, displayName, password, role });
      setOpen(false);
      setPassword("");
    });
  };
  return (
    <>
      <PageHeader
        title="用户与角色"
        description="账号由当前工作空间保管，文件访问按文档单独授权。"
        actions={
          <Button
            onClick={() => {
              setReset(null);
              setUsername("");
              setDisplayName("");
              setPassword("");
              setRole("member");
              setOpen(true);
            }}
          >
            <Users />
            添加用户
          </Button>
        }
      />
      <ErrorMessage value={error} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] text-muted-foreground">
            <tr>
              {["成员", "工作空间角色", "账号状态", "操作"].map((label) => (
                <th key={label} className="p-3 font-normal">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-t border-border">
                <td className="p-3">
                  <strong className="block font-medium">
                    {user.displayName}
                  </strong>
                  <small className="text-muted-foreground">
                    {user.username}
                  </small>
                </td>
                <td className="p-3">
                  <Select
                    aria-label={`${user.username}的工作空间角色`}
                    className="w-36"
                    value={user.role}
                    disabled={busy}
                    onChange={(event) =>
                      void update(async () => {
                        await businessJson(
                          `/users/${user.id}`,
                          { role: event.target.value },
                          "PATCH",
                        );
                      })
                    }
                  >
                    <option value="member">普通成员</option>
                    <option value="admin">管理员</option>
                  </Select>
                </td>
                <td className="p-3">
                  <Badge variant={user.disabled ? "muted" : "success"}>
                    {user.disabled ? "已停用" : "正常"}
                  </Badge>
                </td>
                <td className="p-3">
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setReset(user);
                        setPassword("");
                        setOpen(true);
                      }}
                    >
                      重置密码
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void update(async () => {
                          await businessJson(
                            `/users/${user.id}`,
                            { disabled: !user.disabled },
                            "PATCH",
                          );
                        })
                      }
                    >
                      {user.disabled ? "启用用户" : "停用用户"}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Notice title="停用、角色调整与密码重置会结束该用户的登录会话">
        已发出的编辑 token
        仍需经过实时业务鉴权；停用后不能继续提交内容。最后一个管理员受到保护。
      </Notice>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value);
            setPassword("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reset ? `重置 ${reset.displayName} 的密码` : "添加工作空间用户"}
            </DialogTitle>
            <DialogDescription>
              密码至少 12 个字符，UTF-8 不超过 1024 字节，不会在保存后显示。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void create(event)} className="space-y-5">
            {!reset && (
              <>
                <Field label="用户账号">
                  <Input
                    required
                    value={username}
                    pattern="[a-z0-9_.-]{3,64}"
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </Field>
                <Field label="显示名称">
                  <Input
                    required
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </Field>
                <Field label="工作空间角色">
                  <Select
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                  >
                    <option value="member">普通成员</option>
                    <option value="admin">管理员</option>
                  </Select>
                </Field>
              </>
            )}
            <Field label={reset ? "新密码" : "初始密码"}>
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <ErrorMessage value={error} />
            <Button disabled={busy}>{reset ? "保存新密码" : "创建用户"}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
type EventRow = {
  id: string;
  file_id: string;
  sequence: number;
  type: string;
  received_at: string;
  body: { payload: { receipt: { externalVersion: string; revision: number } } };
};
function BusinessEvents() {
  const [events, setEvents] = useState<EventRow[]>([]),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setEvents(
        (await businessRequest<{ events: EventRow[] }>("/events")).events,
      );
    } catch (cause) {
      setError(String(cause));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  return (
    <>
      <PageHeader
        title="业务事件"
        description="已验签并持久化接收的业务回写通知，按 eventId 去重。"
        actions={
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw />
            刷新事件
          </Button>
        }
      />
      <ErrorMessage value={error} />
      <Notice title="文件提交回执与异步通知分别记录">
        文件保存以同步 commit
        回执为准；事件可能延迟或重复，重复接收不会重复创建业务版本。
      </Notice>
      {events.length ? (
        <div className="space-y-3">
          {events.map((event) => (
            <Panel key={event.id}>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <CheckCircle2 className="size-4 text-success" />
                <strong>业务文件已回写</strong>
                <Badge variant="success">已持久接收</Badge>
                <time className="ml-auto text-muted-foreground">
                  {dateText(event.received_at)}
                </time>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                工作区 r{event.body.payload.receipt.revision} → 业务版本{" "}
                {event.body.payload.receipt.externalVersion} · 文档事件 #
                {event.sequence}
              </p>
              <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                {event.id}
              </p>
            </Panel>
          ))}
        </div>
      ) : (
        <EmptyState
          title="尚未收到业务事件"
          description="回写业务文件成功后，通知会在此出现。"
        />
      )}
    </>
  );
}
function BusinessAudit() {
  const [records, setRecords] = useState<
      {
        id: number;
        actor_name: string;
        action: string;
        target_id: string | null;
        created_at: string;
      }[]
    >([]),
    [error, setError] = useState("");
  useEffect(() => {
    void businessRequest<{ records: typeof records }>("/audit")
      .then((value) => setRecords(value.records))
      .catch((cause) => setError(String(cause)));
  }, []);
  const labels: Record<string, string> = {
    "workspace.initialized": "初始化工作空间",
    "session.login": "登录",
    "session.logout": "退出登录",
    "user.created": "添加用户",
    "user.updated": "更新用户",
    "file.created": "创建业务文件",
    "acl.updated": "更新文件权限",
    "acl.removed": "移除文件权限",
    "publication.committed": "回写业务文件",
  };
  return (
    <>
      <PageHeader
        title="操作记录"
        description="当前业务库记录的账号、权限与文件操作，最近 200 条。"
      />
      <ErrorMessage value={error} />
      <div className="space-y-2">
        {records.map((record) => (
          <div
            key={record.id}
            className="flex flex-wrap items-center gap-3 rounded-xl bg-muted p-4 text-xs"
          >
            <strong>{labels[record.action] || record.action}</strong>
            <span>{record.actor_name || "系统"}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {record.target_id}
            </span>
            <time className="text-muted-foreground">
              {dateText(record.created_at)}
            </time>
          </div>
        ))}
      </div>
    </>
  );
}
