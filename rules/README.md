# 规则包（防漏看机制 · 第一层）

本目录是面向实施的强制清单，不是设计摘要。任何 agent / 子 agent 在修改对应模块前，必须先完整阅读命中的规则包，再按仓库根 AGENTS.md 的路由表回到权威规格核对细节。

- 每条规则格式：R-<模块>-NN + 规则正文 + 方括号锚点（如 [WD §19.1]）+ 相关矩阵需求 ID（如 WF-10）。
- 锚点指向权威规格的真实章节；矩阵 ID 指向 docs/技术可行性/技术要求矩阵.md 的需求行。
- 冲突裁决：以 docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md §1 的分领域权威表为准；WD §1–14 是摘要，§15–24 是权威。

## 规格别名表

校验脚本 scripts/check-spec-refs.mjs 按以下行解析别名，格式必须保持为“- 别名 = 路径”：

- WD = docs/superpowers/specs/2026-08-28-superwagie-workspace-delivery-design.md
- TASK = docs/superpowers/specs/2026-08-29-superwagie-task-management-design.md
- ACC = docs/superpowers/specs/2026-08-29-superwagie-account-credits-organization-design.md
- CAC = docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md
- MATRIX = docs/技术可行性/技术要求矩阵.md
- UIC = docs/superpowers/specs/2026-08-29-superwagie-ui-implementation-contract.md
- CONN = docs/superpowers/specs/2026-08-29-superwagie-connector-sync-design.md
- CTX = docs/superpowers/specs/2026-08-29-superwagie-continuity-profile-memory-design.md
- TASTE = docs/superpowers/specs/2026-08-29-superwagie-html-taste-capability-design.md
- V1RS = docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md
- BCRA = docs/superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md

## 规则包清单

| 文件 | 覆盖模块 | 路由触发词 |
|---|---|---|
| agent-panel.md | Agent 面板、Composer、通知、恢复状态机 | agent、composer、通知、checkpoint、credits 显示 |
| workspace-md.md | Markdown 编辑、保存、冲突、目录结构 | 编辑器、保存、冲突、目录、Obsidian 兼容 |
| tasks.md | 任务管理模块 | 任务、Task、Milestone、任务.md |
| credits.md | Credits、钱包、消费确认 | credits、钱包、充值、余额 |
| ui-shell.md | 界面骨架、布局、标签、快捷键、异步状态、视觉 token | 界面、布局、标签页、快捷键、View ID |
| delivery-workflow.md | 交付工作流、就绪门、引导、检查点 | 交付、引导、就绪门、Content Baseline、Workflow |
| deliverables.md | PPT、Word、HTML 三类交付物闭环 | PPT、Word、HTML、SuperPPT、SuperWriter、Taste、Host |
| video.md | 视频交付五场景八阶段 | 视频、样片、剪辑、合成、Remotion |
| drawing.md | Excalidraw 与 draw.io 原生绘图 | Excalidraw、draw.io、绘图 |
| runtime-isolation.md | 封闭 Agent Runtime 与共享系统依赖 | Runtime、隔离、依赖、feature probe |
| security-extensions.md | 用户扩展、进程隔离、凭证边界 | 扩展、Skill 安装、MCP、沙箱、凭证 |
| capability-ai.md | Managed AI、Capability Contract、两阶段产品化 | AI、模型、Capability、私有化、版本 |
| sync-memory.md | AgentWiki Connector、项目记忆、连续性 | AgentWiki、同步、记忆、SessionReviewer、Profile |
| rust-packaging.md | Rust 迁移、打包、签名、SBOM | Rust、打包、签名、升级、SBOM |
| quality-scope.md | 验收基线、暂缓纪律、范围变更 | 验收、测试、暂缓、fallback、范围 |

## 覆盖率政策

- 运行 node scripts/check-spec-refs.mjs 校验所有锚点与矩阵 ID，必须保持通过。
- 运行 node scripts/check-spec-refs.mjs --coverage 列出尚未被任何规则包引用的矩阵需求（信息性输出，不作为失败）。
- 新增需求行进入矩阵时，应同步评估是否补入对应规则包，保持锚点有效。
