# Agent 状态查询与重同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已确认此范围；沿用当前任务内执行，不另派发任务。

**Goal:** 通过真实 Core Gateway 查询持久 Thread 状态，并提供有序订阅事件、缺口检测和重连 resync。

**Architecture:** 在现有 `Gateway.query` 内增加独立 Agent 状态 projection，复用 `ThreadStore.get`；项目由当前授权 Workspace 派生。订阅是 Core 内有界注册表，受信 Shell 通过 private stdio 拉取事件；一次只读一个 Thread，落后超过一个修订直接 resync，不猜测历史。不接 Renderer UI 或任何执行命令。

**Tech Stack:** 当前锁定 Rust/rusqlite/serde/hmac/sha2，Node 真实 CoreClient 测试；不新增依赖。

**Spec:** CAC `docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md` §3–8；BCRA §5、8；`docs/contracts/v1/ui-query.schema.json`；R-AP-05/07/08、R-SE-09/10、R-WM-10、R-QS-04/10/11。用户本轮已确认“状态查询 + 订阅 + gap/project change/Core restart 必须重读，不开放执行或 AI”。

## Global Constraints

- 只有 `agent.thread_state`，不是完整 AgentTaskThread/账务 snapshot；只输出 project_id、task_thread_id、state、turn、has_state_checkpoint、updated_at。
- 顶层 snapshot_revision 使用真实 Thread revision；查询不推动修订。projection_version 固定 `agent_state:v1`，旧 projection 强制 resync。
- 修订与回合必须在 JavaScript 安全整数范围内；超范围拒绝投影，不做四舍五入或改变存储值。
- 请求不接收可信上下文；params 只有 task_thread_id，禁止自报 project/wallet/grant/actor。项目根身份和 active grant 每次重验，ThreadStore 再在事务中检查 active project。
- Cursor 绑定 Core 实例、scope generation、project/thread 摘要、revision 和 projection，用独立进程随机密钥 HMAC 防篡改；不含路径，不是执行授权。未知 Core 实例/版本只触发重同步，不凭 cursor 返回内容。
- 每个 Gateway 最多 64 个订阅。正常关闭释放；project select/revoke 清空订阅并推进 scope generation；旧 ID 返回 scope_changed。重启旧 ID 返回 core_restarted。
- 订阅每次 poll：相同 revision 返回 None；恰好 +1 返回 subscription.event；跨多个/倒退 revision 返回 cursor_gap 并移除订阅。无事件 replay 队列，不冒充可靠通知或 Worker 流式输出。
- `query.execute` 返回 snapshot + event_cursor；`subscription.open` 接收可选 after_cursor，过期 cursor 返回 resync_required，必须先 query.execute 后重新订阅。
- 只通过现有受认证 private stdio 的 query、subscription_poll、subscription_close 供 Shell 使用。不增加 renderer bridge 白名单或 Public Capability 方法；未来 UI 接入另验 sender/Surface 生命周期与消费显示。
- 不改用户内容、Schema 迁移或 Thread 写入行为；不运行模型、Worker、费用、发布、推送或合并。

## Task 1：真实查询与订阅行为

**Files:** 新建 `crates/product-core/src/protocol/agent_query.rs`（严格请求解析）、`src/gateway/agent_queries.rs`（projection/注册表/调用整合）、`src/gateway/agent_cursor.rs`（不透明签名游标）；小改 `src/protocol.rs`、`src/gateway.rs` 与 `src/workspace/mod.rs`（只将既有 ensure_active 暴露给同 crate）。新增 `tests/agent_queries.rs`。

**Interfaces:**

```rust
// 已有入口新增 query_id，不改变签名。
Gateway::query(&mut self, request: &serde_json::Value) -> Result<serde_json::Value, GatewayError>;
Gateway::poll_agent_subscription(&mut self, id: &str) -> Result<Option<serde_json::Value>, GatewayError>;
Gateway::close_agent_subscription(&mut self, id: &str) -> Result<bool, GatewayError>;
// ThreadStore::get(project_id, thread_id) 为唯一数据读取接口。
```

- [x] 写真实 SQLite fixture 的失败测试，先只调用现有 query 入口，预期因 UnknownQuery 失败：

```rust
let snapshot = gateway.query(&serde_json::json!({
  "protocol_version":1,"message_type":"query.execute","request_id":"request:read",
  "query_id":"agent.thread_state","params":{"task_thread_id":"thread:one"}
})).unwrap();
assert_eq!(snapshot["snapshot_revision"], 1);
assert_eq!(snapshot["payload"]["state"], "ready");
```

- [x] `cargo test --locked --manifest-path crates/product-core/Cargo.toml --test agent_queries` 确认 RED 后实现最小查询；新增 false authority、超长输入、跨项目、撤权和 root identity 失效测试。
- [x] 先写订阅测试再增加接口：初始 snapshot、无变更 None、连续两次 +1、跳跃 resync、重复旧 cursor、Core 重开、project 来回切换/撤权、未知/篡改 cursor、64 项容量和 close 后恢复容量。每项以实际产出/拒绝及数据库不变为断言。
- [x] 实现注册表和签名游标。`after_cursor` 检查在当前访问验证之后；scope/version/boot 不匹配只返回不带业务 payload 的 resync。签名错误拒绝。

## Task 2：受认证传输与机器契约

**Files:** 小改 `crates/product-core/src/transport.rs`；新增 `docs/contracts/v1/product-ui-agent-state.schema.json`、`tests/agent_query_transport.rs` 与 `tests/support/agent_transport.rs`（独立测试进程辅助）。不加产品测试入口。

执行补充：`apps/desktop/tests/agent-query-contract.test.mjs` 从真实 Rust 进程测试读取产出并执行 Ajv 校验，自动进入全量门。复用 `scripts/poc/contract-foundation` 的现有锁文件依赖；`.github/workflows/accepted-feature-regression.yml` 和本地回归说明补上该锁文件安装步骤，不修改 runner、阈值或既有断言。

**Interfaces:** private transport `command={type:"query",request:<QueryRequest|SubscriptionOpen>}` 沿用 Gateway.query；新增 `command={type:"subscription_poll"|"subscription_close",subscription_id:<Identifier>}`，poll 结果为 event 或 null，close 结果 `{closed:boolean}`。返回事件外层继续用现有认证 response；不另开无鉴权端口。

- [x] 写完整真实进程测试：测试夹具先通过 ThreadStore 创建 Thread；启动产品 binary，完成 hello/HMAC，query→subscribe→另一连接写 +1→poll，关闭进程重开→旧 cursor resync→重新 query 仍读到提交状态。只有测试写线程状态，不开放写入命令。
- [x] RED 后把新传输分支接入领域方法：

```rust
"subscription_poll" => Ok((gateway.poll_agent_subscription(id)?.unwrap_or(serde_json::Value::Null), false)),
"subscription_close" => Ok((serde_json::json!({"closed":gateway.close_agent_subscription(id)?}), false)),
```

`id` 必须来自严格闭合结构解析，不接受附加可信字段。
- [x] 新 Schema 约束请求及 payload，复用通用 UI envelope 和权威状态枚举；用现有契约验证工具验证实际 Gateway 产出，不手工造成功 receipt。

## Task 3：回归与交接

- [x] 新文件 scoped rustfmt、Clippy、spec-refs、新 Rust 套件和全量 `node scripts/regression/run.mjs` 通过。保留既有 gateway.rs 测试格式差异，不降低或跳过既有测试。
- [x] 新测试受保护路径单列自审；记录前后台边界、验证 counts、真实进程证据和未接 UI/Runtime/AI 的限制。
- [ ] 更新进度与 `docs/技术可行性/Agent状态查询订阅-本机验收.md`；只暂存本批文件后提交，钩子全量 --staged 回归；提交后核对 index_tree=HEAD tree。系统 P1、LOCAL-02、发布状态不勾选。

基点 `d37c1c6`；前置回归 `da93eaac-59cb-47f1-ad7c-d6871c416239` 通过，当前工作树开始时干净。计划自审：本批只覆盖已确认的状态查询/重同步，非 UI 显示或真实执行/计费；所有新增私有接口在本计划明确，现有公共目录保持不变。

执行记录：Task 1/2 与全量回归已完成，run `9bde39a8-22de-468a-a5e2-6be86f778684` 全量 passed（Rust 77、桌面单元 42、后台 UI 43）。交接文档已整理；最后一项的提交/tree 核验由最终 hook 与交接结果确认，不预填成功。整个 P1 与分支集成仍未完成。
