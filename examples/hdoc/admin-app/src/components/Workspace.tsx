import * as React from "react";
import {
  AlertCircle,
  Check,
  FileCode2,
  FileImage,
  FileText,
  Info,
  LoaderCircle,
  PanelsTopLeft,
  Presentation,
  Sheet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/components/Toast";
import { documentApi, documentTokens, stateLabel } from "@/lib/workspace";
import { cn } from "@/lib/utils";

export function FormatIcon({ format }: { format: string }) {
  const f = format.toLowerCase();
  const Icon =
    f === "xlsx"
      ? Sheet
      : f === "pptx"
        ? Presentation
        : f === "excalidraw"
          ? PanelsTopLeft
          : ["png", "jpg", "jpeg", "webp"].includes(f)
            ? FileImage
            : ["md", "markdown", "html"].includes(f)
              ? FileCode2
              : FileText;
  return (
    <span
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-muted",
        f === "excalidraw"
          ? "bg-[#eee6f3] text-[#644873] dark:bg-[#362a40] dark:text-[#ecdff4]"
          : f === "xlsx"
            ? "text-success"
            : f === "pptx"
              ? "text-warning"
              : f === "pdf"
                ? "text-destructive"
                : "text-accent-foreground",
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}

export function WorkspaceShelfArt({
  board,
  className,
}: {
  board: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 92 62"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {board ? (
        <g stroke="#634d71" strokeWidth="1.8">
          <path d="M24 25c1 18 14 22 29 17" strokeDasharray="3 4" />
          <path d="m49 38 6 3-4 5" />
          <g transform="rotate(-8 25 24)">
            <rect x="7" y="8" width="34" height="29" rx="5" fill="#e0cce7" />
            <path d="M15 18h12m-12 6h17" />
          </g>
          <g transform="rotate(6 65 38)">
            <rect x="55" y="26" width="29" height="26" rx="5" fill="#f8df9c" />
            <path d="m63 39 4 4 8-9" />
          </g>
          <path d="M66 10v5m-2.5-2.5h5" stroke="#9874aa" />
        </g>
      ) : (
        <g stroke="#466273" strokeWidth="1.8">
          <g transform="rotate(-10 34 30)">
            <rect x="15" y="9" width="39" height="45" rx="5" fill="#bed3dc" />
          </g>
          <g transform="rotate(6 51 30)">
            <path
              d="M35 5h26l9 10v34a4 4 0 0 1-4 4H35a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z"
              fill="#fffdf6"
            />
            <path d="M60 6v7a3 3 0 0 0 3 3h6M39 31h22m-22 6h17m-17 6h12" />
            <path d="M39 5h8v15l-4-3-4 3Z" fill="#edce87" />
          </g>
        </g>
      )}
    </svg>
  );
}

export function StatusBadge({ state }: { state: string }) {
  const variant = ["COMPLETE", "completed"].includes(state)
    ? "success"
    : ["failed", "interrupted"].includes(state)
      ? "destructive"
      : ["conflict", "cancelling"].includes(state)
        ? "warning"
        : ["running", "queued", "IMPORTING"].includes(state)
          ? "secondary"
          : "muted";
  return (
    <Badge
      variant={variant}
      className={cn(
        "rounded-lg border-0 px-2.5 py-1 text-[11px]",
        ["running", "queued"].includes(state) &&
          "bg-accent text-accent-foreground",
      )}
    >
      {["running", "queued", "cancelling"].includes(state) && (
        <LoaderCircle className="size-3 motion-safe:animate-spin" />
      )}
      {stateLabel(state)}
    </Badge>
  );
}

export function Notice({
  title,
  children,
  warning = false,
}: {
  title: string;
  children?: React.ReactNode;
  warning?: boolean;
}) {
  const Icon = warning ? AlertCircle : Info;
  return (
    <div
      role="status"
      className={cn(
        "flex min-w-0 gap-3 rounded-[14px] p-4",
        warning ? "bg-warning/10" : "bg-accent",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-[18px] shrink-0",
          warning ? "text-warning" : "text-accent-foreground",
        )}
      />
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium">{title}</p>
        {children && (
          <div className="break-words text-[11px] leading-6 text-muted-foreground">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export function SectionHeading({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <h2 className="text-[17px] font-semibold">{title}</h2>
      {action}
    </div>
  );
}

export function DocumentConnection({
  documentId,
  onConnected,
  children,
}: {
  documentId: string;
  onConnected?: () => void;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const toast = useToast();
  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setError("");
    try {
      const access = await documentApi.auth(documentId, draft.trim());
      if (
        access.documentId !== documentId ||
        !["read", "write"].includes(access.scope)
      )
        throw new Error("文档令牌范围不匹配。");
      documentTokens.set(documentId, draft);
      setOpen(false);
      setDraft("");
      toast.push(
        access.scope === "write"
          ? "已连接文档写入权限。"
          : "已连接文档只读权限。",
        "ok",
      );
      onConnected?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          setDraft("");
          setError("");
        }
      }}
    >
      <DialogTrigger asChild>
        {children || <Button variant="outline">连接文档令牌</Button>}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>连接文档访问权限</DialogTitle>
          <DialogDescription className="break-all">
            {documentId} · 令牌只保留在当前浏览器会话中。
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-5" onSubmit={(event) => void connect(event)}>
          <label className="grid gap-2 text-xs">
            文档只读或写入令牌
            <Input
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="粘贴此文档的短期令牌"
            />
          </label>
          <Notice title="权限由服务端核验">
            正文编辑、历史恢复和任务停止需要文档写入权限。
          </Notice>
          {error && (
            <p role="alert" className="text-xs leading-6 text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy || !draft.trim()}>
              {busy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check />
              )}
              验证并连接
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
