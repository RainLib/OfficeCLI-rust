# 节点资源请求、协作选区与失败重试

日期：2026-10-25。接续 [资源与富文本扩展](hcd-node-resources-and-rich-content.zh.md)，补齐真实网络等待时的请求生命周期与协作选中状态。管理平台、批量附件管理和提醒发送仍后置。

## 已修复

1. **请求绑定会话**：资源上传/读取绑定当前注册服务的生命周期，卸载或替换连接会取消请求。旧 cleanup 不会关闭新连接，旧请求在重连后不能复活。即使 transport 不配合取消，调用也独立结束并消费迟到结果，上传 pending 只释放一次。
2. **取消和超时**：`archiveResource({file,name,key,signal?})` 接受调用方取消信号，内部总等待有 45 秒上限；信号传递到真实 HTTP fetch。属性栏在资源区域提供“取消归档”，卸载该视图会取消自己的上传。取消/失败后节点不自动改变，未应用的属性表单保留；已到达服务端的 staging 字节不自动绑定。
3. **稳定的行内选区**：原书签只记录块结构键，选中的自定义行内 atom 或人员提及没有块键；对方修改其他段落时会退化为普通文字选区，导致属性面板卸载。现在记录稳定 occurrence ID，投影后只在唯一匹配时恢复 NodeSelection。远程前插、不同块输入后仍选中原对象；对象删除则安全回到普通选区，不选中邻居。
4. **统一命令不随上传进度销毁**：资源 pending 的状态订阅与命令注册代次分离。进度只刷新状态；注册/卸载扩展才改变命令集合。否则异步归档完成时会拿到已关闭的旧命令服务。资源关联继续核对节点身份、预期 envelope、权限与冲突，不能绕过陈旧目标保护。
5. **提示同步**：结束归档后清除全局的“正在归档”阻止提示；属性面板报告取消或失败，命令失败还给出本地化的取消/选区变化/不可用原因。失败通过既有宿主 `onError` 提供诊断，不把任意异常内容直接显示给用户。

资源归档成功与资源引用保存仍是两步。字节以 hash 归档，只有 `node.resources` 普通事务关联后，才进入规范保存、协同与版本。重复上传同一字节不会因此给节点重复增加引用。普通附件仍通过原生 HCD 离线包保留，不冒充 Office 的原生附件组件。

## 实际验证

隔离 native、sidecar 和 Vite 后，使用只监听 loopback 的真实 HTTP 代理延迟特定合成资源 POST；没有浏览器请求拦截或假响应代替 native 成功路径。代理不记录凭证，控制文件仅用于测试，产品代码没有测试开关。

| 场景 | 已观察结果 |
|---|---|
| native 已返回 200，代理暂不交付响应 | 保存禁用，关闭留在编辑器，当前内容导出被保存门禁阻止 |
| 用户取消上述请求 | 浏览器中断连接，pending 释放；节点仍无新引用，属性草稿保留，规范仍 r6 |
| 代理返回 503 | 面板显示失败，操作恢复，属性草稿保留；规范仍 r6 |
| 同伴在富文本子段输入 | 修复后原行内节点保持选中，面板/草稿及上传继续；同伴输入保存到 r8 |
| 不转发上传，等待真实 deadline | 45.059 秒后浏览器中断连接，节点引用未改，保存恢复，属性草稿仍在 |
| 新窗口重试相同资源 | 只关联一次，保存 r9；未应用属性仍为原值 |
| 明确应用保留的属性 | 保存 r10，资源和同伴正文保留 |
| 版本/离线/下载 | r6/r8/r9/r10 DOCX、源文件缺席的 HCD 包解包后 DOCX/PDF/MD、浏览器实际 r10 DOCX 回读通过 |

所有四个节点身份、两个未知 v77 业务载荷、Alice 原子段、Bob 两处新增文本及两处 DOCX 图片保留。取消/失败没有为节点绑定资源；r9/r10 仅有一处 `ui-archive.txt` 引用。离线索引中的资源字节 hash/长度与原文件一致。文件回读及下载结束后 head 仍 r10。

前端 **501 项测试**、TypeScript、独立版/嵌入版构建及差异空白检查通过。新增用例覆盖不配合取消的 transport、旧生命周期迟到结果、旧 cleanup、读取取消、元数据捕获、deadline 释放、命令注册稳定性，以及行内节点/提及选区的远程输入与删除。初始真实双 WebSocket 还复验了资源/富文本插入、离线子段合并及自己的撤销/重做到 r6。本批没有 Rust 修改，未重复原生单测；运行证据使用当前原生程序，不能把历史原生测试计为本轮重跑。

调试过程中真实复现了两项故障后才修复。源码热更新后的既有开发窗口仍出现过异步关联失败，最终成功重试/保存/下载使用新窗口验收，不声称热更新迁移已经验证。两次 CUA 输入/点击观察超时均先读取实际 UI，确认已输入/已应用内容后再继续，没有因此重启服务。

- [浏览器全过程与限定范围](../assets/hcd-resource-lifecycle-2026-10-25/browser-evidence.json)
- [实际网络时间与 native 响应](../assets/hcd-resource-lifecycle-2026-10-25/network-evidence.json)
- [历史、资源字节与实际文件](../assets/hcd-resource-lifecycle-2026-10-25/file-evidence.json)
- [当前源码/构建摘要](../assets/hcd-resource-lifecycle-2026-10-25/validation.json)
- [同伴编辑期间保留选中与上传](../assets/hcd-resource-lifecycle-2026-10-25/peer-edit-keeps-selection.png)
- [已保存 r10](../assets/hcd-resource-lifecycle-2026-10-25/resource-saved-r10.png)
- [实际浏览器 DOCX](../assets/hcd-resource-lifecycle-2026-10-25/browser-r10.docx)

## 复现

```sh
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-mention-preview.py --extension-nodes --node-portable \
  --resource-probe --runtime-dir target/hcd-preview-runtime \
  --pages-prefix .hcd-resource-lifecycle
# 对新夹具先生成资源与富文本、离线双端合并到 r6。
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs \
  scripts/hcd-node-portable.mts /absolute/owned-root/private.json
```

`resource-control.json` 仅有 `mode`（`pass/holdBefore/holdAfter/reject`）和 `release`（允许释放的请求序号）；网络事件另存无凭证的 JSONL。用真实文件选择器执行上述操作；保持 r6/r8/r9/r10 的命名样例步骤后运行：

```sh
python3 scripts/hcd-resource-lifecycle-files.py /absolute/owned-root/private.json
```

文件探针创建独立产物目录，不覆盖解包目标。它不会伪造点击证据或修改文档 head，也不是适用于任意生产文档的通用检查器。

## 未完成范围

本轮是 Mac 本机、真实 loopback 网络/浏览器、合成文档和实际文件验证。没有生产、多实例、对象存储故障、真实 Office 客户端或 OS/浏览器崩溃验收。上传取消后 staging 的容量回收、完整离线冷启动/资源缓存、任意 custom mark、行内可编辑容器、复杂富文本/格式往返，以及删除竞争/长期意图压缩仍按原清单继续，不能以本批请求生命周期替代。
