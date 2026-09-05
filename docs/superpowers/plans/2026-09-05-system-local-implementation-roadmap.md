# SuperWagie 系统功能分阶段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前 MacBook 上逐个完成真实、可恢复、可回归的产品闭环，再完成双平台适配与发布工程。

**Architecture:** 沿用 Electron 单壳、Rust Product Core 唯一业务权威、独立 App Server 与隔离 Worker。按用户闭环纵向实现 UI、领域逻辑、持久化与验收；历史 PoC 只提供可复用证据和算法，不等于产品集成完成。

**Tech Stack:** 当前仓库 Electron 44.1.0、CodeMirror 6、Rust 2024、SQLite、Node 测试与真实 Electron UI runner；版本以执行时锁文件为准，本计划不批准升级或引入第二套架构。

**Spec:** `docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md`（V1RS）§2–6；`docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md`（CAC）§1、5–10、14.1；`docs/superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md`（BCRA）；`docs/superpowers/specs/2026-08-29-superwagie-ui-implementation-contract.md`（UIC）；分领域权威入口 `rules/README.md`；`docs/技术可行性/当前MacBook优先-验证任务分流.md`。

## Global Constraints

- 本文是 **Local Development Plan** 的总调度，不是 Production Implementation Admission 或发布许可；`admission_effect: none`。
- 当前开发平台实测为 macOS 26.6.2 / 25G83 / arm64；不得填成 macOS 15。Windows 11 和 macOS 承诺版本仍是发布验收义务。
- V1_REQUIRED 不因实施分期而变成 DEFERRED；V1RS §4 的九项暂缓功能不搭车进入。
- Renderer、Agent、Skill/MCP、Connector 只提交 ClientIntent；可信身份、Project、权限、计费与 Gate 由 Core 注入。
- Working Set Lease + revision/hash CAS + journal + 原子提交是写入底线。未知副作用先 reconcile，不盲目重放；停止不等于撤销。
- 不发现或复用宿主 Codex/Agent 的模型、账户、配置、Skills、MCP、状态及升级通道；不得用系统 PATH 补位产品 Runtime。
- Provider Key 只在服务端；客户端与用户界面不暴露模型、Provider、Token、Key 或内部成本。
- Workflow Gate、Risk Gate、Install Gate 分离；Risk Gate 只处理 scope_expansion、external_effect、destructive、high_cost_billing。可逆低风险本地编辑不新增普遍的逐次强制审批。
- Viewer 默认内部打开；不得用 WPS/LibreOffice 供页。逐格式 GVP-0–5 不达标不能登记为生产支持。
- 本计划不授权实际付费、充值、外部发布、远端设置变更、下载/安装新 Runtime 或连接客户数据。执行到相应动作前核实范围和授权。
- 所有界面遵守 UIC；每次实施先完整阅读 AGENTS.md 命中的规则包及规格。

## 1. 当前基线：继承什么，不夸大什么

规划基点为本工作树 `37f2251`，不是未来验收候选的固定 SHA。

| 状态 | 已核对的范围 | 不能据此宣称 |
|---|---|---|
| 已实现、已有本机测试 | Project 授权；Markdown 真实文件、草稿/保存/冲突/重开；光标驱动 Live Preview；格式工具栏 | 整个 Workspace、完整 Obsidian 兼容、完整多标签、搜索/反链/属性等均完成 |
| 已有保护机制 | 本地统一回归、提交钩子、来源绑定与新 run receipt | 远端必需检查和受保护分支已经强制生效 |
| 历史技术证据 | 原 checkout 审计 37 项：11 GO、12 CONDITIONAL_GO、9 BLOCKED_ENVIRONMENT、5 RESEARCH_REQUIRED，0 missing/invalid、0 signed GO | 全部 PoC 在当前代码重新执行，或全部接入产品 |
| 尚未闭合 | 封闭 Agent + 真实 AI 30 题；真实账本/Host/Connector；Viewer 89 条格式仍 research | mock、候选闭包或可点击入口代表可用功能 |

Live Preview 已获得用户对交互方向的认可。格式工具栏已有自动验证，但不得替用户填写实施后的独立体验签收。LOCAL-01-MD 是已完成子切片，LOCAL-01 仍未完成。

证据位置必须分清：历史 `evidence/` 被忽略，位于 `/Users/neomei/项目/codexprojects/SuperWagie`；当前工作树缺少该目录不代表证据销毁。历史证据只能按原候选、平台与哈希引用；新集成必须产生当前候选的新结果。

## 2. 执行节奏与每阶段完成门

只推进一个主实现切片；下面的“可独立推进”表示依赖允许，不代表自动创建任务或启动多代理。先完成最小可演示路径，再扩展场景；不先铺满全部 UI。

每个切片按以下顺序执行：

1. 冻结本次用户场景、非目标、接口与失败状态，列出命中的规则编号。
2. 先写失败测试，再实现最小行为；复用已验证领域逻辑，不整段搬入 PoC 的模拟账本或测试豁免。
3. 接入真实应用入口，检查实际文件/服务回执，而非只看屏幕文字。
4. 注入外部修改、撤权、取消、断网和进程故障中与该切片相关的场景。
5. 扩充回归保护并运行全量已有回归；不删旧断言、不降阈值、不接受 skip-GREEN。
6. 提交一个可独立审查的变更；有数据迁移时包含备份、兼容与恢复策略，不能只靠回退代码。
7. 交付演示入口、当前候选、证据、限制和下一步；需要用户体验判断的场景单列签收，不能由测试自动勾选。

实现任务与文档核对任务不共用“产品完成”含义。阶段内小批次测试通过只勾选该批次；父阶段的闭环全部通过才勾选父阶段。

## 3. 主路线与退出条件

以下是调度里程碑。除已链接的首批执行计划外，不将路线图冒充可直接逐行编码的详细计划：进入下一批前，根据上一批实测接口生成该子系统执行计划，完成自审后实施。

| 顺序 | 用户可见结果 / 交付物 | 硬依赖 | 退出条件与证据 | 任务归属 |
|---|---|---|---|---|
| P0 风险入口收口 | 现有编辑器保持稳定；明确独立 Runtime、AI 测试服务、Viewer Office 候选各自真实缺口 | 当前锁文件、历史证据原根、已有回归 | 回归新 receipt；候选/服务/费用权限清单；每个阻塞有明确解除条件。不要求所有平台 GO | LOCAL-07；LOCAL-02/03/06 前置 |
| P1 Agent 最小读写闭环 | 用户让 Agent 整理当前文档，看到 Working Set 和修改建议，应用后能停止、重开、恢复 | Core 状态/持久化、隔离 App Server、真实 Managed AI 与最小可信账本通道 | 真入口→授权文件读取→建议/Diff→适用确认→CAS 写入→记录/Artifact→stop/restart；越权、重复写/扣费、覆盖外部编辑均为 0 | LOCAL-02；LOCAL-06 薄切片 |
| P2 本地知识工作空间 | 完整项目导航、多文档、任务、工作台与离线绘图连成日常可用工具 | 已有 MD 事务；任务稳定身份；Agent 创建任务部分依赖 P1 | 下述 P2 子批次全部通过真实保存/外部修改/重开；不损坏未知 Markdown | LOCAL-01 |
| P3 持久交付框架 + 内部 Viewer 主链 | 从文档进入同一工作区的交付引导、成果中心、预览、批注、返工与恢复 | P1；Viewer 早期 Office 风险验证；Artifact/revision 权威 | 内容就绪、Content Baseline、三类 Gate、局部失效、journal 与恢复集成；核心格式本机保真/隔离/性能通过 | LOCAL-03/04 底座 |
| P4 HTML → PPT → Word | 每类都从需求走到可交付文件，不是生成按钮 demo | P3；相关真实服务、能力 Manifest、锁定依赖和目标应用 | HTML 七阶段 + Taste + 浏览器 Review/静态包；PPT 七阶段/按页返工；Word 七阶段/来源与逐章写作；各自最终验收 | LOCAL-04；LOCAL-06 Host |
| P5 五类视频 | 单入口完成五种 Profile 的样片、时间点修改、QA 与导出 | P3；P4 所需文档输入路径；真实媒体 AI/计费；受控 Render/FFmpeg | 五 Profile 分批八阶段闭环；中断只重做受影响场景，音画/字幕/字体/资源权限/媒体 QA 通过 | LOCAL-04 |
| P6 用户扩展与连续性 | 安装 Skill/MCP；持续理解当前项目；可控记忆与 AgentWiki 同步 | P1/P3 事件与 Facade；Broker 安全；账户/真实 Connector 服务 | 扩展全生命周期与攻击回归；自有事件回顾/历史；Roundtable；Profile/Memory 删除审计；同步预览、冲突和部分成功恢复 | LOCAL-05 |
| P7 商业闭环 + 本机全系统验收 | 用户能注册、使用个人/企业钱包、完成工作并找回成果；全系统当前 Mac 可运行 | P1 起逐批接入的真实服务；P2–P6；全部 V1 Viewer 本机格式闭环 | 官网/账户/下载/充值/消费/发票；真实账本一致性；全旅程、30 题 Agent Eval、性能/安全/故障回归；本机开发构建 | LOCAL-06/07 |
| P8 双平台适配与发布 | 可安装、可升级、可回滚的正式 V1 候选 | P7；真实 Windows 11/macOS 承诺版本与签署环境 | 双平台功能/隔离/全部格式 GVP 回执、离线完整安装、签名/公证、SBOM/NOTICE、升级回滚和 Owner 签署 | ADAPT-WIN/MAC；RELEASE-INSTALL/ADMISSION |

P1 的首批代码不直接等于 P1 完成，详见 [首批执行计划](2026-09-05-agent-foundation-first-batch.md)。

### P0：小范围收口，不重跑所有历史 PoC

- [ ] 按首批执行计划刷新现有功能回归，记录旧证据原根与当前候选的区别。
- [ ] 清点 SuperWagie 专有 App Server 制品、固定版本/hash/许可/协议与隔离验证证据；宿主 Codex 可用不算通过。
- [ ] 清点真实测试账户、短期令牌、服务端 Broker、AI/Reservation/Settlement/reconcile 接口与费用授权；只记录“有/无/过期”，不收集明文凭据到计划。
- [ ] 在现有 Viewer 专项计划中核对 Office 候选、Corpus 和实测接口。P1 期间安排有限的本机保真/性能验证，结论必须早于 P3/P4 对其实现路径的依赖。

完成这四项的“状态核实”即可结束 P0；缺少服务不无限滞留在 P0，而是禁用依赖服务的完成门，推进无依赖本地代码。不能因此勾选 P1 的真实 AI 闭环。

### P1：按最小能力逐步打开权限

- [ ] P1.1：Core Thread 状态类型与契约一致性；随后完成 Operational Store 的 Thread/回合/Checkpoint、命令去重与 Schema 迁移。状态模型不调用 Worker、不保存本地模拟财务账本。
- [ ] P1.2：固定 Runtime 私有握手、版本拒绝、流控/超时/heartbeat/parent-death、Worker 故障归属；验证与宿主 Agent 环境互不影响。
- [ ] P1.3：最小账户/Managed AI 平台客户端与服务端真实 reserve/receipt/settle/reconcile；先只读单文件问答，不开放 shell、网络或任意路径写入。
- [ ] P1.4：`workspace.read/search/propose_change/apply_change` 的真实 handler；先单文件局部 semantic patch，再多文件 journal；未持 Lease、过期 revision、伪造 Project/权限/审批一律拒绝。
- [ ] P1.5：同一 Composer 接上 Working Set、流式输出、Diff/适用行内确认、固定 Session Credits 与恢复入口；UI 查询和 Public Facade 分开。
- [ ] P1.6：重试相同 request_id、发送后丢响应、提交前后杀 Core/Worker、外部改文档、撤销授权；断点与副作用回执一致，未知执行状态先 reconcile。

P1 演示建议采用用户明确要求“先给建议，由我应用”的文档整理任务；这不是为所有低风险编辑新增第四种 Gate。完整 30 题知识工作评测按固定 registry 执行；依赖 PPT/长文交付的题在对应能力集成后完成，不用单文件问答替代。正式 G2-AGENT-001 在 P7 前保持未完成，直到不少于 24/30 成功、平均人工评分不少于 4/5、四类安全违规均为 0。

### P2：依次收敛本地产品，不重写已通过编辑器

- [ ] P2.1：UIC 主工作台/项目/多标签/布局与恢复；从静态入口换成真实查询，空、加载、失权、过期、失败均有下一步动作。
- [ ] P2.2：WikiLink、Backlink、标签、属性、搜索和文档操作逐项接入；1k/10k/100k 文档性能按原 Gate 阈值复验；未知语法 round-trip 与真实 Obsidian 对照。
- [ ] P2.3：Tasks 手动/Agent/Milestone 三来源、稳定 block 身份、semantic patch、override/tombstone、重复事件幂等；工作台/项目/日历共用 projection。Thread 与 Task 状态严格分离。
- [ ] P2.4：Excalidraw 后 draw.io，离线创建→编辑→保存→嵌入→导出→重开；独立 Surface、Agent 高层命令与资源权限回归。

P2.1/2/4 的不依赖 AI 部分可在 P1 外部服务阻塞时接续；P2.3 的 Agent 创建来源仍单独等待 P1。

### P3：交付引导与 Viewer 的两条依赖链

- [ ] Workflow/Artifact 领域先集成事件、Baseline、三类 Gate、候选 hash/revision、局部失效、事务与 effect receipt，再接 Guided UI；禁止 UI 直接决定业务完成。
- [ ] Viewer 沿既有 GVP-0→Office 保真→逐格式 Corpus→恶意输入/隔离→包体/性能→集成恢复推进；优先 DOCX/PPTX/PDF 与交付所需格式。
- [ ] 依赖已验本机格式的能力可继续本地集成；其余 89 条记录按台账分批完成，最迟 P7 全部具备本机闭环，P8 补完整双平台签署。未验格式始终明确 partial/unsupported，不借“后续批次”隐性删减。
- [ ] Review 锚点遇到 revision/渲染环境变化先 stale，可靠迁移才 relocated，否则人工处理；Worker 被终止只影响所属文档/任务。

Viewer 专项入口：`docs/superpowers/plans/2026-09-04-universal-viewer-frozen-core-slice-remediation.md` 与 `docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`。保留已完成修订证据，不复活旧 WPS 供页架构。

### P4–P6：每个能力单独通过闭环，不能一次批量勾选

- [ ] HTML 先验本地包和真实浏览器，再接真实 Official Host 测试环境的预览/发布确认/同链接更新/回滚/停止分享；未获授权不得公开发布。
- [ ] PPT 保留默认图片型高保真与选页可编辑重建；Word 保留来源绑定、逐章写作与 DOCX/PDF；WPS/PowerPoint 目标应用验收与内部 Viewer 验收分开。编辑后必须明确保存或放弃并重开核对。
- [ ] 五视频 Profile 分别为网站 Demo、教学课件、PPT 讲解、图片绘本、照片动态。一个 Profile 成功不代表五个完成。
- [ ] 每项官方能力先有十组必填 Capability Manifest，再实现 Reference；冻结 source_commit、capability_version、contract_version、dependency_lock、evaluation_suite、golden_artifacts、acceptance_report 七要素，之后才作 Private Package 等价化。
- [ ] 用户扩展只在设置内；Skill/MCP 安装/更新/回滚/移除、默认断网、Network/Process/Credential Broker 与真实 Public Facade handlers 一起验收。目录当前 34 active 方法逐项映射真实 handler；不把废弃 `wps.render_preview` 恢复为有效方法。
- [ ] SessionReviewer 仅消费 SuperWagie 自身事件；Roundtable 是内部 Workflow；Profile/Safe Memory 分 scope、可删、可审计、不可信；AgentWiki 用真实测试实例完成授权、绑定、预览确认、冲突、部分成功和记忆共享。

## 4. 真实服务不是最后再接的“后端收尾”

| 服务 | 首次进入点 | 最迟闭合点 | 缺失时仍可做什么 |
|---|---|---|---|
| 账户/短期令牌/服务端 Credential Broker | P0 清点，P1.3 接通 | P1 真实 AI；P7 完整官网/个人企业账户 | Thread/Workspace/Viewer 等无服务本地模块 |
| Managed AI + Billing reserve/receipt/settle/reconcile | P1.3，真实测试钱包/允许的测试预算 | P1 文本调用；P4/5 各自媒体能力；P7 完整商业验收 | 确定性协议/故障测试，必须注明非真实 AI/财务验收 |
| Official Host | P4 HTML 发布前 | HTML 外部发布闭环 | HTML 本地导出与浏览器 Review |
| AgentWiki | P6 Connector 集成前 | P6 真实同步与记忆共享 | 本地连续性/Memory scope 测试 |
| 支付/发票/个人与企业治理 | P7 前准备真实测试渠道 | P7 | 已有授权测试钱包消费；不能用其冒充充值/发票验收 |

若仓库只有客户端契约、对应服务端没有可用实现，登记为独立服务端建设依赖，明确仓库/负责人/部署环境后另行确认实施范围；不在本仓库偷偷搭一个假服务宣布接通。

## 5. 防退化与停止条件

统一必跑入口：`node scripts/regression/run.mjs`；提交候选：`node scripts/regression/run.mjs --staged`。新的 UI 切片须同时扩充注册清单、policy 允许的 suite、driver 与真实 receipt 校验；Rust 内部模型测试由现有 cargo suite 纳入，不伪装成用户已验收功能。

- 每阶段保留生命周期、Live Preview、格式工具栏的原断言；编辑器中文 IME、光标定位、跨块选区、工具栏焦点、撤销/重做、保存与真实字节继续检查。
- 测试/阈值/registry/CI/钩子变更独立审查；已认可交互有意变化先取得产品确认。R-QS-11 是硬约束，不承诺软件永不出错。
- 新工作树先核实本地 hook。远端 CI/分支保护单列治理任务，未获远端修改授权前只报告，不宣称已经强制阻断合并。
- 数据损坏、越权、Secret 泄露、重复外部效果/扣费、绕过必经 Gate：立即停止相关路径，不扩展权限来绕开失败。
- 服务/设备缺失：标为 BLOCKED_ENVIRONMENT，列明具体输入与解除条件，转做无依赖切片；不 mock 成绿色。
- 性能按现有 fixture/规格阈值判断；无量化阈值的新增场景先记录基准并审定预算，不能实现后任意挑通过线。

## 6. 文件与职责地图

此表用于限定子系统所有权；进入某批次的详细计划再明确新增文件与接口，不授权预先创建空目录/空接口。

| 已有入口 | 职责与后续拆分方向 | 实施前规则 |
|---|---|---|
| `crates/product-core/src/{protocol.rs,gateway.rs,store.rs,workspace/}` | 可信路由、Operational Store、Workspace 权威；新 Agent/Workflow/Artifact 领域独立模块，不挤入 Main | agent-panel、workspace-md、security-extensions |
| `apps/desktop/src/main/`、`src/preload/bridge.cjs` | 私有 Core 连接、进程/Surface 生命周期、窄 IPC；不接管财务或文件业务 | ui-shell、runtime-isolation、security-extensions |
| `apps/desktop/src/renderer/{workspace/,editor/,query-store.mjs}` | 保留既有编辑器与数据订阅，新界面按功能模块拆分 | ui-shell、workspace-md、命中领域规则 |
| `docs/contracts/v1/` | 公共方法、状态、查询、Gate、资源 Handle 与能力契约 | CAC；修改需评估矩阵/规则同步 |
| `scripts/poc/`、`fixtures/` | 历史算法、Corpus 与领域验证，非产品 runtime | quality-scope、对应领域规则 |
| `scripts/regression/`、`apps/desktop/scripts/test-*.mjs` | 新旧用户行为回归与候选证据 | R-QS-11 |

## 7. 里程碑报告与首次开工

每批报告固定回答：本次实现什么、实际验证什么、尚未证明什么、当前候选与证据在哪里、剩余阻塞、下一批做什么。计划状态不得代替机器回执或用户签收。

- [ ] 批准本路线后，从 [首批执行计划](2026-09-05-agent-foundation-first-batch.md) 开始；先核对基线与风险输入，并落地小而可测的 Core Thread 状态模型。
- [ ] 首批验收后，依据实际 Runtime/服务状况编写 P1 持久化与运行时集成执行计划；缺少真实服务只暂停相应集成，不暂停内部状态/事务与 P2 的无依赖功能。
- [ ] 每进入新的独立子系统，先完成限定范围的执行计划自审；产品边界变化才另行请求产品决策。

本路线未承诺固定日历工期：以每批通过的证据估算后续吞吐，避免把尚未验证的服务与 Office 保真风险写成确定交付日期。当前不修改正式审计状态、生产 Registry 或 V1 范围。
