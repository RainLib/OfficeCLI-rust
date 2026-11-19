import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, Globe, Layers2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormatIcon, WorkspaceShelfArt } from "@/components/Workspace";
import { cn } from "@/lib/utils";

type PublicFile = {
  id: string;
  name: string;
  format: string;
  modifiedAt: string;
  permission?: "read" | "write";
  url: string;
};

function PublicShelf({
  board,
  files,
  searching,
}: {
  board: boolean;
  files: PublicFile[];
  searching: boolean;
}) {
  const title = board ? "白板" : "文档";
  const heading = board ? "public-boards" : "public-documents";
  return (
    <section
      aria-labelledby={heading}
      className="min-w-0 overflow-hidden rounded-[20px] border border-border bg-card"
    >
      <div
        className={cn(
          "flex items-center justify-between gap-4 px-5 py-5 sm:px-6",
          board
            ? "bg-[#eee6f3] text-[#543d64] dark:bg-[#322739] dark:text-[#e9daef]"
            : "bg-[#e6eef2] text-[#324e60] dark:bg-[#25343e] dark:text-[#d8e7ef]",
        )}
      >
        <div>
          <h2 id={heading} className="text-xl font-semibold">
            {title}
          </h2>
          <p className="mt-1 text-xs">
            {files.length} {board ? "块白板" : "份文档"}
          </p>
        </div>
        <WorkspaceShelfArt board={board} className="h-14 w-[84px] shrink-0" />
      </div>
      {files.length ? (
        <ul className="divide-y divide-border">
          {files.map((file) => (
            <li key={file.id}>
              <a
                href={file.url}
                className="group flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-4 transition-colors hover:bg-muted focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent-foreground sm:px-5"
              >
                <FormatIcon format={file.format} />
                <div className="min-w-0 flex-1">
                  <h3
                    className="truncate text-sm font-semibold"
                    title={file.name}
                  >
                    {file.name}
                  </h3>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {board ? "自由画布" : file.format.toUpperCase()}
                    </span>
                    {file.permission && (
                      <span>
                        {file.permission === "write"
                          ? "访客可编辑"
                          : "访客只读"}
                      </span>
                    )}
                    <time dateTime={file.modifiedAt}>
                      {new Date(file.modifiedAt).toLocaleDateString("zh-CN")}
                    </time>
                  </p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground group-hover:underline">
                  打开{title}
                  <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-6 py-8 text-sm text-muted-foreground">
          {searching ? "没有匹配的" : "暂无公开"}
          {title}
        </p>
      )}
    </section>
  );
}

export function PublicLibrary({ name }: { name: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = `公开文件库 · ${name}`;
    return () => {
      document.title = previous;
    };
  }, [name]);
  const [files, setFiles] = useState<PublicFile[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch("/workspace/api/public/files", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("暂时无法读取公开文件，请稍后重试。");
        return response.json() as Promise<{ files: PublicFile[] }>;
      })
      .then((value) => {
        if (!controller.signal.aborted) setFiles(value.files);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry]);
  const query = search.trim().toLocaleLowerCase();
  const documents: PublicFile[] = [],
    boards: PublicFile[] = [];
  for (const file of files) {
    if (file.name.toLocaleLowerCase().includes(query)) {
      (file.format === "excalidraw" ? boards : documents).push(file);
    }
  }
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-6 sm:px-10">
        <a
          href="/public"
          className="flex items-center gap-2 text-lg font-semibold"
        >
          <Layers2 className="size-6 text-accent-foreground" />
          office.
        </a>
        <Button variant="outline" asChild>
          <a href="/">
            登录工作空间
            <ArrowRight />
          </a>
        </Button>
      </header>
      <main className="mx-auto max-w-6xl space-y-7 px-5 py-7 sm:px-10 sm:py-12">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe aria-hidden="true" className="size-4" />
              {name}
            </p>
            <h1 className="text-3xl font-semibold sm:text-4xl">公开文件库</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              无需登录即可打开团队公开分享的文档和白板。
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground"
            />
            <Input
              type="search"
              className="bg-card pl-10"
              aria-label="搜索公开文件"
              placeholder="搜索文档或白板"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取公开文件…
          </p>
        ) : error ? (
          <div className="space-y-4">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button
              variant="outline"
              onClick={() => setRetry((value) => value + 1)}
            >
              重新加载
            </Button>
          </div>
        ) : (
          <div className="grid items-start gap-4 md:grid-cols-2">
            <PublicShelf
              board={false}
              files={documents}
              searching={Boolean(query)}
            />
            <PublicShelf board files={boards} searching={Boolean(query)} />
          </div>
        )}
      </main>
    </div>
  );
}
