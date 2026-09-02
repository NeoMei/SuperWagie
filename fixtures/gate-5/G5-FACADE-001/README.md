# G5-FACADE-001 — Public Capability Facade 身份对等

- Owner role: Capability Router
- 平台: macos-15-arm64（本轮）
- 证据修订: `solution-b-v1`
- 执行器: scripts/poc/gate-5/facade-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-5 --fixture G5-FACADE-001 --platform macos-15-arm64
- 状态: 35 个方法名、Gate 分类和 stub 身份等价性已覆盖；payload/result Schema 与真实领域处理器未实现，因此最多 `CONDITIONAL_GO`

## 固定输入

执行器读取 `docs/contracts/v1/public-capability-methods.json` 的完整 V1 目录，构建 stub Public Capability Facade 与两种调用身份（official-agent、user-skill），对每个方法从两种身份执行同一 fixture 调用。

## 阈值

- 两种身份的响应 Schema 完全一致
- 相同写入产生的 Artifact 哈希与 Workspace revision 一致
- 回执结构一致，仅身份字段不同
- 相同错误在两种身份下错误码与结构一致
- 用户 Skill 枚举/读取/启动 Private Workflow 全部被标准错误拒绝
- 用户 Skill 响应中无 Provider/模型/Key/原始协议字段
- ClientIntent 伪造 actor/caller/project/grant/billing/Gate/Audit 上下文在领域处理器前被拒绝
- Human Gate 决定、Private Workflow 和调用方自带 Gate Receipt 均不属于公开方法

## 证据

results.json checks 与 artifacts/facade-parity.json。只有预留 Schema ID 和模拟结果形状不能签署 Facade `GO`。
