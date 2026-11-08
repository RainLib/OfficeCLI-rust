# Word 区域文档的无源 DOCX 语义导出

2026-10-26，承接[区域结构保存](hcd-flow-regions.zh.md)。本增量把已保存的正文分节和页眉页脚写入实际 DOCX，不需要原始 DOCX。它是语义导出，不是原版式保真导出；浏览器区域编辑、区域协作房间、自动目录和管理平台没有因此完成。

## 行为与兼容

- 模型 2 直接按区域构建。模型 1 在导出的私有离线快照里投影为模型 2，原 head、保存版本、资源与历史不变；同样适用于选择历史版本。更早的内测模型若缺少分节投影所需的正文段落身份，则明确拒绝，不猜边界；仍可用原始 DOCX 回写或 HCDZ。
- 每个正文节保持顺序；非末节的节属性放在该节最后一个段落，末节使用正文末尾的 `sectPr`。以表格等非段落结尾的节增加空的节载体段落，并在报告里说明。
- 每个独立页眉/页脚 story 生成自己的 Word part，保留默认、首页、偶数页、共享和继承关系。未绑定的 story 也保留。纸张、页边距、分节类型、起始页码、页码格式及全局奇偶页设置来自所选版本。
- 富文本、超链接、列表编号和表格沿用现有转换器。页眉页脚中的链接关系写到其所属 part，不借用正文的关系 ID；编号和图片仍使用同一个 OPC 包统一分配。
- 内容寻址图片经过资源校验后嵌入，保留可支持的宽高。浮动位置转为行内图片并报告；不声称保留复杂环绕或视觉分页。
- 人员提及保留可读名称。业务节点按 DOCX 导出适配或可读 fallback 展示；业务身份、附件和不透明资源继续由原生 HCD/HCDZ 保存，报告区分适配与静态化。
- Word 域目前导出已保存的可读结果为静态文字，报告明确说明。域指令仍在 HCD 中，不执行未知指令，也不声称导出的 PAGE/NUMPAGES 会自动更新。无缓存的域仍需后续专门适配。
- 原节属性中可移植的静态设置保留并按 Word 顺序排列；旧关系引用及节属性修订历史不带入无源包。未知外部命名空间属性内容不承诺支持。

输入及适配后的 HTML 均有总量上限，所有区域共用一份校验后的图片目录。生成在同目录临时文件完成，包校验通过后再发布；转换失败清理临时输出，已有目标文件保持。没有更改当前用户预览或迁移其文档。

## 使用

```sh
cargo build -p officecli
hcd_word_demo=$(mktemp -d)
target/debug/officecli hdoc unpack docs/assets/hcd-flow-regions-2026-10-26/regions-r4.hcdz \
  --output "$hcd_word_demo/document.hcd"
target/debug/officecli hdoc export "$hcd_word_demo/document.hcd" \
  --output "$hcd_word_demo/document.docx" --fidelity-report "$hcd_word_demo/fidelity.json"
target/debug/officecli hdoc export "$hcd_word_demo/document.hcd" --revision 0 \
  --output "$hcd_word_demo/original-semantic.docx"
python3 scripts/hcd-word-region-export-verify.py
```

`--source` 仍表示原始包回写，遵守原有结构限制；希望重建区域文档时省略它。无源区域导出当前只开放 DOCX，PDF、HTML、Markdown、TXT、PPTX 等继续拒绝，避免把页眉页脚混入普通正文。

HTTP `GET /export-options` 新增 `semanticFormats`。区域文档返回 `["docx"]` 和 `WORD_REGION_EXPORT_PARTIAL`；旧的“所有通用语义格式均支持”布尔值仍为 false。`GET /export/docx` 支持只读文档 token 和所选保存版本，不要求写权限或原始源文件。它不开放旧客户端的区域写入或签名快照。

## 验证范围

原生单元测试覆盖：导出后重导入的正文、节、页尺寸、首页和奇偶页关系；页眉/页脚独立富文本、表格及链接；严格命名空间的节属性顺序与失效关系清理；生成中失败保持已有文件。

实际 CLI、离线归档和鉴权 HTTP 的文件证据由上述脚本生成到 `docs/assets/hcd-word-region-export-2026-10-26/`。最终通过状态、命令与源码摘要见该目录的验证记录。它们不是浏览器区域 UI、真实签名协作、Office 桌面视觉保真、跨平台或生产验收。

最终验证：新增 4 项区域导出用例；HCD/CLI 的 619 项与 Word 处理器的 39 项，共 658 项通过。clippy（拒绝警告）、fmt、debug 构建、实际 CLI/只读 HTTP、区域联合保存/归档及旧模型回归均通过；三个实际文件验证器使用最终 debug 二进制且摘要一致。438 个文本文件/归档成员未发现凭证。首次依赖配置和旧夹具身份缺失的失败记录保留，原因及最终结果见[验证记录](../assets/hcd-word-region-export-2026-10-26/validation.json)。
