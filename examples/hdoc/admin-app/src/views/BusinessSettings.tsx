import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Database, RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/Page";
import { Notice } from "@/components/Workspace";
import { Button } from "@/components/ui/button";
import { businessRequest } from "@/lib/business";

type Service = {
  name: string;
  schemaVersion: string;
  ai: { enabled: boolean };
  storage: { business: string; editing: string };
  deployment: { provider: string; offlineReleaseVerified: boolean };
};

export function BusinessSettings() {
  const [service, setService] = useState<Service | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setService(await businessRequest<Service>("/service"));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <PageHeader
        title="服务设置"
        description="查看当前工作空间的接入方式、数据保存与部署策略。"
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
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-destructive/10 p-4 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {(
          [
            [
              "业务接入",
              service ? "内置业务 Provider" : "正在连接…",
              "账号、文件和权限在当前部署内管理",
              ShieldCheck,
            ],
            [
              "编辑器入口",
              "同源站点",
              `${location.origin}/editor/`,
              CheckCircle2,
            ],
            [
              "AI 功能",
              service?.ai.enabled ? "已启用" : "已关闭",
              "未启用时隐藏入口，不读取个人模型配置",
              Database,
            ],
          ] as const
        ).map(([label, value, detail, Icon]) => {
          return (
            <section
              key={label}
              className="space-y-3 rounded-[20px] bg-muted p-6"
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{label}</span>
                <Icon className="size-4" />
              </div>
              <strong className="block text-xl font-semibold">{value}</strong>
              <p className="break-all text-[11px] leading-6 text-muted-foreground">
                {detail}
              </p>
            </section>
          );
        })}
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="space-y-5 rounded-[20px] border border-border p-6">
          <h2 className="text-base font-semibold">数据与存储职责</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-5 text-xs leading-6">
            <dt className="text-muted-foreground">源文件与最终版本</dt>
            <dd>业务 Provider 保存不可变文件版本</dd>
            <dt className="text-muted-foreground">用户与文档权限</dt>
            <dd>业务 Provider 管理账号、角色和文件授权</dd>
            <dt className="text-muted-foreground">正文与协作数据</dt>
            <dd>OfficeCLI 持久保存 HCD、编辑历史和协作状态</dd>
            <dt className="text-muted-foreground">业务提交与通知</dt>
            <dd>同步回执确认保存；Webhook 通知提交结果</dd>
            <dt className="text-muted-foreground">工作空间协议</dt>
            <dd>{service?.schemaVersion || "—"}</dd>
          </dl>
          <Notice title="接入已有业务系统">
            可以用使用方的 Provider
            接管身份、权限和文件存储，继续使用同一套编辑与回写接口。
          </Notice>
        </section>
        <section className="space-y-5 rounded-[20px] border border-border p-6">
          <h2 className="text-base font-semibold">离线部署</h2>
          <p className="text-xs leading-7 text-muted-foreground">
            管理台、编辑器与协作服务使用本地构建资源，登录和权限校验在部署网络内完成。
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-5 text-xs leading-6">
            <dt className="text-muted-foreground">静态资源</dt>
            <dd>随部署提供，无需在线加载 CDN</dd>
            <dt className="text-muted-foreground">字体与主题</dt>
            <dd>在品牌资源中登记并按许可证使用本地字体</dd>
            <dt className="text-muted-foreground">模型接入</dt>
            <dd>当前内置业务模式尚未开放 AI 委托；内网模型接入仍需建设</dd>
            <dt className="text-muted-foreground">全格式发行验收</dt>
            <dd>
              {service?.deployment.offlineReleaseVerified
                ? "已通过"
                : "尚未完成"}
            </dd>
          </dl>
          <Notice title="编辑数据需要长期保管">
            备份时一并保留业务库、文件版本、OfficeCLI
            编辑数据、字体主题和密钥。仅下载最终文档不能恢复全部编辑历史。
          </Notice>
        </section>
      </div>
    </>
  );
}
