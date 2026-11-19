# Spec 选句协同验收

在业务工作台打开「发布评审」，双击纸面上的标题或正文即可在点击处输入。纸面上方的工具条提供段落样式、选句改写和全屏入口。选中「春季发布」并点击「改写选句」，全局聊天会显示文件名和原句。发送改写指令后，可在该次回执点击「撤销这次改写」。

## 纸面原位编辑

在 707 × 1033 的工作台视口复测了「发布评审」r154。双击前后，首段首个文本片段的屏幕坐标、宽度和高度完全一致。打开和退出编辑时，画布写入请求数为零。[工作台实测截图](spec-edit-on-paper.png)

回归测试逐字核对换行标题和正文的位置，验证滚动画布、进入全屏再返回、拖动压在正文上的便签以及刷新后读取改动。长文滚到中段后，从全屏返回纸面或结束原位编辑，仍能在原处看到刚读到的段落。草稿恢复测试在真实服务上重现旧版文字高度的 412，核对本地输入、同事追加的文字和已排队的对象移动。双方修改纸张本身的高度时，协作版本和未提交草稿各自保留。

```sh
HCD_CANVAS_TEST_HOST=::1 npm --prefix examples/hdoc/editor run test:workspace -- e2e/canvas.spec.ts -g 'double-click edits the exact glyph|recovering a legacy height-conflicted|a long Spec'
```

## 人员和 Agent 的视觉状态

人员显示实色姓名签。Agent 显示带明暗边缘的圆角笔尖和带 AI 标记的名字。等待时笔尖始终朝左上，箭头和姓名签每 3.2 秒沿同一横向椭圆平移一圈，两者间距恒定。文字插入点固定。箭头的上缘带亮线，下缘和侧面的暗部形成轻微的厚度。写入时笔尖归位。系统开启减少动态效果或画布暂停动效时，箭头和姓名签保持静止。画布内、Spec 全屏和只读预览共用光标图形。

[播放等待和写入对照](agent-idle-glide.gif) · [矢量动效](agent-pointer-motion.svg) · [Pen 状态稿](pointers-pen.png) · [两个 MCP 客户端同时读取选句](spec-two-mcp-agents.png)

## 并发场景

| 操作 | 核对结果 |
| --- | --- |
| 在白板上同时显示等待和写入的 Agent | 浏览器每隔 45° 采样一次，核对椭圆轨迹、恒定朝向、笔尖与姓名签的恒定间距及相同位移，以及固定的协作位置。写入时箭头归位，上缘比箭面亮，下缘比箭面深 |
| Alice 在画布里选中第二个「春季发布。」；Bob 在全屏编辑 | 两端看到对方和墨点的名字、选区和插入点。标题选区也能在另一端显示 |
| Bob 在原句中输入「（甲）」，墨点随后提交「秋季上线。」 | 第一个同名句、旁边的文字和「（甲）」均保留 |
| Bob 在改写结果内键入「（乙）」，由测试延迟网络提交；Alice 撤销后再放行 | 两端和服务端都恢复原句，两次人工输入均保留。重复撤销同一回执不会再次插入原文 |
| 外部 MCP 客户端分别声明「尺规」「折页」，读取同一份选句授权 | 两个浏览器各自看到两位具名 Agent。另一位编辑者在打开聊天后继续输入，工作台仍针对原先获授权的句子执行和撤销 |

[画布内选句](spec-inline-global-ai.png) · [全屏选区](spec-full-selection.png) · [撤销后的同一段文字](spec-selective-undo.png)

[独立浏览器的原文、改写与撤销结果](verified-text.json) · [实际 MCP 回执与并发文字](workbench-proof.json) · [业务工作台截图](spec-workbench-mcp.png)

## 复现

从仓库根目录执行。浏览器测试使用项目的 Playwright 环境，可通过 HCD_BROWSER_PATH 指定本机 Chrome。

```sh
cargo build -p officecli
cargo test -p canvas-core
cargo test -p officecli --bin officecli hdoc_server::canvas_spec
cargo test -p officecli --bin officecli hdoc_server::agent_identity
node --test apps/workspace/src/provider.test.mjs apps/workspace/src/selection-grants.test.mjs
HCD_CANVAS_TEST_HOST=::1 npm --prefix examples/hdoc/editor run test:workspace -- e2e/canvas.spec.ts
```

启动业务工作台前，先完成项目的前端依赖安装和构建。以下命令使用独立的临时分发目录和演示文件。

```sh
OFFICECLI_BIN="$PWD/target/debug/officecli" OFFICECLI_WORKSPACE_DIST=/tmp/officecli-spec-demo node apps/workspace/scripts/build.mjs
OFFICECLI_DEMO_SPEC_BOARD=1 OFFICECLI_WORKSPACE_DIST=/tmp/officecli-spec-demo OFFICECLI_EMBED_PORT=4417 node examples/hdoc/embed-host/demo.mjs
```

打开 [本地 Spec 示例](http://fold.localhost:4417/examples/spec)。在另一终端运行以下命令可操作两个浏览器和两个 MCP 客户端，完成后演示正文恢复初始内容。

```sh
OFFICECLI_DESK_ARTIFACTS=/tmp/officecli-spec-proof node examples/hdoc/embed-host/verify-spec-sentence.mjs
```

内置模型回归使用可控的模型响应来安排读、写、撤销的交错顺序。工作台演示使用本地显式改写指令，走实际的 MCP 初始化、工具调用及持久化路径。
