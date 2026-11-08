# Word 页码节点的编辑器接线与验收边界

2026-10-30。承接[原生页码节点](hcd-word-numeric-field-nodes.zh.md)，接通客户端内置定义、统一插入命令、`/` 菜单及右侧属性。分页、实时页数计算、自动目录、其他文档格式和完整目标继续；管理平台与提醒发送后置。

## 普通入口与数据契约

本机原生 `/auth` 仅在区域 Word `/2` 下声明 `wordNumericFields: inline-v1`。客户端同时核对 DOCX、模型 2、协作协议和确切版本；旧服务、未知版本、错误类型或其他模式不会注册创建能力。归一化显式覆盖原始声明，避免对象展开残留未经确认的值。

内置 `officecli.word.numeric_field` 复用节点注册表和自动生成的 `node.insert.officecli.word.numeric_field` 命令，不另建一套保存或权限通道。插入操作区、命令面板和 `/` 均使用现有插入门禁。属性仅允许 PAGE、NUMPAGES、SECTIONPAGES 和预定义编号格式，不接收任意指令、伪造页数或文件。

共用扩展属性新增有限 `select` 选项、描述和 `allowResources` 策略；注册时验证选项并复制冻结。页码节点设置 `allowResources:false`，注册表拒绝资源，属性面板不显示附件选择器；普通扩展的附件默认行为保持。静态目标输出可读占位；DOCX 使用前一批的受检动态适配。界面明确显示“待计算”，不声称编辑器已经完成排版和域更新。

## 本机验证

- 前端完整测试使用 `--test-concurrency=2`，**2043 项通过，0 失败**；含 TypeScript 的 standalone/embed 构建及原生构建通过。33 项相关测试覆盖能力协商、有限属性、资源策略、只读和 Yjs 个人撤销。未重新运行 Rust 全工作区或全目标 Clippy。
- 普通 Chrome 编辑页通过 `/页码` 菜单插入节点，r3 保存 PAGE，属性修改为罗马数字后 r4 保存；关闭原窗口后新页面可读到该节点。r2 是先前自动保存的中间输入 `/页码`，没有节点，不能将 r2 当作插入完成。此前 IAB 中间连接及 Chrome 控制超时使全程不能声称只有固定三个窗口。
- 真实两个 WebSocket 成员复用生产侧车和原生服务：r5 保存 NUMPAGES 与 Bob 文字；Alice 的个人撤销保存 r6，重做保存 r7，均保留 Bob 内容；可编辑页眉段落加入 SECTIONPAGES 后保存 r8。这是服务层验证，不冒充浏览器撤销/重做点击。首次脚本将插入点放到含受保护内容的末块，模型拒绝 `ownershipTransition`；日志保留，改选可编辑段落后从已有 r7 继续，没有回退或重建规范历史。
- 普通页面重开 r8，显示总页数占位和 Bob 内容，[截图](../assets/hcd-word-field-ui-2026-10-30/saved-r8.png)保留。产品“下载草稿备份”产生两份相同的 48,880 字节文件；Chrome 下载事件观察超时，但实际文件已落盘。复制具名产物后，生产 `/6` 读取器在隔离 Y.Doc 中验证身份范围、规范内容、布局、两节点实例/属性及同伴文字一致。该文件 `localUpdates:0`，不证明未提交修改的恢复/合并。
- CLI 从实际 r3–r8 导出六份 DOCX，另从 HCDZ 导出 r8；核对 PAGE/NUMPAGES/SECTIONPAGES、罗马/阿拉伯格式、域边界、请求打开时更新、原文字、两节纸张与图片。全部重新导入识别为受保护原生域。HCDZ 解包后 **79 个规范文件逐字节一致**，r0–r8 投影与在线包相同。HCDZ 保留可编辑扩展身份；DOCX 再导入不自动恢复原扩展身份。

结果与范围见[验证汇总](../assets/hcd-word-field-ui-2026-10-30/validation.json)、[服务结果](../assets/hcd-word-field-ui-2026-10-30/socket.json)、[文件回读](../assets/hcd-word-field-ui-2026-10-30/files.json)及[实际设备下载读取](../assets/hcd-word-field-ui-2026-10-30/backup.json)。初始失败和后续日志均保留。

后续外部应用实测：LibreOffice 的 PAGE/NUMPAGES 更新及指令另存保留有实际文件证据，但 SECTIONPAGES 保留占位，结果为部分不通过；属性说明已补目标应用支持边界，见[应用兼容实测](hcd-word-field-application-compatibility.zh.md)。

## 同一工作包仍需完成

1. 普通双成员浏览器完整执行插入、同字段冲突、删除、个人撤销/重做、保存中继续输入；正文及页眉页脚分别验收。当前只有部分浏览器插入/属性/重开证据，以及独立服务层的个人历史证据。
2. 对含未提交页码修改的设备备份进行正常文件选择、比较、导入与恢复，覆盖冲突、取消和另一窗口；不能用本次已保存快照的隔离读取替代。
3. 普通浏览器实际下载 DOCX/HCDZ、静态目标提示及只读权限路径的完整验收；本批 DOCX/HCDZ 文件来自 CLI，不把文件回读说成浏览器下载。
4. 外部 Word/WPS 真实重算、精确分页、跨节连续排版、自动更新目录和旧协议安全迁移。`updateFields` 只是打开时请求，不是实际重算结果。
5. PPT/PDF/Excel 创作、正文分段、字体/国际化、真实 AI、跨设备和多实例仍按[整体矩阵](hcd-current-capabilities.zh.md)推进。

## 复验

```sh
node --import tsx --test --test-concurrency=2 src/*.test.ts # examples/hdoc/editor 内
npm --prefix examples/hdoc/editor run build
cargo build -p officecli --bin officecli
python3 scripts/hcd-word-layout-browser.py --clean --draft-only --story-source
# 在普通页面插入 PAGE 并修改 upperRoman，保存至 r4 后：
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-numeric-field-socket.mts <owned-root> <evidence-directory>
python3 scripts/hcd-word-numeric-field-files.py <owned-root> <evidence-directory>
# 产品下载的文件先保存为 field-device-r8.hcd-word-draft，再运行：
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-numeric-field-backup.mts <owned-root> <evidence-directory>
```

脚本仅适用于具名前缀、显式新建的测试目录；不会访问用户文档，也不把脚本操作当成浏览器操作。
