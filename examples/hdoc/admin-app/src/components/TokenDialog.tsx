import * as React from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { tokenStore } from "@/lib/api";
import { useToast } from "@/components/Toast";

const MINT =
  "officecli hdoc issue-token --document-id '*' --scope admin --ttl-seconds 3600";

/**
 * The console is same-origin with `hdoc serve` and has no session of its own:
 * an admin bearer token is pasted here and kept in sessionStorage only.
 */
export function TokenDialog({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const toast = useToast();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(tokenStore.get());
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <KeyRound />
          管理令牌
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>粘贴管理令牌</DialogTitle>
          <DialogDescription>
            令牌只存在这个页面的 sessionStorage 里，页面关掉就没了。目录的每一次读写都带它。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="admin-token">Bearer JWT</Label>
          <Input
            id="admin-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                tokenStore.set(draft);
                toast.push("令牌已保存，正在重新加载目录。", "ok");
                setOpen(false);
                onSaved();
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            在跑服务的那台机器上签发：
            <code className="tabular ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              {MINT}
            </code>
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            disabled={!draft.trim()}
            onClick={() => {
              tokenStore.set(draft);
              toast.push("令牌已保存，正在重新加载目录。", "ok");
              setOpen(false);
              onSaved();
            }}
          >
            保存并重载
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
