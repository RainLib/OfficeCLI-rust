# 本机草稿启动、服务端故障分类与恢复

2026-10-24。本轮修复的是启动故障分类和恢复流程，完整编辑器原清单继续有效，管理平台与实际提醒发送后置。

## 问题与结果

LocalDraftBootstrap 过去把整个启动流程的异常都显示为“本机备份不可用”，其中也包括原生服务端读取失败、代次/协议变化。旧代次的重试仍携带旧会话，会反复得到同样结果；“无备份继续”再次查身份后反而可能恢复。这不能据以断言磁盘故障。早前浏览器没有保存原异常，不能反推其精确原因；本轮确认并修复了这条实际存在的错误分类路径。

现在只有磁盘身份、枚举、打开、读取、归档和绑定写入操作的失败才显示本机备份不可用，并开放明确的“无本机备份继续”。服务端连接、访问失效、不兼容正文各自显示对应提示。状态读取遇到 409/426 或正文协议不符时，只查询一次最新身份；确实发生代次/协议变化才通知宿主刷新会话，不直接进入另一个房间，不循环重试。服务端故障不会授予无备份降级入口。所有提示为英文/简体/繁体中文键，不显示服务器异常正文或凭据。

已加载的本机候选在协作正文暂时无法读取时仍可展示/下载，恢复保持禁用，未核对服务端时不归档候选。重试、关闭或切换会话会取消旧请求；旧代次的延迟结果不能启动 provider 或替换新状态。“无备份继续”和恢复动作仍需重新核对当前身份/协议。恢复对比的结构化纯文本预览另修复硬换行丢失，不解释正文 HTML。

## 实际验证

- 用前端读取函数访问真实原生服务，旧代次请求返回 409，随后 `/auth` 返回 200；得到刷新代次的决定，只有两次请求，原生 manifest 未变。该证据证明当前路径，不是对旧浏览器错误原因的追认。
- 新隔离双端自动进入可编辑状态，本机日志均为 stored，没有手工跳过本机备份。
- 暂停同一份自有 sidecar 进程，native API/Vite 保持在线。第二次控制实验中，原生协作快照 r2 不含“离线二次验证”，新窗口的本机草稿含该文字，服务端预览不含；真实 IndexedDB 对比页出现。
- 恢复原进程后点击恢复，内容进入 r3。同伴继续输入后保存 r4。原窗口保留且可能发送缓冲 CRDT，因此不声称恢复按钮是唯一发送路径；已验证本机独有副本、恢复对比及最终内容幂等。
- r4 三处文字各一次，来源 ID 不变，无结构重建。实际 source-backed DOCX 为 HIGH，字节比较仅三处预期文字不同，换行元素、非正文结构、运行属性及其他部件保持不变；再导入的树/起始号/换行/正文等于保存状态，历史 r1 不变。
- 450 项前端测试与 TypeScript、standalone/embed 构建通过，包括 API 冲突、权限/连接错误、协议不匹配、取消、磁盘故障分类，以及恢复预览换行。本轮没有 Rust 修改，没有重复原生单测。React 生命周期检查覆盖取消、代次守卫和操作按钮的忙碌状态。

证据：[真实 API](../assets/hcd-workbench-2026-10-24/bootstrap-native-evidence.json)、[原生缺少离线文字的快照检查](../assets/hcd-workbench-2026-10-24/bootstrap-server-before-recovery.json)、[浏览器过程和边界](../assets/hcd-workbench-2026-10-24/bootstrap-browser-evidence.json)、[实际 DOCX](../assets/hcd-workbench-2026-10-24/bootstrap-file-evidence.json)、[恢复对比](../assets/hcd-workbench-2026-10-24/bootstrap-device-review.png)、[恢复后编辑页](../assets/hcd-workbench-2026-10-24/bootstrap-recovered-editor.png)。对比截图采集在修复预览换行之前，修复后的预览由新增回归覆盖；实际编辑页和文件本来就保留硬换行。

## 复现与边界

运行 `npm --prefix examples/hdoc/editor test` 和 `npm --prefix examples/hdoc/editor run build`。`python3 scripts/hcd-mention-preview.py --source-docx <列表验收 exported.docx> --pages-prefix .hcd-bootstrap` 可生成隔离双端样例。`node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-bootstrap-native.mts <自有样例目录>` 对已迁移的样例验证实际旧代次响应；加第三个文字参数可确认当前原生协作快照不含该文字。凭据只在权限 0600 的自有 loopback 目录内读取，不打印。

按浏览器记录中的命名文字完成本机恢复和同伴输入后，运行 `python3 scripts/hcd-bootstrap-files.py --browser-root <自有样例目录>` 检查 r4 实际文件。暂停服务仅用于本机自有隔离进程，必须恢复同一个进程并设置兜底恢复，不能操作生产服务。

本轮验证了 native API 在线而协同进程暂停时的本机恢复；没有验证完全离线的首次身份初始化、OS 重启或浏览器进程崩溃。真实浏览器的存储拒绝/容量耗尽/打开阻塞仍需补验，现有故障语义证据来自 fake-indexeddb。旧协议副本仍不自动合入新代次。完整 SDK、AI、引用、字体/国际化/PPT/PDF 与生产验收继续推进，不将本轮视为全部保存或协同能力完成。
