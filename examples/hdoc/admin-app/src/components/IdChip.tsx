import * as React from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";
import { shortId } from "@/lib/format";

/**
 * Content-addressed ids are 64 hex characters: show a prefix, keep the full
 * digest one click away, and let the operator copy it into a pin request.
 */
export function IdChip({
  value,
  keep = 12,
  copy = true,
  className,
}: {
  value: string;
  keep?: number;
  copy?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  return (
    <span className={cn("inline-flex max-w-full items-center gap-1", className)}>
      <code
        title={value}
        className="tabular rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
      >
        {shortId(value, keep)}
      </code>
      {copy ? (
        <button
          type="button"
          aria-label="复制完整 id"
          title="复制完整 id"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
            } catch {
              /* clipboard may be blocked; the title still holds the id */
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? (
            <Check className="size-3.5 text-success" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
      ) : null}
    </span>
  );
}
