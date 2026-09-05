# Agent 状态查询与订阅：本机验收边界

2026-09-05；基点 `d37c1c6`，分支 `codex/agent-foundation-first-batch`。实测 macOS 26.6.2 / arm64。用户已确认本批范围为真实状态查询、有序订阅、缺口/项目切换/Core 重启后重读，不开放执行、Runtime 或 AI。

## 本批实现

- `Gateway.query` 增加 `agent.thread_state`，`query.execute` 返回真实持久 revision、状态、回合和状态检查点存在性。项目由当前 Workspace 派生，查询不修改 Thread，也不返回数据库路径、检查点明细、钱包或执行权限（R-AP-05/08、R-SE-10）。
- `subscription.open` 返回 snapshot、签名 cursor 和 subscription ID；私有传输 `subscription_poll` 返回一个事件或 null，`subscription_close` 释放订阅。最多 64 项，项目切换/撤权主动清空。
- 仅 revision 恰好递增 1 时发送状态事件；跳跃或倒退要求 `cursor_gap → query.execute`。不猜测中间状态，不自动重放执行；旧 projection、Core 实例或项目作用域分别返回 projection_changed/core_restarted/scope_changed（CAC §5、BCRA §8.2、R-AP-07）。
- Cursor 绑定独立进程随机密钥、Core 实例、scope generation、project/thread 摘要、revision 和 projection；签名验证不通过即拒绝。未知实例/版本仅作为 resync 提示，不提供任何访问权。
- 查询和有效订阅读取都重验 active grant 与目录身份；存储层在事务中再验 active project。调用方自报项目、身份、权限或钱包被拒绝；传输 query 和订阅控制结构也禁止附加可信字段（R-SE-09/10、R-WM-10）。
- 投影 revision/turn 限于 JavaScript 安全整数范围，超范围拒绝，不舍入、不改存储。新增 `product-ui-agent-state.schema.json` 复用通用 UI envelope 与权威九状态枚举。

## 实际证据

先写 query 测试得到 `Protocol(UnknownQuery)`；订阅接口未定义时得到 E0599；真实子进程在尚未接入 poll 时得到 `SW_GATEWAY_INVALID_REQUEST`。另以 RED 测试捕获超大修订未拒绝，以及传输 query 外层此前忽略 actor_context 的问题，修复后 GREEN。

| 层级 | 验证结果 |
|---|---|
| 新 Core 集成 | 14 项：真实修订/白名单 payload、连续事件/静默、gap、旧 cursor、Core 重开、撤权、项目来回切换、根身份替换、容量/关闭、假上下文/超长输入、篡改/旧版本、整数上限、跨 Thread cursor、畸形输入 |
| 新真实进程 | 1 项：实际产品 binary + HMAC 握手/响应校验，query→subscribe→另连接写入→poll→close，杀掉测试所属 Core 后重开，旧 cursor resync，新 snapshot 仍读到 committed revision |
| 新机器契约 | 1 项桌面测试：从上述真实进程收集 8 个请求/结果，用既有 Ajv 验证器校验；假权限、非法状态和额外路径字段均拒绝 |
| 全量回归 | `9bde39a8-22de-468a-a5e2-6be86f778684` passed：Rust 77 项、桌面单元 42 项、生命周期 12 项、Live Preview 17 项、工具栏 14 项；另含门禁自测、Clippy、Core 构建和规格引用检查 |

本批修改/新增 Rust 文件 scoped rustfmt 与 `git diff --check` 通过。既有 `tests/gateway.rs` 格式差异未动；不声明全仓 `cargo fmt --check` 通过。

上表全量回归之后只整理交接文档和计划状态。最终提交仍由 hook 全量 `--staged` 新运行验收，交接中报告实际 SHA/run_id 并核对 `receipt.index_tree == HEAD^{tree}`；不把上表 run 冒充最终提交回执。

## 受保护变更自审

新增 `tests/agent_queries.rs`、`tests/agent_query_transport.rs`、`tests/support/agent_transport.rs` 和桌面 `agent-query-contract.test.mjs`。测试只使用有归属标记的临时 Workspace/App Data；子进程固定为本仓构建的产品 Core、清空继承环境、校验响应 MAC、有限超时，退出只终止自身 child。不存在生产测试入口、模型调用或测试用假业务结果。

CI 与《已验收功能与回归保护》补装既有 `scripts/poc/contract-foundation` 锁定依赖；不改包版本、runner、registry、阈值或旧断言。CI 配置尚未远端执行，本机已有依赖的验证不能冒充全新 CI 环境通过。此处为当前任务逐文件自审，不是独立第三方验收。

## 尚未证明与下一步

- 这是 **Core/Shell 查询协议的可用实现**，尚未把 Agent 面板接到新 API；renderer bridge 白名单保持原样。订阅事件由受信 Shell 按需拉取，不是后台自动推送或模型 token 流。
- 未实现完整 AgentTaskThread/Session Credits UI projection、真实 Runtime checkpoint/effect receipt、Worker 监管或 AI/财务闭环。running 是存储观察，不据此自动继续、重试或收取费用。
- 后台真实 Electron 回归没有抢占原生焦点；不代表前台输入法/视觉/Obsidian 对照验收。真实进程测试不等于机器断电或真实 AI 执行恢复（R-QS-04/10/11）。
- 未迁移真实用户数据库，未触发网络服务、发布、推送或合并；LOCAL-02、系统 P1 与发布准入不更新为通过。

下一批可接 Agent 面板的只读状态消费：生成窄 IPC、sender/Surface 绑定、订阅关闭、resync 时清空旧状态并重读；保持 Composer 执行与计费不可用，直到专有 Runtime 和真实服务具备独立验证输入。
