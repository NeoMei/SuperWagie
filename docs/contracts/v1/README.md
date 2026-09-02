# 超级牛马（SuperWagie）Contract v1

本目录是 SuperWagie 跨进程、持久化和扩展边界的首个可机读契约基线，不是某种语言的内部类型定义。

## 文件

| 文件 | 用途 |
|---|---|
| `envelopes.schema.json` | ClientIntent、AuthorizedCommand、CommandResult、Event、ArtifactRef 和 Error 信封 |
| `resource-handle.schema.json` | audience-bound、短期、限操作的字节访问授权；不暴露真实路径 |
| `ui-query.schema.json` | 产品 UI 的 Snapshot、Subscription、Event Cursor 与 resync 协议 |
| `human-gates.schema.json` | Workflow/Risk/Install 三类 Gate 的决定与强绑定回执 |
| `capability-manifest.schema.json` | Private/Public/Extension/Connector Capability 的统一 Manifest |
| `states.schema.json` | Task Item、Agent Thread、Workflow、Host、扩展、事务、计费、发布和批注的持久状态枚举与 snapshot 结构 |
| `error-codes.json` | 稳定错误码目录 |
| `public-capability-facade.md` | 主 Agent 和用户 Skill/MCP 共用的方法级高层 API |
| `public-capability-methods.schema.json` | 公开方法目录本身的 JSON Schema；约束方法名、Schema ID、Gate 与风险分类 |
| `public-capability-methods.json` | Public Capability Facade 的机器权威方法目录、Schema ID 与 Gate 分类 |
| `public-method-schemas/` | 35 个方法的 70 个 input/output Draft 2020-12 Schema、共享定义、固定 fixture 与离线确定性 resolver |

## 版本和传输

- `protocol_version` 首版固定为整数 `1`；新增可选字段不升主版本，删除/改义必须升主版本。
- private stdio 使用 UTF-8 NDJSON；Electron preload 只向 Rust Product Core 提交 `ClientIntent` 或 UI Query。renderer 不得直接访问 private stdio、原始 App Server 协议或任意方法调用器。
- 调用者不得提交 `actor_context`、`caller_identity`、有效 grant、wallet、billing、Gate Receipt 或 `audit_context`；Trusted Gateway 根据已认证 channel、Surface/Extension Registry、Project Binding 和服务端投影注入 `AuthorizedCommand`。
- Human Gate 决定只经认证 `app_ui` 产品命令提交，不属于 Public Capability Facade；Trusted Gateway 只注入与候选、动作/范围或安装清单精确绑定且未过期的回执。
- 单信封默认上限 1 MiB。大文件、图像、Office 和视频以 `ArtifactRef` 表示业务身份，以 `ResourceHandle` 做短期受限传输；两者不能互换。
- `ResourceHandle.auth_tag` 是 Rust Product Core 签发的带密钥 MAC 或数字签名；可被调用方自行重算的内容哈希不构成授权证明。
- UI Query 与 Public Capability Facade 分离；Event Cursor 断档、Projection 版本变化或 Core 重启必须发出 `resync_required`，UI 重读 Snapshot。
- 同一 aggregate 的 Event 以 `aggregate_revision` 严格递增；出现缺口时重读 projection。
- Host、Network、Managed AI 命令必须带 deadline；取消通过 `system.request.cancel` 引用原 `request_id`。
- schema 校验失败不允许部分执行；必须返回 `SW_SCHEMA_INVALID`。

## 生成代码与契约测试

生产实现应从 Schema 生成或校验 Rust/TypeScript/Python 类型，不手工维护另一套枚举。每个协议消费者必须共用以下 fixture 类别：

1. 最小合法 ClientIntent、AuthorizedCommand、ResourceHandle 与 UI Query；
2. 含所有可选字段的合法信封；
3. 缺失必填字段；
4. 未知字段和未知枚举；
5. ClientIntent 伪造 actor、caller、grant、wallet、billing、Gate Receipt 或 audit context；
6. ResourceHandle audience、revision、TTL、range 与 size 越界；
7. 不支持的协议主版本与超过大小上限；
8. Event revision/cursor 重复和缺口、Projection 版本变化与 resync；
9. 取消、deadline 和重复 `request_id`。

当前 Contract Foundation Node/AJV 元验证、协议 fixture 与公开方法 Schema 校验共 284/284，通过独立 TypeScript、Python、Rust Draft 2020-12 消费者对 CF-PROTOCOL-002 的 46 个协议 fixture 产生 46/46 一致判定。35 个方法的 70 个 catalog URI 全部由 `public-method-schemas/resolve.mjs` 离线、确定性解析；resolver 校验 catalog、containment、realpath、从文件系统根到 `contractsDir` 的每一级祖先非 symlink directory、目标 regular-file 与字节哈希。每个 Schema 的 `$id` 精确等于 catalog URI，70 个最小合法 input/output 与 70 个非法样例均经过真实 AJV 校验；独立手写 `method-contract-inventory.json` 另将 catalog、Schema、fixture 四方对照，并证明占位 Schema 变异会被拒绝。统一 Contract Gate 将完整 parity report 写入 `artifacts/consumer-parity.json`，并在 `results.json` 绑定其 SHA-256；三端消费者依赖分别由现有 npm lock、Python `uv.lock` 与 Rust `Cargo.lock` 固定。最新证据为 `evidence/contract-foundation/20260901T150050887Z-2600-e32e071d6c2bed612eff96b2/`，Contract Foundation 的执行结论为未签署 draft `GO`、limitation 为空。

`public-capability-methods.json` 当前锁定 35 个 V1 方法名、已解析 Schema ID、Gate 分类和风险类型，`schema_resolution_status=resolved`。公共结构集中在 `public-method-schemas/common.schema.json`：LogicalPath 拒绝 `.`/`..`、反斜杠、重复分隔符和百分号编码，`browser.fetch` 只允许显式 HTTPS 且拒绝本地/回环/凭据 URL。大文件、图片、Office 和视频只通过 `ArtifactRef`/`ResourceHandle` 表达；`runtime.probe` 不返回路径。Managed AI Schema 递归拒绝内部路由字段别名和显式 key/value 泄漏标记，但真实 handler 的输出清洗与 Secret scanner 仍属 G5 垂直切片。Schema 形态过滤不代替未实现的 Network Broker DNS/IP/redirect/localhost 每跳校验与垂直验收。Schema 完成只解除 Contract Foundation 的契约条件，不代表真实领域 handler 或产品 Worker 已实现，因此 `G5-FACADE-001` 仍保持 `CONDITIONAL_GO`。
