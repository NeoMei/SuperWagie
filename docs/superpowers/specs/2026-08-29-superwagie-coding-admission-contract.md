# 超级牛马（SuperWagie）编码准入与契约补充说明

> 状态：架构与编码契约基线；已确认方案 B“分层模块化核心”，Gate 0/2、Gate 3 Review、Gate 4/5/6 的受影响证据已按 `solution-b-v1` 重开  
> 日期：2026-09-01  
> 上位产品基线：`docs/最早期产品方案-V0.1.md`  
> V1 范围基线：`docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md`  
> 上位界面与交付规范：`docs/superpowers/specs/2026-08-28-superwagie-workspace-delivery-design.md`  
> UI 实施契约：`docs/superpowers/specs/2026-08-29-superwagie-ui-implementation-contract.md`  
> 任务管理设计：`docs/superpowers/specs/2026-08-29-superwagie-task-management-design.md`  
> 账户、Credits 与企业组织设计：`docs/superpowers/specs/2026-08-29-superwagie-account-credits-organization-design.md`  
> 连续性、Profile 与记忆设计：`docs/superpowers/specs/2026-08-29-superwagie-continuity-profile-memory-design.md`  
> Connector 与同步设计：`docs/superpowers/specs/2026-08-29-superwagie-connector-sync-design.md`  
> 桌面壳与浏览器 Runtime：`docs/superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md`  
> Universal Viewer Platform：`docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`
> 领域语言：`CONTEXT.md`

## 1. 目的与分领域权威

本文把已确认的产品、界面和技术方向收口为可直接约束模块设计、PoC 和后续实施计划的契约。它不是实施排期，也不把尚未验证的技术路线升级为已完成能力。

不再用“后写的整篇文档覆盖上位产品定义”解决冲突。每类问题有自己的唯一权威来源：

| 问题类型 | 唯一权威来源 | 约束 |
|---|---|---|
| 产品目标、用户可见能力、V1 范围 | `最早期产品方案-V0.1.md` + `2026-08-29-superwagie-v1-release-scope.md` | 技术文档不得扩大或削减产品语义 |
| 领域词汇和对象边界 | `CONTEXT.md` | 其他文档不得为同一术语另立含义 |
| 界面、交互、交付阶段 | `2026-08-28-superwagie-workspace-delivery-design.md` 的 §15–§24 | §1–§14 是摘要，与后文不一致时必须就地修正，不形成第二套流程 |
| Task Item、Milestone 和任务管理行为 | `2026-08-29-superwagie-task-management-design.md` | 不得把 Task Item、Agent Task Thread 或 Workflow Stage 合并 |
| 账户、Wallet、Organization、Credits 与 Billing 行为 | `2026-08-29-superwagie-account-credits-organization-design.md` | 不得让客户端、扩展或支付渠道直接改写账本，不得把计费权解释为内容权 |
| Continuity、Agent Profile 与 Safe Memory 行为 | `2026-08-29-superwagie-continuity-profile-memory-design.md` | 记忆 scope、同意、保留与注入边界以该规格为准；记忆内容不得提升为系统指令 |
| Connector 授权、绑定、同步与记忆共享行为 | `2026-08-29-superwagie-connector-sync-design.md` | 不得成为记忆本体上传通道；不得绕过本地授权、Push 预览确认与服务端 ChangeSet 审核三边界 |
| 桌面壳、Chromium Surface、Electron/Rust/Worker 边界与安装完整性 | `2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md` | Electron 是唯一首选壳；Chromium 随基础安装包；Rust Product Core 是唯一业务、数据与策略权威；副作用进入隔离 Worker |
| Viewer、格式准入、打开/状态/ReviewBridge、Chunk、安全与 GVP | `2026-09-04-superwagie-universal-viewer-platform-design.md` + Viewer contracts + Format Admission Ledger | 内置 Viewer 是默认打开权威；每个格式独立准入，未经 GVP-0–5 不得进入生产 Registry |
| 模块、协议、状态机、持久化责任 | 本文与 `docs/contracts/v1/` | 只约束实现，不改写产品意图 |
| 可行性与准入状态 | `技术可行性/技术要求矩阵.md` | 状态只能由可重复证据升级 |
| 实现候选、开源参考和研究记录 | 单项技术调查 | 不得覆盖已确认的产品或交互定义 |
| 视觉布局与状态意图 | `界面原型确认索引.md` 指向的原型 | 不作为生产组件代码或技术可行性证据 |

跨领域冲突必须回到相应权威文档修正，不允许依靠默默的全局覆盖顺序解释。

任何 `RESEARCH_REQUIRED` 仍然不能进入发布实现；任何 `FEASIBLE_CONDITIONAL` 必须先满足本文对应 PoC 门。

## 2. 已消除的定义冲突

### 2.1 首页

首页唯一视觉基线为 `confirmed-i2-original-replay.html`：A2 平衡工作台，左上角是原始 I2 紧凑深色“开始工作”卡片。V3、V4、`workbench-restored-i2.html` 和拟物变体均不是最终稿。

### 2.2 用户扩展

生产用户只可安装 Skill 和 MCP。用户 Workflow 不是公开安装类型；Private Workflow 是官方内部能力，二者不得共用 UI、目录、权限或可见性定义。

用户扩展只在设置的“用户扩展”子页安装、查看、启停和移除。项目工作区、全局侧轨和首页不提供扩展入口；系统内置能力不出现在扩展列表。

### 2.3 极简设置

设置主页面固定为四项：

1. 外观；
2. 启动时恢复上次工作；
3. 关键任务通知；
4. Viewer 诊断与离线存储占用。

账户与 Credits 位于头像菜单并跳转官网；用户扩展是设置子页，不计入四项主设置。

### 2.4 Universal Viewer

SuperWagie 内置 Universal Viewer Platform 是文件默认打开、浏览与 Review 信息的权威。ViewerSurface/ViewerWorker/ViewerShell 以内部 Open/Query 契约工作，严格区分 `ready` 与带范围诊断的 `partial`；不得在打开路径调用 WPS、Office、LibreOffice、WpsComposer、系统命令或外部转换器。WpsComposer 的生成/格式化语义保持不变；目标 Office 应用仅能作为用户显式授权、与 Viewer 分离的最终交付 smoke。

### 2.5 Runtime 隔离与依赖共享

SuperWagie Agent 核心、状态、配置、会话、工具和模型出口完全独立，不发现或复用机器上的 Codex Server、CLI、Skills、MCP 和配置。依赖固定分为 OS Baseline、Signed Runtime Image、External Host 与 User Extension Environment 四层。可再分发的 Electron/Chromium、App Server、V1 内置能力实际需要的 Python/Node、FFmpeg/codec、字体与签名资源只在只读 Signed Runtime Image 中安装一份并共享；WPS/Office、Git 与不可再分发系统库按绝对路径和 feature probe 作为 External Host 使用；用户扩展依赖只进入独立扩展环境。任何共享都不继承用户全局语言包、Agent 参数、配置、状态、缓存或升级通道。

### 2.6 任务管理

Tasks 是一级工作模块。用户手动、Agent 对话和已确认 Project Milestone 创建统一 `Task Item`；项目自动创建只到 Milestone 粒度，内部 Workflow Stage 不生成任务。Task Item 的用户语义来自 Markdown，运行关联进入 Operational Store。Task Item 完成与 Agent Task Thread 停止是两个不同动作。

### 2.7 桌面壳与安装完备 Runtime

Electron + 随基础安装包分发的 Chromium 是唯一首选桌面壳；不再并行实现 Tauri、
WKWebView/WebView2 或 Tauri + CEF。CodeMirror Markdown 与产品 Shell 同处沙箱化 `app_ui`；
Excalidraw/draw.io、Artifact Preview 与后台 Render 分别使用隔离 Surface，其中视频与 headless
渲染进入独立 Electron Render Worker Host。Electron Main 属于客户端 TCB，但只是可信、非业务
权威的 Shell Controller；Rust Product Core 是 Workspace、Workflow、Agent、Artifact、权限、
凭证、网络路由、Credits 和恢复语义的唯一权威。WPS、FFmpeg、App Server、内置能力、用户扩展
与 Connector 分 Worker 执行。可合法再分发的 V1 内置依赖必须在安装事务结束前完备。

## 3. 模块边界

| 模块 | 唯一职责 | 拥有的数据 | 只能通过 |
|---|---|---|---|
| Shell Controller | Electron 窗口、导航、Deep Link、Chromium Surface 和应用生命周期；校验 sender 后转发 Intent | 窗口、布局、Surface Registry 与 renderer 生命周期状态 | 生成的窄 IPC → Trusted Gateway；不得直接执行能力 |
| Rust Product Core | 唯一业务、数据与策略权威；命令授权、查询投影、跨模块事务、恢复与 Worker 监管 | Operational Store、Project Binding、Policy、Journal、Registry 与请求追踪 | Product Core API / AuthorizedCommand / Worker Contract |
| UI Query Gateway | UI snapshot、增量订阅、cursor gap 检测与 resync | 可重建 UI projection 与订阅 cursor | Query/Subscription Contract；不进入 Public Capability Facade |
| Worker Supervisor | 由绝对身份与 Execution Manifest 启停 App Server、Capability、Extension、Installer、WPS、FFmpeg、Connector Worker | Worker identity、job lease、heartbeat、有限运行指标 | Worker Contract / Effect Journal |
| Workbench | 首页查询与进入工作 | 工作台 projection | Project / Task Query API |
| Project & Task | Project registry、Task Item 命令/查询、Milestone reconciliation、Markdown 任务投影、日历和执行关联 | Project registry、Task projection、Milestone mapping、tombstone、user override provenance | Project / Task API |
| Workspace Core | 授权目录、文件身份、事务、revision、watch 和索引 | Workspace registry、transaction、index | Workspace API |
| Markdown Engine | Markdown 原文、解析、Live Preview、链接与任务投影 | 解析缓存和 source map | Workspace API |
| Diagram Platform | Excalidraw/draw.io 原生格式编辑与渲染 | 原生图表文件和派生预览 | Diagram Capability |
| Agent Session | Agent Task Thread、流式事件、Composer 和任务状态 | 任务线程投影 | Agent Runtime API |
| Durable Workflow | 阶段、人工门、checkpoint、失效和恢复 | Workflow Run event log | Workflow API |
| Delivery Framework | Delivery Project、Content Baseline、来源绑定与目录 | 交付项目 projection | Workflow + Workspace API |
| Artifact Catalog | Artifact 所有权、修订、provenance、接受状态和查询 | Artifact metadata、revision graph | Artifact Contract |
| Preview & Review | Artifact/Preview Revision、批注和验收 | Review projection、预览缓存 | Preview Contract |
| Universal Viewer | Registry、格式探测、Viewer Session、严格状态、ReviewBridge 与缓存身份 | 签名 Format Admission Ledger、可丢弃索引/页面缓存；不拥有用户内容真相 | Viewer contracts；ViewerWorker 与隔离 ViewerSurface |
| Notification | 注意力事件去重、系统通知和已读状态 | Notification projection、dedupe key | Notification Contract |
| Continuity | 消费 SuperWagie 自身事件并生成项目回顾、历史和演化 | bounded evidence cursor、continuity projection | Continuity Contract |
| Profile & Safe Memory | 用户可见、可删除、可审计的 Profile 与长期记忆 | scoped profile/memory records | Memory Contract |
| Capability Router | 能力发现、版本、权限和执行模式路由 | Capability registry | Capability Contract |
| Host Worker Plane | WPS、系统自动化、宿主图片与受保护桌面宿主执行 | 只拥有当前 Host request 的临时状态与 receipt | Host Request Contract；权威策略仍在 Core |
| Extension Runtime | 用户 Skill/MCP 安装与沙箱执行 | Extension registry、manifest、独立扩展环境 | Public Capability Facade；不得加载进 Core 或 Electron Main |
| Dependency Resolver | 四层依赖的身份解析、完整性验证、健康检查和最小环境构造 | Runtime inventory、Runtime Manifest、environment signature | Dependency Contract；不得从随机 PATH 发现内置语言 Runtime |
| Platform Service Client | 账户、Managed AI、Credits 与 Official Host 的官方服务调用 | 短期会话与服务端投影 | 官方端点白名单、类型化协议、服务端鉴权 |
| Connector Service Client | AgentWiki 等用户授权业务服务的同步调用 | Connector binding、cursor、sync journal | Connector Contract；不得借用平台服务凭证 |
| Extension Network Broker | 用户扩展声明式出站访问 | egress grant、审计与有限连接状态 | Network Contract；默认断网 |
| Account & Credits | 登录上下文、钱包选择、预留和结算 | 服务端账本；客户端只存短期投影 | Billing Contract |
| Connector Plane | AgentWiki 等独立远程服务连接 | Connector binding、sync journal | Connector Contract |
| Official Publisher | 官方 HTML Host 的 preview、promote、同链接更新、rollback、revoke 和审计 | 服务端 deployment、share policy、publish receipt | Official Publisher API |

禁止跨模块直接读取对方数据库、隐藏目录、环境变量或实现对象。UI 不直接调用 WPS、产品 Runtime/外部宿主、扩展进程或模型网关。

## 4. 稳定身份与聚合边界

所有跨进程、持久化和可恢复操作必须使用稳定 ID，不使用文件行号、页面索引、UI 组件实例或进程 PID 作为业务身份。

| ID | 聚合 | 核心不变量 |
|---|---|---|
| `workspace_id` | Content Workspace | 绑定用户授权根和规范化 root identity |
| `project_id` | 内容项目 | 属于一个 Workspace，不随显示名称改变 |
| `task_id` | Task Item | 绑定一个 Markdown task block，不等于 Agent Task Thread |
| `milestone_id` | Project Milestone | 在 Project 内稳定，最多对应一个活跃自动 Task Item |
| `task_thread_id` | Agent Task Thread | 是 Session Credits 的唯一累计边界 |
| `workflow_run_id` | Workflow Run | 绑定一个业务目标和 Capability 版本 |
| `delivery_project_id` | Delivery Project | 拥有独立目录、来源绑定和输出树 |
| `content_baseline_id` | Content Baseline | 指向不可变来源 revision 集合 |
| `workspace_revision_id` | Workspace Revision | 不可变，绑定文件身份、因果和内容哈希 |
| `artifact_id` | Artifact | 所有权唯一，不能被其他交付目录静默接管 |
| `artifact_revision_id` | Artifact Revision | 不可变，绑定父修订、输入哈希和验收状态 |
| `preview_revision_id` | Preview Revision | 绑定 Artifact hash、渲染器、应用版本和字体环境 |
| `capability_id` | Capability | 与 `capability_version` 共同决定执行语义 |
| `request_id` | 有副作用请求 | 重试时保持不变，保证幂等 |
| `receipt_id` | 已完成副作用 | 能验证真实结果、计量和 Artifact 所有权 |
| `extension_id` | User Extension | 与来源、版本、权限和环境签名绑定 |
| `billing_reservation_id` | Billing Reservation | 绑定钱包、任务线程、估算和最终 settlement |
| `deployment_id` | Official Host Deployment | 绑定静态 Artifact Revision、稳定分享链接和发布 receipt |
| `annotation_id` | Review Annotation | 绑定 Preview/Artifact Revision 与可重定位锚点 |

V1 中 Project 与 Content Workspace 一一对应。一个 Project 可以聚合多个 Task Item、Agent Task Thread 和 Delivery Project；每个 Delivery Project 只属于一个 Project。一个 Task Item 可以关联多个历史 Thread/Run，但最多只有一个当前执行 Thread；一个 Agent Task Thread 可以观察或启动多个 Workflow Run；一个 Delivery Project 同时只能有一个活跃主 Workflow Run，但可以保留历史 Run。Task、Thread、Run 和 Delivery Project 不能共用 ID。

## 5. 跨边界统一信封

逻辑信封与具体序列化语言无关，首版使用版本化 JSON over private stdio / Electron IPC。调用方只能提交 `ClientIntent`；Trusted Gateway 从已认证通道、Surface/Extension Registry、Project Binding、授权投影与 Billing Reservation 注入可信上下文后，形成 `AuthorizedCommand`。调用方自报的 actor、caller、grant、wallet、billing、Gate Receipt 或 audit context 必须被 Schema 拒绝。可机读定义位于 `docs/contracts/v1/envelopes.schema.json`。

```text
ClientIntent
├── protocol_version
├── request_id
├── command_type
├── resource_refs
├── requested_permissions
├── expected_revision?
├── payload
├── issued_at
└── deadline_at?
```

```text
AuthorizedCommand
├── intent（原始 ClientIntent）
├── actor_context
├── caller_identity / surface_identity
├── project_context
├── permission_context（effective grants）
├── billing_context?
├── gate_context（Workflow / Risk / Install 分类回执）
├── audit_context（trace、policy revision、decision log）
└── authorized_at
```

```text
EventEnvelope
├── protocol_version
├── event_id
├── event_type
├── causation_id
├── correlation_id
├── aggregate_type
├── aggregate_id
├── aggregate_revision
├── payload
└── recorded_at
```

```text
ArtifactRef
├── artifact_id
├── artifact_revision_id
├── owner_type
├── owner_id
├── media_type
├── logical_path
├── content_hash
├── provenance
└── acceptance_state
```

```text
ResourceHandle
├── handle_id
├── resource identity / revision
├── audience
├── allowed_operations
├── project / owner scope
├── size / range policy
├── expiry / one-shot
└── auth_tag（Rust Core 签发的 MAC 或数字签名）
```

```text
ErrorEnvelope
├── error_code
├── category
├── retryability
├── safe_user_message
├── affected_scope
├── checkpoint_id?
├── technical_detail_ref?
└── next_actions
```

业务错误不能只依赖自由文本。底层堆栈、Provider、模型、API Key、Codex 内部协议和宿主凭证不得进入 `safe_user_message`。

传输约束：

- private stdio 使用 UTF-8 NDJSON，每行一个完整信封；Electron IPC 只通过生成的 preload bridge 提交 `ClientIntent` 或 UI Query，Main 不接受任意方法名；
- 默认单信封上限 1 MiB，超限数据必须转为 `ArtifactRef`；Renderer/Worker 的字节访问使用短期 `ResourceHandle` 与受控流，不暴露真实路径；
- 每个 Command 必须返回 `CommandResultEnvelope` 或 `ErrorEnvelope`；异步执行返回已接受状态和可追踪 aggregate ID；
- Event 只保证同一 aggregate 内按 `aggregate_revision` 有序；消费者发现缺口必须重读 projection，不能猜测中间状态；
- 取消使用 `system.request.cancel` 并引用原 `request_id`；Host、Network 和 Managed AI 命令必须带 deadline；
- `protocol_version` 使用整数主版本；不支持的主版本立即返回 `SW_PROTOCOL_VERSION_UNSUPPORTED`，不尝试降级执行。

产品 UI 查询不复用 Public Capability Facade：`query.execute` 返回 `snapshot_revision`，`subscription.open` 返回 Snapshot 与 Event Cursor；cursor gap、projection 版本变化或 Core 重连必须返回 `resync_required`，UI 只能重读 Snapshot。可机读定义见 `ui-query.schema.json`。

三类 Human Gate 的决定和回执由 `human-gates.schema.json` 分别定义；决定只允许经认证 `app_ui` 产品命令提交，不是 Agent/用户扩展可调用的公开方法。Public Capability Facade 的机器权威目录为 `public-capability-methods.json`，调用签名是 `call(ClientIntent)`，方法名只取 `ClientIntent.command_type`，不能再额外传入第二份 method 参数。

## 6. 状态机契约

### 6.1 Agent Task Thread

```text
ready
→ running
→ awaiting_user | user_stopped | credits_blocked | disconnected | recoverable_failed | completed
awaiting_user | user_stopped | credits_blocked | disconnected | recoverable_failed | completed
→ running
ready | completed | user_stopped → archived
```

- `user_stopped` 是安全暂停，不是撤销或永久取消；
- `awaiting_user`、`credits_blocked`、`disconnected` 和 `recoverable_failed` 进入前必须写入 Checkpoint；
- 恢复只能从 Checkpoint 继续，不能重放已有 receipt 的副作用；
- `completed` 后继续对话会创建新执行回合，但不创建新 task thread；只有用户新建任务才重置 Session Credits；
- `archived` 是 Thread 的终止导航状态，不删除历史、Artifact 和计量记录；恢复后回到 `completed` 或 `user_stopped`。

### 6.2 Workflow Run

```text
created
→ checking_readiness
→ awaiting_gate | running_stage
→ paused | credits_blocked | disconnected | recoverable_failed
→ awaiting_gate | running_stage
→ completed | cancelled | superseded | terminal_failed
created | paused | recoverable_failed → abandoned
```

- 阶段变化必须形成事件和 aggregate revision；
- Workflow Gate 绑定 Workflow revision 与候选输入哈希；Risk Gate 绑定 risk kind、动作和范围；Install Gate 绑定 extension、manifest 与 permissions；所有回执绑定决定审计、状态和有效期；
- 修改上游内容先计算影响范围，再使受影响节点失效；
- 不提供“重新从头运行”作为默认错误恢复；
- `paused` 是可恢复停止，`cancelled` 是用户明确取消且已完成补偿，`superseded` 是被新 Run 取代，`abandoned` 只能用于从未产生未补偿副作用的未完成 Run；
- `terminal_failed` 必须保留 failed-run evidence、已完成 Artifact 和结算结果，不可自动重试。

### 6.3 Host Request

```text
prepared → executing → effect_confirmed → committing → committed
    ↘ rejected        ↘ execution_unknown   ↘ recoverable_failed
execution_unknown → effect_confirmed | recoverable_failed | terminal_failed
effect_confirmed | committing → compensating → compensated | terminal_failed
```

- `prepared` 先持久化 `request_id`、输入哈希、权限、计费上下文和预期所有权；
- `committed` 必须有 receipt 和已验证 Artifact；
- 相同 `request_id` 重试只能返回已有结果或继续未完成提交，不能重复执行已确认副作用；
- 超时或连接中断时无法证明宿主是否已执行，必须进入 `execution_unknown`，通过宿主查询或 receipt reconciliation 确认，不得直接重放；
- Connector 远程成功、本地提交失败也使用 `effect_confirmed → committing → recoverable_failed`，不得误报完成。

### 6.4 User Extension 安装

```text
discovered → inspected → awaiting_permission → installing → enabled
                                      ↘ rejected
                         installing → quarantined | disabled
enabled ⇄ disabled
enabled | disabled → updating → enabled | rollback_pending | quarantined
rollback_pending → enabled | disabled | quarantined
enabled | disabled | quarantined → removing → removed
```

- 类型只能是 Skill 或 MCP；
- 来源、版本、文件范围、网络目标、脚本/构建动作或权限变化必须重新检查；
- 安装失败只影响该扩展，不影响 Agent Runtime 和其他系统能力；
- 更新发生权限、构建脚本、网络目标或原生依赖变化时必须返回 `awaiting_permission`；
- `removed` 删除执行包和凭证绑定，保留最小审计回执，不删除已有 Artifact。

### 6.5 Workspace Transaction

```text
prepared → committing → committed
prepared | committing → recovering → committing | committed | conflicted
prepared → conflicted
```

- `prepared` 前不能修改 canonical 文件；每个已提交文件都必须有独立 receipt；
- 外部修改或 hash 不一致进入 `conflicted`，保留 Base、Current 和 Proposed；
- `recovering` 只根据 journal、receipt 和实际 hash 继续，不用旧快照覆盖用户新修改。

### 6.6 Billing Reservation

```text
reserve_requested → reserved → executing → settlement_pending → settled
reserve_requested → rejected
reserved → expired | refund_pending → refunded
executing | settlement_pending → settlement_unknown → settled | refund_pending | recoverable_failed
```

- reservation 必须绑定 wallet、task thread、workflow run、估算和 idempotency key；
- 实际使用量由受信 usage receipt 累计，客户端不能自报结算金额；
- 取消、失败和超时都必须进入 settlement/refund 流程，不能直接删除 reservation。

### 6.7 Official Host Deployment

```text
prepared → uploading → preview_ready → awaiting_publish_confirmation
→ promoting → published
published → updating → preview_ready
published → rolling_back → published
published → revoking → revoked
uploading | promoting | updating | rolling_back | revoking
→ execution_unknown | recoverable_failed
```

- 只允许 Official Publisher API，用户不选择第三方 Publisher；
- `preview_ready` 不对外发布，`promoting` 前必须有用户确认回执；
- 同链接更新产生新 deployment revision；rollback/revoke 必须有 receipt 和审计记录。

### 6.8 Review Annotation

```text
active → stale → relocated | unresolved
relocated → active
active | unresolved → resolved | dismissed
```

- Artifact Revision 或渲染环境变化后先进入 `stale`，不按旧坐标静默附着；
- 组合锚点只有达到置信阈值才能 `relocated`，否则进入 `unresolved` 等待人工确认。

### 6.9 Task Item

```text
inbox → planned → in_progress → completed
             ↘ waiting_user | blocked ↗
inbox | planned | in_progress | waiting_user | blocked
→ cancelled | superseded
completed | cancelled | superseded → planned | in_progress
```

- `origin = manual | agent | project_milestone` 只表示创建来源，`responsibility = user | agent | shared` 表示完成责任；
- Project Milestone 通过稳定 origin key 幂等创建或更新一个活跃任务；重复事件和重启不得创建副本；
- 重规划用 `superseded` 保留历史，不能静默删除；用户 override 和删除 tombstone 优先于自动 reconcile；
- Agent Thread 的 Credits、断网、失败和停止状态独立保存，只有确实阻止用户目标时才投影 Task Item 为 `blocked/waiting_user`；
- 完成 Task Item 不隐式停止仍在运行的 Agent Thread。

所有状态枚举的可机读定义见 `docs/contracts/v1/states.schema.json`。

## 7. Workspace 写入与外部编辑契约

所有系统和 Agent 写入遵循：

```text
read base revision
→ acquire Working Set lease
→ prepare semantic patch / staged files
→ compare current revision and hashes
→ apply or rebase
→ journal
→ atomic promote
→ emit Workspace Revision
→ release lease
```

- 单文件使用同目录临时文件、flush 和原子 rename；
- 多文件使用 transaction journal、staging、逐项 receipt 和崩溃恢复；
- watcher 只触发 reconciliation，不作为无遗漏事实日志；
- 外部 Obsidian/WPS 不参与 Lease，提交时必须重新做 CAS；
- 冲突保留 Base、Current、Proposed，禁止旧 revision 整文件覆盖；
- Markdown 局部修改优先使用 source range/AST patch，未知语法原样保留；
- 删除默认进入可恢复区域，永久删除另走行内授权。

### 7.1 数据真相与持久化责任

| 数据类型 | 权威存储 | 可否重建 | 删除/迁移规则 |
|---|---|---:|---|
| Markdown、Excalidraw、draw.io、Office、HTML bundle、媒体 Artifact | 用户 Workspace 中的规范文件 | 否 | 由用户文件操作决定；应用卸载不得删除 |
| Task Item 的标题、状态、日期、优先级、标签、循环和 dependency | 项目 Markdown task block | 否 | 通过 Task semantic patch 修改；外部 Obsidian 修改必须增量同步 |
| 文档/链接/任务/全文检索 projection | 本机 SQLite Derived Index | 是 | 可清空并从 Workspace 重建 |
| Milestone origin mapping、Thread/Run link、user override provenance 和删除 tombstone | 本机 App Data Operational Store + 可迁移 checkpoint manifest | 条件可恢复 | 不得与 Derived Index 一起清除；没有可信 mapping 时不按标题猜测或自动重建 |
| Workflow event、Checkpoint、Workspace transaction journal、Host receipt、failed-run evidence | 本机 App Data Operational Store，可携带经裁剪的 `.superwagie` checkpoint manifest | 否 | 必须 Schema 迁移、备份和显式清理；不随索引重建删除 |
| Review cache、缩略图、临时渲染 | 本机 Cache | 是 | 可按空间策略清理，清理后不改变验收事实 |
| Profile、Safe Memory、设备偏好和本地同意记录 | 本机加密 Personal Data Store；可同步部分遵循记忆/Connector 规格 | 条件可恢复 | 与 Project Operational Store 分 namespace；退出登录、撤回同意和删除按 scope 执行 |
| Provider、Connector、WPS 与扩展 Secret | OS Keychain/Credential Manager，Core 仅保存 opaque secret handle | 否 | Renderer、Electron Main、Workspace 和日志不得出现明文；撤销即使 handle 失效 |
| Electron、App Server、内置 Runtime、FFmpeg、字体与签名 Web 资源 | 只读 Signed Runtime Image + Runtime Manifest | 可重新安装 | 不被任务或扩展修改；完整性失败进入修复/回滚 |
| 用户 Skill/MCP 执行包与依赖 | Extension Store + 独立 Extension Environment | 可按来源重建 | 只由显式安装/更新/移除事务修改；不得污染 Signed Runtime Image |
| Credits ledger、wallet、reserve/settle/refund | 官方服务端财务账本 | 否 | 客户端只持有可刷新投影，不能改写账本 |
| Official Host deployment、share policy、publish receipt | 官方 Host 服务端 | 否 | 通过版本化 API 更新、rollback 或 revoke，不从客户端缓存推断 |

“恢复布局”、“恢复任务”和“跨机器携带项目”是三个不同能力：布局可丢失，本机未完成副作用不能丢失，跨机器只携带已安全封存且不包含凭证的 checkpoint manifest。

## 8. UI 与业务状态契约

### 8.1 四个核心视图

| 视图 | 固定职责 | 不允许承担 |
|---|---|---|
| 主工作台 | 时间、日历、待办、项目、统计、成果、开始工作 | 模型配置、扩展管理、交付物类型主导航 |
| 智能工作区 | 文件/知识导航、Markdown/图表编辑、Agent 内容加工 | 独立 PPT/Word 应用壳 |
| 交付引导 | 在同一工作区展示阶段、缺口、预览和 Human Gate | 用传统表单替代 Agent Composer |
| Review | 展示真实 Artifact 预览、批注、差异和返工 | 自行重绘 Office 格式事实 |

### 8.2 Tasks 一级视图

Tasks 采用统一列表 + 详情：今天、即将到期、全部、已完成以及 project/origin/responsibility/state/priority/tag 筛选。工作台只提供摘要和快速创建，项目详情显示本项目任务与 Milestone，Agent 面板只显示当前关联任务。三者必须订阅同一 Task projection。

### 8.3 所有异步界面的必备状态

每个查询、命令、Workflow Stage 和预览组件必须明确实现：

- 初始空状态；
- 加载/流式状态；
- 等待用户；
- 权限不足；
- Credits 不足；
- 连接中断；
- 可恢复失败；
- 已完成；
- 内容或 revision 已过期。

任何状态都必须提供下一步动作，不能只显示 spinner、错误码或不可关闭弹窗。

### 8.4 Agent Composer

- 空闲显示播放图标，运行显示停止方块；
- 附件、Working Set 和当前任务范围位于 Composer 内或紧邻位置；
- Composer 在普通工作区、交付引导和 Review 中保持同一行为；
- 固定状态行显示 `task_thread_id` 对应的 Session Credits 累计，默认弱化；
- 余额正常不展示账户余额，低余额才增强并提供充值入口。

## 9. Capability Contract 最小必填项

每个 Capability 在进入 Reference 实现前必须拥有机器可校验 Manifest；规范位于 `docs/contracts/v1/capability-manifest.schema.json`：

```text
identity: id, version, source, visibility, trust_level
schemas: input, output, event, checkpoint, human_gate
execution: modes, executor, timeout, retry, cancellation
security: permissions, workspace_mounts, egress, secret_refs
dependencies: runtimes, host_capabilities, feature_probes
artifacts: accepted_types, ownership, staging, validation
durability: idempotency, resume, compensation, receipts
billing: reserve_policy, usage_receipt, settlement_policy
acceptance: fixtures, target_clients, visual/semantic thresholds
compatibility: protocol_range, migration, fallback
```

上层只能按 `capability_id + version + schema` 调用。不得把 Skill 文件路径、MCP 配置、Python 模块名、Rust crate、COM 对象或 macOS 代理细节作为业务 API。

Public Capability Facade 可以暴露文件、产品 Runtime/外部宿主、WPS、浏览器/网络、绘图、Artifact、Workflow Run 管理和 Managed AI 等高层接口，但必须经过同一权限和审计层。方法级公开面见 `docs/contracts/v1/public-capability-facade.md`。这里的 Workflow 接口只管理调用者已创建或获授权的运行实例，不允许用户扩展枚举、读取或执行 Private Workflow 定义。

## 10. Runtime 与进程契约

```text
OS → Electron Main / Shell Controller
       ├── App UI Renderer（Workbench / Tasks / Agent / CodeMirror）
       ├── Diagram Editor Surface
       └── Artifact Preview / Viewer Surface
     → authenticated private channel
     → Rust Product Core（唯一业务、数据与策略权威）
       ├── UI Query Gateway
       ├── Product Domain + Durable Workflow + Effect Journal
       ├── Public/Private Capability + Policy/Billing
       └── Worker Supervisor
           ├── pinned Codex App Server Worker
           ├── Built-in Capability Worker
           ├── Viewer Worker（按格式/会话隔离）
           ├── User Extension / MCP Worker
           ├── Installer Worker
           ├── WPS / Office Host Worker
           ├── FFmpeg / Media Worker
           ├── AgentWiki Connector Worker
           └── Electron Render Worker Host
```

- Electron Main 属于客户端 TCB，但只是非业务权威 Shell Controller；不直接读写 Workspace、凭证、WPS、FFmpeg、Agent、Workflow 或 Credits；
- 所有 renderer 强制 sandbox、context isolation、关闭 Node integration；CodeMirror 留在 `app_ui`，图表/Preview 使用隔离 WebContentsView，后台渲染使用独立 Electron Render Worker Host；
- Renderer/Agent/Extension 只能提交 ClientIntent；actor、caller、project、effective grants、billing、Gate Receipt 与 audit context 由 Trusted Gateway 注入，伪造字段在 Schema 层拒绝；
- Renderer 与 Worker 只通过 audience-bound Resource Handle 访问字节，不取得 Workspace 真实路径；
- Agent Runtime 使用应用内绝对路径和独立数据根，不读取系统 Agent 环境；
- 主通信使用私有 stdio，不开放公共服务端口；
- Signed Runtime Image 中的 Electron/Chromium、App Server、内置能力必要 Runtime、FFmpeg/codec、字体和签名 Web 资源由 Runtime Manifest 固定；外部 WPS/Office 等集成通过 Resolver 返回绝对 executable/library path 与 environment signature；
- 子进程只继承最小白名单环境，不继承 `CODEX_HOME`、Provider Key 和全局 Agent 配置；
- App Server、内置能力、Extension、Installer、WPS、FFmpeg、Connector 与 Render Host 使用不同 Worker 身份、权限和 Execution Manifest，不得在 Core 或 Electron Main 中动态加载；
- 安装结束后可合法再分发的 V1 内置依赖必须完备；缺少不可随包分发的外部宿主只把关联 Capability 标为 unavailable，不阻断工作台和其他能力。

## 11. Preview、Review 与真实验收契约

| Artifact | 预览事实源 | 深度编辑 | 发布前真实验收 |
|---|---|---|---|
| Markdown | Markdown 原文 + SuperWagie renderer | SuperWagie / Obsidian | 双向 reopen corpus |
| Excalidraw | 原生 `.excalidraw(.md)` | 内嵌 Excalidraw | 原格式 reopen + render |
| draw.io | 原生 mxGraph XML | 内嵌 diagrams.net | 原格式 reopen + export |
| PPTX | 内置 Universal Viewer 的准入渲染 | WPS/PowerPoint（显式外部编辑） | Viewer Corpus；可选目标应用编辑、撤销、保存/放弃、重开 smoke |
| DOCX | 内置 Universal Viewer 的准入渲染 | WPS/Office（显式外部编辑） | Viewer Corpus；可选目标应用分页、编号、表格、字体和重开 smoke |
| HTML | 本地真实浏览器 | SuperWagie Workflow | 桌面/平板/移动浏览器 |
| 视频 | 目标播放器解码结果 | Agent 场景级返工 | 双平台播放和媒体 QA |

Preview Revision 缓存键必须包含 Artifact hash、渲染器/应用版本、字体环境和参数。缓存命中不能绕过 revision 一致性检查。

## 12. 技术 PoC 准入门

计划分为三类：

1. **Technical Validation Plan**：为 Gate 0–6 编写可丢弃 PoC、fixture、技术探针和证据收集，现在允许启动；
2. **Production Implementation Plan**：将已通过准入的能力按纵向切片落成产品代码，只能在相关 Gate 通过后启动。
3. **Local Development Plan**：按 V1RS §5.1 在当前 MacBook 上逐切片开发、集成并验证可维护的本机版本，遵守本文 §14.1；不等待跨平台与发布工程门全部完成。

三类计划不得共用“完成”状态或把 PoC 代码直接当成已验收产品。当前 Technical Validation Plan 见 `docs/技术可行性/技术验证执行计划.md`。以下门保留为正式准入证据要求，不代表完整实施排期，也不阻止 §14.1 的本机开发。

### Gate 0：桌面壳与封闭 Runtime

- Electron + bundled Chromium 在目标 macOS/Windows 上完成签名开发构建；
- Chromium renderer 的中文 IME、剪贴板、拖放、缩放、多标签、无障碍和崩溃恢复通过；
- app_ui、diagram_editor、artifact_preview 与 render_worker 的 origin、session、cache、network、Resource Handle 与 IPC 权限隔离通过；
- sandbox、context isolation、Node integration 禁止、CSP、navigation/permission deny、sender 校验、ASAR integrity 与 Electron fuses 通过攻击测试；
- Electron Main、Rust Core 和各 Worker 的启动、握手、parent-death、单次 Core 重启、checkpoint 停机与故障域验证通过；
- UI Query Snapshot/Event Cursor/resync 与 Renderer 崩溃后恢复通过；ClientIntent 伪造 actor/caller/grant/wallet/Gate Receipt/audit context 的攻击样例必须被拒绝；
- SuperWagie 与机器已有 Codex 并行运行，端口、配置、缓存和环境互不影响；
- Signed Runtime Image/Runtime Manifest 完整且只读；External Host 发现只返回显式绝对路径、身份和 feature probe 结果。

旧 `G0-SHELL-001` 的 Tauri 结果为历史证据；新架构由 `G0-SHELL-002` 验收。失败时阻止发布并重新裁决桌面架构，不并行维护第二套壳。

### Gate 1：Workspace、Markdown 与图表

- 原子单/多文件事务、CAS、外部编辑冲突和断电恢复通过；
- Obsidian 兼容语料完成编辑、保存、关闭和重开；
- 大型 Vault 冷启动、增量索引和 watcher overflow reconciliation 达标；
- Excalidraw/draw.io 原格式往返和恶意内容隔离通过。
- 手动、Agent 对话和三个已确认 Milestone 进入同一 Task projection；重复 reconcile 不增生任务，用户 override/tombstone 不被覆盖。

### Gate 2：Agent、Workflow 与 Guided UI

- Agent Task Thread 完整生命周期、六类注意/结果投影和 Checkpoint 恢复通过；
- Workflow Gate、Risk Gate、Install Gate、局部失效和 Host Request 幂等通过；
- Guided UI Schema 能安全呈现问题、选择、Diff、预览和影响范围；
- Credits 不足、断网、停止和失败恢复不重复副作用与计费。

### Gate 3：PPT、Word 与 HTML 交付

- SuperPPT/SuperWriter 最小垂直流程及三个关键人工门通过；
- WPSComposer 在 macOS/Windows 的真实生成与回改闭环通过；
- 30 页 DOCX、20 页 PPTX 的渲染、缓存、批注重定位和 fallback 通过；
- HTML 静态包、官方 Host、同链接更新、停止分享和回滚契约通过。
- HTML Taste 冻结版本、MIT 归属、无运行时网络安装、设计预检、无障碍与三断点真实浏览器回归通过；上游更新不得自动改变已发布客户端行为。

### GVP-0–5：Universal Viewer 阻塞拓扑

| Gate | Meaning |
|---|---|
| GVP-0 | Contract + Provenance |
| GVP-1 | Office Fidelity |
| GVP-2 | Per-format Corpus |
| GVP-3 | Isolation + Malicious Files |
| GVP-4 | Package + Performance |
| GVP-5 | Product Integration + Recovery |
- 每一格式变体必须持有绑定候选、版本、平台、Corpus 与证据 SHA-256 的全部 Gate 回执，方可离开 `RESEARCH_REQUIRED`；
- 旧 G3-REVIEW 运行仅作历史，不能满足任何 GVP 门，也不能授权生产 Viewer 代码。

### Gate 4：视频

- 五个 Profile 各有代表样片；
- Scene IR、帧求值、字幕、音频、局部重渲染和时间点 Review 通过；
- 独立 Electron Render Worker Host 的逐帧确定性、Job 级 session/cache、资源上限、崩溃恢复和双平台 golden render 通过；
- Electron/Chromium、FFmpeg/codec、字体和媒体素材完成 SBOM 与许可证准入；
- 黑帧、静音、缺帧、音量、字幕安全区和双平台播放通过。

### Gate 5：用户扩展与安全

- Skill/MCP 类型识别、权限变化、安装、更新、回滚和 quarantine 通过；
- 文件、网络、进程、Prompt injection 和凭证隔离攻击样例通过；
- 用户 Skill 对 Public Capability Facade 的等价调用通过，但无法发现 Private Workflow；
- 机器目录中的每个公开方法都能解析到版本化 payload/result JSON Schema，并由真实领域处理器执行；只有预留 Schema ID 或模拟 parity 时最多为 `CONDITIONAL_GO`；
- 扩展伪造 actor、project、grant、wallet、billing reservation、Gate Receipt、audit context 或其他 caller identity 均被 Trusted Gateway 拒绝；ResourceHandle 跨 audience 转用与直连 Main/Core/Worker 均被拒绝。

### Gate 6：账户、Credits 与发布工程

- Personal/Organization Wallet、reserve/settle、退款和幂等并发通过；
- 官网登录、充值回调和客户端自动刷新通过；
- 离线安装结束即具备 Chromium、`app_ui`、`diagram_editor`、`artifact_preview` 和 `render_worker` 所需依赖，不发生首次使用动态下载；
- OS Baseline、Signed Runtime Image、External Host、User Extension Environment 四层归属与故障语义通过；内置语言 Runtime 不从系统 PATH 回退；
- Electron/Rust/App Server/FFmpeg 的安装、签名、公证、ASAR/fuses、升级、回滚、SBOM 和故障注入通过；
- Reference/Private 差分和包体积、启动、内存、子进程、任务耗时基线完成。

## 13. 界面—功能—技术追踪

| 用户界面 | 功能规范 | 技术要求组 | 进入实现前的主门 |
|---|---|---|---|
| 原始 I2 主工作台 | §3、§16 | UI-02、UI-08、WS-10 | Gate 0、1 |
| Tasks 一级模块 | 任务管理设计全文 | UI-08/10、MD-08、TASK-01–06 | Gate 1、2 |
| 三栏智能工作区 | §4、§17、§18 | UI-03/06/07/09/10、WS、MD | Gate 0、1 |
| Agent Composer 与状态 | §19、§22 | AR、SEC、AI、WF-01/02/10、BILL | Gate 0、2、6 |
| 交付引导 | §7、§8、§20.1 | UI-04、WF-06/07/08/09 | Gate 2 |
| SuperPPT/SuperWriter/HTML | §20.2–20.4 | PPT、DOC、HTML、SK | Gate 2、3 |
| Universal Viewer | §13.5、§21.1 + Viewer design | VIEW-01–15 | GVP-0–5 |
| 视频制作与 Review | §20.5 | VID-01–11 | Gate 2、4、6 |
| 绘图文档标签 | §9、§21.2 | DG-01–07 | Gate 1 |
| 极简设置与用户扩展 | §23 | UI-11、SEC-08/09/10、DEP | Gate 0、5 |

这里的章节号均指 `2026-08-28-superwagie-workspace-delivery-design.md`。

生产组件结构、布局断点、焦点/快捷键、拖放、tab 恢复、异步状态和稳定 stage ID 见 `2026-08-29-superwagie-ui-implementation-contract.md`。

## 14. 实施计划准入判定

技术矩阵使用 `PROVEN_EXISTING`、`PROVEN_POC`、`FEASIBLE_CONDITIONAL`、`RESEARCH_REQUIRED`、`DEFERRED` 和 `NO_GO` 表示单项证据状态；垂直切片使用 `GO`、`CONDITIONAL_GO`、`NO_GO` 和 `DEFERRED` 表示准入决定。两套状态不能混用。

本节的“实施计划”专指 Production Implementation Plan。只有同时满足以下条件，才能把某个垂直切片写入该计划并启动生产实现：

1. 涉及的 `RESEARCH_REQUIRED` 已转为 `PROVEN_POC`、`PROVEN_EXISTING` 或明确 `DEFERRED`；
2. 每个 `FEASIBLE_CONDITIONAL` 已记录负责人、fixture、命令、目标平台、通过指标和 fallback；
3. 本文涉及的 Schema 和状态迁移已经版本化，并有契约测试；
4. 安全、许可证、供应链和真实客户端验收没有未接受的 No-Go；
5. UI 原型中的空、加载、等待、权限、失败、恢复、完成和过期状态均有组件验收；
6. 垂直切片能从真实用户入口走到真实 Artifact 和真实目标客户端验收；
7. 后续 Rust/Private 迁移使用同一契约和差分 fixture，不重新定义产品语义。

在这些条件满足前，允许实现可丢弃 PoC、契约测试夹具和技术探针；也允许按 §14.1 实施本机开发切片，但不得把两者包装成已完成发布准入的产品能力。

### 14.1 当前 MacBook 本机开发准入

依据 2026-09-05 用户明确调整和 V1RS §5.1，允许启动可持续维护的本机功能实现与集成。这里的“允许开发”不是测试 GO，也不改变机器审计器的 Production Implementation Admission。

1. 每片沿用现有产品/界面/契约与 Electron + bundled Chromium + Rust Core 架构，从真实 UI 到持久化文件、Artifact 或服务结果验收；不得直接复制旧 PoC/旧 Reviewer 取代当前产品设计。
2. Windows、macOS 15/其他系统版本、双平台签署、发布签名/公证和干净机矩阵单列后续任务，不阻止当前机器编码；本机报告记录实际 OS/build/arch、候选与依赖哈希，不冒用旧平台 ID 或生成虚假 receipt。
3. 核心权限、沙箱、依赖完整性、凭证隔离、Human Gate、文件 CAS/恢复、取消/重试与副作用幂等仍须随切片实现和验证。尚未验证的高风险路径保持不可用，不允许用“开发模式”放开任意权限。
4. Viewer 可进行本机研发集成与 Corpus 验证，但必须明确为开发候选，不修改生产 Registry/Format Ledger 的准入；未验证模式不能声称 `ready`，不得以 WPS、LibreOffice 或其他外部转换器替代 Viewer。
5. 真实外部服务按所属切片准备。缺少 Managed AI、Official Host、AgentWiki 或 Billing 时记录该切片未完成；模拟结果仅证明契约，不证明真实 Agent、发布、同步或计费闭环。
6. 本机完成记录与发布 Gate 分开。只有相关真实 UI/后端/恢复链通过才能记本机切片完成；整个本机产品完成需覆盖全部既定功能闭环，不能只凭壳启动、PoC 或测试总数签收。

任务分类与验收清单见 `docs/技术可行性/当前MacBook优先-验证任务分流.md`。当前只确认开发顺序和准入边界，未宣称本机产品已经实现或验收。

## 15. 当前判定

- 产品与界面结构：`GO`，可作为 PoC 输入；
- V1 范围：`GO`；桌面壳已变更为 Electron + bundled Chromium，旧 Tauri fallback 已废止；
- 机器契约基线：`docs/contracts/v1/` 已定义首版 Schema、Viewer contracts、三类 Human Gate 与公开方法面；当前 Contract Foundation 为 355/355。34 个 active 公开方法的 68 个 payload/result Schema 已全部确定性解析，退役预览方法只有不可发现、不可调用的 dated deprecated record；Frozen Core base + Office 只读窄切片候选闭包为 `GO`，但 GVP-0 仍为无 receipt 的 `BLOCKED_ENVIRONMENT`，GVP-1–5 与全部格式记录仍为 `RESEARCH_REQUIRED`，不得因 Schema 或候选闭包通过、旧证据通过而升级；
- Technical Validation Plan：`GO`，但方案 B 要求 G0-SHELL-002、Gate 0 隔离/依赖、Gate 2、Gate 3 Review、Gate 4/5/6 的受影响 fixture 使用 `solution-b-v1` 重跑；旧修订不得准入；
- 单项技术路线：`CONDITIONAL_GO` 或 `RESEARCH_REQUIRED`，以技术矩阵为准；
- Local Development Plan：允许按 §14.1 逐切片实施，优先当前 MacBook；本机产品完成状态仍待真实端到端验收；
- Production Implementation Plan：`NO_GO`，每个纵向切片等待自己依赖的 Gate 证据，不必等待无关 Gate；
- 全量发布准入：`NO_GO`；本机开发适用 §14.1，不受无关跨平台与发布门前置阻塞。

下一份实施计划必须按可独立验收的垂直切片编写，不能按“先做全部 UI、再做全部后端”拆分，也不能绕过真实 Markdown、WPS、浏览器或播放器验收。
