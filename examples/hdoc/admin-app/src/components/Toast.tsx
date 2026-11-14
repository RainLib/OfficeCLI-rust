import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from "lucide-react";

import { cn } from "@/lib/utils";

type Tone = "ok" | "err" | "warn" | "info";

interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

interface ToastApi {
  push: (text: string, tone?: Tone) => void;
  err: (error: unknown) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = React.useContext(ToastContext);
  if (!context) throw new Error("useToast 必须在 ToastProvider 内使用");
  return context;
}

const ICONS: Record<Tone, React.ReactNode> = {
  ok: <CheckCircle2 className="size-4 text-success" />,
  err: <XCircle className="size-4 text-destructive" />,
  warn: <AlertTriangle className="size-4 text-warning" />,
  info: <Info className="size-4 text-muted-foreground" />,
};

const TONE_CLASS: Record<Tone, string> = {
  ok: "border-success/30",
  err: "border-destructive/40",
  warn: "border-warning/40",
  info: "border-border",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = React.useCallback(
    (text: string, tone: Tone = "info") => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, tone, text }]);
      // Errors stay until dismissed; everything else fades on its own.
      if (tone !== "err") {
        window.setTimeout(() => dismiss(id), tone === "ok" ? 4000 : 7000);
      }
    },
    [dismiss],
  );

  const api = React.useMemo<ToastApi>(
    () => ({
      push,
      err: (error: unknown) =>
        push(error instanceof Error ? error.message : String(error), "err"),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-lg border bg-card px-3 py-2 text-xs shadow-lg",
              TONE_CLASS[toast.tone],
            )}
          >
            <span className="mt-px shrink-0">{ICONS[toast.tone]}</span>
            <span className="min-w-0 flex-1 break-words">{toast.text}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="关闭提示"
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
