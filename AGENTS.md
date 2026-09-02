# SuperWagie 实施路由（对所有 agent 生效）

本文件是防漏看机制的路由层。开始任何实施改动前，先按「改动区域 → 必读」表完整阅读对应规则包与权威规格。规则包是强制清单，不是摘要；每条规则都带可溯源锚点。

## 权威优先级

1. docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md §1 分领域权威表（冲突最终裁决）。
2. CAC §1 分领域列出的全部权威：V1RS、CONTEXT.md、WD §15–24、TASK、ACC、CTX、CONN、BCRA、CAC + `docs/contracts/v1/`、MATRIX 与原型索引（别名表见 rules/README.md）。
3. WD §1–14 为早期摘要，只用于快速定位，不作为实现依据。
4. rules/ 规则包把权威规格压缩为可执行清单，锚点必须始终有效。

## 改动区域 → 必读

| 改动区域 | 必读规则包 | 必读规格 |
|---|---|---|
| Agent 面板 / Composer / 通知 / 执行状态 | rules/agent-panel.md | WD §19、§22；ACC §9；CAC §3–§8；BCRA §5、§8 |
| Markdown 编辑 / 保存 / 冲突 / 目录 | rules/workspace-md.md | WD §5、§6、§17、§18 |
| 任务管理 / Milestone | rules/tasks.md | TASK 全文；WD §16.1 |
| Credits / 钱包 / 消费确认 | rules/credits.md | ACC 全文；WD §22 |
| 界面骨架 / 布局 / 标签 / 异步状态 | rules/ui-shell.md | UIC 全文；WD §15.1；CAC §2.3；BCRA 全文 |
| 交付工作流 / 就绪门 / 引导 | rules/delivery-workflow.md | WD §7、§8、§8.1、§8.6、§12、§15.2；UIC §7；CAC §3–§8；`docs/contracts/v1/human-gates.schema.json` |
| PPT / Word / HTML 交付 | rules/deliverables.md | WD §20.2–20.4、§21.1、§8.4；V1RS §3；TASTE |
| 视频交付 | rules/video.md | WD §8.5、§20.5；BCRA §13 |
| 原生绘图 | rules/drawing.md | WD §9、§21.2；BCRA §6、§13 |
| 封闭 Runtime / 共享系统依赖 | rules/runtime-isolation.md | CAC §2.5；V1RS §2、§3；WD §11.4；BCRA §5、§12 |
| 安全 / 用户扩展 / 凭证 | rules/security-extensions.md | CAC §2.2、§5、§6.4、§9；WD §23.2；ACC §11；BCRA §3、§7、§8、§15 |
| Managed AI / Capability / 版本 | rules/capability-ai.md | V1RS §2；CAC §3、§5、§9；WD §10、§12；ACC §9、§11.3；`docs/contracts/v1/` |
| Connector / 记忆 / 连续性 | rules/sync-memory.md | CONN 全文；CTX 全文；CAC §2.2 |
| Rust 化 / 打包 / 签名 / SBOM | rules/rust-packaging.md | WD §11；V1RS §5；TASTE §2、§7；BCRA §12、§17 |
| 验收 / 测试 / 暂缓 / 范围 | rules/quality-scope.md | WD §10.2、§11.4、§12、§13；V1RS §1、§3、§4、§6；BCRA §18 |
| 全部界面实现 | 命中的规则包 | docs/superpowers/specs/2026-08-29-superwagie-ui-implementation-contract.md |

冲突时以权威优先级第 1 层裁决；仍无法裁决时停下来询问用户，不要自行取舍。

## 完成前自检

1. 触及上表区域的改动，提交前运行 node scripts/check-spec-refs.mjs 并保持通过。
2. 汇报实现时引用规则编号（例如 R-AP-02）说明关键行为依据，便于复核。
3. 规格或需求矩阵更新后，同步评估规则包与别名表是否需要跟着更新，保持锚点有效。
