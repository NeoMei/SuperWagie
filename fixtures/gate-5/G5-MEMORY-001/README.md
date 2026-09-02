# G5-MEMORY-001 — 安全记忆边界

- Owner role: Profile & Safe Memory/Security
- 平台: macos-15-arm64（本轮）
- 执行器: scripts/poc/gate-5/memory-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-5 --fixture G5-MEMORY-001 --platform macos-15-arm64

## 固定输入

执行器在临时目录构建 stub 记忆库（来源标注、同意门、scope 索引、过期时间、删除标记、注入隔离层与审计日志）。

## 阈值

- 每条记忆带来源（user/agent/connector）与时间戳
- 无同意的写入被拒绝且不落盘
- scope 外读取被拒绝，scope 内正常返回
- 过期记忆不出现在读取结果中
- 删除后记忆不可恢复读取，审计记录删除事件
- 含指令样文本的记忆内容按数据返回，不触发动作
- 全部变更（创建/删除/过期清理）进入审计日志

## 证据

results.json checks 与 artifacts/memory-audit.jsonl。
