# 业务节点导出兼容预检

2026-10-25 更新：资源归档、可移植导出和富文本容器已接入，当前协同 wire 模型为 3、通用 envelope 为 2；以下早期保留项以[最新实现与边界](hcd-node-resources-and-rich-content.zh.md)为准。

2026-10-24。本阶段补齐下载前的业务信息提示；不代替完整格式保真、字体覆盖或业务导出适配器验收。管理平台与实际提醒发送继续后置。

## 固定版本的服务端声明

`GET /v1/documents/{id}/export-capabilities?revision=N` 要求文档读权限，返回 `Cache-Control: private, no-store`。固定版本必须存在；未来版本返回 409，不能悄悄使用当前 head。响应包含：

```json
{
  "schemaVersion": "hcd-export-capabilities/1",
  "scope": "business-nodes",
  "documentId": "example",
  "revision": 4,
  "features": []
}
```

`features` 当前按 `extension_inline`、`extension_block`、`reference` 三类汇总，每项包含数量、最多 3 个可读示例，以及各目标格式、源文件模式、原生 HCD 的能力声明。每个示例最多 160 个 Unicode 字符。服务端从已验证的历史索引、分块读取规范 HTML，不建立整份编辑投影、不加载宿主业务代码、不返回业务 JSON、节点身份或人员目标 ID。扩展和引用分别最多 10000 个身份，重复或无效 envelope 拒绝；扫描占用有界导出槽，HTTP 任务取消后仍由实际扫描持有槽直至结束。

能力分为 `native / semantic / static / unsupported`，数据保留另以 `native / embedded / omitted` 描述，不能把“可读文字还在”当作“业务数据可恢复”。当前共同 envelope 的实际转换是：

| 目标 | 当前业务节点表现 | 业务数据 |
| --- | --- | --- |
| 原生 HCD 包 | 保留规范节点、身份、版本及 JSON 载荷 | native；不意味着业务扩展已加载，也不是新增打包下载入口 |
| DOCX、XLSX、PPTX、PDF、Markdown、TXT 的语义转换 | 可读替代文字；原有业务交互不随文件提供 | omitted |
| HTTP HTML 导出 | 静态可读内容；规范 data 属性仍在文件中 | embedded，接收方可读取，不是数据脱敏 |
| 保留源文件模式 | 无法承载后来加入规范版本的业务节点 | unsupported |

以上只说明业务节点经过转换器时的表示，不承诺任意源文档都能转换成七种目标，也不承诺页面、图片、字体、复杂结构或第三方 Office 的视觉一致。已有导出检查与保真报告仍然执行。HTML 带嵌入数据不等于业务交互或完整导入回转已实现。

目前所有共同业务节点采用上述通用文字替代，尚未连接按业务类型/版本区分的原生或语义适配器。[显式业务迁移](hcd-node-migrations.zh.md)已接入受检节点命令；自定义 marks、富文本容器、资源及逐类型导出 adapters 继续属于完整 SDK 后续工作，不能将三类汇总声明计作这些接口已交付。

## 下载与保存的联动

1. 工具栏加载当前已保存版本的预检；点击提示可展开行内元素、块、引用的数量、有限示例和保留方式。
2. 点击导出先走既有联合保存。保存失败或仍有未确认修改时不下载，并提示先处理保存问题。
3. 保存成功后，以实际回执版本重新获取导出选项和兼容声明。下载请求明确携带同一版本号。
4. 若出现新的业务节点数量或转换/数据保留方式发生变化，先更新提示并结束此次下载动作；用户核对后再次导出。普通版本号、示例文字变化不要求重复复核。
5. 不支持的模式禁用下载；预检失败不能静默跳过。停止下载等待不取消已经开始的正常保存。

兼容摘要依据声明计算，未来的 native/semantic 结果不会被界面硬编码显示成 static。说明使用浏览器顶层浮层，避免被紧凑工具栏的滚动区域裁切；支持键盘、Escape、点击外部关闭及滚动/缩放后的关闭。简体、繁体和英文均有翻译。

本轮另修复保存尚未就绪时误报“修订未加载”的提示。只有当前文字、图片与已保存回执完整相符，且协同仍已连接并同步时，才清除残留的临时连接警告；接到连接事件本身不等于保存成功。

## 实际文件发现的问题与修复

五格式探针最初发现 PDF 将任务替代文字中的 U+2610“☐”丢掉，不能用只检查任务标题来认定成功。现在 HTML/CSS 打印副本按完整 grapheme 选择覆盖该字符的次级字体，保留原始 Unicode；不重写规范 HTML、属性、注释或业务数据。真实 PDF 文字回读恢复完整替代文本，并渲染检查了整页。

该修复依赖配置或系统中可用且覆盖所需字符的次级字体，不构成所有平台/脚本/字体覆盖保证；完整字体打包、缺字诊断与跨设备排版仍在后续范围。原有 Markdown 专用任务标记处理没有扩展成业务数据转换。

## 验证与复验

- 初版预检：`cargo test -p hcd-core -p officecli` 449 项通过，含 66 项核心和 142 项 CLI 单元及现有集成测试。PDF 修复后 CLI 单元更新为 143 项并全部重跑通过；另重跑 2 项 PDF CLI 集成回归。原生构建、相关 all-targets Clippy、fmt 和 diff 检查通过。
- 前端：456 项测试通过；独立页和嵌入构建通过。决策测试覆盖固定版本、数量/保留方式变化、源模式拒绝、空文档、错误声明和未来 native/semantic 摘要。
- 原生 HTTP：只读候选可查预检及导出，未鉴权拒绝，r1 历史为空，未来版本拒绝；r4 原生 HCD、四个扩展和一个引用的载荷保留。五种实际文件为 DOCX、PDF、Markdown、TXT、HTML；前四种逐项回读替代文字，HTML 另解析嵌入 envelope 并与规范数据深比较，导出未改变 manifest。
- 真实 CUA 页面：预检从 6 项更新为 7 项，导出先保存 r7，再显示复核提示；再次点击实际下载 r7 DOCX，独立 ZIP/XML 回读确认原有五处内容各一次、新任务两处。HTML 显示嵌入数据提醒；中英繁体切换通过。自有 sidecar 暂停时导出被拒绝、草稿保留，恢复后继续保存；不把暂停当服务终止重启。

复验：先构建原生二进制并安装编辑器依赖，在仓库根执行：

```bash
python3 scripts/hcd-mention-preview.py --extension-nodes --node-conflicts --node-sdk --pages-prefix .hcd-export-cap
# 将上一步打印的临时 root 作为下面参数；只操作明确的隔离样例。
python3 scripts/hcd-export-capabilities-verify.py /absolute/temporary/hcd-mention-preview-example --seed-reference
```

文件探针适用初始四扩展/单引用样例，不应在浏览器已新增业务节点后重跑该固定数量用例。真实页面下载与后续草稿恢复有独立证据，不用测试环境冒充生产、多实例、真实模型或设备验收。

- [原生/API/五格式文件证据](../assets/hcd-extensions-2026-10-24/export-capabilities-file-evidence.json)
- [真实页面与下载回读](../assets/hcd-extensions-2026-10-24/export-capabilities-browser-evidence.json)
- [保存后重新复核](../assets/hcd-extensions-2026-10-24/export-capabilities-review.png)
- [HTML 嵌入数据提醒](../assets/hcd-extensions-2026-10-24/export-capabilities-html.png)

## 2026-10-29：兼容性检查失败后的重试

共用导出操作区现在要求兼容性检查结果匹配当前文档、版本、会话令牌、服务地址和源文件刷新代次，检查中禁用导出并显示状态；检查失败时显示原因并允许重试。保存后仍重新核对目标版本，内容或资源保留声明变化时沿用既有复核门禁。会话标识只用于内存比较，不写入界面或日志。

隔离 Word 固定版式浏览器中代理让首次兼容性请求返回 503，DOCX 和 HCDZ 的导出均被禁用；重试后下载 HCDZ，实际解包得到预期 `region-ui` r1，见[失败界面](../assets/hcd-word-source-text-replay-2026-10-29/capability-failed.png)和[解包记录](../assets/hcd-word-source-text-replay-2026-10-29/capability-retry-readback.json)。专项测试覆盖文档、版本、令牌、地址与刷新代次不匹配，以及原有转换复核规则。本次故障为本机代理注入，仅在 Word 浏览器完成端到端验收，其他格式、真实断网和生产环境仍需验证。

## 2026-10-29：预检响应有界读取

原文件选项和业务内容兼容性预检现在从响应头到正文共用 120 秒时限，并以 64 KiB 限制读取 JSON，严格检查 UTF-8；超时、超限或非法响应不会启用导出，界面可重试。切换文档或关闭时取消等待，忽略取消的迟到响应会被关闭；这不保证服务器端已经开始的只读检查立即停止。时间上限意味着极慢的大文档预检可能需要重试，仍需性能优化。

18 项导出检查和有界读取专项覆盖卡住的响应头与正文、迟到响应、切换取消、超限及正常 JSON。隔离 Excel 浏览器代理返回 65,537 字节的兼容性响应时，保存后的 r1 导出保持禁用；恢复服务并重试后实际 XLSX 包含修改，原公式及缓存值保留，见[文件回读](../assets/hcd-export-preflight-bounded-2026-10-29/readback.json)。超时使用短时限受控测试验证，未等待真实浏览器的 120 秒时限，也未验证生产慢网及大文档性能。
