# G2-WORKFLOW-001 — 三阶段 Workflow 与局部失效

- Owner role: Durable Workflow
- 平台: macos-15-arm64
- 证据修订: `solution-b-v1`
- 执行器: scripts/poc/gate-2/workflow-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-2 --fixture G2-WORKFLOW-001 --platform macos-15-arm64

## 固定输入

执行器在临时目录构建 stub Workflow：draft → (summary ∥ review) → export，依赖按内容 revision 追踪，并分别验证 Workflow Gate、四类 Risk Gate 与 Install Gate 的候选/动作/范围/清单绑定、有效期和恢复。

## 阈值

- 首次全量执行各阶段恰好一次
- 无匹配 Workflow Gate Receipt 时 export 被阻止；候选或 revision 改变后旧回执失效
- 四类 Risk Gate 的 kind/action/scope 任一变化均拒绝，Install Gate 的 manifest/permissions 任一变化均拒绝
- 修改 summary 分支后：summary 重跑、export 重跑、review 复用零执行（影响范围精确）
- export 失败重试只重跑 export，上游阶段执行计数不变
- 中途 kill/restart 后从断点继续，已完成阶段不重跑
- 过期 gate 与错误 schema_version 的批准均被拒绝

## 证据

results.json checks。
