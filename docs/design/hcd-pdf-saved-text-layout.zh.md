# PDF 保存布局、混合字体与离线选区

日期：2026-10-25。接续 [压缩输入与新字保存](hcd-pdf-input-and-font-save.zh.md)，修复字体替换后正文已经保存、点击框和离线搜索层仍沿用旧尺寸的问题。管理平台与实际提醒发送继续后置。

## 本轮行为

原文件支持的保存路径先生成 PDF 候选，再从候选读取各字体段的矩形、基线、字号和字体。正文、页面栅格与布局元数据在同一个规范版本中提交。预览文字命中框、在线协作姓名高亮、属性栏及无源离线 PDF 搜索层读取这份布局。

CID 字宽现在从 Type0 字体的后代字体字典读取 `/W`、`/DW`，避免将 emoji 错估为普通等宽字符。一个逻辑文字对象含多个 `Tj`/`TJ` 时，替换清除全部旧文字操作，防止尾部旧字残留。

候选 PDF 用有界的 marked-content 分组把原文字操作关联到稳定的 HCD 节点。回退字体把一个节点拆成多个字体段后，仍须逐段拼接等于预期规范文字；不通过则拒绝保存。标记过程规范化字符串编码，保留原始字节；不支持安全重编码的内联图片流会明确拒绝。图片单独保存与旋转/裁切回归仍通过。

## 保存和兼容契约

- `data-hcd-pdf-text-layout` 是版本为 1 的派生元数据，含规范文字 hash、源坐标/视口矩形及字体段；字体段使用 Unicode scalar 数量分区，不重复存储正文，不插入嵌套正文 span。
- 每个计划绑定生成时的文档 root hash 和旧节点 hash。提交前复核版本、实际文字、节点类型、栅格来源及完整覆盖；拒绝过期或不完整计划。重复请求仍先返回既有回执，不因 head 后续前进而重放。
- 元数据校验限制字体段数、坐标、字号、字体名、分区总数与矩形并集。读取会拒绝失效 hash。前端不会把元数据当宿主代码执行。
- 没有候选布局的旧式/无源修改会清除旧派生元数据并标记近似布局，不继续使用绑定旧正文的矩形。旧文档缺少该属性时仍走原兼容路径。未知或被旧写入端遗留的失效元数据不能冒充精确布局。
- 归档仍按既有不可变版本保存 HTML、地图和资源，所以当前/历史布局随 `.hcdz` 一起保留。无需宿主扩展或原始 PDF 的无源导出按字体段生成不可见文字层，页面外观仍以已提交栅格为准。
- 属性栏显示真实字体段的混合字体/字号/样式；它是已保存样式的展示。本批不新增字体替换或字号修改命令。

## 实际验收

`scripts/hcd-pdf-search-verify.py` 通过 CLI、两名鉴权 HTTP actor 及 Poppler 检查真实文件。五页来源使用 ASCII85+Flate、四种页面旋转、裁切、小分片 continuation 和纯扫描页。主分支 r0/r1 历史及 Alice/Bob r2→r3→r4 保留，独立分支进一步替换 90°、180°、270° 页的新中文/emoji。

| 实际比较 | 结果 |
|---|---|
| r1 首行源文件支持导出 vs 无源导出 | 各词边界最大误差 0.000013pt，小于 0.02pt 门限 |
| 90°/180°/270° 新文字替换 | Unicode 保留，文字区域边界最大误差约 0.000007pt |
| r0/r1 共十页，不可见层加入前后 | 页面像素逐页完全一致；纯扫描页不虚构文字 |
| 两名 HTTP actor 顺序保存、迟到的重复请求、逆向修改 | 已提交版本正确，Bob 正文保留；不支持字形失败时 head 不变 |
| 两名只读浏览器成员 | 文字可选中检查，保存禁用；混合字体与 14pt 展示正确 |
| 右侧在线协作 | 显示姓名/操作正文，高亮尺寸与同一文字命中框相等，跨页跟随及停止通过 |

原生相关测试 **358 项**：核心 76、PDF handler 54、格式 49、CLI 内联 157、多格式集成 19、HTML 集成 3。前端 **496 项**，TypeScript/独立版/嵌入版构建、所选包 all-targets Clippy、fmt、Python 语法及 diff 空白检查通过。

这是 Mac 本地合成文档、实际文件和 CUA 浏览器证据。HTTP 的逆向 patch 不是所有前端撤销行为或真实同时输入的验收；只读浏览器的跟随验证也不等于双端同时保存验收。未做生产、多实例或真实 Office 客户端验收。

- [文件与边界实测](../assets/hcd-pdf-search-2026-10-25/pdf-search-evidence.json)
- [当前源码、产物与检查摘要](../assets/hcd-pdf-layout-2026-10-25/validation.json)
- [浏览器记录](../assets/hcd-pdf-layout-2026-10-25/browser-evidence.json)
- [右侧在线协作画面](../assets/hcd-pdf-layout-2026-10-25/online-collaboration.png)
- [混合字体属性画面](../assets/hcd-pdf-layout-2026-10-25/mixed-font-properties.png)
- [r1 无源 PDF](../assets/hcd-pdf-search-2026-10-25/offline-r1.pdf)、[r1 源文件支持 PDF](../assets/hcd-pdf-search-2026-10-25/source-backed-r1.pdf)
- [270° 无源 PDF](../assets/hcd-pdf-search-2026-10-25/rotated-offline-270.pdf)、[270° 源文件支持 PDF](../assets/hcd-pdf-search-2026-10-25/rotated-source-270.pdf)

```sh
cargo test -p hcd-core -p pdf-handler -p hcd-formats --offline
cargo test -p officecli --bin officecli --test hdoc_multi_format --test html_convert --offline
cargo clippy -p hcd-core -p pdf-handler -p officecli --all-targets --offline -- -D warnings
cargo fmt -- --check
cargo build -p officecli --offline
npm --prefix examples/hdoc/editor test
npm --prefix examples/hdoc/editor run build
python3 scripts/hcd-pdf-search-verify.py
# 使用证据记录中的隔离 root，启动只读协作复核；脚本不会输出令牌。
python3 scripts/hcd-pdf-layout-preview.py /absolute/owned/hcd-pdf-search-root
```

## 仍需继续

本轮确认了带完整字宽信息的测试字体及 0/90/180/270° 页面旋转。没有完整 `/Widths` 的简单字体、特殊文字矩阵、连字、复杂 `TJ` 字距和复杂脚本整形仍可能依赖原解析器的近似值，不能据此宣称任意 PDF 精确排版。未保存的旋转文字私有草稿内部变换、复杂 emoji 组合、不同平台字体外观及全部设备仍待覆盖。

### 固定版式预览资源校验

PDF/PPT 页面资源现在流式限制为 64 MiB，并在生成预览 data URL 前验证 SHA-256 与文档引用一致；超限会停止读取，错误资源不会进入预览。9 项资源、流读取、页面和字体专项及 TypeScript 检查通过。隔离 PDF 浏览器样例正常显示页面并可选择图片、读取其位置尺寸，见[界面](../assets/hcd-fixed-preview-integrity-2026-10-28/pdf.png)。错误字节和超限由受控响应测试覆盖；未验证真实网络截断、大资源性能或 PPT 浏览器回归，也不扩大 PDF 可编辑对象范围。

后续隔离 PPT 浏览器补验：图片加载并可选择，将宽度从 100 pt 改为 110 pt 后保存为 r1；语义重建 PPTX 的图片宽度回读为 1,397,000 EMU，见[回读](../assets/hcd-fixed-preview-integrity-2026-10-28/ppt-readback.json)。此修改的保留原文件导出明确拒绝，界面禁用该方式并提示使用语义重建或 HCD 归档，见[导出界面](../assets/hcd-fixed-preview-integrity-2026-10-28/ppt-export.png)。这不是原稿图片修改导出能力；复杂页面与真实 Office/WPS 仍待验收。

自定义节点资源归档、逐业务版本导出 adapters、行内原子与富文本容器的已有结果见 [资源与富文本契约](hcd-node-resources-and-rich-content.zh.md) 和 [离线归档](hcd-offline-archive.zh.md)。任意 custom mark、复杂容器/格式往返、删除竞争与历史压缩、引用冲突/旧代恢复、完整 XLSX/剩余命令、结构化及固定布局 AI 仍按总清单继续；本批不替代这些验收。

源页面带栅格背景时，原文字层会设为透明；此前未保存草稿只替换文字，未开启覆盖样式，画布可能仍显示栅格中的旧文字。现在仅对实际发生变化的 PDF 文字启用既有近似覆盖样式，未变化节点保留原有内容结构；有本页草稿或临时文字覆盖时显示近似预览提示。隔离浏览器点击单页 PDF 文字对象后输入 `Visible draft`，页面显示草稿及提示，保存至 r1；下载 PDF 用 `pdftotext` 回读为 `Visible draft`。[未保存预览截图](../assets/hcd-pdf-draft-preview-2026-10-28/draft.png)。这是本机合成单页 PDF；覆盖使用近似背景和原区域，复杂背景、旋转文字、不同字体及超出原区域的布局仍未充分验收，不代表任意 PDF 精确编辑。

补充 90° 旋转页的隔离浏览器验收：通过文字区域输入 `Rotated draft` 后，草稿按页面旋转方向可见并显示近似提示；保存为 r1，浏览器下载 PDF 经 `pdftotext` 回读文字，并用 Poppler 渲染确认文字方向与页面一致。[草稿](../assets/hcd-pdf-rotated-draft-2026-10-28/draft.png)、[保存后](../assets/hcd-pdf-rotated-draft-2026-10-28/saved.png)。较长草稿会超出原选择框，草稿覆盖位置和外观仍为近似；未覆盖 180°/270° 草稿、复杂字体和背景或真实生产文件。隔离服务可使用 `python3 scripts/hcd-workbook-recovery-preview.py --pdf --pdf-rotation 90` 重建样本。

PDF 文字清空保存后，原生布局现在保留该文字节点先前的页面与源坐标；空内容仍按原节点显示在属性列表，有有效区域时也可从页面点击。历史版本已经丢失区域的空节点仍能从列表编辑，不凭空创建页面坐标。隔离浏览器将 `Original` 清空保存 r1，切到图片后重新点击原文字区域，输入 `Refilled PDF` 并保存为 r2；下载 PDF 经 `pdftotext` 回读新文字，[界面](../assets/hcd-pdf-empty-text-2026-10-28/refilled.png)。原生专项覆盖清空、保留坐标、再次写入和 HCD 校验，PDF 14 项格式回归与 TypeScript 检查通过。测试使用单页合成 PDF；旋转、复杂背景、空节点跨设备协作以及旧零坐标文件的恢复位置仍需验收。

90° 旋转页的空文字补充双成员浏览器验收：Alice 清空并保存 r1 后，Bob 接收该版本，切换到图片再点击原文字区域，输入并保存 r2；Alice 随后接收 Bob 的内容。继续由 Alice 和 Bob 分别保存 r3、r4，修正底部状态只在其本次保存版本仍等于当前版本时显示“已保存到 rN”，避免同伴更新后仍显示旧版本；Alice 顶部显示 r4、底部显示已保存，[截图](../assets/hcd-pdf-empty-peer-2026-10-28/alice.png)。浏览器下载 r4 PDF 后 `pdftotext` 回读 `Bob fourth`。该验证是同机隔离服务、单页合成 PDF 和版本通知，不等于逐字协作或跨设备验收。

无源 PDF 重绘时，若某节点曾因无法重绘而显示近似覆盖层，后续成功重绘该节点会清除它的旧覆盖标记，避免栅格与覆盖层重复绘制；同页未重绘节点的覆盖层继续保留。原生回归先保存不能重绘的多行文字，再保存可重绘文字，核对覆盖标记和规范文本。隔离浏览器移走原 PDF，清空文字保存 r1、再次输入 `New` 保存 r2；页面源记录该节点覆盖标记为 false，下载无源 PDF 的文字层回读 `New`，[界面](../assets/hcd-pdf-offline-overlay-2026-10-28/saved.png)。该样例是单页本机服务，并非应用完全离线运行；多节点覆盖混合、复杂背景与真实设备尚待验收。

同页两个文字对象补充原生验证：先让两者进入无法重绘的覆盖状态，再只重绘其中一个；已重绘节点的覆盖标记清除，另一节点和文字保留，HCD 校验通过。独立脚本 `python3 scripts/hcd-pdf-mixed-overlay-verify.py` 使用本机合成 PDF、无源保存及实际 PDF 导出，`pdftotext` 能读到两处文字，但没有验证复杂版式的视觉还原。测试同时发现固定版式经 HTML 语义回退生成 PDF 时原报告标为 HIGH；现改为 SEMANTIC，栅格路径仍为 VISUAL，语义流 HTML 转 PDF 的既有报告不变。格式库专项及命令行视觉/语义分支回归通过；未覆盖生产文件、多设备或全部字体。

**后续修正：**上一段只验证了文字提取，不能证明导出外观安全。对同一合成样例作 Poppler 渲染后发现，未重绘对象的新文字叠在旧栅格上，旧文字仍然可见。现在对所选版本检查未重绘标记；存在时，服务端及命令行阻止无源转换并返回 `PDF_UNPAINTED_TEXT`，导出界面显示原因。重绘完成后可再次无源导出。原稿路径仍须原 PDF，HCDZ 归档会保留旧内容及历史，只适合备份，不是脱敏导出。隔离浏览器验证了禁用提示及 HCDZ 入口；两文字节点的命令行样例验证阻止、重绘后导出和文字回读。复杂背景及真实文件的视觉一致性仍待验证，完善无源页面合成仍是后续工作。

进一步用隔离服务及只读令牌验证：r2 未重绘时，PDF 和其他六种目标格式均拒绝无源导出，跨格式带 `source=true` 也不能绕过；r0 预检可导出，r3 重绘后可导出，单独请求历史 r2 仍受阻；r2 HCDZ 可下载。将完全相同的原 PDF 放回服务后，样例中含换行的 r2 有源导出返回不支持的错误，不能保证找回源文件就能导出所有编辑。这里验证的是合成文件与 HTTP 路径；多行原稿重排及复杂页面仍未完成。

导出预检现按所选版本检查修改过的 PDF 文字：包含换行时返回 `PDF_MULTILINE_SOURCE_UNSUPPORTED`，界面禁用原稿导出并说明可用 HCD 归档备份；当原稿缺失且无源导出也受阻时，不再提示“可导出当前内容”。删除换行并保存后重新检查当前版本。该预检只覆盖已知的换行限制，不保证其他原稿文字替换必然成功；多行布局实现仍未完成。

隔离浏览器使用合成 PDF 保存多行覆盖后，原稿缺失时显示旧文字风险提示；恢复同一原稿并重新打开后，原稿导出按钮禁用并显示多行不支持原因。脚本同时检查版本预检、历史版本和重绘后可导出；未验证真实文件、复杂页面或多设备。
