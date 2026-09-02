# G2-HOST-001 — Product Core Effect Journal / Host Worker 副作用协议

- Owner role: Durable Workflow + Platform Integration
- 平台: macos-15-arm64
- 证据修订: `solution-b-v1`
- 执行器: scripts/poc/gate-2/host-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-2 --fixture G2-HOST-001 --platform macos-15-arm64

## 固定输入

执行器在临时目录构建 Rust Product Core 拥有的 prepare/execute/effect-confirm/commit Journal、隔离 Host Worker、一次性 audience-bound Worker identity、模拟外部副作用注册表、补偿账本与计量账本。

## 阈值

- 正常路径四阶段齐全，计量一次
- execution_unknown 后 reconcile：外部效果已存在则采纳提交，计量仍恰好一次
- execution_unknown 后 reconcile 未发现外部效果则安全重试，外部效果恰好一份
- commit 失败触发补偿：外部效果被撤销且补偿入账
- 同一计量键重试 5 次只扣一次 Credits
- Journal 只能由 Product Core 写入；Host Worker 不取得 Journal/钱包，并拒绝跨 audience 与 identity 重放

## 证据

results.json checks。
