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
| `public-method-schemas/` | 34 个方法的 68 个 input/output Draft 2020-12 Schema、共享定义、固定 fixture 与离线确定性 resolver |
| `viewer-descriptor.schema.json` | Viewer Registry 的探测、能力、依赖、限额、fallback 与准入元数据 |
| `format-admission-record.schema.json` | 每个格式变体的平台、Corpus、Gate、支持模式和技术状态 |
| `format-admission-ledger.json` | 唯一机器可读格式准入登记表；初始记录全部为 `RESEARCH_REQUIRED` |
| `viewer-chunk-manifest.schema.json` | 可离线签名 Viewer Chunk 的身份、依赖、许可、来源、哈希与签名 |
| `viewer-protocol.schema.json` | Product Core 内部 Viewer Open、状态快照与诊断契约 |
| `viewer-security.schema.json` | Viewer ResourceHandle、一次性 SecretHandle、字体和 Office 特征清单 |
| `viewer-review.schema.json` | 格式专属批注锚点、Diff 能力和事务导出命令 |
| `viewer-render-artifacts.schema.json` | 可复现的隔离 Worker `PptPageRender` 制品 |
| `viewer-gate-receipt.schema.json` | 与候选、平台、Corpus 和证据哈希强绑定的 GVP-0–5 回执 |
| `viewer-contract-fixtures.json` | 每个新 Viewer contract 分支的合法与非法 fixture |

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

当前 Contract Foundation 注册 Viewer 合约、全量 Format Admission Ledger 和公开方法 Schema。34 个 active 方法的 68 个 catalog URI 全部由 `public-method-schemas/resolve.mjs` 离线、确定性解析；每个 Schema 的 `$id` 精确等于 catalog URI。`wps.render_preview` 仅存于机器可读弃用记录，不能解析为 active callable method。历史 Contract Foundation 证据不因本次契约迁移自动升级；新 Viewer fixture 与 GVP-0–5 均保持 `RESEARCH_REQUIRED`。

Format Admission Ledger 当前有 89 个稳定格式/容器/解析变体记录，覆盖设计 §5 的 96 个扩展名；只有检测和解析行为完全相同的真别名共用记录。`PROVEN_*` 晋级不接受内联回执摘要：`admission_receipt_refs` 必须指向可解析的 `ViewerGateReceipt`，并绑定文件哈希、候选/版本、格式、Corpus、Chunk、平台、Gate 和 `GO` 裁决。

`public-capability-methods.json` 当前锁定 34 个 active V1 方法名及一个不可调用的 dated deprecated record，并继续约束 Schema ID、Gate 分类和风险类型。公共结构集中在 `public-method-schemas/common.schema.json`。大文件、图片、Office 和视频只通过 `ArtifactRef`/`ResourceHandle` 表达；`runtime.probe` 不返回路径。Schema 形态过滤不代替未实现的领域 handler、Network Broker、Viewer Worker 或垂直验收。
