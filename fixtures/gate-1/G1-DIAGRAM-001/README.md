# G1-DIAGRAM-001 — 原生绘图格式往返与安全

- Owner role: Diagram Platform + Security
- 平台: macos-15-arm64
- 执行器: scripts/poc/gate-1/diagram-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-1 --fixture G1-DIAGRAM-001 --platform macos-15-arm64

## 固定输入

- fixtures/sample.excalidraw / sample.drawio：正常场景（含绑定与箭头）
- fixtures/malicious.excalidraw：javascript: 链接、外部跟踪图、未知元素类型
- fixtures/malicious.drawio：DTD 实体注入（billion laughs 变体）
- 20MB 超限文件由执行器运行时生成，不落仓库

## 阈值

- 原格式往返：结构化命令只改动目标字段，其余字节不变
- .excalidraw.md 容器：场景更新后 markdown 壳字节不变
- Agent 命令层：未知类型/不存在端点被拒绝
- 超限文件在解析前拒绝；恶意 URL 白名单拦截；实体不扩展
- 原子保存 + undo 恢复到原字节

## 证据

results.json checks；安全拦截明细在 check detail。
