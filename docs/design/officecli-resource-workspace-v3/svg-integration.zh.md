# 角角 SVG 接入

本目录资产完全自包含，不引用网络字体、位图或脚本。基础视口 320 × 320，动态版本使用 SVG 路径与内嵌 CSS。

## 文件与尺寸

| 文件 | 场景 |
| --- | --- |
| svg/jiaojiao-master.svg | 内联组件母版，通过 data-state 切换状态 |
| svg/jiaojiao-idle.svg 等六个状态文件 | 作为独立图片展示动作 |
| svg/jiaojiao-*-static.svg | 静态、减少动态效果、设计工具导入 |
| svg/jiaojiao-mark-static.svg | 32px AI 面板标识 |
| svg/jiaojiao-inline-static.svg | 24px 回复标识 |
| svg/jiaojiao-hero-static.svg | 欢迎页形象 |
| svg/resource-link.svg | 480ms 资源流转提示 |
| svg/commit-check.svg | 320ms 提交完成提示与光圈 |

## 运行方式

简单展示可使用 img 引用单个状态文件。图像自身的 CSS 动画可以播放，父页面不能直接修改 img 内部的 SVG；需要暂停、主题或连续状态切换时，将母版转换为组件并内联。

~~~html
<img src="/assets/jiaojiao-working.svg" width="160" height="160" alt="AI 正在执行任务" />
~~~

内联时，根 SVG 的 data-state 接受 idle、thinking、working、complete、waiting、attention。is-paused 类暂停所有子动画；恢复时移除该类。监听页面可见性，隐藏时暂停；用户主动暂停的选择应继续保留。内置 prefers-reduced-motion 会禁用动作，同时保留完成勾号。

母版包含 jiaojiao、jiaojiao-title、jiaojiao-desc 三个 ID。**同一 HTML 文档多次内联时，为每个实例统一重写 ID、aria-labelledby 与 CSS 选择器**；不要只改根 ID，否则状态样式会失效。独立 img 文件之间不存在该 ID 冲突。

完成与需核对动作为有限次数。若要重播同一状态，需要先清除该状态并在下一帧重新设置；不要靠重复设置相同属性假定动画自动重启。正式组件应将 taskId 或完成序号作为重播触发条件。

## 状态与业务

状态应由全局任务状态派生，不能由用户切换 Tab 重置。waiting 只在业务确实等待选择时展示；attention 用于来源更新、范围失效或操作冲突。动画不可替代文字错误信息、读屏提示和任务结果。

执行成功应在服务端确认提交后展示 complete。切换到另一文档时继续显示同一任务的进度，不自动把正在执行的目标改成当前 Tab。

## 验证范围

所有 SVG 已解析为有效 XML；动效样式、六种姿态和内联脚本语法已检查。已查看圆角三角版本的浏览器待机画面，以及 FigCraft 导入后的形象页和欢迎页。完整六状态播放、减少动态效果与不同浏览器仍应在产品接入时完成实际验收。
