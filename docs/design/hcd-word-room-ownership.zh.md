# Word 区域房间的本机所有权与恢复日志绑定

2026-10-26。本增量接在[区域房间](hcd-word-room.zh.md)之后，防止同一文档/epoch 被多个本机 sidecar 同时写入。默认仍关闭 `HCD_WORD_ROOMS`；不迁移现有用户文档，不切换当前纸张 UI。管理平台与实际提醒发送继续后置。

## 所有权覆盖范围

一个活跃房间必须同时持有三项证据：

| 证据 | 作用 |
|---|---|
| 原生租约 | 按文档/epoch 绑定 ownerId、leaseId，原生期限 15 秒 |
| 恢复存储身份 | 绑定同一私有目录的认证身份；另一份空目录不能接管 |
| 已落盘日志链 | 原生记录最近确认的私有日志 hash；接管者必须从本地完整校验日志链，证明包含该 hash |

不能仅复制身份文件后重新从规范版本初始化，这会漏掉尚未提交的协作输入。缺失日志链返回 `word-owner-recovery-chain-missing`；存储身份不同返回 `word-owner-recovery-store-mismatch`。

这是同一原生本地根目录下的实现：两个原生进程通过不可删除的锁文件和 OS 文件锁互斥。**acquire/renew/record/checkpoint 必须路由至同一原生实例**；当前没有任意负载均衡、远端 PostgreSQL/S3 或跨主机文件系统的所有权适配。远端配置下所有权接口明确返回 501。

## 原生与 sidecar 协议

原生增加 `POST /v1/documents/{id}/collaboration/word-owner`，只允许协作服务身份、coordinator 5、相同 epoch 和 `hcd-word-regions/1`。普通写成员不能取得租约。

- `acquire`：取得 OS 锁，校验持久存储身份和日志祖先；已有其他 owner 时返回 409。
- `renew`：必须匹配现有 owner/store/lease；过期后不能复活旧租约。
- `record`：私有日志 fsync 后，提交完整已验证祖先 hash；必须包含原生先前确认的 hash，末项成为新的持久绑定。
- `release`：匹配租约才可释放，迟到的旧请求不能释放后继 owner。

区域原生 checkpoint 必须携带当前 owner、lease 和 journal hash。持有的租约 guard 覆盖整个规范操作；已准入的操作结束前，即使租约过期或显式 release，仍保有 OS 锁。锁文件从不 unlink，避免另一个进程通过新 inode 绕过互斥。私有文件检查软链接、大小和路径，采用私有权限。

sidecar 使用从请求发送时刻计算的单调时钟截止时间，预留 2 秒安全余量，周期续租并有独立到期计时器。回复到达太晚不能续命。record 与 renew 串行，避免旧回执覆盖新的日志 hash。

## 保存和接管顺序

1. 加载并校验私有签名日志链，取得存储身份及已验证的祖先 hash。
2. 原生取得租约并核对持久绑定，再恢复区域 owner；Hocuspocus 宿主只绑定到同一签名状态。
3. 每次持久化先写不可变日志、fsync、以 link CAS 接到链上，再由原生确认 journal hash。
4. 只有以上确认成功后才允许提交区域 checkpoint，随后仍沿用原请求 ID、签名回执和迟到输入保护。
5. 原生 record 回复丢失时不能继续提交；本地准备记录仍在。下一 owner 读取同一链后可以证明旧/新原生 hash 均为祖先，再按现有未知结果流程恢复。
6. 正常 SIGTERM/SIGINT 先 drain，再释放租约。进程崩溃或暂停则依赖到期和 OS 锁；新 owner 仍必须找到同一完整私有日志。

## 失去租约后的内容

失去租约立即冻结 owner、停止自动保存和上传应用，将连接置只读并关闭。迟到的原生保存回复不能重新绑定来源、确认作者代次或推进活动日志。

尚在内存的状态另存为 HMAC 压缩 `recovery-*.gz`，不推进活动链，也不覆盖后继 owner。每份恢复记录包含完整 capsule，不包含 token 或文件原始上传字节。新 owner 仅在这份完整状态已出现在签名活动链历史中时自动标为已处理；仅忽略已处理记录 ID，不能仅凭文字 digest 判断相同。

不同内容的恢复记录继续阻止直接开房间，返回 `word-owner-recovery-required`；后续已增加[显式审阅与选择](hcd-word-recovery-review.zh.md)。同基线的安全因果合并及保留当前可解除指定副本的阻断，跨基线和未确认请求仍需继续。未落盘的进程内输入在进程被强杀时仍可能不可恢复，不能把本次测试解释为所有内存输入都有崩溃保障。

## 验证与复现

```bash
cargo test -p officecli word_owner
cargo test -p officecli hdoc_server --bin officecli
cd examples/hdoc/editor
npm test
npm run build
# 从仓库根目录运行：
python3 scripts/hcd-word-room.py --owners
python3 scripts/hcd-word-room.py
```

所有脚本只创建合成文档、随机端口和隔离私有目录，不改用户文档。多进程检查运行两个原生进程与四个 sidecar，验证：

- 活跃 sidecar/另一个原生进程的竞争被拒绝；普通成员无法取得租约。
- SIGSTOP 保留旧 PID，等待实际租约到期，再由新 sidecar 恢复已落盘、未提交的正文/页眉/页脚。
- SIGCONT 后旧连接关闭，恢复快照保全；新 owner 超过一个完整租约周期仍能续租并联合保存。
- 正常退出 drain/release；不同私有存储、仅复制身份文件而缺少日志的接管都被拒绝。
- 无租约和已释放租约的原生 checkpoint 拒绝，规范 head 不被旧 owner 改写。
- 实际 DOCX 保留区域内容和图片字节，HCDZ 全部版本精确回读并 validate。

新增 12 项前端检查，完整前端 847 项、专项 61 项通过；原生服务筛选 72 项通过，其中包含 4 项所有权测试。TypeScript、生产/嵌入构建、Fmt 和 all-targets Clippy 通过。当前运行证据使用的原生二进制 hash 单独保存；其后仅有原生类型别名/测试格式整理，最终源代码经 Clippy 编译。

结果与当前源码 hash 见 [验证摘要](../assets/hcd-word-owner-2026-10-26/validation.json) 和 [真实进程/API/文件证据](../assets/hcd-word-owner-2026-10-26/socket-api-files.json)。区域原有并发/个人文字撤销/异常包/重启/撤权回归使用同一新版原生二进制复验。

## 后续开放条件

1. 旧协议用户文档的可恢复 epoch 迁移，贯通在线连接、浏览器未提交草稿和上传预留。
2. 同基线恢复的[独立审阅组件](hcd-word-recovery-review.zh.md)已验证；主编辑器接入、跨基线/未确认请求恢复、journal 压缩/GC 和容量处理仍待完成。
3. 浏览器区域富文本 binding、上传恢复/关闭选择、统一命令与 Notion 菜单、个人图片撤销及 AI 接受事务。
4. 长文数据虚拟化和远端持久服务/多主机所有权适配的独立验收。

本地进程接管不等于浏览器迁移、真实 Office 客户端或生产部署验收；原完整目标仍在进行。
