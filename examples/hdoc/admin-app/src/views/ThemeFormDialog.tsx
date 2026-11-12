import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { GROUP_NAMES, SLOT_KEYS, SLOT_NAMES } from "@/lib/format";
import type { ThemeFontSlots } from "@/lib/types";
import { slotOptions, useCatalog } from "@/state/CatalogProvider";
import { useToast } from "@/components/Toast";

const EMPTY_SLOTS: ThemeFontSlots = { latin: undefined, eastAsia: undefined, bidi: undefined };

/**
 * A theme is immutable: saving creates a new themeRevisionId, so this form only
 * ever adds. Documents keep the id they pinned, which is why a wrong theme is
 * retired rather than edited.
 */
export function ThemeFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { fonts, refresh } = useCatalog();
  const toast = useToast();
  const options = slotOptions(fonts);
  const [name, setName] = React.useState("");
  const [fallbacks, setFallbacks] = React.useState("");
  const [slots, setSlots] = React.useState<Record<"major" | "minor", ThemeFontSlots>>({
    major: { ...EMPTY_SLOTS },
    minor: { ...EMPTY_SLOTS },
  });
  const [busy, setBusy] = React.useState(false);

  const pick = (value: string): ThemeFontSlots["latin"] => {
    if (!value) return undefined;
    const [fontId, fontRevisionId] = value.split("/");
    return { fontId, fontRevisionId };
  };

  const anySlot = SLOT_KEYS.some(
    (key) => slots.major[key] || slots.minor[key],
  );
  const fallbackList = fallbacks
    .split(",")
    .map((family) => family.trim())
    .filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(640px,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>新建主题</DialogTitle>
          <DialogDescription>
            槽位留空即「不钉」：预览按回退族显示，导出不改写该脚本的字体。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="theme-name">主题名</Label>
              <Input
                id="theme-name"
                value={name}
                placeholder="Brand default"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="theme-fallback">回退字族（逗号分隔，最多 4 个）</Label>
              <Input
                id="theme-fallback"
                value={fallbacks}
                placeholder="system-ui, sans-serif"
                onChange={(event) => setFallbacks(event.target.value)}
              />
            </div>
          </div>

          {(["major", "minor"] as const).map((group) => (
            <fieldset key={group} className="grid gap-2 rounded-lg border p-3">
              <legend className="px-1 text-xs font-semibold">
                {GROUP_NAMES[group]}
              </legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {SLOT_KEYS.map((key) => (
                  <div key={key} className="grid gap-1.5">
                    <Label htmlFor={`${group}-${key}`}>{SLOT_NAMES[key]}</Label>
                    <Select
                      id={`${group}-${key}`}
                      disabled={options.length === 0}
                      value={
                        slots[group][key]
                          ? `${slots[group][key]!.fontId}/${slots[group][key]!.fontRevisionId}`
                          : ""
                      }
                      onChange={(event) =>
                        setSlots((current) => ({
                          ...current,
                          [group]: { ...current[group], [key]: pick(event.target.value) },
                        }))
                      }
                    >
                      <option value="">（不钉）</option>
                      {options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
            </fieldset>
          ))}

          {options.length === 0 ? (
            <p className="text-xs text-warning">
              目录里还没有带字面的字体修订，先去「上传登记」登记一个字体。
            </p>
          ) : null}
        </div>

        <DialogFooter>
          {fallbackList.length > 4 ? (
            <span className="mr-auto text-xs text-destructive">回退族最多 4 个</span>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy || !anySlot || fallbackList.length > 4}
            onClick={async () => {
              setBusy(true);
              try {
                const theme = await api.createTheme({
                  name: name.trim() || "未命名主题",
                  major: slots.major,
                  minor: slots.minor,
                  fallbackFamilies: fallbackList,
                });
                toast.push(
                  `主题已保存：${theme.name} · ${theme.themeRevisionId.slice(0, 12)}…`,
                  "ok",
                );
                onOpenChange(false);
                await refresh();
              } catch (error) {
                toast.err(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "保存中…" : "保存主题"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
