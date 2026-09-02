# 技术可行性 03：Durable Workflow、Capability、闭源打包与 Rust 迁移

> 状态：Workflow/Capability fixture 已执行；签名 Package、双平台干净机与 SBOM 环境阻塞  
> 日期：2026-09-01  
> 范围：`UI-04`、`SEC-06`、`WF-01`～`WF-10`、`SK-01`～`SK-07`、`RUST-01`～`RUST-04`（WF-10 为后补的统一恢复状态项）  
> 结论等级：除明确保留为 `RESEARCH_REQUIRED` 的项目外，本报告结论均为 `FEASIBLE_CONDITIONAL`。

## 1. 本轮结论

SuperWagie 的“两阶段内置 Skill”路线可行，但必须把几个概念拆开：

1. **Dev Skill**：第一阶段保留 `SKILL.md`、MCP、Python/Node/Go 工具，便于快速调试行为；
2. **Capability Contract**：从第一天存在，统一声明输入输出、权限、依赖、Artifact、人工门、幂等与计量；
3. **Durable Workflow**：由 Rust Product Core 执行版本化状态机，不把 `流水线状态.md` 或聊天历史当机器真相；
4. **Capability Builder**：负责验证、生成适配器、固定依赖、差分测试、签名与打包；
5. **Rust/Wasm 迁移**：只对已识别、确定性的模块逐项人工迁移，不承诺自动翻译任意 Skill；
6. **Private Capability**：生产包不再以标准可复制 Skill 形式发布，但本地闭源制品不能保证绝对不可逆；真正敏感的 Prompt、路由和商业逻辑应留在服务端。

推荐总体架构：

```text
研发期
Traditional Skill / MCP / Script
        │
        ├── 必须通过 SuperWagie Dev Host 调用 Capability Facade
        ├── 必须带 capability manifest 和 contract tests
        └── 生成 reference run / golden evidence
        │
        ▼
Capability Builder
├── manifest/schema lint
├── dependency and license lock
├── adapter/code generation
├── reference/private differential runner
├── SBOM + provenance
└── signed .swcap package
        │
        ▼
生产期
SuperWagie Durable Workflow Engine
├── Rust Core operations
├── Wasm component operations
├── sandboxed Python/Node/Go worker（尚未迁移部分）
├── Electron/Chromium Surface module
└── isolated Host Worker adapter（WPS/Office）
```

### 1.1 最重要的边界

| 问题 | 结论 |
|---|---|
| 能否自动把任意 Skill 编译成 Rust | 不能。这是 `NO_GO` 的泛化目标；只能自动构建契约/包，Rust 逻辑需要模块化迁移和差分验证 |
| 能否不再发行可复制的标准 Skill | 可以。生产包可只含编译制品、Wasm、受限 Worker 和签名 Manifest |
| 能否保证客户端中的逻辑绝对无法提取 | 不能。加密、混淆和 AOT 只能增加成本；离线执行需要在本机出现可执行逻辑 |
| 如何获得较强 IP 保护 | 敏感 Prompt、模型路由、策略和高价值编排留在服务端；本地只拿短期、任务化、最小计划 |
| 能否直接嵌入 Temporal | 不建议。Temporal 是成熟参考，但本地桌面产品不应增加独立服务和运维依赖 |
| 本地 Workflow 如何可靠 | SQLite 事务 + append-only event log + immutable Artifact revisions + effect receipt + fault injection |
| Workflow 状态放在哪里 | 机器真相位于 SuperWagie App Data 的本地 SQLite；项目只保存人类投影、Artifact 与可迁移 checkpoint manifest |
| 用户 Skill 如何兼容 | 继续以源代码形式安装到 Extension Sandbox；与官方 Private Capability 使用同一 Facade，但信任等级和签名策略不同 |

## 2. 现有项目提供的真实架构证据

本轮先对已在本机的 NeoMei 项目做了源码级初查。它们不是最终 SuperWagie 架构，但已经证明了若干关键模式。

### 2.1 SessionReviewer：事务与证据链模板

当前 SessionReviewer 使用 Go 确定性引擎和 Skill 语义层：

```text
Codex session JSONL
 -> bounded/redacted evidence packet
 -> Skill 生成 proposal
 -> CLI schema/invariant validation
 -> render all target bytes
 -> ledger + receipt
 -> accepted cursor CAS
```

它已经包含：稳定 cursor、packet digest、proposal schema、revision、幂等 `already_applied`、写入后/cursor CAS 前恢复、三方合并、冲突 ID、hidden machine ledger 和人类可读 Markdown。这是 SuperWagie 的 `Prepare → Execute → Commit`、effect receipt、proposal/apply、恢复和人机数据分层的首要参考。

适配建议：

- Go CLI 第一阶段可作为签名 Worker 直接复用；
- session source 不再默认读取系统 `~/.codex/sessions`，改由 SuperWagie Runtime Event Store 提供 typed cursor stream；
- `prepare/proposal/apply` 保持契约，Host 负责 Workspace scope、Artifact 事务和 UI；
- 稳定后可把 redaction、schema validation、merge、ledger 和 transaction 模块迁移 Rust；
- 语义 synthesis 继续走 Managed AI，不在本地保存 Provider Key。

参考：

- [SessionReviewer repository](https://github.com/NeoMei/SessionReviewer)
- 本地 `README.zh-CN.md`、`schemas/`、`internal/sync/`、`internal/reviewv2/`、`internal/proposal/`

### 2.2 SuperWriter：阶段契约与门，但还不是 Durable Workflow

SuperWriter 已有：

- 0～9 阶段和机器/人工门；
- `references/阶段契约.json` 作为 interaction/action 的唯一语义；
- `流水线状态.md`、评分表、矩阵、大纲、章节、配图、合并稿和验收清单；
- WPSComposer、访谈/建模 Skill、ai-image-to-ppt、obsidian-excalidraw 等依赖；
- `验收清单.json` 与 verifier 对阶段证据、输出哈希和交付物进行确定性检查。

这证明 Guided Workflow 可从现有 Skill 中抽出，但 `流水线状态.md` 仍是人类文件，不能承担并发、lease、effect receipt、Schema migration 或 crash recovery。

适配建议：

- 把阶段契约转为 `WorkflowDefinition`；
- 人工门转为 `AwaitingUserInput` event 和版本化 `InteractionSpec`；
- `流水线状态.md` 变成 Rust projection，不再是机器权威；
- 第三方 Skill 依赖改为 Capability ID/version constraint；
- 标书内容、配图和 WPS 导出通过 Artifact/Host Request，不让编排文本直接执行任意命令。

参考：

- [SuperWriter repository](https://github.com/NeoMei/SuperWriter)
- 本地 `SKILL.md`、`references/阶段契约.json`、`references/依赖清单.json`、`scripts/verify_acceptance.py`

### 2.3 SuperPPT：稳定身份、确认基线和局部失效模板

未发布的 SuperPPT 设计已经明确：

- outline、逐页描述、代表性样页三个人工确认门；
- 每页稳定 ID，页码只是排序；
- 上游 revision、影响范围、局部重算和旧版本保留；
- image/editable 两类页面；
- `superppt.json` 机器状态、`项目状态.md` 人类投影；
- staging、failed-runs、ownership marker、Artifact hash；
- 单页修改预览确认后才替换整套版本。

这是 `WF-03`、`WF-07`、`WF-08`、`WF-09` 的直接需求样本。正式实现应把这些规则放入通用 Workflow Engine，而不是仅存在于 Skill 指令和项目 JSON 中。

### 2.4 WPSComposer：Host Worker 的闭合生成计划

WPSComposer 已把长文档架构拆成：Markdown → semantic model → versioned closed generation plan → Windows COM/macOS JSAPI executor → temporary PDF quality gate → atomic publication。

其设计明确要求生成计划只包含允许操作、纯 JSON 参数和逻辑资源 ID，不包含任意脚本、平台对象或未验证路径。这与 SuperWagie Host Request Contract 高度一致。

适配建议：

- `generation_plan` 直接成为 `wps.execute-plan` Host Request payload；
- WPS Worker 独立进程，Rust Product Core 负责 deadline、lease、专属实例、staging、Effect Journal 和 receipt；
- Python 语义/渲染模块先保留，锁定在隔离 env；
- 计划验证、Artifact transport、Unicode/ID、通用 document model 可逐步迁移 Rust；
- macOS JSAPI 和 Windows COM 保留生态实现，不强行 Rust 重写。

参考：

- [WPSComposer repository](https://github.com/NeoMei/WPSComposer)
- 本地 `skills/WPSComposer/`、`generation_plan.py`、`artifact_transport.py`、`docs/superpowers/specs/2026-08-20-wpscomposer-longform-engine-design.md`

### 2.5 ai-image-to-ppt：Host 能力路由与 Artifact 接收

ai-image-to-ppt 当前已区分 Host Capability 与显式 API fallback，并实现固定候选顺序、fatal/fallback 状态、serial sticky batch、原始 Host Artifact 保存、严格比例/尺寸、output ownership、recovery 和 export limits。

适配建议：

- 删除 Skill 自己寻找 Provider Key 的默认路径，统一调用 `ai.generate_image`；
- 保留 routing state、sticky batch、尺寸验证、Artifact import、导出与 recovery 作为 Capability 内部逻辑；
- Provider 名只进入服务端 receipt 或内部审计，不进入用户可见项目状态；
- POSIX-only 安全发布逻辑不能直接宣称 Windows 可用，应改用 SuperWagie 跨平台 Artifact Store。

参考：

- [ai-image-to-ppt repository](https://github.com/NeoMei/ai-image-to-ppt)
- 本地 `references/host-image-routing.md`、`scripts/host_routing_policy.py`、`scripts/import_host_image.py`

### 2.6 obsidian-excalidraw：确定性生成 + Web 渲染的混合能力

该项目用 Python 把无坐标 spec 转为 `.excalidraw`/`.excalidraw.md`，再用固定版 Excalidraw + Playwright 做视觉验证。其当前依赖包括 Python 3.11、Playwright、Chromium、Excalidraw 0.18.1 和大量字体资源。

适配建议：

- 生成器、布局、binding、schema validation 可迁移 Rust；
- 不再为该能力单独下载 Chromium；交互复用隔离 `diagram_editor`，导出与 QA 使用 Electron Render Worker Host；
- 字体资源与许可证进入统一静态资产/SBOM；
- `.excalidraw.md` 兼容仍需独立语料 PoC。

### 2.7 agentwiki-sync：Port/Adapter 和预览确认模板

agentwiki-sync 已将 Vault、HTTP、Secret、Remote、Control Store 抽为 ports，并实现 snapshot/delta、baseline、generation、three-way merge、pull transaction、preview/confirm、retry、limits 和 protocol conformance tests。

适配建议：

- TypeScript Obsidian adapters 替换为 SuperWagie Workspace/Secret/Network ports；
- core canonical/hash/model/merge 可优先迁移 Rust；
- Remote API 和 retry 保留 adapter；
- Pull/Push 的 preview、用户确认、事务和服务端审批必须继续分离。

参考：

- [agentwiki-sync repository](https://github.com/NeoMei/agentwiki-sync)
- 本地 `src/ports/`、`src/application/`、`src/storage/`、`src/core/`、`docs/contracts/`

### 2.8 codex-roundtable：纯 Skill 的能力与限制

codex-roundtable 是 skills-only 编排，依赖 Codex 原生 subagent 工具；当前明确不保证 app restart 后恢复，也明确成员的 analysis-only 只是指令边界，不是独立硬沙箱。

适配建议：

- roster、round、member turn、summary、interjection 和 minutes 变成 Durable Workflow state；
- 参与者通过 SuperWagie Agent Runtime API 创建，权限由 Host 强制为 read-only capability set；
- model 选择对普通用户隐藏，改为 persona/profile；
- 纯文本 Skill 可继续作为研发 reference，但生产形态应是 WorkflowDefinition + server policy。

参考：

- [codex-roundtable repository](https://github.com/NeoMei/codex-roundtable)

## 3. Durable Workflow Engine

### 3.1 为什么不能只靠聊天和状态文件

聊天历史、`项目状态.md` 或 `superppt.json` 可以作为投影或导出，但无法独立解决：

- 一次 Host Request 在 crash 前执行成功、但结果尚未写入状态；
- 用户同时在 UI 和外部应用编辑源文档；
- 旧客户端打开新版本 Workflow；
- retry 导致图片、WPS、上传或 Credits 重复执行；
- confirmed revision 被上游修改后，哪些下游对象应失效；
- 多窗口、后台任务或客户端重启后的 lease 接管。

推荐一个本地嵌入式、单用户优先的 Durable Workflow Engine。Temporal 可作为 durable execution、retry、activity/workflow 分离的概念参考，但不直接嵌入其独立服务。

参考：

- [Temporal durable execution repository](https://github.com/temporalio/temporal)（MIT，概念参考）
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)
- [SQLite WAL](https://www.sqlite.org/wal.html)

SQLite 官方说明事务在 OS crash 或断电中仍表现为原子提交；但数据库不得放在不可靠网络文件系统，Artifact 文件也不与 SQLite 自动形成跨文件原子事务。因此需要显式 Artifact journal。

### 3.2 状态模型

建议核心表/实体：

```text
workflow_definition
workflow_run
workflow_event          # append-only
workflow_projection     # 当前投影，可重建
step_run
approval
interaction_response
effect_request
effect_receipt
artifact_revision
source_binding
lease
outbox
```

关键事件示例：

```text
RunCreated
StepScheduled
StepStarted
InteractionRequested
InteractionAnswered
ApprovalGranted
EffectPrepared
EffectCommitted
ArtifactPromoted
StepCompleted
StepFailed
SourceRevisionChanged
DownstreamInvalidated
RunPaused / RunResumed / RunCompleted
```

规则：

- event 只追加，不原地改历史；
- projection 与 event append 在同一 SQLite transaction；
- LLM 输出和外部副作用不通过“重放函数”重新执行，而是以 effect receipt 恢复；
- 每个 definition、event payload、interaction 和 receipt 都有 Schema version；
- migration 必须能从 fixture DB 验证，不能靠运行时 Prompt 猜测旧状态。

#### 3.2.1 本机机器状态与项目可迁移状态

已确认采用分层持久化：

```text
SuperWagie App Data（本机、机器真相）
└── workflow.sqlite
    ├── append-only events / projections
    ├── lease / outbox / effect request + receipt
    ├── approval / interaction response
    ├── local recovery journal
    └── local account/task references

用户项目目录（可读、可复制、非事务数据库）
├── 项目状态.md / 各交付物项目状态.md
├── 用户内容与不可变 Artifact revisions
└── .superwagie/
    ├── project.json
    └── checkpoints/
        └── <checkpoint-sequence>.json
```

`workflow.sqlite` 不放进用户项目、Vault、NAS、Dropbox、OneDrive 或其他同步目录；不能通过复制数据库迁移任务。项目 checkpoint manifest 是经过 Schema 校验的可迁移恢复描述，至少包含：

- project/delivery/run 的稳定 ID 与 Workflow definition/version；
- 当前已完成阶段、人工确认和下一安全步骤；
- source bindings 的项目相对路径、revision 和内容哈希；
- Artifact 的项目相对路径、类型、revision 和内容哈希；
- 已提交 effect 的不透明 receipt reference 和幂等标识；
- manifest schema version、sequence、created_at 和整体摘要哈希。

checkpoint manifest 不包含 Provider Key、账户 refresh token、Credits 账本、私有 Prompt/Workflow 实现、任意本机绝对路径或可直接重放的高权限请求。用户复制项目后，另一台机器将 manifest 视为不可信导入数据，重新验证 root containment、文件/Artifact 哈希、Capability 版本和服务端 receipt；不能验证的已完成步骤进入 Review，尚在执行中的外部 effect 一律恢复为“待核对/暂停”，不得自动重放。

导入成功后在目标机器创建新的本地 `workflow_run` 绑定，并保留原 run ID 作为 provenance；导入副本不得与原机器共享 lease。项目状态 Markdown 继续作为用户可读投影，即使 checkpoint 缺失也能理解已有成果，但不能凭 Markdown 推断已完成支付、发布或其他外部副作用。

#### 3.2.2 并行任务与 Working Set 写 Lease

已确认并发策略为：项目之间可并行；同一项目的只读任务可并行；写任务按实际 Working Set 获取互斥 Lease。

```text
Project A
├── Read-only task R1 ─────────────── parallel
├── Write task W1: 内容/A.md ──────── lease(paths=[A.md])
├── Write task W2: 交付物/PPT-X/** ── lease(subtree=PPT-X)  parallel with W1
└── Write task W3: 内容/A.md ──────── queued / rebase after W1

Project B
└── tasks ─────────────────────────── independent parallel execution
```

Lease 必须绑定 `project_id + canonical file/subtree identities + owner run/step + base revisions + expiry + fencing token`。目录 Working Set 在执行前解析为授权 subtree 和当前目标集合；新增文件只能写入已授权 subtree。父目录与子路径、rename 源与目标、大小写/Unicode 等价路径都视为重叠，不能只比较字符串。

规则：

- 只读任务不获取独占写 Lease，但读取结果带 revision，升级为写任务前必须重新检查并获取 Lease；
- 不重叠写集可以并行；每个交付物独立目录天然形成主要并行单元；
- 请求与现有 Lease 重叠时默认排队；若任务允许重新规划，可在前一任务提交后基于最新 revision 重建 patch；
- 不允许两个任务先同时覆盖同一文件、再把自动三方合并当正常路径；只有外部编辑或不可避免竞态才进入 Base/Current/Proposed 冲突流程；
- Lease 通过 heartbeat 续期，进程崩溃后必须等待过期或由拥有更高 fencing token 的恢复者接管；旧 Worker 即使恢复也不能提交；
- Obsidian、WPS 和其他外部应用不参与 Lease，因此所有实际写入仍必须执行 revision/CAS 检查；
- 文件 rename/move、跨文件引用更新和多文件事务在整个目标集合上一次性获取 Lease，避免只锁主文件而漏掉引用文件。

### 3.3 Effect 的 Prepare / Execute / Commit

```text
1. Prepare
   - validate request schema and permission
   - bind input revisions/artifacts
   - allocate effect_id + idempotency_key
   - reserve credits if needed
   - append EffectPrepared

2. Execute
   - call AI / WPS / network / worker
   - write only to private staging
   - collect structured receipt and output hashes

3. Commit
   - validate output
   - promote immutable artifact revision
   - append receipt + ArtifactPromoted + StepCompleted
   - settle credits
```

若 crash：

- 没有 `EffectPrepared`：可重新计划；
- 有 prepared、无 receipt：用同一 idempotency key 查询/重试；
- 有 receipt、无 Artifact pointer：验证 staging/object hash 后完成提升；
- 已 commit：返回 existing receipt，不重复执行。

### 3.4 Artifact Store

多文件交付物不能依赖逐文件覆盖。使用 immutable version directory：

```text
artifacts/<artifact-id>/revisions/<revision-id>/
├── manifest.json
├── files/...
└── receipt.json
```

`current revision` 是数据库指针或一个原子替换的小 pointer 文件。生成过程只写 staging；完成文件 hash、结构、ownership、格式验证后才提升为 revision。失败运行进入 quarantine/failed-run 并保留有界证据。

### 3.5 Dependency DAG 与局部失效

所有关键对象使用稳定语义 ID 和 revision：

```text
source section@r3
  -> brief@r4
  -> outline node@r2
  -> slide spec@r5
  -> prompt@r3
  -> image@r1
  -> deck@r7
```

上游改变时只把可达的下游 revision 标为 stale，不删除旧 Artifact。用户先看到影响范围，再确认生成新 revision。曾确认的 baseline 保留，可以回到旧版本；“确认”不是永久锁死。

## 4. Guided Workflow UI Protocol

Skill 不能向 WebView 注入任意 HTML/JS。Capability 只能返回声明式、版本化 UI：

```text
InteractionSpec
├── id / schema_version / run_id / step_id
├── title / explanation
├── fields[]
│   ├── short_text / long_text
│   ├── single_choice / multi_choice
│   ├── file_or_directory_scope
│   └── structured_editor
├── previews[]
│   ├── markdown
│   ├── diff
│   ├── artifact_ref
│   ├── slide/contact-sheet
│   └── office/pdf preview
├── decisions[]
├── validation_schema
├── expires_on_source_revision_change
└── actions[] = confirm / revise / back / cancel
```

安全规则：

- 组件类型是 Host 固定白名单，Capability 不提供脚本、CSS 或 URL；
- 所有文本作为不可信内容渲染，Markdown HTML 默认禁用；
- file picker 返回 scope handle，不返回任意可伪造绝对路径；
- response 带 interaction ID、source revisions 和 nonce，旧问题的答案不能应用到新 baseline；
- Capability 可给推荐值和理由，但 Host 决定是否需要确认、是否允许跳过；
- Back/Revise 创建新 event，不改写历史答案。

Content Readiness Gate 是一种标准 Interaction：

```text
readiness
├── hard_blockers[]      # 无法继续，例如缺关键源文档
├── quality_gaps[]       # 可继续但质量受影响
├── questions[]          # 针对当前内容的具体问题
├── requested_materials[]
├── safe_assumptions[]
└── user_decision = supplement | accept_risk | cancel
```

## 5. Capability Contract

建议 Manifest 至少包含：

```text
identity
├── id / version / publisher / trust_tier
├── min_host_version / contract_version
└── entrypoints[]

permissions
├── workspace read/write scopes
├── process/runtime requirements
├── network operations/domains
├── managed AI operations/profiles
├── credentials handles
└── trusted host operations

runtime
├── rust-core | wasm-component | python-worker | node-worker | webview-module
├── platform/architecture
├── lockfile hashes
└── resource/time/memory limits

workflow
├── definition/schema versions
├── resumability/idempotency
├── interactions/approvals
└── effects/artifacts/receipts

distribution
├── files + sha256 + size
├── SBOM / licenses / notices
├── provenance
└── signatures
```

同一 Facade 向官方和用户 Capability 暴露相同功能，但策略不同：

| 类型 | 代码形态 | 信任 | 默认权限 |
|---|---|---|---|
| Rust Core built-in | 随主程序编译 | 平台签名、最高 | 仍通过内部 typed API，不给任意路径/Key |
| Official Private Capability | 签名 Wasm/Worker/Web assets | 平台签名 | 按 Manifest |
| User Capability | 源码或用户构建包 | 未信任/用户签名 | 最小、默认断网、强确认 |
| Dev Reference Skill | SKILL/MCP/scripts | 开发信任 | 只在 Dev Host，不能进入生产默认路径 |

## 6. 两阶段转换的真实实现路径

### 6.1 第一阶段：Reference Capability

每个要内置的 Skill 必须补齐：

```text
capability.toml/json
schemas/input.json
schemas/output.json
schemas/events.json
fixtures/
reference-runner
acceptance-runner
license-lock/SBOM
```

传统 Skill 可以继续用 Prompt 编排，但所有文件、AI、网络、WPS、绘图和 Artifact 操作必须改走 Dev Host Facade。这样生产转换时只替换内部执行单元，不改变对外 contract。

MCP 适合第一阶段本地工具适配。当前 MCP 规范使用 JSON-RPC，标准本地传输是 stdio，客户端负责启动 server；Remote 使用 Streamable HTTP。SuperWagie Dev Host 应优先使用私有 stdio，并固定协议版本、tool allowlist 和 schema；生产 Private Capability 不需要为了“兼容”而继续暴露完整 MCP server。

参考：

- [Model Context Protocol specification](https://modelcontextprotocol.io/specification/)
- [MCP transports](https://modelcontextprotocol.io/specification/draft/basic/transports)

### 6.2 第二阶段：Private Capability

Capability Builder 可自动完成：

- Manifest/schema/permission lint；
- 为 Rust/WIT/Worker 生成绑定和 adapter skeleton；
- 依赖锁定、license/SBOM、资源清单；
- Reference 与 Private runner 对同一 fixture 的差分；
- 签名 package、兼容矩阵和升级 metadata；
- 安装、回滚和 quarantine 测试。

不能自动完成：

- 把任意自然语言指令准确转成状态机；
- 把任意 Python/JS/Go 语义无损翻译 Rust；
- 判断一次 LLM 结果与另一次结果“语义等价”；
- 把依赖浏览器、WPS COM/JSAPI 的能力变成纯 Rust；
- 证明闭源包绝对不可逆。

因此 `Skill Compiler` 应正式改名为 `Capability Builder`。若保留 Compiler 一词，也只能指 schema/binding/package compilation，不指通用代码翻译。

## 7. Wasm 与 Worker 执行形态

Wasmtime 是 Bytecode Alliance 的 WebAssembly/WASI/Component Model runtime，采用 Apache-2.0 with LLVM exception。WebAssembly 默认必须显式 import Host 功能，WASI 文件系统使用 capability-based security；Wasmtime 提供 memory/instance resource limiter、fuel/epoch 等中断机制。

参考：

- [Wasmtime documentation](https://docs.wasmtime.dev/)
- [Wasmtime security](https://docs.wasmtime.dev/security.html)
- [Wasmtime Store resource limits](https://docs.wasmtime.dev/api/wasmtime/struct.Store.html)
- [Wasmtime repository and license](https://github.com/bytecodealliance/wasmtime)

建议执行选择：

| 能力类型 | 首选形态 | 说明 |
|---|---|---|
| 稳定、确定性、纯数据变换 | Rust Core 或 Wasm Component | merge、hash、schema、索引、路由、manifest、文件计划 |
| 可选官方确定性模块 | Wasm Component | 进程内但 capability imports、memory/time limit；仍需 Wasmtime CVE 更新 |
| Python/Node/Go 生态能力 | 独立 Worker + stdio | 第一阶段保留；用 OS sandbox、锁环境、deadline、typed protocol |
| WPS/系统宿主 | Host Worker | COM/JSAPI 必须保留；不进入通用用户 sandbox |
| Markdown/Excalidraw/draw.io | WebView Module | Host asset/IPC capability，不提供任意 JS bridge |
| 高价值 Prompt/路由 | 服务端 | 客户端不持有长期策略真相 |

不要把 native dynamic library 从 Capability 包直接加载进 Rust Core。即使官方签名，崩溃和内存安全问题也会拖垮主进程；可选原生能力应使用 Worker，或静态并入受完整发布测试的 Core。

## 8. 私有包、签名、升级和现实保护边界

### 8.1 `.swcap` 包

建议使用一个受限 ZIP/自定义容器，至少包含：

```text
manifest.json
manifest.sig
payload/
schemas/
sbom.cdx.json
LICENSES/
provenance.json
```

Manifest 列出每个文件的规范路径、SHA-256、长度和类型。安装流程：

1. 读取有大小上限的 header/manifest；
2. 用内置 root public key 验证签名；
3. 验证 publisher delegation、host compatibility、rollback/freeze metadata；
4. staging 解包，拒绝绝对路径、`..`、symlink、hardlink、重复/大小写碰撞和超额展开；
5. 对每个文件验证 size/hash；
6. 做 dependency/license/policy check；
7. 原子提升新 immutable version，最后切换 current pointer；
8. 旧版本保留到健康检查和 Workflow migration 成功。

下载与密钥轮换可参考 TUF。TUF 定义 root、targets、snapshot、timestamp 等角色，用于抵御 arbitrary install、endless data、extraneous dependency、freeze、mix-and-match 和 rollback 攻击。

参考：

- [The Update Framework specification](https://theupdateframework.github.io/specification/latest/)

### 8.2 闭源不等于不可提取

现实保护等级：

| 手段 | 能保护什么 | 不能保护什么 |
|---|---|---|
| 不分发 SKILL.md/源码 | 降低直接复制 | 不能阻止逆向二进制/运行期观察 |
| Rust native/AOT Wasm | 增加逆向成本 | 不能提供数学意义不可逆 |
| Package 加密 | 防静态随手查看 | 客户端执行需要解密，密钥和明文可被调试 |
| 签名 | 真实性、完整性、升级授权 | 不提供保密性 |
| 混淆/反调试 | 增加成本 | 可能破坏稳定性，也不能保护服务端 Secret |
| 服务端执行 | 最强保护 Prompt/策略/路由 | 增加在线、延迟、服务成本和隐私边界 |

推荐把“闭源能力”的承诺写成：

> 生产版不发布可直接复制的标准 Skill 源文件；本地逻辑以签名编译制品和受限 Worker 分发；高价值策略保留服务端。平台不承诺客户端制品绝对无法逆向。

## 9. Rust-first 迁移策略

迁移优先级：

1. **安全与身份**：path/scope、hash、signature、manifest、token、permission；
2. **Durable state**：event log、revision、DAG、lease、receipt、Artifact store；
3. **确定性 contract**：schema、canonicalization、merge、routing、validation；
4. **性能热点**：large vault index、session stream、image metadata、package/install；
5. **可稳定移植的业务规则**；
6. 最后才考虑 Prompt-heavy 和 Office/Web 生态部分。

每次迁移必须：

- 冻结 reference version 与 fixtures；
- 记录 reference input/output/event/artifact hashes；
- 为 nondeterministic AI 使用 mock/record-replay，不比较两次真实模型文本；
- 对确定性部分做 byte/semantic differential；
- 对视觉产物做结构 + 渲染容差；
- 新实现支持按 Capability version 回滚；
- 只有安装包、启动、内存或耗时基准实际改善，才计入 Rust 收益。

## 10. 分项可行性结论

### 10.1 Workflow 与 UI

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| UI-04 | `FEASIBLE_CONDITIONAL` | Host 白名单声明式 `InteractionSpec`，Capability 不提供任意 UI 代码 | 版本兼容、恶意 schema、过期 response、Back/Revise PoC |
| WF-01 | `FEASIBLE_CONDITIONAL` | App Data 本地 SQLite event log + projection + versioned confirmation event；项目生成可迁移 checkpoint manifest | 本机重启完全恢复；复制项目到另一台机器可校验导入且不复制活跃数据库 |
| WF-02 | `FEASIBLE_CONDITIONAL` | Working Set 写 Lease + fencing token + safe checkpoint + effect idempotency/receipt；跨机器导入创建新 run binding | 多项目、同项目不重叠写集、重叠排队、kill -9、过期 Lease、旧 Worker 迟到提交、跨机器导入均不重复或覆盖副作用 |
| WF-03 | `FEASIBLE_CONDITIONAL` | stable semantic ID + revision DAG + stale propagation | SuperPPT 修改大纲/页面/风格的局部失效 fixture |
| WF-04 | `FEASIBLE_CONDITIONAL` | typed Prepare/Execute/Commit + request ID + receipt | AI/WPS/upload 每个 effect 在所有 crash point 恢复 |
| WF-05 | `FEASIBLE_CONDITIONAL` | private staging + immutable revision + quarantine + atomic pointer | 部分输出、格式错误、磁盘满不替换旧成功版本 |
| WF-06 | `FEASIBLE_CONDITIONAL` | `InteractionSpec` + diff/preview/artifact refs + response schema | SuperWriter/SuperPPT 全部人工门能无自定义 JS 表达 |
| WF-07 | `FEASIBLE_CONDITIONAL` | 标准 `ContentReadiness` issue/decision loop | 内容不足时补充、接受风险、取消与恢复路径通过 |
| WF-08 | `FEASIBLE_CONDITIONAL` | source binding = file ID/range/revision/hash + snapshot | 外部编辑后拒绝把旧确认应用到新内容 |
| WF-09 | `FEASIBLE_CONDITIONAL` | delivery ownership + independent run + immutable artifact tree | 复制/重命名/删除交付目录不会串 run 或误删其他产物 |

### 10.2 Skill 与 Private Capability

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| SEC-06 | `FEASIBLE_CONDITIONAL` | Capability Manifest → policy → approval UI → audit event | 权限新增/减少、拒绝、撤销和企业锁定 PoC |
| SK-01 | `FEASIBLE_CONDITIONAL` | Dev Host 运行传统 Skill/MCP/scripts，但强制走最终 Facade | 一个真实 Skill 在 Dev/Private 两种 runner 下行为一致 |
| SK-02 | `FEASIBLE_CONDITIONAL` | versioned Manifest + JSON Schema/WIT + effects/artifacts contract | SuperWriter、SuperPPT、SessionReviewer、WPS 能被同一元模型描述 |
| SK-03 | `FEASIBLE_CONDITIONAL` | 定义为 Builder：验证、codegen、封装、测试；不承诺任意代码转 Rust | 构建三种 entrypoint 包并 fail-closed 拒绝非法包 |
| SK-04 | `FEASIBLE_CONDITIONAL` | signed `.swcap` + TUF-style metadata + immutable install/rollback | tamper、rollback、freeze、zip bomb、path collision 攻击测试 |
| SK-05 | `FEASIBLE_CONDITIONAL` | 不发标准 Skill；本地编译制品 + 服务端敏感逻辑；不承诺不可逆 | 发布包审计无 reference Skill/明文高价值 Prompt，威胁模型获批 |
| SK-06 | `FEASIBLE_CONDITIONAL` | deterministic differential + recorded AI fixture + structural/visual graders | 每个迁移能力有 reference/private compatibility report |
| SK-07 | `FEASIBLE_CONDITIONAL` | host/contract/capability/artifact schema 独立 semver + compatibility matrix | 跨两个客户端和三个 capability version 的安装/恢复矩阵 |

### 10.3 Rust-first

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| RUST-01 | `FEASIBLE_CONDITIONAL` | Rust Core 承载安全、Workflow、Artifact、Broker、Package | core crash/fuzz/security/跨平台测试通过 |
| RUST-02 | `FEASIBLE_CONDITIONAL` | 按模块人工迁移 + differential runner + rollback | 至少选 SessionReviewer deterministic core 做代表性迁移 PoC |
| RUST-03 | `FEASIBLE_CONDITIONAL` | WebView editor、WPS COM/JSAPI、必要 Python/Node Worker 保留 | IPC/资源/权限边界通过，不因 Rust 目标强拆成熟生态 |
| RUST-04 | `RESEARCH_REQUIRED` | 同功能 reference/private 基准和安装包组成分析 | 尚无真实数据前不承诺包更小或端到端更快 |

## 11. 不采用的路径

- 不把 Workflow 机器真相放在 Markdown、聊天历史或任意 Skill 自写 JSON；
- 不重放 LLM/API/WPS 副作用来“恢复”状态；
- 不把 Temporal、数据库服务或消息队列作为桌面端安装依赖；
- 不允许 Capability 注入任意 HTML、JavaScript、CSS 或 Host command；
- 不把 MCP 当生产内部所有能力的唯一 ABI；
- 不把 native dynamic library 从下载包直接加载进主进程；
- 不宣称可以自动把任意 Skill/Python/JS 翻译成 Rust；
- 不以一次真实模型输出的字面相等作为迁移验收；
- 不把 package 加密宣传为绝对防逆向；
- 不为了“纯 Rust”重写 Excalidraw、draw.io、WPS COM/JSAPI 等成熟生态。

## 12. 必须执行的组合 PoC

### 12.1 Workflow Spike

实现一个一次性本地 Spike，使用 SQLite 和临时 Artifact Store，跑通：

```text
内容输入
 -> readiness gate
 -> outline interaction
 -> one AI effect
 -> one generated file
 -> user confirmation
 -> one Host Worker mock
 -> final immutable artifact
```

在每个 transaction/effect/artifact promotion 边界注入 crash，重启后必须恢复且不重复 effect。

并发场景必须同时覆盖：两项目并行、同项目只读并行、不重叠写集并行、父子目录重叠、大小写/Unicode 等价路径、rename 跨集合、Lease 过期接管和旧 Worker 迟到提交。任何旧 fencing token 的提交必须被拒绝。

随后复制不含 SQLite 的完整项目目录到另一台干净机器，必须能从 checkpoint manifest 与 Artifact 创建新的本地 run binding；篡改 manifest、缺失 Artifact、旧 Capability version 和未完成外部 effect 均应进入明确 Review/暂停状态，不能自动重放。

### 12.2 Guided UI Spike

用同一声明式协议表达：

- SuperWriter 访谈、素材缺口和终稿确认；
- SuperPPT outline、逐页描述、风格样页和单页替换；
- AgentWiki Pull/Push diff/confirm；
- WPS 执行前风险/输出位置确认。

恶意 Capability 提供 script、超大 schema、远程 URL、伪造 artifact、旧 revision response 时 Host 必须拒绝。

### 12.3 Capability Package PoC

构建三种最小包：

1. Rust/Wasm deterministic capability；
2. Python Worker capability；
3. WebView module capability。

验证签名、SBOM、权限、资源限制、安装、升级、回滚、quarantine，以及 tamper/rollback/freeze/path traversal/zip bomb/大小写碰撞。

### 12.4 Reference → Private 差分 PoC

首选 SessionReviewer deterministic core 作为迁移样本：

- Go reference 与 Rust/Wasm candidate 消费同一 bounded packet；
- 比较 redaction、cursor、digest、proposal validation、merge、ledger 和 receipt；
- 保留模型 synthesis 为 recorded fixture；
- macOS/Windows 均跑 fault injection；
- 记录二进制体积、启动、峰值内存和耗时。

### 12.5 Go / No-Go 条件

出现以下任一情况时不得进入正式实现：

- effect 在任一 crash point 可重复产生外部副作用或重复结算；
- Capability 能绕过 Host UI/权限协议提供任意代码或路径；
- package 签名只校验 archive 而不校验解包后的每个 payload；
- Dev Skill 依赖宿主私有能力，但生产 Facade 无等价 contract；
- Reference 与 Private 的差异无法被稳定 fixture 和 grader 判断；
- 项目仍要求“自动把任意 Skill 编译成 Rust”或“客户端包绝对不可逆”。
