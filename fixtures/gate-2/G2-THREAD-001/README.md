# G2-THREAD-001 — Thread 状态机与恢复

- Owner role: Agent Session
- 平台: macos-15-arm64
- 证据修订: `solution-b-v1`
- 执行器: scripts/poc/gate-2/thread-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-2 --fixture G2-THREAD-001 --platform macos-15-arm64

## 固定输入

执行器在临时目录构建九态 Thread 状态机（ready/running/awaiting_user/user_stopped/credits_blocked/disconnected/recoverable_failed/completed/archived）、checkpoint、Artifact 注册表、Session Credits 账本与离线队列。

## 阈值

- 九个状态全部覆盖，转移符合状态表
- checkpoint 后 kill/restore：状态、Session Credits、Artifact 数量一致，无重复 Artifact
- stop/resume 后重试同一操作产生零新增 Artifact
- kill/restart 后 Session Credits 不清零；新 Session 从 0 开始
- Credits 不足进入 credits_blocked，充值后恢复且只扣一次
- 断网队列 flush 一次全部送达，重复 flush 零投递
- archived 拒绝新操作；显式恢复回到归档前的 completed 或 user_stopped

## 证据

results.json checks。
