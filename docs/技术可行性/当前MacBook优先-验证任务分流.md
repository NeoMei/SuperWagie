# 当前 MacBook 优先：验证任务分流

> 日期：2026-09-05；用户决策：先在当前 MacBook 把整个项目做出来、跑通，Windows 和其他 OS 版本适配不作为本机开发必过前置。
> 实测环境：macOS 26.6.2 / build 25G83 / arm64。
> 权威：V1RS §5.1、CAC §14.1、R-QS-10。本表是任务安排，不是 Gate receipt。

## 1. 审查结论

尚未全部完成，剩余项不只涉及系统适配。当前审计为 37 项：11 GO、12 CONDITIONAL_GO、9 BLOCKED_ENVIRONMENT、5 RESEARCH_REQUIRED；0 missing、0 invalid、0 signed GO。Windows 已有 20 个父 fixture 的受审运行观察，不能再写成从未验证。

现有本机子验证已经证明 Electron/Rust/Worker、依赖隔离、Workspace/Markdown、PPT 组装、HTML、五类视频与历史 Review/Recovery 的多项路径；不代表整个产品 UI 已集成。Viewer Frozen Core 窄切片候选闭包通过，但 GVP-0 无 receipt，GVP-1–5 未闭合，89 条格式记录仍为 RESEARCH_REQUIRED。

依据：[机器状态](当前技术验证状态.json)、[执行计划](技术验证执行计划.md)、[macOS 历史报告](macOS技术验证阶段报告-2026-09-03.md)、[Windows 观察索引](../../fixtures/platform-observations/windows-validation-2026-09-04.json)、[格式台账](../contracts/v1/format-admission-ledger.json)。历史平台标签不代表本次机器实测身份；父结果中的旧 limitation 必须结合后续 child 证据阅读，不能据此重复已完成的子验证。

## 2. 全部 37 项分流

状态列保留机器审计语义；本机安排不自动升级状态。

| Fixture（数量） | 执行状态 | 本机下一步与后置边界 |
|---|---|---|
| CF-PROTOCOL-002；G1-WORKSPACE-001、G1-CRASH-001、G1-MARKDOWN-001、G1-TASK-001、G1-DIAGRAM-001；G2-THREAD-001、G2-WORKFLOW-001、G2-HOST-001、G2-CONTINUITY-001；G5-MEMORY-001（11） | GO | 保留已验证逻辑，接入真实产品 UI/Core 后做切片回归；不因缺 Windows 签署重开无关 PoC |
| G0-SHELL-002（1） | BLOCKED_ENVIRONMENT | 壳/Core/Surface 子验证已存在；完成统一本机应用、输入/退出/恢复；发布签名与跨机安装后置 |
| G0-ISOLATION-001、G0-DEPS-001（2） | CONDITIONAL_GO | 复用 Task 5 候选/zero-diff 证据，验证产品 Runtime/依赖布局；不能复用外部 Codex 配置；双平台签名包后置 |
| G2-AGENT-001（1） | BLOCKED_ENVIRONMENT | 封闭 App Server + Managed AI 的 30 题真实评测仍缺，不是系统适配 |
| G3-PPT-001（1） | BLOCKED_ENVIRONMENT | 三页组装/脱耦已有子证据；补七阶段、人工门、局部返工/恢复和真实产物验收；Windows Office 后置 |
| G3-WRITER-001（1） | CONDITIONAL_GO | 补产品七阶段、确认门与保存/放弃/重开闭环；操作证据、人工视觉与发布签署分别记录 |
| G3-REVIEW-001、G3-REVIEW-002（2） | BLOCKED_ENVIRONMENT | 历史 Review/恢复子验证已做，不恢复旧 WPS 供页方案；当前集成/恢复归 GVP-5；发布干净机后置 |
| G3-HTML-001（1） | CONDITIONAL_GO | 本地浏览器路径已有证据；集成产品并接入 Official Host 测试服务；Windows 渲染复验后置 |
| G4-VIDEO-001..005（5） | CONDITIONAL_GO | 自动媒体路径已有证据；补产品入口、时间点 Review、局部修改与真实 Credits；Windows 解码后置 |
| G5-EXT-001、G5-ATTACK-001、G5-FACADE-001（3） | CONDITIONAL_GO | Worker/攻击子验证已做；补当前 34 active 方法真实 handler、Broker/Secret 清洗与产品扩展全链；不能跳过安全 |
| G5-CONNECTOR-001（1） | BLOCKED_ENVIRONMENT | 真实 AgentWiki 授权实例、Space、同步/冲突/恢复；只阻塞所属功能 |
| G6-BILLING-001（1） | BLOCKED_ENVIRONMENT | 真实测试账户、钱包、回调、账本一致性；mock 不代表计费完成 |
| G6-PACKAGE-001（1） | BLOCKED_ENVIRONMENT | 先做本机可启动、依赖明确的开发构建；签名、公证、干净机、正式升级/回滚归发布工程 |
| GVP-0（1） | BLOCKED_ENVIRONMENT | 本机平台/候选身份验证与 macOS 15 兼容分开；后续补明确的本机验证入口，不向严格 runner 伪造平台参数 |
| GVP-1、GVP-2（2） | RESEARCH_REQUIRED | 本机 Office 保真度与逐格式 Corpus 仍为重点；89 条格式保留目标，未验证不能宣称支持 |
| GVP-3、GVP-4、GVP-5（3） | RESEARCH_REQUIRED | 本机恶意输入/隔离、性能/打开速度、产品批注/外部修改/恢复仍须验证；跨平台回执与发布 Chunk 签署另行完成 |

## 3. 后续适配与发布任务

以下均未完成，但不阻塞本机编码；本机切片稳定后安排，承诺相应平台支持或对外发布前完成。

- [ ] ADAPT-WIN（Desktop Runtime / QA）：Windows 11 当前候选、路径/junction、输入/剪贴/拖放、字体/媒体/Office、隔离及逐格式 GVP 复验；复用已有观察，不从零调查。
- [ ] ADAPT-MAC（Desktop Runtime / QA）：macOS 15 与其他承诺版本兼容矩阵；当前 macOS 26.6.2 不能代签。
- [ ] RELEASE-INSTALL（Release Engineering）：双平台签名/公证、干净机离线完整安装、升级/回滚、卸载保留 Workspace。
- [ ] RELEASE-ADMISSION（各 Gate Owner / Release Engineering）：当前候选双平台结果、逐格式 receipts、签名 Chunk、SBOM/NOTICE、生产许可证审查与 Owner 签署。

这是排期后置，不是把 V1_REQUIRED 改为 DEFERRED；本机依赖完整性、来源与许可证检查仍须执行。

## 4. 当前 MacBook 验收任务

以下均待产品集成验收，不因已有独立 PoC 通过自动勾选。

- [x] LOCAL-01-MD 子切片（2026-09-05）：统一 Electron 44.1.0 启动 → Rust Product Core 握手 → 本地 Project 授权 → Markdown 实时预览/源码/阅读 → 持久草稿与自动保存 → Base/Current/Proposed 冲突三动作 → 外部重命名 → 正常关闭重开 → Core 崩溃恢复 → 撤销授权。当前机器实测为 macOS 26.6.2 / build 25G83 / arm64；`npm --prefix apps/desktop run test:ui` 检查真实 UI 与文件字节，结果的 `admission_effect` 为 `none`。这不勾选 LOCAL-01，因为任务、绘图仍未进入本切片，也不改变 37 项正式审计快照。

  Live Preview 更正：最初的编辑/分栏/预览不符合 R-WM-02，不能作为实时预览完成证据。本次按 WD §17.5 实现默认光标驱动就地编辑，增加 `npm --prefix apps/desktop run test:live-preview` 的真实 Electron 点选、选区、组合输入、撤销和磁盘字节验收；覆盖范围与剩余兼容性验证见 [Markdown Live Preview 本机验收](Markdown-Live-Preview-本机验收.md)。

- [ ] LOCAL-01：统一应用启动 → 主工作台 → 授权 Project → Markdown/任务/绘图保存 → 外部编辑 → 重开/故障恢复。
- [ ] LOCAL-02：封闭 Agent + 真实 Managed AI → Working Set → 修改/确认 → stop/restart → Artifact/记录不丢且副作用不重复。
- [ ] LOCAL-03：内置 Viewer 默认打开 → Office 保真/速度 → 逐格式模式 → 批注/Diff → revision 变化/恢复；不依赖 WPS 供页，不引入 LibreOffice。
- [ ] LOCAL-04：PPT/Word/HTML/五类视频从真实入口完成内容就绪、人工门、生成、局部返工、恢复、导出与目标客户端验收。
- [ ] LOCAL-05：Skill/MCP 生命周期与真实 Facade → 拒绝越权 → 连续性/记忆 → AgentWiki 授权同步与冲突恢复。
- [ ] LOCAL-06：账户/个人与企业钱包/Managed AI/Official Host/Billing 按功能接通真实测试服务；断网/失败/回调重放无数据损失或重复扣费。
- [ ] LOCAL-07：当前机器统一前后端与真实 UI 端到端回归，记录候选/依赖/实际平台、性能、恢复和限制；不能只凭壳启动或各 PoC 总测试数签收。

按依赖逐片开发；外部凭据不可用只标明所属切片等待，不阻止无关本地功能，也不能用 stub 宣称整个项目跑通。未经授权不产生费用、真实支付或对外发布。

当前已实现并执行 LOCAL-01-MD 的本机开发 runner 与产品入口；它不是全产品 UI、GVP receipt 或双平台验收。外部服务仍未接通，机器审计、历史证据与生产 Registry 均未修改；正式 Production Implementation Admission 和 Viewer Release Admission 保留原状态。
