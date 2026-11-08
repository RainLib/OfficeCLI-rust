# 可编辑行内容器：原生共同模型与离线基础

2026-10-26。此批完成原生 Rust、直接 HTTP/CLI 与离线文件路径，**尚未开放浏览器插入/编辑入口，也未完成 CRDT 行内容器协同**。不是完整七阶段目标的完成声明。管理平台和实际提醒发送继续后置。

## 共同模型

正文不进入业务 `data`，也不以整段 JSON 充当一个可覆盖的文字 atom。段落的 inline 可以包含独立的 `content`：

```json
{
  "text": "",
  "content": {
    "kind": "extension",
    "extension": {
      "schemaVersion": "hcd.extension/3",
      "instanceId": "x_0000000000000000000000000000001b",
      "type": "example.inline_field",
      "version": 77,
      "display": "inline",
      "contentModel": "inline",
      "data": {"project": "P-27"},
      "fallback": {"text": "Field label"}
    },
    "inlines": [{"text": "Shared中😀", "bold": true}]
  }
}
```

- `instanceId` 标识容器，内部每段文字/提及保留各自来源 ID。外部 wrapper 的 `text` 必须为空，不能附带另一份正文、格式、来源或 atom；实际文字只在 `content.inlines` 中。
- `content` 共用原生块 DTO，但此位置只允许 extension kind、inline display、inline content model，不允许块子树、代码块或普通块伪装。内部可以嵌套行内容器、普通文字、格式 mark、提及和已有行内 atom；继续遵守总层数、跨度、文字量、身份唯一性与 JSON/资源边界。
- 空容器保留业务身份，规范保存为内部空文字来源载体；后续文字 splice 在同一来源上填字。没有把标签插入正文作为占位字符。
- 规范 HTML 使用 `span` 和 `data-hcd-inline-container="true"`，内部是正常文字节点及来源映射。HTML 不另存隐藏正文 JSON，`fallback` 只是标签，不替代实际正文。非法标签/标记组合拒绝。
- 格式、来源、资源和引用遍历都进入行内子树。提及增加独立 `inlinePath`，与原有块 `childPath` 分开；`inlineIndex` 仍表示最终叶子在所在层的索引。没有行内路径的旧结果不增加该字段。
- 保存规范化保留空 wrapper、递归处理来源；正文内部发生变化时不能误判为普通顶层 text-only/style-only 快捷保存。还原继续复用不可变对象，模型要求保持为3。

## 模型门禁

包含行内容器的 HCD 声明 `capabilities.extensionNodes:3`。旧版 native 只接受1/2，会拒绝打开；新版也拒绝未知模型4。故意降为模型2的文件不能通过验证或投影。

编辑投影、结构 patch 和 checkpoint 还要求 `X-HCD-Inline-Containers-Version:1`；结构写入同时要求 `X-HCD-Extension-Version:3`。缺少声明、未知声明、已有内容却提交去掉子树的旧 snapshot，均拒绝且不写入。人员提及、mark、权限、版本/来源 precondition 原有检查继续适用，声明能力不授予写权限。

当前浏览器/sidecar仍使用 wire7、SDK 的 envelope1/2 和 blocks-v1 声明；**本批未修改其能力广告或增加编辑按钮**。旧客户端不能读入新子树再静默丢弃。Native 的新路径可由明确声明模型的服务调用；这不等于当前浏览器已经支持协同编辑它。

## 逐格式结果

| 目标 | 本次已核对 | 边界 |
|---|---|---|
| HCD/HCDZ | 未知业务v77、嵌套/空容器、mark、提及、全部来源和资源字节、版本1–8精确回读 | 需要支持模型3的 native |
| DOCX | 正文、提及姓名、嵌套文字、资源图片；粗体/斜体/高亮从OOXML核对 | 业务身份不保留；含图片的行内 adapter 可能拆段 |
| PDF | 正文/姓名/资源、粗体/斜体/高亮；一页实际渲染目检 | 静态呈现，不保留业务身份或编辑能力 |
| PPTX | 正文/姓名/资源回读 | 通用转换器展平部分文字 run 格式，能力报告强制降为 static；部分图片输出拆段 |
| Markdown | 原文和姓名经真实再导入解析后回读，图片采用可读资源说明 | 基础粗体/斜体仍会展平，能力报告为 static；业务身份不保留 |
| HTML检视 | 正常 span 子树与嵌入载荷保留 | 仅规范检视，不当作 HTML 业务节点/资源完整回导的证明 |

adapter 必须声明 `includeContent:true`，不能拿旧快照覆盖实时子树。默认行内容器导出正文，不将标签重复插入正文；宿主可追加受限文字/资源呈现。PPTX/MD 的实际 body 转换能力不能被宿主 adapter 的 semantic 声明升级。

## 实际验证

新建自有隔离原生 HTTP 服务，用真实鉴权用户/只读用户/协同服务身份完成：

1. r1 导入；r2 创建含两层正文、两层提及、未知mark、PNG资源的容器，以及空容器。
2. 缺少/未知行内模型的投影与结构写入、旧 envelope 写入，以及去掉子树的协调器 snapshot 均426；snapshot 明确因行内容器模型拒绝，未用别的错误冒充门禁证明。前后 native 全部文件字节精确相同。
3. r3 修改内部正文；r4 修改业务属性，正文/来源保持；只读403、旧版本409，属性修改不产生新提及事件。
4. r5 复制并重新分配容器/提及/文字来源；r6 给空容器填字。两层 `inlinePath` 分别为 `[1]`、`[1,2]`，最终四处提及各有独立 occurrence。
5. r7 还原r2，r8还原r6，**r2.blocks==r7.blocks、r6.blocks==r8.blocks**，包含来源/hash。打包后在无原稿目录解包，版本1–8投影精确相等，资源PNG字节相等。
6. 实际 DOCX/PPTX/PDF/MD 文字回读及 DOCX run 样式核对；业务属性/ticket没有混入Office包。提醒仍关闭，没有发送。

第一次文件探针直接比较 Markdown 转义前缀，随后改为实际再导入解析；该探针错误不算产品故障。最终使用新夹具、新 native 和完整重测结果。服务在验证结束后正常退出，没有为了观察超时重启；不将此流程称为服务重启/多实例或生产验收。

89项core、43项DOCX、53项格式、162项CLI单元测试，以及native构建、相关all-targets Clippy、fmt/diff通过。没有修改前端实现或将历史前端测试计为本批新结果。

证据：[HTTP](../assets/hcd-inline-content-native-2026-10-26/http-evidence.json)、[文件](../assets/hcd-inline-content-native-2026-10-26/file-evidence.json)、[规范r8](../assets/hcd-inline-content-native-2026-10-26/projection-r8.json)、[两层提及](../assets/hcd-inline-content-native-2026-10-26/references-r8.json)、[导出能力](../assets/hcd-inline-content-native-2026-10-26/export-capabilities.json)、[PDF整页](../assets/hcd-inline-content-native-2026-10-26/pdf-r8.png)、[检查/模型负例](../assets/hcd-inline-content-native-2026-10-26/validation.json)。

复现：

```sh
cargo test -p hcd-core -p hcd-docx -p hcd-formats --lib
cargo test -p officecli --bin officecli
cargo clippy -p hcd-core -p officecli --all-targets -- -D warnings
cargo build -p officecli
python3 scripts/hcd-inline-content-native.py
python3 scripts/hcd-inline-content-audit.py <owned-root>/private.json
```

## 后续接入顺序

1. 为每个行内容器建立永久共享文字载体。父段落只存稳定引用；内部文字沿用独立 Yjs 字符/格式身份，不能将整个 body 放进 embed JSON 或属性意图。后续已完成[内部共享载体和位置映射内核](hcd-inline-carriers.zh.md)及16项回归；尚未接入活动房间或保存链路。
2. 补父级一个 embed 存储位置与 ProseMirror `子树大小+2` 之间的映射；内部选区、相对位置、来源回执、AI目标和协作光标进入相应载体，不能沿用atom的一个字符偏移假设。
3. 接入 NodeEditStore 的属性候选、自己的历史、复制/剪贴板、删除审阅/迟到输入和不可用codec保护；验证嵌套、空内容和跨边界操作。
4. 更新影子验证、客户端/服务端协同模型与能力声明后，再开放 SDK 定义、统一命令、菜单/属性面板及实际浏览器双端验收。
5. 继续补 PPTX/Markdown run 格式、含图片的行内排版、HTML业务节点/资源回导，以及原计划其余容量、国际化、设备和生产验收。
