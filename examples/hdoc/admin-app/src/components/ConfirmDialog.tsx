import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface ConfirmRequest {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
}

/**
 * Catalog mutations are destructive and irreversible on a same-machine disk
 * store, so they go through a dialog instead of `window.confirm`: the reason
 * and the guard stay on screen while the operator clicks.
 */
export function ConfirmDialog({
  request,
  open,
  onOpenChange,
}: {
  request: ConfirmRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [busy, setBusy] = React.useState(false);

  return (
    <Dialog
      open={open && request !== null}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription asChild>
            <div>{request?.description}</div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant={request?.destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={async () => {
              if (!request) return;
              setBusy(true);
              try {
                await request.onConfirm();
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "执行中…" : (request?.confirmLabel ?? "确认")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function useConfirm() {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);
  const [open, setOpen] = React.useState(false);

  const confirm = React.useCallback((next: ConfirmRequest) => {
    setRequest(next);
    setOpen(true);
  }, []);

  const node = (
    <ConfirmDialog
      request={request}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setRequest(null);
      }}
    />
  );

  return { confirm, node };
}
