import * as React from "react";
import { Check, ExternalLink, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/Page";
import { Notice, SectionHeading } from "@/components/Workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCatalog } from "@/state/CatalogProvider";
import {
  editorSettings,
  formatTime,
  openEditor,
  saveEditorSettings,
} from "@/lib/workspace";
import { useToast } from "@/components/Toast";

export function SettingsView() {
  const { service, busy, refresh } = useCatalog();
  const [url, setUrl] = React.useState(() => editorSettings().url);
  const [error, setError] = React.useState("");
  const toast = useToast();
  return (
    <>
      <PageHeader
        title="服务设置"
        description="查看运行状态和工作目录，配置当前浏览器的编辑器入口。"
        actions={
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw />
            刷新状态
          </Button>
        }
      />
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ["文档 API", service?.api ? "已启用" : "等待连接", location.origin],
          [
            "HTTP MCP",
            service?.mcp ? "已启用" : "等待连接",
            "/v1/documents/{id}/mcp · 使用文档令牌",
          ],
          [
            "AI 模型",
            service
              ? service.agentAvailable
                ? "已配置"
                : "尚未配置"
              : "等待连接",
            service?.agentModel || "服务端配置",
          ],
        ].map(([title, status, detail]) => (
          <div key={title} className="space-y-3 rounded-[20px] bg-muted p-6">
            <p className="text-xs text-muted-foreground">{title}</p>
            <strong className="block text-xl font-semibold">{status}</strong>
            <p className="break-all text-[11px] text-muted-foreground">
              {detail}
            </p>
          </div>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="space-y-6 rounded-[20px] bg-muted p-6">
          <SectionHeading title="工作目录与运行信息" />
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-6 text-xs">
            {[
              ["文档目录", service?.documentsRoot],
              ["字体目录", service?.catalogRoot],
              [
                "存储方式",
                service
                  ? service.storage === "local"
                    ? "本机目录"
                    : "远端存储与本机缓存"
                  : undefined,
              ],
              [
                "默认主题",
                service?.defaultThemeRevisionId ||
                  (service ? "未指定" : undefined),
              ],
              [
                "协作服务",
                service ? "按文档连接；可用性由编辑器连接核验" : undefined,
              ],
              ["导出并发", service?.exportConcurrency?.toString()],
              [
                "服务启动",
                service ? formatTime(service.startedAtEpochMs) : undefined,
              ],
              ["服务版本", service?.version],
            ].map(([label, value]) => (
              <React.Fragment key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all leading-6">{value || "—"}</dd>
              </React.Fragment>
            ))}
          </dl>
          <Notice title="通过服务启动参数调整目录">
            修改服务目录或模型配置后重启服务；此处展示当前生效值。
          </Notice>
        </section>
        <section className="space-y-6 rounded-[20px] bg-muted p-6">
          <SectionHeading title="文档编辑器" />
          <p className="text-xs leading-7 text-muted-foreground">
            后台与文档工作台可以独立运行。设置编辑器地址后，从文档详情打开时会安全传递该文档的访问凭证。
          </p>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                saveEditorSettings(url.trim());
                setError("");
                toast.push("编辑器地址已保存。", "ok");
              } catch (cause) {
                setError(String(cause));
              }
            }}
          >
            <label className="grid gap-2 text-xs">
              编辑器地址
              <Input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://127.0.0.1:8767/"
              />
            </label>
            {error && (
              <p role="alert" className="text-xs leading-6 text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit">
                <Check />
                保存入口
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void openEditor().catch(toast.err)}
              >
                <ExternalLink />
                打开已保存的编辑器
              </Button>
            </div>
          </form>
          <Notice title="配置与当前浏览器绑定">
            编辑器需连接同一个文档服务。文档令牌通过窗口消息传递，并核对来源与一次性标识。
          </Notice>
        </section>
      </div>
    </>
  );
}
