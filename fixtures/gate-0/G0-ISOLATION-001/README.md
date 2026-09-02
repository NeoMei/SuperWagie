# G0-ISOLATION-001：封闭 Runtime 隔离 PoC

- Gate：gate-0（见 docs/技术可行性/技术验证执行计划.md §6）
- 所有者角色：Desktop Runtime / Security
- 平台：macos-15-arm64、windows-11-x64
- 证据修订：`solution-b-v1`
- 状态：基线采集执行器已实现（固定输入 1：主机干扰源只读清单）；步骤 2–4（Runtime 三场景 zero-diff 对比）待 SuperWagie Runtime 实现后执行，决策预期 CONDITIONAL_GO + limitation 记录

## 固定输入

1. 主机现有 Codex Server、全局 Skills/MCP/配置的探测清单（只读采集，不修改主机环境）；
2. 方案 B 进程拓扑快照：Electron Main、Rust Product Core、私有 App Server、隔离 Worker、签名 Runtime identity、参数、私有通道和缓存路径。

## 步骤

1. 采集 baseline：SuperWagie Runtime 单独启动时的全部快照维度；
2. 在系统 Codex Server 运行中、全局 Skills/MCP/配置变化的三种场景下分别重启 SuperWagie Runtime；
3. 对比每次快照与 baseline 的逐维度差异；
4. 记录 results.json 的 zero-diff 断言结果。

## 指标与阈值

- 全部维度 zero-diff；任何由主机环境变化引起的差异即 fail；
- 端口/stdio 冲突必须以 SuperWagie 私有通道解决，不允许复用系统 Codex 端口。
