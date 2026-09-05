# 超级牛马（SuperWagie）

以本地内容为事实源、由 Agent 协助加工内容并生成多种交付物的桌面工作系统。

本仓库已积累多轮技术验证，当前优先进入 MacBook 本机垂直切片开发与集成；现有规格、PoC 与证据不等于完整产品已实现。

## 入口

- 领域词汇与对象边界：[CONTEXT.md](CONTEXT.md)
- 实施路由与规则包：[AGENTS.md](AGENTS.md)
- 技术可行性总入口：[docs/技术可行性/README.md](docs/技术可行性/README.md)
- 当前机器权威验证状态：[docs/技术可行性/当前技术验证状态.json](docs/技术可行性/当前技术验证状态.json)
- 编码准入与契约：[docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md](docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md)
- Windows 11 x64 验证交接：[docs/技术可行性/Windows11-x64-验证交接清单.md](docs/技术可行性/Windows11-x64-验证交接清单.md)

## 状态

2026-09-05 起优先在当前 MacBook 跑通整个项目。Windows 和其他 macOS 版本适配单列后续任务，不再阻止本机开发；V1 双平台发布要求不变。完整分类见 [本机优先验证任务](docs/技术可行性/当前MacBook优先-验证任务分流.md)，开发准入见 CAC §14.1。

当前 37 项验证为 11 GO、12 CONDITIONAL_GO、9 BLOCKED_ENVIRONMENT、5 RESEARCH_REQUIRED，0 signed GO；Windows 既有 20 个父 fixture 有受审运行观察。剩余项不只涉及平台：Viewer、真实 Agent/服务与产品集成仍须完成。机器 Production Implementation Admission 仍为 `NO_GO`，与“允许本机开发”分别记录。
