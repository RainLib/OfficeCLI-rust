import * as React from "react";
import {
  AlertCircle,
  Check,
  FileCode2,
  FileImage,
  FileText,
  Info,
  LoaderCircle,
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
        : ["png", "jpg", "jpeg", "webp"].includes(f)
          ? FileImage
          : ["md", "markdown", "html"].includes(f)
            ? FileCode2
            : FileText;
  return (
    <span
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-muted",
        f === "xlsx"
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
