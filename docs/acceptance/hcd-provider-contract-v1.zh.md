# Provider V1 设计契约核查 · 2026-11-15

状态：**本记录仅为设计契约核查。后续阶段 A 的实现与测试见[运行时验收](hcd-provider-integration-v1.zh.md)。**

## 本轮交付

- [产品化设计](../hcd-product-integration-v1.zh.md)：根据用户明确选择划分数据职责，参考 WPS 官方接口，定义同步 Provider、异步事件、HCD 与业务版本的保存边界、V2 页面增量、默认正式应用和断网部署验收要求。
- [OpenAPI 3.1 草案](../contracts/officecli-provider-v1.openapi.yaml)：8 个同步 Provider 接口和 1 个独立事件接收接口；应用服务签名、精确版本读取、最小用户资料、操作权限及三阶段发布。
- [本地验证脚本](../contracts/verify_provider_contract.py)与[开发验证依赖](../contracts/requirements.txt)。这些依赖只用于检查文档，不加入产品运行时。
- 在 HCD 总览、管理台和编辑器 README 增加设计入口，不改变现有页面或服务行为。

## 复现

从仓库根目录执行。开发验证依赖可在联网开发机安装；离线发行包目标不依赖此安装流程。

```bash
python3 -m venv /tmp/officecli-provider-contract-venv
/tmp/officecli-provider-contract-venv/bin/pip install -r docs/contracts/requirements.txt
/tmp/officecli-provider-contract-venv/bin/python docs/contracts/verify_provider_contract.py
```

实际输出保存在 [validation.json](hcd-provider-contract-v1/validation.json)：

```json
{
  "status": "passed",
  "scope": "draft-contract-only",
  "openapi": "3.1.0",
  "paths": 9,
  "schemas": 26,
  "embeddedExamples": 3,
  "validCases": 13,
  "rejectedCases": 20,
  "runtimeVerified": false
}
```

脚本使用标准 OpenAPI 验证器核查文档结构，使用 JSON Schema 2020-12 及 format 校验核查示例。重点拒绝无回执却标记 committed、unknown 附带成功回执、将 uploaded 当终局状态、空 CAS 版本、错误 SHA-256 编码、无效 UUID/时间戳、负修订、不认识的权限、缺少类型必需字段的事件和直接携带 token 字段的事件。

## 证据边界

本轮没有修改 Rust、sidecar、编辑器或管理台运行时代码，因此没有重复运行与本次改动无关的全仓构建或浏览器验收，也没有新增页面截图。

本验证没有运行 Provider 服务，也没有检验签名实现、nonce 缓存、权限撤销、跨租户隔离、文件上传、宿主 CAS、响应丢失后的恢复、持久 outbox 或离线发行包。schema 不能验证响应与原始请求的字段相等、授权结果为请求子集、60 秒授权时限、文件实际 hash 或模型调用是否出网。这些仍须由实现及[运行时验收矩阵](../hcd-product-integration-v1.zh.md#10-后续验收矩阵)验证。

WPS 参考为当日在线官方文档，不是与 WPS SDK 的兼容性测试。当前工作区已有其他未提交改动；本轮不将此前功能验收或这些未提交内容归为接入/离线部署交付。
