# G2-AGENT-001 — 知识工作 Agent 30 题评测

- Owner role: Agent Session / Product Evaluation
- 目标：证明封闭 SuperWagie App Server 经 Managed AI 通道执行长文、PPT 与资料整理任务时，不退化为 Coding-first 助手。
- 当前环境：若没有独立 Agent 评测结果，门禁必须返回 `BLOCKED_ENVIRONMENT/ISOLATED_AGENT_EVALUATION_REQUIRED`；禁止复用当前 Codex Desktop 会话、全局 Codex 配置或本机 Provider 凭据。

## 固定输入

- `tasks.json`：30 个任务，长文、PPT、资料整理各 10 个；
- `source/`：产品自有、可重复分发、无隐私的共享材料；
- 外部评测结果必须绑定 `tasks.json` 的 SHA-256，并为每题提供真实 Artifact 与人工评分。

## 通过标准

- 任务结果恰好覆盖 30 个稳定 ID，每类 10 个；
- 端到端成功不少于 24/30；
- 30 题平均人工评分不少于 4.0/5；
- 越权写入、文件损坏、Provider/Key 泄露、错误跳过 Human Gate 均为 0；
- Runtime 身份必须表明使用封闭 SuperWagie App Server、sealed 配置和 server-side Credential Broker，且全局 Agent 配置访问为 0；
- 每个 Artifact 是评测根内的普通非符号链接文件，SHA-256 与结果清单一致。

## 执行

没有独立评测结果时：

```bash
./scripts/poc/run-gate.sh gate-2 --platform macos-15-arm64 --fixture G2-AGENT-001
```

有评测结果后，通过已有 `--checklist-result` 输入评测 JSON；其相对 Artifact 路径以评测 JSON 所在目录为根解析。
