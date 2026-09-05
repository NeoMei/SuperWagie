# Agent 首批基础：实现与本机验证边界

日期：2026-09-05。开发基点 `37f225164f0c83b6748cc40f2e52bacc8f66eed8`；实测 macOS 26.6.2 / 25G83 / arm64。这是 P0/P1.1 子批次记录，不是 LOCAL-02 或发布 Gate receipt。

## 已有行为回归与输入干扰

初次全回归 `c1b0a674-abb7-4269-9359-fc81a324ebe0` 在工具栏首项失败；复测出现另一英文字母。用户确认测试窗口截获了其他任务的物理键盘输入。两次失败保留，不能当成编辑器缺陷的充分证据，也不追改为通过。

之后改为隐藏、不可获取系统焦点的真实 Electron 测试窗口，统一启动器检查窗口状态并监测运行期间 show/focus 事件。既有编辑器/格式算法未改；全部行为断言、检查清单与阈值保留。背景模式及其非原生前台验收边界见 [回归保护](已验收功能与回归保护.md)。

背景模式基础复测 `1ab6039e-779f-484d-943f-604f4a53f318` 全量通过：Rust 40 项、桌面单元 41 项、生命周期 12 项、Live Preview 17 项、工具栏 14 项，另含门禁自测、规格校验、Clippy 与构建。该 run 在 Agent 模型代码写入前执行，只证明编辑器基线恢复；不得作为最终提交的完整证据。

最终提交必须由钩子生成新的 `apps/desktop/test-results/regression/<run_id>/result.json`，`status=passed`、源码/HEAD 前后一致且 `index_tree` 等于提交 tree；最终 run_id 与 SHA 在本次交接中给出，避免把待提交文档的自身 SHA 写入文档形成循环绑定。

## 首批产品代码与 TDD

新增 `crates/product-core/src/agent/state.rs`，通过 `agent/mod.rs` 与 `lib.rs` 导出：

- `ThreadState`：完整九状态，serde wire 名与 `states.schema.json` 一致（R-AP-05）。
- `can_transition(from, to)`：81 对状态组合逐项检查，非法边与自环拒绝；不承担权限或持久化检查。
- `archive_restore_target(archived_from)`：可信归档来源映射回 completed/user_stopped，不自动开始执行；不以此宣称 Checkpoint 恢复完成（R-AP-07）。
- 不修改 Task Item 状态，不增加财务账本、不启动 Worker、不开放 UI/Public Facade 命令（R-AP-08）。

先写三项测试并运行，因三个导出缺失而得到 Rust E0432/E0425；实现后同一筛选命令三项通过。归档恢复预期使用独立字面量表，不调用待测函数构造期望。

```sh
cargo test --locked --manifest-path crates/product-core/Cargo.toml agent::state::tests
rustfmt --edition 2024 --check crates/product-core/src/agent/state.rs crates/product-core/src/agent/mod.rs
cargo clippy --locked --manifest-path crates/product-core/Cargo.toml --all-targets -- -D warnings
node scripts/check-spec-refs.mjs
```

以上定向检查通过。全仓 `cargo fmt --check` 发现既有 `crates/product-core/tests/gateway.rs` 两处排版差异；对 `git show HEAD:crates/product-core/tests/gateway.rs` 单独运行 rustfmt 重现相同差异，证明属于基点既有问题。本批按计划不重排无关受保护测试文件，不把全仓格式检查报告为通过。它不是本批新增行为失败；统一强制回归仍须完整通过。

## 历史证据来源

重新只读调用 `auditValidationStatus({repoRoot})`：

| 根 | 37 项审计结果 | 含义 |
|---|---|---|
| 当前 worktree | 31 missing、1 blocked、5 research | 历史 evidence 目录未携带到 worktree |
| `/Users/neomei/项目/codexprojects/SuperWagie` | 11 GO、12 conditional、9 blocked、5 research，0 missing/invalid、0 signed GO | 原根历史记录可解析，不是当前候选全部重新执行 |

两处正式 Production Admission 均为 NO_GO；89 条 Viewer 格式仍 research、0 complete receipts、Viewer Release NO_GO。没有修改状态 JSON、生产 Registry 或格式台账。

## Runtime 与真实服务输入

仅核对当前仓库产品入口、fixture 登记与验证分流文档；没有扫描宿主全局 Agent 配置、读取凭据、下载制品或发起服务请求。因此以下是本批尚未获得的集成输入，不是断言用户其他环境不存在服务。

| 输入 | 核实结果 / 证据 | 解除条件 |
|---|---|---|
| 独立 App Server 固定制品、hash/版本/许可 | 当前产品 Core 未接入；G0-DEPS fixture 描述的是候选验证规则，不能替代可用产品制品 | 明确 SuperWagie 专有候选及 manifest、来源许可与可验证绝对身份 |
| App Server 私有协议、隔离、parent-death | 已有 PoC 路线和历史观察，当前产品没有本批集成回执 | 固定候选与当前 Core 握手/取消/故障测试，证明不复用宿主配置 |
| Managed AI 真实测试端点 | 验证分流仍列为真实服务待接入；本批未获得授权可用的测试入口 | 服务实现位置、类型化端点与测试身份明确 |
| 短期令牌、服务端 Credential Broker | 未核验，不索取/保存明文 Provider Key | 验证服务端 Broker 与短期凭证通道，返回值/日志无 Secret |
| Reservation/Usage Receipt/Settlement/reconcile | 有契约与评测义务，没有本批真实账本结果 | 真实测试服务端可验证预留、结算、取消及未知结果核对 |
| 测试钱包、允许的费用范围 | 未提供本批实际付费授权；没有产生费用 | 明确可用测试钱包与预算范围后再执行消费 |

参考：`fixtures/gate-0/G0-DEPS-001/README.md`、`fixtures/gate-2/G2-AGENT-001/README.md`、`docs/技术可行性/当前MacBook优先-验证任务分流.md`、`docs/技术可行性/技术验证执行计划.md`。

## 尚未验证与下一批

本批不证明：持久 Thread/回合/Checkpoint、同请求去重、真实 Agent/AI、Lease 写入、审批与恢复 UI、Session Credits 或 30 题知识工作 Eval。LOCAL-02、LOCAL-06 和 G2-AGENT-001 不勾选。

下一批先冻结 Operational Store 接口与 Schema 迁移，完成 Thread/回合/Checkpoint 原子持久化、request_id 去重、归档来源与故障恢复；再根据以上真实输入接 Runtime/平台客户端。Snapshot/cursor gap 的 UI 接入须有单独产品命令契约与真实界面验收，不在持久化测试中假称已接通。服务阻塞只限制对应闭环，不阻止无服务的内部持久化实现。

受保护变更已在回归报告单列：统一 UI 启动器、新增测试开关测试、runner 运行模式元数据和回归说明。没有放宽旧检查，不能自行签发用户体验认可。
