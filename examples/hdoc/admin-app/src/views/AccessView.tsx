import * as React from "react";
import { Check, Copy, LogOut, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/Page";
import { Notice, SectionHeading } from "@/components/Workspace";
import { TokenDialog } from "@/components/TokenDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useCatalog } from "@/state/CatalogProvider";
import { tokenStore } from "@/lib/api";
import { documentTokens } from "@/lib/workspace";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function AccessView() {
  const { session, documents, refresh } = useCatalog();
  const [scope, setScope] = React.useState("read");
  const [documentId, setDocumentId] = React.useState("");
  const [userId, setUserId] = React.useState("");
  const [ttl, setTtl] = React.useState("3600");
  const [copied, setCopied] = React.useState(false);
  const [now, setNow] = React.useState(Date.now());
  const { confirm, node } = useConfirm();
  const toast = useToast();
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  React.useEffect(() => setCopied(false), [scope, documentId, userId, ttl]);
  const needsDocument = scope === "read" || scope === "write";
  const valid =
    (!needsDocument || /^[\w-]{1,128}$/.test(documentId)) &&
    /^\d+$/.test(ttl) &&
    Number(ttl) >= 1 &&
    Number(ttl) <= 3600 &&
    userId.length <= 128 &&
    !/[\r\n\0]/.test(userId);
  const command = valid
    ? `officecli hdoc issue-token --document-id ${quote(needsDocument ? documentId : "*")} --scope ${scope}${userId.trim() ? ` --user-id ${quote(userId.trim())}` : ""} --ttl-seconds ${Number(ttl)}`
    : "";
  return (
    <>
      <PageHeader
        title="访问与令牌"
        description="查看当前管理会话，按文档与操作范围生成签发命令。"
        actions={<TokenDialog onSaved={() => void refresh()} />}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_1.25fr]">
        <section className="space-y-6 rounded-[20px] bg-muted p-6">
          <SectionHeading title="当前管理会话" />
          <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
            <ShieldCheck className="size-6" />
          </span>
          <dl className="grid grid-cols-[auto_1fr] gap-5 text-xs">
            <dt className="text-muted-foreground">身份</dt>
            <dd className="break-all">
              {session?.displayName || session?.userId || "尚未连接"}
            </dd>
            <dt className="text-muted-foreground">权限</dt>
            <dd>{session ? "admin · 字体、主题与后台元数据" : "—"}</dd>
            <dt className="text-muted-foreground">范围</dt>
            <dd>{session?.documentId || "—"}</dd>
            <dt className="text-muted-foreground">有效时间</dt>
            <dd>
              {session
                ? Math.max(
                    0,
                    Math.ceil((session.expiresAt * 1000 - now) / 60_000),
                  ) + " 分钟"
                : "—"}
            </dd>
            <dt className="text-muted-foreground">保存位置</dt>
            <dd>当前浏览器会话</dd>
          </dl>
          <Notice title="内容访问按文档单独授权">
            管理员可以指定文档主题。查看正文需 read 或
            write；修改内容、恢复历史需 write；导入使用 upload。
          </Notice>
          <Button
            variant="outline"
            className="w-full"
            onClick={() =>
              confirm({
                title: "清除当前后台会话？",
                description:
                  "清除此后台保存的管理、上传和文档令牌。已打开的编辑器使用自己的会话。",
                confirmLabel: "清除后台会话",
                onConfirm: () => {
                  documentTokens.clear();
                  sessionStorage.removeItem("hcdAdminUploadToken");
                  tokenStore.set("");
                  toast.push("后台会话已清除。", "ok");
                },
              })
            }
          >
            <LogOut />
            清除当前会话
          </Button>
        </section>
        <section className="space-y-6 rounded-[20px] bg-muted p-6">
          <SectionHeading title="生成令牌签发命令" />
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="grid gap-2 text-xs">
              权限范围
              <Select
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value="read">read · 只读文档</option>
                <option value="write">write · 编辑文档</option>
                <option value="upload">upload · 导入文档</option>
                <option value="admin">admin · 后台管理</option>
              </Select>
            </label>
            <label className="grid gap-2 text-xs">
              有效期（1–3600 秒）
              <Input
                type="number"
                min="1"
                max="3600"
                value={ttl}
                onChange={(event) => setTtl(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs sm:col-span-2">
              文档 ID
              <Input
                disabled={!needsDocument}
                list="token-documents"
                value={needsDocument ? documentId : "*"}
                placeholder="选择或输入 documentId"
                onChange={(event) => setDocumentId(event.target.value)}
              />
              <datalist id="token-documents">
                {documents?.map((doc) => (
                  <option key={doc.documentId} value={doc.documentId} />
                ))}
              </datalist>
            </label>
            <label className="grid gap-2 text-xs sm:col-span-2">
              使用者 ID（AI 任务需稳定身份）
              <Input
                value={userId}
                maxLength={128}
                onChange={(event) => setUserId(event.target.value)}
                placeholder="例如 workspace-user"
              />
            </label>
          </div>
          <div className="space-y-4 rounded-2xl bg-card p-5">
            <p className="text-xs font-medium">在运行服务的机器上执行</p>
            <code className="block whitespace-pre-wrap break-all text-xs leading-7">
              {command || "请选择有效文档 ID，并填写 1–3600 秒有效期。"}
            </code>
            <Button
              variant="outline"
              size="sm"
              disabled={!valid}
              onClick={() =>
                void navigator.clipboard
                  .writeText(command)
                  .then(() => setCopied(true))
                  .catch(() =>
                    toast.push("未能自动复制，请选中上方命令复制。", "err"),
                  )
              }
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "已复制" : "复制命令"}
            </Button>
          </div>
          <Notice title="签名密钥保留在服务端">
            页面只生成命令。命令需使用服务相同的 HCD_TOKEN_SECRET
            环境变量。令牌到期后重新签发并连接。
          </Notice>
        </section>
      </div>
      {node}
    </>
  );
}
