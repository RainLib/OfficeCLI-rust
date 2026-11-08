# PDF 压缩输入与子集字体新字保存

日期：2026-10-25。接续离线 PDF 文字层验收中留下的两项实际反例，修复导入和真实保存路径；管理平台和提醒发送继续后置。

## ASCII85+Flate 导入

有界 ASCII85 解码器此前无条件跳过 `>`，但该字符也是合法的数据数字。ReportLab 默认压缩页面中的字节因此被改变，接着 Flate 报 `corrupt deflate stream`。

解码现在只把 `~>` 识别为结束标记，保留数据中的 `<` / `>`，兼容起始 Adobe 包装和 PDF 空白。非法字节、错位 `z`、单字符尾组和 32 位溢出会明确失败，不能饱和后生成错误字节或静默截断。每个解码阶段、合并页面内容和字体辅助流的大小上限继续生效，没有改用无界解码回退。

独立已知向量覆盖中间 `>`、`<`、所有长度的尾组、零压缩和最大整数；真实反例覆盖 ASCII85→Flate 的顺序、页面大小及字体辅助流的拒绝边界。原先留存的 [有效反例](../assets/hcd-pdf-search-2026-10-25/ascii85-content-source.pdf) 现在可正常解析，完整文件复验也改用默认压缩内容流。

## 新字保存与字体资源

原 PDF 经常将 `/Resources` 或 `/Font` 放在共享的间接字典中，资源还可以从父页面树继承。旧注册逻辑只处理其中一层；新增字体没有正确注册，调用方又忽略了嵌入错误，最终表现为新字符不可编码。

新实现沿页面资源继承链解析最近的资源字典，解引用字体字典，保留原有资源和字体名，再只为当前页面复制并注册新增字体。共享字典、其他页面、原图和原字体不被改写；空字体映射可以初始化，资源环和非法类型明确拒绝。

普通文本替换先检查现有页面字体，只为缺少的字符按需嵌入内置 Noto Sans SC / Noto Emoji。已有字符继续优先使用原段字体。完全没有可用字形时，在改变字体资源之前报错；显式字体文件的读取/嵌入错误也不再被吞掉。不可见搜索层字体仍与可见回退字体隔离。

这补齐的是缺字情况下的普通中文、Latin 和单个 emoji 等可覆盖字符的保存，并不恢复缺失的原始字体外观。复杂脚本整形、复杂 emoji 组合和完整混合字体属性仍需继续验收；未覆盖字符会失败保留当前版本，不能替换成空白。

## 当前证据

- `pdf-handler` 52 项、`hcd-formats` 48 项、OfficeCLI 内联 157 项、多格式 19 项、HTML 转换 3 项，共 **279 项相关原生测试通过**。clippy 全目标检查、格式检查和构建通过。本批没有改前端源代码，未重新运行前端套件。
- 五页真实 PDF 全部使用 ASCII85+Flate 内容流，含中文、四种页面旋转、裁切和纯扫描页。强制小分片，覆盖 continuation。
- CLI 将原子集字体没有的“已保存 offline r1 😀”保存为 r1。原文件支持的导出和无源离线导出均能抽取完整文字；原文件哈希不变，未修改的四页逐像素不变。
- r0/r1 打包解包后保留各自正文。两个版本的十页，增加搜索层前后逐页像素完全一致，扫描页没有虚构文字。
- Alice 和 Bob 使用不同的真实本机 HTTP 写令牌，分别保存新中文/emoji 到 r2/r3。再次提交 Alice 原始请求返回 r2 回执，文档仍为 r3，Bob 的内容保留。
- Alice 的逆向 patch 生成 r4，Bob 的段落保留。CLI 和 HTTP 中均验证了无可用字形的 U+10FFFF 被拒绝且 head 不变；r4 的原文件支持和无源导出都包含两人的正确正文。
- 资源测试覆盖直接/间接和继承的四种组合、原字体名碰撞、共享资源不变、字体复用、空字体映射及资源环拒绝。

验证范围是本机合成文档、原生 CLI/HTTP、两个鉴权 actor 的顺序保存和实际文件。逆向 patch 不能代替前端撤销栈与真实同时输入的全部验收，本批也未做生产、设备或真实 Office 客户端验收。

证据：[当前记录](../assets/hcd-pdf-search-2026-10-25/pdf-search-evidence.json)、[校验与源码哈希](../assets/hcd-pdf-search-2026-10-25/pdf-search-validation.json)、[r1 原文件支持导出](../assets/hcd-pdf-search-2026-10-25/source-backed-r1.pdf)、[r1 无源导出](../assets/hcd-pdf-search-2026-10-25/offline-r1.pdf)、[r4 原文件支持导出](../assets/hcd-pdf-search-2026-10-25/http-r4-source.pdf)、[r4 无源导出](../assets/hcd-pdf-search-2026-10-25/http-r4-offline.pdf)。

```sh
cargo test -p pdf-handler -p hcd-formats --offline
cargo test -p officecli --bin officecli --test hdoc_multi_format --test html_convert --offline
cargo clippy -p officecli -p pdf-handler --all-targets --offline -- -D warnings
cargo fmt -- --check
cargo build -p officecli --offline
python3 scripts/hcd-pdf-search-verify.py
```

脚本使用隔离目录、默认压缩的合成 PDF、临时本机服务和有时限的读/写令牌。原生文档与导出留在忽略的运行目录用于复核，进程在验证后关闭，凭证不进入证据文件。

## 下一步仍需完成

后续保存布局批次已从候选源回写文字框、基线和混合字体信息。曾测得的首行矩形差异现已修正：实际导出各词最大误差约 0.000013pt，旋转页新字替换与浏览器姓名高亮/跟随也已复核。证据现使用 `savedFontReplacementGeometry`。当前校验摘要已更新，以上 279 项为前一批的历史结果；本批的 358 项原生、496 项前端及完整边界见 [保存布局契约](hcd-pdf-saved-text-layout.zh.md)。

没有完整字宽的字体、复杂脚本/文字矩阵、未保存旋转草稿及总清单中的 XLSX/剩余命令、复杂块与自定义 marks、结构化/固定布局 AI、设备和生产验收继续保留。
