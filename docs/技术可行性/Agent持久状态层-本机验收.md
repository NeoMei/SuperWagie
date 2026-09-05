# Agent 持久状态层：本机验证

日期：2026-09-05。基点 `7ff6d28`，工作分支 `codex/agent-foundation-first-batch`。实测 macOS 26.6.2 / 25G83 / arm64；本记录仅覆盖 P1.1 的本地存储子批次，不是 LOCAL-02、真实 Agent 或发布 GO。

## 实现范围

- Core `ThreadStore` 保存九状态 Thread、回合身份、归档来源与状态检查点；暂停继续原回合，完成后 Start 开新回合（R-AP-05/07/08）。
- 每次写入在 IMMEDIATE 事务中同时提交 snapshot、history 和 request result；同项目同请求同参数返回原结果，异参拒绝，旧 revision 拒绝。
- 当前项目的 active 登记检查先于去重查询；撤权后的请求不能凭旧缓存成功。此检查是内部存储最低边界，不替代 Gateway 身份、root grant、Lease 或消费授权。
- 复用 App Data `operational.sqlite3`，只添加 Agent namespace 表，不改 Workspace 表结构或用户 Markdown。未开放 IPC、Public Facade 或 Renderer 命令。
- 重开只加载已提交状态；running 记录列为 recovery candidates，不自动改状态、调用 Worker 或重放操作。检查点只有状态修订和回合，不含工具/模型上下文，不是 Runtime 恢复令牌。

实现文件见 `crates/product-core/src/agent/thread.rs`、`src/store/threads.rs`、`src/store/agent_migration.rs`。无新增依赖。

## 测试证据与限制

首批 13 项测试在接口实现前执行，因缺少实际导出报 E0432；实现后全部通过。随后补充迁移、异常退出及并发等边界，最终定向套件 **19 项行为测试通过**。子进程入口合并进实际退出测试，不作为额外的空通过项计数。

| 测试类别 | 实际证明 |
|---|---|
| 创建/重开/请求重放 | 重开后保留最新状态；重放旧请求返回其原结果而非最新状态 |
| 五类暂停/继续/新回合 | checkpoint 与暂停同事务；继续保留 turn；完成后另开 turn |
| 归档/恢复 | ready、completed、user_stopped 来源按契约恢复，不隐式运行；历史保留 |
| CAS/去重并发 | 两连接竞争同修订仅一个写入；相同请求并发只产生一个事件 |
| 撤权/跨项目/无效输入 | 拒绝失效项目、跨项目读取或占用身份、非法 ID 与溢出 revision |
| 错误检查点/损坏修订 | 缺失、错回合、标识变化拒绝继续；snapshot/列修订不一致拒绝读取/变更 |
| 事务故障 | request receipt 插入前触发 SQLite ABORT，状态、检查点和历史一起回滚；同请求可重试 |
| 进程异常退出 | 独立测试子进程修改未提交事务后 exit(91)，绕过析构；重开只见原提交与原请求结果 |
| Schema 迁移 | 旧文档与持久草稿保留，备份可打开且 0600；重复 open 不重复迁移；高版本拒绝降级；中途 DDL 失败回滚 |

异常退出案例使用真实文件 SQLite 和已提交 Thread，但未在真实 App Server 执行中杀 Worker，也没有模拟财务结算；不能外推为断电、工具副作用或真实 Agent 恢复验收（R-QS-04）。

验证命令：

```sh
cargo test --locked --manifest-path crates/product-core/Cargo.toml --test agent_store
rustfmt --check --edition 2024 crates/product-core/src/agent/thread.rs crates/product-core/src/store/agent_migration.rs crates/product-core/src/store/threads.rs crates/product-core/tests/agent_store.rs
node scripts/regression/run.mjs
```

实现前全量基线 `a2b9d336-e82d-429c-b2cb-9caba750cc66` 通过。实现后的全量 run `a1815b82-a148-4fbc-831d-30591ff3294a` 通过；该 run 之后仅合并测试子进程入口与整理交接文档，因此它不是最终提交回执。

最终候选仍须通过全量门：Rust 62 项（既有 43 + 新增 19）、桌面单元 41 项、生命周期 12 项、Live Preview 17 项、格式工具栏 14 项，另含门禁自测、规格引用检查、Clippy 和构建。**最终提交 SHA/run_id 在交接中给出，并校验提交 tree 等于钩子新回执 index_tree**，避免文档自身 SHA 循环引用。没有降低测试数、跳过旧检查或修改 registry。

UI 继续使用真实 Electron 的隐藏、不可获取原生焦点窗口。后台回归不代表原生前台、输入法、视觉对照或 Obsidian 最终体验验收（R-QS-10/11）。既有 `tests/gateway.rs` 全仓 rustfmt 差异维持原状，仅声明本批新文件格式检查通过。

## 迁移与人工恢复

首次打开 Agent 存储前在 App Data 新建独占 0700 目录 `agent-pre-v1-<pid>-<nonce>`，0600 的 `snapshot.sqlite3` 由 SQLite `VACUUM INTO` 生成。完整性检查和同步成功后才开始原子 DDL，成功版本表登记备份路径。其一致性快照及中断限制依据 [SQLite 官方说明](https://www.sqlite.org/lang_vacuum.html)。

迁移失败保持原库，不自动覆盖；未登记的残留快照不能视作成功备份。未来 namespace 版本拒绝打开，不试图降级。已迁移库可保留旧 Workspace 数据，但旧代码不具备 Agent 功能。

人工恢复必须先停所有使用该库的 Core，再保留当前库及 WAL/SHM、核对候选备份的完整性和时间点，另行确定恢复方案。**不能将迁移前快照直接自动覆盖当前库**：快照不含迁移后的新草稿、状态或其他提交。本批没有用户可用的备份管理/还原 UI，也未执行任何真实用户数据库迁移。

## 自审与后续

本批受保护路径仅新增 `crates/product-core/tests/agent_store.rs`：测试只使用带归属标记的独立临时目录，故障 SQL 和 exit 入口不进入产品；无 ignored/筛选后冒充全量、无生产测试开关。已逐项核对断言和真实数据库结果；不是独立第三方审查。

P1.1 仍有真实运行时 Checkpoint 的整合义务，不勾选整项。下一步冻结 Gateway 命令/查询、snapshot/cursor gap 与 Runtime 私有握手契约，再按可用的固定 App Server 制品推进。真实 Managed AI、Broker、测试钱包及费用范围缺口沿用 [首批输入清单](Agent首批基础-本机验收.md)，不得借宿主 Codex 凭据或假账本补齐。服务依赖不阻止继续无服务的本地实现，但限制真实 Agent 闭环结论。
