# Word 分节页码编号设置（2026-10-30）

区域 Word `/2` 的“布局 → 页面设置”现接通当前节的起始编号和编号格式，复用已有页面事务、协作交接和设备原请求。管理平台与实际提醒继续后置；完整格式目标保持开放。

## 交互与数据

- 编号方式提供保持原值、继续上一节、重新起始；格式提供保持原值、未指定默认，以及十进制、大小写罗马数字、大小写字母。原稿中其他合法格式保留并可查看，未主动修改时不强制替换。
- 编号明确只作用于当前节，与纸张和边距的整篇文档范围独立。可与纸张、边距合成一份原子页面请求，确认页按各节、各字段列出原值和新值。
- 继续编号、默认格式以显式 `null` 删除对应设置；未填写的字段保持不变。起始值接受十进制非负整数，保留零，拒绝空值、负数、小数、指数和溢出值，不将输入隐式转换成零。
- 确认、普通原请求、停房恢复和结构审阅共用字段感知显示。页码不再误显示为毫米；只读属性也显示编号和未知原稿格式。
- 使用既有 native `NumberStart` / `NumberFormat` 事务与语义 DOCX `w:pgNumType` 导出，无新增 Rust 写入通道。编号作用于当前节、起始和格式属性的映射参见 [Microsoft Open XML 文档](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.pagenumbertype?view=openxml-3.0.1)。

这只配置编号规则。不会自动插入 `PAGE` / `NUMPAGES` 域，也不会在当前浏览器重算页码；不宣称动态目录、精确分页、计算域可编辑、原稿混合导出或 Office 桌面视觉验收。已有语义导出仍可能将域结果转为静态内容，界面保留相应说明。

后续已接通区域 `/2` 语义 DOCX 的受支持页码域指令及缓存保留，见[页码域导出与实际文件证据](hcd-word-field-export.zh.md)。原批次产物不追溯改变；浏览器域插入、重算和分页仍未完成。

## 保存、恢复与兼容

`wordNumberingIntent.ts` 产生受当前布局摘要约束的修改；`wordPageIntent.ts` 合成页面设置。普通页面队列与停房结构队列的白名单、原值和新值校验均支持这两个字段。请求协议版本保持不变；旧客户端不认识新增字段时仍应保留原始备份并拒绝执行，不承诺旧客户端可以恢复新版编号请求。

发送前继续完整持久化原参数；结果不明时按原身份核对，不新建操作。纸张和 story 结构本身仍不属于普通文字撤销，历史草稿比较/合并与跨设备仍未完成。

## 本机浏览器与实际文件

使用全新隔离合成 DOCX、Alice/Bob 两名写成员和一名只读成员，通过普通产品入口操作，未用浏览器脚本写入编辑器或设备库。

| 版本 | 实际操作和结果 |
| --- | --- |
| r1 | 导入并分区，保留原两节、页眉页脚、图片及不同纸张 |
| r2 | 第一节从 8 开始并设为大写罗马数字；上方选择整篇纸张范围仍只改当前节编号；另一成员无刷新读取新值 |
| r3 | 同伴正文修改经已有保存流程进入规范版本 |
| r4 | 第二节从 12 开始并设为小写罗马数字；测试代理在成功后丢弃最终响应、阻止提交重试，产品保留未知原请求 |
| r4 恢复 | 真实关闭 Alice 标签页、重启一次侧车，再打开普通入口确认原 r4；重开前后实际下载的完整原请求 731 字节完全相同，无重复编号提交 |
| r5 | Bob 重新打开后正常编辑并保存追加正文 |
| r6 | 第二节继续上一节并恢复未指定格式；实际请求的两个新值均为 `null`，第一节的 8/大写罗马数字保持 |

无效指数输入被阻止；只读成员页面设置禁用。正常页面事务有原窗口自动交接证据，但**侧车重启后原 Bob 窗口的“重试”未恢复连接，关闭重开才恢复**。已保留[原窗口状态](../assets/hcd-word-numbering-2026-10-30/peer-retry-after-restart.png)，原因待查，不能把新窗口恢复成功当作旧窗口重连完成。该缺口应优先继续修复。

后续已独立定位并修复该重连问题，真实三个原窗口无需刷新/重开接续的验证见[普通断线重连](hcd-word-reconnect.zh.md)。上段和本批截图保留为当时失败证据，不将后续结果倒填进原编号批次。

`hcd-word-numbering-files.py` 独立检查浏览器下载的 r2/r4/r6 DOCX：两节编号、尺寸和两处正文标记符合各自版本；原图片字节保留，再导入后编号和尺寸一致。实际 r2、r6 HCDZ 解包和 validate 通过，分别完整回读 r1–r2、r1–r6；布局除目标编号外不变，页面版本不改变正文、页眉页脚块。真实 `/6` 设备备份经生产 reader 解码，布局与最终投影完全一致，正文标记各一次。

证据：[浏览器记录](../assets/hcd-word-numbering-2026-10-30/browser.json)、[文件回读](../assets/hcd-word-numbering-2026-10-30/files.json)、[设备备份](../assets/hcd-word-numbering-2026-10-30/backup-readback.json)、[同伴最终设置](../assets/hcd-word-numbering-2026-10-30/numbering-final-peer.png)。仅本机合成样本，不是跨物理设备、外部 Office、真实断电或生产验收。

## 复验

```sh
python3 scripts/hcd-word-layout-browser.py --clean --draft-only --story-source --allow-restart --native-topology-proxy --topology-ui-proxy
# 使用打印的普通入口，按上表操作并保存实际下载到本批输出目录。
# owned-root 必须是该脚本新建的隔离目录，不可指向用户文档。
python3 scripts/hcd-word-numbering-files.py /absolute/owned-root /absolute/output-directory
node --import ./examples/hdoc/editor/node_modules/tsx/dist/loader.mjs scripts/hcd-word-numbering-backup.mts /absolute/owned-root /absolute/output-directory
```

验证脚本不执行或伪造浏览器步骤，不提交规范修改。测试、构建、源码摘要、首次失败及清理以本批 [validation.json](../assets/hcd-word-numbering-2026-10-30/validation.json) 为准。新增专项覆盖范围是设置与恢复契约；完整 HCD 目标和前述重连问题仍未完成。
