# 超级牛马（SuperWagie）技术可行性调查总入口

> 状态：编码前技术验证已有旧边界的首轮全量归类；已确认方案 B“分层模块化核心”，Gate 0/2、Gate 3 Review、Gate 4/5/6 按 `solution-b-v1` 重开，生产实现准入为 `NO_GO`  
> 基准日期：2026-09-01  
> 最新结论：[编码前技术验证收口报告-2026-09-01.md](编码前技术验证收口报告-2026-09-01.md)

## 1. 调查目的

这组文档不是实施计划。它逐项回答：

- 技术要求是否可行；
- 首选实现路径是什么；
- 哪些现有能力可以复用，哪些只能参考；
- 是否需要开源项目，许可证和供应链边界是什么；
- 哪些结论只有设计依据，哪些已有代码证据，哪些已经通过 PoC；
- 哪些失败条件会阻止进入实施。

## 2. 结论等级

| 状态 | 含义 | 是否允许直接进入实现 |
|---|---|---|
| `PROVEN_EXISTING` | 现有项目已证明主要路径，但仍需 SuperWagie 适配验收 | 否 |
| `PROVEN_POC` | SuperWagie 范围内的代表性 PoC 已通过 | 仅在其他准入门同时通过时允许 |
| `FEASIBLE_CONDITIONAL` | 有可信实现路径，但依赖 PoC、许可证、平台或产品条件 | 否 |
| `RESEARCH_REQUIRED` | 尚缺足够证据 | 否 |
| `DEFERRED` | 已完成影响分析，但明确不进入当前发布范围 | 否 |
| `NO_GO` | 当前约束下不可接受 | 否 |

“可行”不等于“完成”，“有现成仓库”不等于“可以直接打包”，“单元测试通过”不等于“真实客户端验收通过”。

## 3. 当前文档

| 文档 | 覆盖范围 | 当前阶段 |
|---|---|---|
| [V1 发布范围基线](../superpowers/specs/2026-08-29-superwagie-v1-release-scope.md) | V1 Required/Conditional Fallback/Deferred 与内部里程碑 | 范围已收口 |
| [Electron 与随包 Chromium 架构基线](../superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md) | Shell Controller、Rust Product Core、隔离 Worker、Surface、四层依赖与 Gate | 方案 B 已确认；等待全部 `solution-b-v1` 受影响证据 |
| [技术要求矩阵.md](技术要求矩阵.md) | 147 项编号要求：98 `FEASIBLE_CONDITIONAL`、40 `RESEARCH_REQUIRED`、9 `DEFERRED` | 持续更新；编号无重复 |
| [技术验证执行计划.md](技术验证执行计划.md) | Contract Foundation、Gate 0–6、fixture、runner、证据和决策格式 | 旧 31/31 为历史快照；审计器会拒绝方案 B 受影响 fixture 的旧修订证据 |
| [编码准入与契约补充说明](../superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md) | 权威消歧、模块边界、状态机、契约骨架、PoC 门和三向追踪 | 契约基线与审计器通过；尚无 Owner 签署 GO |
| [Contract v1](../contracts/v1/README.md) | 可机读信封、三类 Human Gate、Capability Manifest、状态枚举、错误码和公开方法面 | 284/284 通过；70 个方向已完成独立 inventory/catalog/Schema/fixture 对照与联合语义变异；TypeScript/Python/Rust 对 46 个协议 fixture 为 46/46 一致 |
| [01-桌面界面-Markdown-WebView-绘图.md](01-桌面界面-Markdown-WebView-绘图.md) | Electron/Chromium UI、Markdown、Excalidraw、draw.io | 架构已确认；旧 macOS fixture 仅作历史证据，G0-SHELL-002/Windows 待执行 |
| [02-Agent运行时-沙箱-共享依赖-托管AI.md](02-Agent运行时-沙箱-共享依赖-托管AI.md) | App Server、隔离、Runtime、Managed AI | 四层 Resolver 模型与真实内容哈希校验已通过；签名候选 Runtime、双平台真实 probe、封闭 App Server 与 Managed AI 环境仍阻塞 |
| [03-Durable-Workflow-Capability-闭源打包-Rust迁移.md](03-Durable-Workflow-Capability-闭源打包-Rust迁移.md) | Workflow、Capability、私有包、Rust | 契约/Workflow PoC 通过；签名包与 clean-machine 阻塞 |
| [04-Workspace文件授权-事务-索引与跨平台路径.md](04-Workspace文件授权-事务-索引与跨平台路径.md) | Workspace、CAS、事务、watch/index、路径安全 | macOS Workspace/Crash/Markdown 固定 fixture 通过 |
| [05-内置能力逐项适配-PPT-Word-HTML-WPS.md](05-内置能力逐项适配-PPT-Word-HTML-WPS.md) | 全部指定内置能力及交付链 | 自有 PPT assembler 与无 node_modules Runtime bundle 子验证通过；实际 SuperPPT 仍因 Codex Runtime 耦合 `NO_GO` |
| [06-视频课件-OpenMontage-Remotion.md](06-视频课件-OpenMontage-Remotion.md) | OpenMontage/Remotion 技术与许可证研究记录 | 直接集成路径已放弃 |
| [07-轻量视频制作内核-五场景.md](07-轻量视频制作内核-五场景.md) | 自有视频 Workflow、Scene IR、帧渲染和五个首发场景 | Task 6 五个 Profile 已在 bundled Electron Render Host 上完成 macOS CONDITIONAL_GO；Windows / 人工 Review / Credits 仍阻塞 |
| [08-独立Office-Reviewer.md](08-独立Office-Reviewer.md) | 不依赖 Codex Desktop 的 PDF/DOCX/PPTX ReviewShell、双预览和批注闭环 | Task 7 macOS solution-b 子验证 APPROVED；父级 G3-REVIEW-001/002 仍 BLOCKED_ENVIRONMENT |

## 4. 已验证但尚未解除的准入条件

- 个人/企业账户、Credits reserve/settle、幂等计费和退款；
- AgentWiki Connector 需要真实授权测试 Space；SessionReviewer/连续性/记忆契约的本机 fixture 已通过；
- 安装包、代码签名、公证、Windows 签名、差分升级、回滚；
- SBOM、许可证、字体/模型/模板/媒体资产和第三方 SDK 条款；
- Windows 11 真机、从未安装 Codex Desktop 的干净机、签名安装包与升级/回滚；
- WPS 人工视觉签署、受控副本保存/放弃/重开完整签署；
- 五个视频 Profile 已在 bundled Electron Render Host 上完成 macOS 全链 CONDITIONAL_GO；Windows 解码、时间点人工 Review 与 Credits 幂等仍是外部硬阻塞；
- Official Host、真实 Billing Sandbox、真实 AgentWiki Connector 与封闭 Managed AI 环境；
- OpenMontage/Remotion clean-room 来源已记录；Chromium、FFmpeg/codec、字体和媒体素材仍需有权角色完成生产许可证准入；
- 旧架构 31 个 fixture 已全部产生终态证据；历史汇总为 15 GO、5 CONDITIONAL_GO、6 NO_GO、5 BLOCKED_ENVIRONMENT、0 signed GO。当前审计登记表已切换 `CF-PROTOCOL-002`/`G0-SHELL-002`，并要求 Gate 0/2、Gate 3 Review、Gate 4/5/6 的受影响 fixture 带 `solution-b-v1`；旧证据统一标记 `superseded_evidence`。
- 当前方案 B 机器快照为 11 GO、12 CONDITIONAL_GO、0 NO_GO、8 BLOCKED_ENVIRONMENT、0 missing、0 invalid、0 signed GO，Production Implementation Admission 仍为 `NO_GO`。Contract Foundation 的 284/284 新证据是未签署 draft `GO`；公开 Facade 仍因真实领域 handler、产品 Worker、Network Broker 与 Managed AI 输出清洗/Secret scanner 未落地保持 `CONDITIONAL_GO`；实时数据以 [当前技术验证状态.json](当前技术验证状态.json) 为准。

## 5. 实施准入门

只有同时满足以下两大门，才编写完整 Production Implementation Plan。首轮 Technical Validation
已经执行并收口，但 B 门仍未满足；当前只允许编写针对本报告 No-Go/Blocked 项的解除型实施计划：

### A. 产品与界面门

- [x] 主工作台、智能工作区、制作引导和交付目录原型逐屏确认；
- [x] Markdown/Obsidian 核心体验、统一工作台任务投影和 Excalidraw/draw.io 边界确认；
- [x] 内容不足引导、人工确认、回改和恢复路径确认；
- [x] Agent 状态、Credits、行内授权、设置和用户扩展边界确认。

### B. 技术可行性门

- 技术矩阵没有未解释的 `RESEARCH_REQUIRED` 高风险项；
- 每个 `FEASIBLE_CONDITIONAL` 都有负责人、PoC、通过指标和 fallback；
- 所有高风险 PoC 产生可复现代码、fixture、原始结果和结论；
- 安全、许可证、平台兼容和供应链没有未接受的 No-Go；
- 关键垂直链在 macOS/Windows 和目标应用中真实通过；
- 最终形成 `Go / Conditional Go / No-Go / Deferred` 决策表。

## 6. 当前明确的 No-Go

- 自动把任意 Skill/Python/JavaScript 编译成 Rust；
- 承诺客户端闭源制品绝对不可提取；
- Chromium renderer、Electron Main 或普通 Skill 获得任意文件、进程或网络权限，或调用方能伪造 actor/caller/grant/wallet/Gate Receipt/audit context；
- SuperWagie 回退或连接机器已有 Codex Server；
- 用户配置 Provider Key 或看到模型路由；
- watcher 被当作无遗漏事实日志；
- 旧 revision 整文件覆盖外部编辑；
- 没有真实 WPS/PowerPoint 证据却宣称交付物已通过目标客户端验收；
- 把当前 AGPLv3 OpenMontage 源码、Prompt、模板或 UI 带入闭源生产实现；
- 把 Remotion 源码、npm 包、Renderer、Player、Studio 或 Editor Starter 带入当前生产依赖；
- 向生产用户暴露代码、多轨时间线、Provider 配置或任何 Skill 自带 UI；
- UI 或技术准入门未完成就编写并启动全量实施计划。
