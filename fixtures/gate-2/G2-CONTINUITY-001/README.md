# G2-CONTINUITY-001 — 结构化事件与 Cursor 恢复

- Owner role: Continuity
- 平台: macos-15-arm64
- 执行器: scripts/poc/gate-2/continuity-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-2 --fixture G2-CONTINUITY-001 --platform macos-15-arm64

## 固定输入

执行器在临时目录构建结构化事件日志、持久化 cursor、项目回顾 proposal/apply 状态机与审计日志。

## 阈值

- 事件带单调 seq，按 cursor 读取只返回增量
- 读取方中途崩溃后从持久化 cursor 恢复，每条事件恰好处理一次
- proposal 首次 apply 成功，重复 apply 被拒绝
- 过期 base revision 的 proposal 被冲突拒绝，rebase 后成功
- proposal/apply/conflict 全部进入审计日志

## 证据

results.json checks。
