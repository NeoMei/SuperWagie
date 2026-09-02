# G1-CRASH-001 — 多文件事务故障注入

- Owner role: Workspace Core
- 平台: macos-15-arm64
- 执行器: scripts/poc/gate-1/crash-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-1 --fixture G1-CRASH-001 --platform macos-15-arm64

## 固定输入

执行器生成的三文件项目与 journal 事务；子进程在 prepared / committing（首个 rename 后）/ committed 三个注入点用 SIGKILL 模拟进程崩溃，另含无崩溃 clean commit。

## 阈值

- 每个注入点重启恢复后，三文件要么全部旧内容、要么全部新内容，绝不出现混合态
- prepared → 回滚；committing → 前滚；committed → 确认并清理 journal
- 恢复幂等：重复恢复不改变内容

## 证据

results.json checks；每个场景的恢复状态记录在 check detail。

## 已知边界

SIGKILL 模拟进程崩溃而非掉电；生产 Rust 实现使用 F_FULLFSYNC/等价语义，掉电级验证由 G6-PACKAGE-001 干净机场景覆盖。
