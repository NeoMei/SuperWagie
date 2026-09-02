# G1-TASK-001 — 任务三来源与 Milestone 幂等

- Owner role: Project & Task + Markdown Engine
- 平台: macos-15-arm64
- 执行器: scripts/poc/gate-1/task-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-1 --fixture G1-TASK-001 --platform macos-15-arm64

## 固定输入

执行器在临时项目生成的 任务.md 与 .superwagie/task-store.json：三个已确认 Milestone、手动任务、Agent 任务、外部 Obsidian 编辑样本、重规划与删除事件序列。

## 阈值

- 三 Milestone 各重放 10 次（每次唯一 request ID、每轮全量重启扫描）后仍只有 3 个活跃自动任务
- 内部 Workflow Stage 事件生成 0 个任务
- user_overrides 在重规划重放后保留；tombstone 阻止重建，恢复使用同一 task_id
- 只读扫描不写文件；外部新增任务仅在写事件时惰性获得稳定 ID
- 重启 10 轮后 任务.md 字节稳定；过期 revision 提交被拒并可按块 ID 重定位
- 任务完成与 Thread 停止状态分离

## 证据

results.json checks；最终 任务.md 与 task-store.json 快照落 artifacts。
