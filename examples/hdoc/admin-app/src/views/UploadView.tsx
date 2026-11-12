import * as React from "react";
import { Trash2, Upload, UploadCloud } from "lucide-react";

import { PageHeader } from "@/components/Page";
import { IdChip } from "@/components/IdChip";
import { useToast } from "@/components/Toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import {
  SCRIPT_OPTIONS,
  formatBytes,
  formatExactBytes,
  guessFormat,
  subfamilyOf,
} from "@/lib/format";
import type { FontFace, FontScript, PendingFace } from "@/lib/types";
import { useCatalog } from "@/state/CatalogProvider";

const MAX_FONT_BYTES = 32 * 1024 * 1024;
const FONT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function UploadView({ onNavigate }: { onNavigate: (route: string) => void }) {
  const toast = useToast();
  const { refresh } = useCatalog();
  const [fontId, setFontId] = React.useState("");
  const [family, setFamily] = React.useState("");
  const [licenseName, setLicenseName] = React.useState("");
  const [expires, setExpires] = React.useState("");
  const [web, setWeb] = React.useState(true);
  const [ooxml, setOoxml] = React.useState(true);
  const [pdf, setPdf] = React.useState(false);
  const [redistribution, setRedistribution] = React.useState(false);
  const [faces, setFaces] = React.useState<PendingFace[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState("");
  const [savedId, setSavedId] = React.useState<string | null>(null);

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const accepted: PendingFace[] = [];
    for (const file of Array.from(list)) {
      const format = guessFormat(file.name);
      if (!format) {
        toast.push(`${file.name}：只支持 woff2 / otf / ttf`, "err");
        continue;
      }
      if (file.size > MAX_FONT_BYTES) {
        toast.push(
          `${file.name}：${formatBytes(file.size)} 超过单库上限 32 MiB`,
          "err",
        );
        continue;
      }
      accepted.push({
        name: file.name,
        format,
        bytes: new Uint8Array(await file.arrayBuffer()),
        subfamily: subfamilyOf(file.name),
        weight: 400,
        style: "normal",
        stretch: "normal",
        scripts: ["latin"],
      });
    }
    if (accepted.length) setFaces((current) => [...current, ...accepted]);
  };

  const patch = (index: number, next: Partial<PendingFace>) =>
    setFaces((current) =>
      current.map((face, position) =>
        position === index ? { ...face, ...next } : face,
      ),
    );

  const invalid =
    !FONT_ID_PATTERN.test(fontId) || !family.trim() || faces.length === 0;

  const submit = async () => {
    setBusy(true);
    try {
      const stored: string[] = [];
      for (const [index, face] of faces.entries()) {
        setProgress(`正在上传字库 ${index + 1}/${faces.length}：${face.name}`);
        const blob = await api.putBlob(fontId, face.format, face.bytes);
        stored.push(blob.sha256);
      }
      const payloadFaces: FontFace[] = faces.map((face, index) => ({
        family: family.trim(),
        subfamily: face.subfamily.trim() || "Regular",
        weight: face.weight,
        style: face.style,
        stretch: face.stretch,
        scripts: face.scripts.length ? face.scripts : (["latin"] as FontScript[]),
        format: face.format,
        sha256: stored[index],
        byteLength: face.bytes.length,
      }));
      const license = {
        name: licenseName.trim() || "未命名",
        webPreview: web,
        ooxmlEmbed: ooxml,
        pdfEmbed: pdf,
        redistribution,
        ...(expires
          ? { expiresAtEpochMs: new Date(`${expires}T23:59:59`).getTime() }
          : {}),
      };
      setProgress("正在登记字体修订…");
      const revision = await api.createRevision(fontId, {
        family: family.trim(),
        faces: payloadFaces,
        license,
      });
      setSavedId(revision.fontRevisionId);
      setFaces([]);
      toast.push(
        `已登记 ${revision.fontId} · ${revision.faces.length} 个字面`,
        "ok",
      );
      await refresh();
    } catch (error) {
      toast.err(error);
    } finally {
      setProgress("");
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="上传登记"
        description="字库按 sha256 存成不可变 blob，再和许可证、脚本槽位一起登记成一次字体修订。单个字库上限 32 MiB。"
      />

      {savedId ? (
        <Card className="border-success/30">
          <CardHeader>
            <CardTitle>修订已登记</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm">
            <IdChip value={savedId} keep={16} />
            <span className="text-xs text-muted-foreground">
              把这个 id 填进主题的槽位，或用于文档钉版。
            </span>
            <Button size="sm" variant="outline" onClick={() => onNavigate("themes")}>
              去新建主题
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSavedId(null)}>
              继续登记
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>字体标识</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="font-id">fontId</Label>
                <Input
                  id="font-id"
                  value={fontId}
                  onChange={(event) => setFontId(event.target.value.trim())}
                  placeholder="source-han-sans"
                  aria-invalid={fontId.length > 0 && !FONT_ID_PATTERN.test(fontId)}
                />
                <p className="text-[11px] text-muted-foreground">
                  小写字母、数字、连字符；1–64 个字符，不以连字符开头或结尾。
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="family">字族名 family</Label>
                <Input
                  id="family"
                  value={family}
                  onChange={(event) => setFamily(event.target.value)}
                  placeholder="Source Han Sans"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>许可证</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="license-name">名称</Label>
                  <Input
                    id="license-name"
                    value={licenseName}
                    onChange={(event) => setLicenseName(event.target.value)}
                    placeholder="OFL-1.1"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="license-expires">到期（可选）</Label>
                  <Input
                    id="license-expires"
                    type="date"
                    value={expires}
                    onChange={(event) => setExpires(event.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    className="mt-0.5"
                    checked={web}
                    onChange={(event) => setWeb(event.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-foreground">网页预览</span>
                    <span className="block text-muted-foreground">
                      允许把字面内联给编辑页与预览（超过 8 MiB 的字面仍会跳过）。
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    className="mt-0.5"
                    checked={ooxml}
                    onChange={(event) => setOoxml(event.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-foreground">OOXML 嵌入</span>
                    <span className="block text-muted-foreground">
                      docx / pptx 导出时才写入字库字节；关闭则只登记字体名。
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    className="mt-0.5"
                    checked={pdf}
                    onChange={(event) => setPdf(event.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-foreground">PDF 嵌入</span>
                    <span className="block text-muted-foreground">
                      PDF 导出注册该字面；关闭则导出报告写明未嵌入原因。
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    className="mt-0.5"
                    checked={redistribution}
                    onChange={(event) => setRedistribution(event.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-foreground">允许再分发</span>
                    <span className="block text-muted-foreground">
                      记录用；托管或分发前据此判断能否带字库。
                    </span>
                  </span>
                </label>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>字库文件</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Input
              type="file"
              multiple
              accept=".woff2,.otf,.ttf"
              aria-label="选择字库文件"
              onChange={(event) => void addFiles(event.target.files)}
            />
            {faces.length === 0 ? (
              <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-6 text-xs text-muted-foreground">
                <UploadCloud className="size-4" />
                还没有选择文件。woff2 只适合网页预览，OOXML / PDF 导出只嵌入 TTF / OTF。
              </p>
            ) : null}
            {faces.map((face, index) => (
              <FaceEditor
                key={`${face.name}-${index}`}
                face={face}
                onPatch={(next) => patch(index, next)}
                onRemove={() =>
                  setFaces((current) => current.filter((_, p) => p !== index))
                }
              />
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="sticky bottom-0 -mx-5 -mb-4 flex flex-wrap items-center gap-3 border-t bg-card/95 px-5 py-3 backdrop-blur">
        <span className="text-xs text-muted-foreground">
          {faces.length} 个字面 ·{" "}
          {formatBytes(faces.reduce((total, face) => total + face.bytes.length, 0))}
        </span>
        {progress ? (
          <span className="tabular text-xs text-primary">{progress}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setFaces([]);
              setSavedId(null);
            }}
          >
            清空
          </Button>
          <Button size="sm" disabled={busy || invalid} onClick={() => void submit()}>
            <Upload />
            {busy ? "提交中…" : "上传并登记修订"}
          </Button>
        </div>
      </div>
    </>
  );
}

function FaceEditor({
  face,
  onPatch,
  onRemove,
}: {
  face: PendingFace;
  onPatch: (next: Partial<PendingFace>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <code className="max-w-full truncate rounded bg-background px-1.5 py-0.5 font-mono text-xs">
          {face.name}
        </code>
        <Badge variant="secondary">{face.format}</Badge>
        <span
          className="tabular text-xs text-muted-foreground"
          title={formatExactBytes(face.bytes.length)}
        >
          {formatBytes(face.bytes.length)}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto size-7"
          aria-label={`移除 ${face.name}`}
          onClick={onRemove}
        >
          <Trash2 />
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <div className="grid gap-1">
          <Label htmlFor={`subfam-${face.name}`}>字面名</Label>
          <Input
            id={`subfam-${face.name}`}
            className="h-7 text-xs"
            value={face.subfamily}
            onChange={(event) => onPatch({ subfamily: event.target.value })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`weight-${face.name}`}>字重</Label>
          <Input
            id={`weight-${face.name}`}
            type="number"
            min={1}
            max={1000}
            step={100}
            className="tabular h-7 text-xs"
            value={face.weight}
            onChange={(event) => onPatch({ weight: Number(event.target.value) || 400 })}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`style-${face.name}`}>样式</Label>
          <Select
            id={`style-${face.name}`}
            className="h-7 text-xs"
            value={face.style}
            onChange={(event) =>
              onPatch({ style: event.target.value as PendingFace["style"] })
            }
          >
            <option value="normal">normal</option>
            <option value="italic">italic</option>
            <option value="oblique">oblique</option>
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`stretch-${face.name}`}>宽度</Label>
          <Select
            id={`stretch-${face.name}`}
            className="h-7 text-xs"
            value={face.stretch}
            onChange={(event) =>
              onPatch({ stretch: event.target.value as PendingFace["stretch"] })
            }
          >
            <option value="normal">normal</option>
            <option value="condensed">condensed</option>
            <option value="expanded">expanded</option>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-muted-foreground">脚本槽位</span>
        {SCRIPT_OPTIONS.map((script) => (
          <label key={script} className="flex items-center gap-1.5 text-xs">
            <Checkbox
              checked={face.scripts.includes(script)}
              onChange={(event) =>
                onPatch({
                  scripts: event.target.checked
                    ? [...face.scripts, script]
                    : face.scripts.filter((item) => item !== script),
                })
              }
            />
            <span className="font-mono">{script}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
