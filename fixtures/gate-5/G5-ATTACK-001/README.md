# G5-ATTACK-001 — 安全攻击探针

- Owner role: Security
- 平台: macos-15-arm64（本轮；windows-11-x64 端待另行覆盖）
- 证据修订: `solution-b-v1`
- 执行器: scripts/poc/gate-5/attack-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-5 --fixture G5-ATTACK-001 --platform macos-15-arm64
- 状态: 方案 B stub 守卫合同通过；真实 Electron/Rust/Worker 边界渗透与 Windows 探针未执行，因此最多 `CONDITIONAL_GO`

## 固定输入

执行器在临时目录构建 stub 安全守卫（工作区根包含检查、shell/子进程白名单、网络目标白名单、Secret 隔离、Managed AI 门面、内容/指令隔离、Artifact 哈希校验），并对每个守卫发起对应攻击探针。

## 阈值

- 路径穿越（../、绝对路径、符号链接逃逸）全部被工作区根包含策略拦截
- 白名单外 shell 与子进程请求被拒绝
- 白名单外 localhost/DNS/redirect 目标被拒绝，重定向到非白名单主机被拦截
- 用户扩展无法读取 Secret 存储，响应中无 Provider/Key
- 外部 LLM 直连被拒绝，模型访问只能经 Managed AI 门面
- 文档内容中的 Prompt injection 被视为数据，不触发任何特权操作
- 哈希不匹配的恶意 Artifact 被拒绝加载

## 证据

results.json checks 与 artifacts/attack-probes.json。该证据不能替代对签名生产构建的进程边界、Sandbox、IPC、文件和网络攻击测试。
