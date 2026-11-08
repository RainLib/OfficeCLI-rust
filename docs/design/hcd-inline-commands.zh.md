# 行内容器统一命令与宿主注册（2026-10-27）

本增量将模型 3 的行内富文本容器接到统一命令和 React 注册生命周期，沿用独立正文、因果属性、个人历史、签名房间及保存协议。它没有完成主编辑页的整体接入：普通节点接口继续兼容旧模型，主编辑页对尚未完成的模型 3 链路仍保留保护提示。

## 注册与命令

`EmbeddedHcdEditorProps.inlineContainerExtensions` 是独立的注册入口，不能把 `contentModel:'inline'` 放进普通 `nodeExtensions`。React provider 为每个编辑器维护自己的注册器，`onReady` 返回清理函数，注销或配置替换后取消旧实例的待提交操作；较早的 effect 清理不能关闭更新的连接。错误经 `onError` 和配置错误提示呈现，不授予文档写入或房间升级权限。

```ts
import type {
  InlineContainerExtensions,
} from '@officecli/hcd-reference-editor/inline-containers'

const inlineContainerExtensions: InlineContainerExtensions = {
  nodes: [{
    type: 'business.field', version: 1,
    display: 'inline', contentModel: 'inline',
    label: { 'zh-CN': '业务字段', 'en-US': 'Business field' },
    defaultData: { title: '字段' },
    validate: data => typeof data.title === 'string',
    fallback: data => String(data.title),
    properties: [{ key: 'title', label: '名称', kind: 'text', required: true }],
  }],
  onReady: service => service.subscribe(() => refreshHost()),
  onError: error => reportHostError(error),
}
```

注册的插入命令为 `node.inline.insert.<type>`，保留定义中的翻译标签、图标、分组及排序，复用 ribbon、右键、`/`、块插入和命令面板。它调用统一的 `node.insert`，参数显式包含 `model:'inline'`。只有宿主能力同时声明 `customNodes`、`inlineContainers` 且当前插入动作可用时才启用；登记 codec 不能自行协商模型。旧原子/块适配器遇到这个参数会拒绝，避免同名节点插成错误类型。

公开 SDK 新增 `prepareInlineContainerTransaction` 和 `selectedInlineContainer`。前者支持插入、属性、已归档资源关联、删除与显式迁移；构造阶段不写正文，提交时重新检查文档、选区、stored marks、输入法组合状态、编辑权限和 codec。真实文字留在独立的永久正文中，属性与资源命令不重建正文、来源和字符身份。

`/` 插入与删除触发词构成一个事务，失败保留原查询；块前/后插入新建段落，保留参照块。缺少模型 schema 的宿主整次拒绝。空容器的真实正文区域现在有最小可点击宽度，解决初次插入后难以点击输入的问题。

迁移先检查确定性的完整预览，再通过私有事务许可仅替换 envelope。伪造字符串 meta、预览过期、迁移顺带修改正文/标记/来源均被拒绝。原始定义与正文身份保留，当前版本进入正常属性候选/保存链路。迁移后若旧 codec 不可用，历史保护仍可能阻止重做；没有将此验收描述成任意版本间的无条件撤销重做。

## 验证与证据

证据目录：`docs/assets/hcd-inline-commands-2026-10-27/`。

- **前端代码**：57 项专项、完整 **1042 项**测试通过，TypeScript、独立应用与嵌入包构建通过。覆盖命令能力、只读、过期选区/正文、输入法组合门禁、注册清理、资源更新、私有迁移许可、个人撤销保留同伴输入、`/` 单次提交及块前后插入。
- **实际包消费者**：运行 `npm pack`，解包到隔离目录；严格 TypeScript 检查公开注册 props/service、拒绝旧定义，执行真实 JavaScript 的 PM 插入、NodeSelection、属性更新及卸载后的待提交拒绝。首次测试宿主遗漏 JSON 初始内容及 view.editable，修正后完整重跑通过；没有修改生产逻辑以迎合测试，也没有发布 npm。
- **真实浏览器**：React StrictMode 下两个真实编辑器交换本机 Yjs 更新，使用生产 provider、`useCommands`、命令面板、`/` 菜单和 NodeView。中文搜索和 Enter 插入、空正文点击输入、属性修改、卸载只读、显式迁移及另一成员升级前只读均已观察；编辑器只读后仍接收同伴新输入。独立页面不写原生或用户文档，不冒充完整主编辑页或操作系统 IME 验收。
- **真实 Socket / 原生文件**：生产 sidecar 与原生 HTTP，从独立 r8 副本开始，命令插入和属性更新、一个已有真实归档资源的关联及版本 1→2 迁移进入正常保存；正文可见字符身份保持不变。重启 sidecar 后重新加载并保存至 r11，DOCX、PDF、PPTX、Markdown 实际文件均含更新后的业务标题和实时正文。HCDZ 离线规范内容精确一致、validate 通过，原始归档摘要不变。导出报告保留语义转换和静态化警告，不宣称 Office 原生业务关系或精确版式无损。

```sh
cd examples/hdoc/editor
npm test
npm run build
cd ../../..
python3 scripts/hcd-inline-commands-package.py
python3 scripts/hcd-inline-room-files.py --commands
python3 scripts/hcd-inline-binding-preview.py --commands
```

## 主编辑页接入仍须完成

当前注册 props 和命令分派已预接，但主编辑页尚未开放模型 3；不能把独立宿主的成功算成编辑页全流程完成。后续必须同时接入：

1. 先协商有效 Session，再建立对应模型的房间、schema、结构 binding、历史保护和递归 snapshot；模型 3 不得按 chunk 数退回普通固定分段编辑器。
2. 属性选择/候选/冲突与迁移面板显式支持 envelope 3；含容器的块复制、移动、转换使用正确身份和保护策略，不能只放开按钮。
3. 自定义节点资源上传和设备文件日志适配 envelope 3，使用协商后的 Session；目前 `node.resources` 验证的是已归档描述关联，不代表新文件选择的重启恢复已经完成。
4. 删除审阅、保存状态、恢复包比较/确认与设备草稿接入同一模型，保留未知扩展正文和迟到同伴输入。
5. 主页面的真实多人浏览器、保存重开/导出/离线和权限失效验收后再移除保护提示。容器内部 AI 选区、跨文档附件、长文分页与容量、Word 追加基础能力及此前七阶段开放项继续实施。

管理平台和真实提醒投递保持后置。整体目标仍未完成。
