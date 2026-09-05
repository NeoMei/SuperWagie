# SuperWagie Agent 首批基础 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 刷新已有编辑器回归并核实 Agent 集成前置，交付可独立测试的 Rust Thread 状态模型，作为持久化与 Runtime 集成的第一块产品代码。

**Architecture:** 只在 Rust Core 增加一个无 I/O 的 Thread 状态模块；沿用权威九状态，不移植 PoC 的模拟扣费。此批次不开放 UI/Agent 命令，不启动 App Server、不连接模型、不写用户 Workspace；下一批由 Core 持久化/Checkpoint 层消费该模型。

**Tech Stack:** 现有 Rust 2024、serde、serde_json 与 cargo test；已有 Node/Electron 统一回归，不添加依赖。

**Spec:** `docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md` §6.1、7.1、14.1；`docs/contracts/v1/states.schema.json`；`rules/agent-panel.md` R-AP-05/07/08；`rules/runtime-isolation.md` R-RI-01/03；`rules/capability-ai.md` R-CA-01/04；`rules/quality-scope.md` R-QS-10/11；[系统路线图](2026-09-05-system-local-implementation-roadmap.md)。

## Global Constraints

- 这是 P0 + P1.1 的第一批，不是 LOCAL-02 或 G2-AGENT-001 完成。
- 状态严格为 ready、running、awaiting_user、user_stopped、credits_blocked、disconnected、recoverable_failed、completed、archived。
- `user_stopped` 是安全暂停，不是撤销；归档不删除记录。恢复归档只能返回 completed 或 user_stopped。
- 状态合法不等于执行已获授权；本模块不检查 Project、Lease、Gate、钱包或恢复证据。后续 Gateway/持久化层必须在落库与调 Worker 前实施这些检查。
- awaiting_user、credits_blocked、disconnected、recoverable_failed 的持久化必须与可信 Checkpoint 一致；本批无持久化，不允许据纯状态转换自动恢复执行。
- 不改既有公共方法目录；不增加 Renderer 直调状态接口；不把 Thread 枚举混入 Task Item。
- 不升级依赖，不写外部服务，不读取宿主凭据，不将历史证据或当前 Mac 测试改签为发布 GO。

## 文件地图

执行更新（2026-09-05）：基线输入干扰由用户确认；已修正后台测试呈现并完整复测。Task 1 输入清点、Task 2 状态模型与定向测试已执行，最终提交以新回归 receipt 为准；Task 3 的下一批持久化/Runtime 详细执行计划仍待编写。具体证据和既有全仓 rustfmt 差异见 [本机验证记录](../../技术可行性/Agent首批基础-本机验收.md)。这不勾选 LOCAL-02，也不把整个首批计划标记为完成。

| 文件 | 动作 | 职责 |
|---|---|---|
| `crates/product-core/src/agent/mod.rs` | 新建 | Core 内部 Agent 领域入口 |
| `crates/product-core/src/agent/state.rs` | 新建 | 九状态、纯转换判断、归档恢复规则与单元测试 |
| `crates/product-core/src/lib.rs` | 增加 `pub mod agent;` | 与现有领域模块保持一致；Rust 模块导出不等于 IPC/API 开放 |
| `docs/技术可行性/Agent首批基础-本机验收.md` | 新建 | 当前候选、现有回归、输入阻塞、模型测试与非验收项 |
| `apps/desktop/test-results/regression/` | runner 生成、保持忽略 | 新 run 结果与日志，不手工改写 |

不修改 store/protocol/gateway/UI、正式状态 JSON、格式台账或 accepted-features registry；内部模型尚不是用户已验收行为。

## Task 1：基线与真实集成输入核验

**Files:** Read `scripts/regression/run.mjs`、`scripts/poc/validation-status-audit.mjs`、`fixtures/gate-2/G2-AGENT-001/README.md`、`fixtures/gate-0/G0-DEPS-001/README.md`；Create `docs/技术可行性/Agent首批基础-本机验收.md`。

**Interfaces:** Consumes 现有回归 CLI 与 `auditValidationStatus({repoRoot: string})`；Produces 带实际候选/平台/证据定位和独立阻塞行的报告，不新增准入状态机。

- [ ] 读完上述规格及 AGENTS.md 命中的规则，核对工作树、HEAD 和钩子。运行：

```bash
git status --short
git rev-parse HEAD
git config --get core.hooksPath
sw_vers
uname -m
```

预期基点可能已前进；记录实际值，不要求硬退回 37f2251。若有其他人的改动，保留并隔离本批范围；不得 stash/reset。钩子未启用时不能声称提交保护存在，后续单独配置前核实用户已有 hook，不覆盖它。

- [ ] 运行当前完整回归：

```bash
node scripts/regression/run.mjs
```

预期 exit 0、新 run_id、status passed、admission_effect none，生命周期/Live Preview/工具栏每项均 true。失败先停止本批实施，报告与已验收行为的关系；不能降低门槛。

- [ ] 只读核对历史证据与当前工作树，明确原根是否可访问：

```bash
node --input-type=module -e 'import {auditValidationStatus} from "./scripts/poc/validation-status-audit.mjs"; for (const repoRoot of [process.cwd(), "/Users/neomei/项目/codexprojects/SuperWagie"]) { const r = auditValidationStatus({repoRoot}); console.log(JSON.stringify({repoRoot, summary:r.summary, production:r.production_implementation_admission, viewer:r.format_admission_ledger}, null, 2)); }'
```

预期原 checkout 可解析既有 37 项而当前工作树可能报告缺失；不是要求两处统计一致。原根不可用则标记历史证据不可复核，不重新制造 receipt，不运行 `--update-status`。

- [ ] 对 App Server 制品与 Managed AI 测试服务做限定清点：只查仓库登记的制品/Manifest/文档与已明确提供的服务配置入口，不扫描用户全局 Agent 配置、不输出环境变量值。报告逐项写“证据定位 + 已核实/未核实 + 解除条件”：固定制品及 hash/许可；协议与隔离证据；真实服务端测试环境；短期令牌/Broker；reserve/settle/reconcile；测试钱包/费用授权。未提供制品或服务即记录缺失，不能猜测路径或复用宿主账户。

- [ ] 报告使用以下固定栏目，内容填实际观察而非预填成功：候选与平台、已有行为回归、历史证据来源、Runtime 依赖、AI/计费依赖、可继续的无服务代码、尚未验证、下一批进入条件。不要把令牌/客户文件内容写入报告。

Task 1 验收：现有行为通过新回归，且每项外部输入都已明确存在证据或具体缺口。缺真实服务不阻止 Task 2 的纯模型，但 P1 真实 Agent 闭环仍不通过。本任务的文档随 Task 2 一起提交，不为无行为变化的清点单独制造代码提交。

## Task 2：TDD 实现权威 Thread 转换模型

**Files:** Create `crates/product-core/src/agent/mod.rs`、`crates/product-core/src/agent/state.rs`；Modify `crates/product-core/src/lib.rs`；Test `agent/state.rs` 内部单元测试。

**Interfaces:**

- Produces `ThreadState`：derive Debug/Clone/Copy/PartialEq/Eq/Serialize/Deserialize，serde snake_case。
- Produces `can_transition(from: ThreadState, to: ThreadState) -> bool`：仅回答显式状态边是否合法；自环为 false，重复请求去重留给下一批持久化层。
- Produces `archive_restore_target(archived_from: ThreadState) -> Option<ThreadState>`：ready/completed 归档恢复到 completed，user_stopped 恢复到 user_stopped；其余输入 None。`archived_from` 是以后由可信 Store 保存的来源，不是 Renderer 自报字段；不能凭本函数直接恢复运行。

- [ ] 先建立 `agent/mod.rs` 的 `pub mod state;`，并在 `lib.rs` 添加 `pub mod agent;`；`state.rs` 先只写以下完整测试，不写实现：

```rust
#[cfg(test)]
mod tests {
    use super::{ThreadState, archive_restore_target, can_transition};
    use ThreadState::*;

    const STATES: [ThreadState; 9] = [
        Ready, Running, AwaitingUser, UserStopped, CreditsBlocked,
        Disconnected, RecoverableFailed, Completed, Archived,
    ];

    #[test]
    fn all_eighty_one_transition_pairs_match_cac() {
        let allowed: [&[ThreadState]; 9] = [
            &[Running, Archived],
            &[AwaitingUser, UserStopped, CreditsBlocked, Disconnected,
              RecoverableFailed, Completed],
            &[Running], &[Running, Archived], &[Running], &[Running],
            &[Running], &[Running, Archived], &[],
        ];
        for (index, from) in STATES.into_iter().enumerate() {
            for to in STATES {
                assert_eq!(can_transition(from, to), allowed[index].contains(&to),
                    "{from:?} -> {to:?}");
            }
        }
    }

    #[test]
    fn wire_states_match_authoritative_schema_and_round_trip() {
        let schema: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"), "/../../docs/contracts/v1/states.schema.json"
        ))).unwrap();
        let expected = schema["$defs"]["AgentTaskThread"]["properties"]
            ["state"]["enum"].as_array().unwrap();
        let actual: Vec<serde_json::Value> = STATES.into_iter()
            .map(|state| serde_json::to_value(state).unwrap()).collect();
        assert_eq!(&actual, expected);
        for state in STATES {
            let value = serde_json::to_value(state).unwrap();
            assert_eq!(serde_json::from_value::<ThreadState>(value).unwrap(), state);
        }
        for invalid in ["paused", "cancelled", "blocked", "in_progress", "unknown"] {
            assert!(serde_json::from_value::<ThreadState>(invalid.into()).is_err());
        }
    }

    #[test]
    fn restoring_an_archive_never_starts_execution() {
        for state in STATES {
            let expected = match state {
                Ready | Completed => Some(Completed),
                UserStopped => Some(UserStopped),
                _ => None,
            };
            assert_eq!(archive_restore_target(state), expected);
            assert_ne!(archive_restore_target(state), Some(Running));
        }
    }
}
```

- [ ] 运行失败测试：

```bash
cargo test --locked --manifest-path crates/product-core/Cargo.toml agent::state::tests
```

预期编译失败，原因是 ThreadState/can_transition/archive_restore_target 尚未定义。若因工具链、依赖或路径问题失败，先修复测试环境，不把环境失败计作有效 RED。

- [ ] 在 `state.rs` 测试模块前添加最小实现：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThreadState {
    Ready,
    Running,
    AwaitingUser,
    UserStopped,
    CreditsBlocked,
    Disconnected,
    RecoverableFailed,
    Completed,
    Archived,
}

pub fn can_transition(from: ThreadState, to: ThreadState) -> bool {
    use ThreadState::*;
    match from {
        Ready | UserStopped | Completed => matches!(to, Running | Archived),
        Running => matches!(to, AwaitingUser | UserStopped | CreditsBlocked
            | Disconnected | RecoverableFailed | Completed),
        AwaitingUser | CreditsBlocked | Disconnected | RecoverableFailed => to == Running,
        Archived => false,
    }
}

pub fn archive_restore_target(archived_from: ThreadState) -> Option<ThreadState> {
    use ThreadState::*;
    match archived_from {
        Ready | Completed => Some(Completed),
        UserStopped => Some(UserStopped),
        _ => None,
    }
}
```

- [ ] 再运行同一测试命令，预期三项测试通过，81 个状态对全部核对；这仅证明纯模型，不证明持久化、恢复或任何真实执行。
- [ ] 运行格式与静态检查：

```bash
cargo fmt --manifest-path crates/product-core/Cargo.toml --check
cargo clippy --locked --manifest-path crates/product-core/Cargo.toml --all-targets -- -D warnings
```

格式差异只修本批新增代码；不顺手重排无关文件。
- [ ] 在报告记录测试命令、结果和状态语义，明确没有模拟财务逻辑；审查 `git diff --stat` 与逐文件 diff，确认未改公共 Facade、持久化或 UI。
- [ ] 检查规则引用，明确暂存本批四个文件并提交；钩子必须运行真实全回归，不能 bypass：

```bash
node scripts/check-spec-refs.mjs
git add crates/product-core/src/agent/mod.rs crates/product-core/src/agent/state.rs crates/product-core/src/lib.rs docs/技术可行性/Agent首批基础-本机验收.md
git diff --cached --check
git commit -m "feat: add contract-aligned agent thread state model"
```

如果用户有额外未暂存/未跟踪改动导致提交门失败，停止提交、报告冲突，不擅自暂存用户文件或降低门槛。钩子不可用时先运行 `node scripts/regression/run.mjs --staged`，不能把手跑说成 hook 已安装。

Task 2 验收：独立可测试的 Core 模型已提交；九状态与 Schema 一致，非法转换全部拒绝；现有编辑器全量回归仍通过。本批新增 3 项 Rust 测试，不修改既有测试最低数量来绕过失败，也不把模型登记为新的已验收 UI。

## Task 3：验收交接与下一批范围冻结

**Files:** Read 本批提交、fresh regression receipt 和 `docs/技术可行性/Agent首批基础-本机验收.md`；下一批另建 `docs/superpowers/plans/2026-09-05-agent-persistence-runtime-integration.md`，仅在本批结果可用后编写。

**Interfaces:** Consumes Task 2 的三个明确 Rust 导出与 Task 1 的真实输入清单；Produces 下一批计划的持久化、隔离 Runtime、平台服务准入边界，不开放未实现接口。

- [ ] 检查提交 tree 与暂存区回归 receipt 的 index_tree 一致，报告实际 SHA/run_id；不得用提交前别的候选的旧回归代替。
- [ ] 交付本批结果：Thread 模型已实现；持久会话、真实 Agent、读写/审批 UI、AI/计费/恢复均尚未证明；LOCAL-02 和正式 G2-AGENT-001 保持未完成。
- [ ] 下一批计划必须明确 Operational Store 的 Schema 迁移、Thread/回合/Checkpoint 事务、request_id 去重、归档来源、重连 Snapshot/cursor gap；定义接口后才修改 `store.rs`、`gateway.rs` 与 `protocol.rs`。
- [ ] Runtime/服务有真实可验证输入时，把受监管私有握手与只读单文件真实 AI 纳入下一批；缺失时仅实施无服务依赖的持久化/恢复模型及其故障测试，同时报告精确缺口。不建立“临时”宿主 Codex 通道。

## 自审与批准边界

- 本计划覆盖 CAC §6.1 的九状态合法边、归档恢复规则和 wire enum；Checkpoint、同线程新回合、财务与 Artifact 保留是下一持久化/真实集成批次的明确义务，本批不宣称覆盖。
- 本计划所有 Rust 导出已在 Task 2 定义，测试路径和现有命令均已定位；不依赖尚不存在的 Runtime 客户端函数。
- 当前只交付计划，不在规划回合执行这些实现任务。执行方式由用户选择：当前任务内分批执行，或经用户授权后使用子代理分工；无默认自动派发。
