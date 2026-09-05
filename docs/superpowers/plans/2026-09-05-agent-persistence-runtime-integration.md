# Agent 持久状态层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本次按用户选择在当前任务内执行，不自动派发。

**Goal:** 在现有 Operational Store 中持久保存 Thread、回合、状态检查点与请求结果，验证重开、CAS、并发、撤权、事务失败及迁移恢复边界。

**Architecture:** `store/threads.rs` 是 Core 内部领域存储访问层，复用 `OperationalStore` 连接与 `agent::state`。新增 Agent 专属版本表和三张领域表，不改 Workspace 表结构、不把数据库移到用户项目。Runtime 与 UI 集成保持关闭。

**Tech Stack:** 当前锁定 Rust 2024、rusqlite 0.40.1 / SQLite WAL、serde 1.0.219、serde_json 1.0.143、sha2；不新增依赖。

**Spec:** CAC `docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md` §4–7.1、14.1；BCRA §5、8–10；`docs/contracts/v1/states.schema.json`；R-AP-05/07/08、R-QS-04/10/11。完整 Agent 集成继续受 [总路线图](2026-09-05-system-local-implementation-roadmap.md) P1 约束。

## Global Constraints

- 九状态沿用现有 `ThreadState`。停止不等于撤销；归档保留历史；同线程完成后 Start 增加回合，不更换 thread_id。
- 本批检查点仅包含状态修订和回合身份，不含模型上下文、工具调用或可重放副作用；不是 App Server 的恢复令牌。
- 对有效项目的检查先于请求去重查询。当前项目激活登记仅是存储访问最低边界，不能替代未来 Gateway 身份、根授权及 Lease 验证。
- 相同 `(project_id, request_id)` 和完整命令指纹返回原结果；同键异参拒绝。失败事务不缓存成功，也不单独保存暂停状态。
- `open/get/recovery_candidates` 不改状态、不调用 Worker。运行中记录只供后续受监管的启动核对，不能据此自动重试。
- 每次 mutation 采用 SQLite IMMEDIATE 事务，同时写 Thread snapshot、history 与 request result；revision 使用 i64 可表示范围内的正整数。
- 迁移仅增加 Agent namespace v1，迁移前在线一致性备份、完整性检查、权限保护；失败不自动覆盖数据库。高版本拒绝、不降级。
- 不接真实 AI/财务、不开放 IPC、不修改公共方法目录或用户文件；不宣称 LOCAL-02、30 题 Eval 或发布完成。

## 文件与接口

| 路径 | 职责 |
|---|---|
| `crates/product-core/src/agent/thread.rs`（新增） | 内部命令、存储记录、状态检查点、错误类型 |
| `crates/product-core/src/store/threads.rs`（新增） | ThreadStore、项目作用域检查、幂等/CAS/事务、只读恢复候选 |
| `crates/product-core/src/store/agent_migration.rs`（新增） | 专属版本检测、迁移备份、原子 DDL |
| `crates/product-core/src/store.rs`、`src/agent/mod.rs` | 仅模块声明/导出；不更改现有 Workspace SQL |
| `crates/product-core/tests/agent_store.rs`（新增） | 真实文件 SQLite 的领域、故障、并发与迁移测试 |
| `docs/技术可行性/Agent持久状态层-本机验收.md`（新增） | 证据、边界、升级/恢复说明 |

公共 Rust 导出（不是 Public Capability Facade）：

```rust
pub struct ThreadCommand {
    pub project_id: String,
    pub thread_id: String,
    pub request_id: String,
    pub expected_revision: u64,
    pub action: ThreadAction,
}
pub enum ThreadAction { Create, Start, Pause(ThreadState), Complete, Archive, RestoreArchive }
pub struct StateCheckpoint { pub checkpoint_id: String, pub turn: u64, pub revision: u64 }
pub struct ThreadRecord {
    pub project_id: String, pub thread_id: String, pub state: ThreadState,
    pub revision: u64, pub turn: u64, pub checkpoint: Option<StateCheckpoint>,
    pub archived_from: Option<ThreadState>, pub updated_at: String,
}
// ThreadError: Storage, Sql, InvalidInput, ScopeDenied, NotFound, RevisionConflict,
// RequestIdReused, InvalidTransition, CheckpointRequired, CorruptState, UnsupportedSchema.
// 内部记录不直接冒充 states.schema.json 的 UI snapshot；正式投影在 UI 接入批次实现。
pub struct ThreadStore { /* 私有 OperationalStore */ }
// ThreadStore::open(state_root: &Path) -> Result<Self, ThreadError>
// ThreadStore::apply(&self, command: &ThreadCommand) -> Result<ThreadRecord, ThreadError>
// ThreadStore::get(&self, project_id: &str, thread_id: &str) -> Result<ThreadRecord, ThreadError>
// ThreadStore::recovery_candidates(&self, project_id: &str) -> Result<Vec<ThreadRecord>, ThreadError>
```

## Task 1：版本化数据底座与真实失败测试

- [x] 复核现有存储、权威状态与基线；后台全回归 run `a2b9d336-e82d-429c-b2cb-9caba750cc66` 通过。
- [x] 在 `tests/agent_store.rs` 复用 `support::TestWorkspace`，先写以下首个行为与首批 13 项测试，运行确认因缺少实际导出失败；随后补齐至 19 项行为测试：

```rust
let fixture = TestWorkspace::new();
let command = ThreadCommand {
    project_id: fixture.core().project_id().to_owned(),
    thread_id: "thread:one".into(), request_id: "request:create".into(),
    expected_revision: 0, action: ThreadAction::Create,
};
let store = ThreadStore::open(fixture.state()).unwrap();
let created = store.apply(&command).unwrap();
drop(store);
let reopened = ThreadStore::open(fixture.state()).unwrap();
assert_eq!(reopened.apply(&command).unwrap(), created);
assert_eq!(reopened.get(&command.project_id, &command.thread_id).unwrap(), created);
```

命令：`cargo test --locked --manifest-path crates/product-core/Cargo.toml --test agent_store`。

- [x] 实现 Agent namespace schema（`agent_schema`、`agent_threads`、`agent_events`、`agent_requests`）；版本表只由事务提交设置。Workspace 行保留。
- [x] 迁移前用 SQLite `VACUUM INTO` 生成独立快照，检查 `PRAGMA integrity_check` 与 0600 文件权限；原库不替换，备份失败直接拒绝迁移。语义依据 [SQLite 官方说明](https://www.sqlite.org/lang_vacuum.html)。
- [x] 测试旧库内容/草稿保存、备份可打开、第二次 open 不再备份、高版本拒绝、坏迁移回滚。

## Task 2：事务领域操作

- [x] 先运行失败测试；以以下原子操作骨架实现 `apply`，具体状态规则必须使用 Task 2 下方的表而非自由转换：

```rust
let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
// 在同一 transaction 内依次进行作用域验证、请求指纹重放检查、revision CAS、
// 状态计算、snapshot/history/request-result 写入；任何一步 Err 由 Drop 回滚。
transaction.commit()?;
```

| 动作 | 限制与结果 |
|---|---|
| Create | revision=0 且新 thread_id；存储 revision=1、ready、turn=0 |
| Start | ready/completed 开始新回合；暂停类状态必须有匹配回合的检查点并继续原回合；归档拒绝 |
| Pause | 仅 running 到五类暂停（含 user_stopped），当前 revision+1 的检查点与状态一起写 |
| Complete | running→completed，不删除回合历史；不能由任意状态直达 |
| Archive | ready/completed/user_stopped→archived，保留归档来源与暂停检查点 |
| RestoreArchive | 只由 archived，经既有映射返回 completed/user_stopped，绝不 running |

- [x] 验证同 ID 异参、旧 revision、未知/撤权项目、跨项目线程、缺失/错回合检查点都被拒绝。
- [x] 用 SQLite 触发器在 request receipt 插入前注入 ABORT，证明暂停 snapshot、checkpoint、history 与 request result 一起回滚。
- [x] 两个真实连接并发基于同一 revision Start，最多一个成功；另一方明确 RevisionConflict。重开 running 记录不自改状态，只列为 recovery candidate。
- [x] 使用单独子进程对已提交状态执行未提交 SQLite mutation 后异常退出，再重开检查已提交 revision 与 request result；这是存储崩溃测试，不是实际 App Server crash 验收。

## Task 3：全量回归与交接

- [x] 运行新测试、修改文件 rustfmt、Clippy 与 `node scripts/check-spec-refs.mjs`；不修上一批已注明的无关 gateway.rs 排版。
- [x] 运行 `node scripts/regression/run.mjs`；所有已有 43 项后台 UI 检查必须保持。新 Rust 集成测试自动进入 cargo 全量套件，禁止筛选或跳过来过门。
- [x] 更新验证记录及首批计划的后续链接，受保护新测试文件单独审查；不增加假 UI、假账本或降低验收阈值。
- [ ] 明确暂存本批文件，提交 `feat: persist agent thread checkpoints with atomic request replay`；钩子重新执行 --staged；核对 receipt.index_tree 与提交 tree 一致。

本计划已获“继续”授权按当前任务执行。Runtime 候选、Managed AI 端点/测试钱包仍未提供本批可验证输入，不阻止此存储子批次；完整 Gateway/UI snapshot/cursor gap 与真实 Agent 恢复属于后续真实运行链集成，不在本批冒签。

执行记录：接口缺失的 RED 与 19 项定向 GREEN 已验证；全量 run `a1815b82-a148-4fbc-831d-30591ff3294a` 通过后，合并子进程入口（不计空测试）并整理交接文档。最终候选还会重跑全量门；上方最后一项由提交后的 tree/receipt 核对完成，其结果在交接消息给出，不预填成功。存储层实现不等于整条 P1 运行链完成。
