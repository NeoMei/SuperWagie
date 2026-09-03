# 技术可行性 05：内置能力逐项适配、PPT、Word、HTML 与 WPS

> 状态：第一轮核查与部分 macOS PoC 已完成；自有 PresentationService 结构子验证已通过，SuperPPT 当前候选实现仍为 NO_GO，等待接入后重跑完整组合 PoC  
> 日期：2026-09-01  
> 范围：全部已指定内置能力，以及 `PPT-01`～`PPT-05`、`DOC-01`～`DOC-05`、`HTML-01`～`HTML-02`（DOC-04/05 为后补的 WPS Review 项，状态 RESEARCH_REQUIRED）  
> 调查快照：2026-08-28。GitHub 状态会变化，进入发行前必须重新生成相同清单。

## 1. 总结论

指定能力整体可以进入 SuperWagie，但不能采用“把所有仓库一起塞进客户端并照原方式运行”的方案。它们实际属于五种不同执行形态：

```text
Rust Core / Wasm
├── Workspace、事务、索引、稳定 ID、DAG、验证器
├── SessionReviewer 确定性内核（迁移候选）
└── AgentWiki sync protocol / merge（迁移候选）

Private Durable Workflow
├── SuperPPT
├── SuperWriter
└── codex-roundtable

Restricted Worker
├── ai-image-to-ppt（首阶段 Python）
├── image-to-editable-pptx（首阶段 Node/TypeScript）
└── 必要的 Office/图片确定性处理

Native WebView Module
├── Excalidraw
├── draw.io
├── 统一工作台任务/日历视图
└── 项目回顾/演化视图

Host Worker / Connector
├── WPSComposer COM / macOS JSAPI
├── WPS/PowerPoint 真实验收
├── AgentWiki remote connector
└── Official Publisher API
```

十项 PPT/文档/HTML 要求仍有明确实现路径，但 2026-09-01 的 Gate 3 实证表明，
“架构路径可行”不能等同于“当前候选实现可进入产品”。当前结论仍为
`FEASIBLE_CONDITIONAL`，且 SuperPPT 候选实现为明确 `NO_GO`：

- SuperPPT 已有本地候选代码，但 deck builder 直接引用 `@oai/artifact-tool`，测试脚本默认寻找 `codex-primary-runtime`；这违反 SuperWagie 不依赖 Codex Desktop 的封闭 Runtime 边界；
- 混合图片页/可编辑页已完成一个与 Codex Runtime 解耦的自有 assembler 结构子验证，但还没有接入统一 `SlideArtifact`、SuperPPT 七阶段 Workflow 和真实 Host；
- WPSComposer 的 macOS 路径当前支持生成和 PDF 转换，但完整 inspect/edit 仍主要依赖 Windows COM；
- HTML 已有固定 Taste 快照与离线站点 fixture，发布目标锁定为 Official Host；Host 生命周期仍待官网测试环境；
- 许可证、依赖锁定和跨平台真实验收仍是发行门。

### 1.1 不需要照搬的部分

- 不保留用户自行配置 Provider API Key 的路径；全部改走 Managed AI Facade；
- 不保留向 `~/.codex`、`~/.agents`、OpenCode 或 Obsidian 安装插件的逻辑；
- 不把 Obsidian Plugin API 当作 SuperWagie Runtime；
- 不让 Skill 自己发现宿主工具、全局环境和相邻仓库；
- 不让每个 PPT 工具各自管理同一交付目录的 ownership/事务；
- 不把单页 PPTX ZIP 直接拼成整套 PPTX；
- 不把明文 Prompt/`SKILL.md` 作为生产能力发行格式。

## 2. GitHub 与本地设计快照

### 2.1 当前公开仓库

| 能力 | GitHub 主语言 | 当前公开许可证据 | 当前主要形态 | SuperWagie 判断 |
|---|---|---|---|---|
| SessionReviewer | Go | Apache-2.0 + NOTICE | CLI/Skill/Obsidian companion | 可复用，优先做 Rust/Wasm 差分迁移 |
| ai-image-to-ppt | Python | MIT | Skill + 图片/导出脚本 | 可复用为 versioned Capability |
| SuperWriter | Shell（实际以 Skill/文档契约为主） | GitHub 根目录无 LICENSE | 分阶段 Skill | 先确认权属/贡献，再封装 Private Workflow |
| agentwiki-sync | TypeScript | 当前 GitHub 根目录无 LICENSE；本地 checkout 有 MIT，但不能视作远端发行证据 | Obsidian sync adapter | 只复用明确 MIT 的 protocol/package 或补齐根许可 |
| image-to-editable-pptx | TypeScript | MIT | Node pipeline | 可复用为 Restricted Worker |
| AgentWiki | TypeScript | 根仓库无 LICENSE；sync-protocol/local-sync 子包各有 MIT | 远程 Web 服务 | 不嵌入完整服务，只做 Connector |
| obsidian-excalidraw | JavaScript/Python | MIT | Skill + Excalidraw renderer | 文件协议/生成逻辑可复用，编辑器原生化 |
| WPSComposer | Python | `pyproject.toml` 声明 MIT，但 GitHub 根目录无 LICENSE | Python ABI + COM/JSAPI | 补齐 LICENSE/NOTICE 后进入 Host Worker Plane |
| codex-roundtable | Prompt/design | GitHub 根目录无 LICENSE | Skill 设计 | 作为行为规格重建 Private Workflow |
| agentsoul | JavaScript | README 声明 MIT，但 GitHub 根目录无 LICENSE | OpenCode wrapper/plugin | 不嵌入 wrapper；原生重做 Profile/Safe Memory |

GitHub API 在调查时显示这些仓库均为 `NeoMei` 下公开仓库，最近 push 日期介于 2026-06-24 和 2026-08-28。许可证结论以仓库实际文件为准，不能只看作者相同、README 文案或 GitHub API 的 `NOASSERTION`。

### 2.2 未公开能力

SuperPPT 尚未发布到 GitHub。本机在 2026-09-01 已存在候选 worktree
`codex/superppt-local-full-deck@8053e7611faa5e30ac9ecdf1e920d9dc12c052cc`，
但它仍不是可发行能力：

- 已确认的产品与架构设计；
- 可构建的 Node/TypeScript 候选、测试和 Skill manifest；
- deck builder 直接加载 `@oai/artifact-tool`；
- 测试默认依赖 Codex workspace runtime；在隔离 HOME/XDG_CACHE_HOME 下没有显式
  `RUNTIME_NODE`、`RUNTIME_NODE_MODULES`、`RUNTIME_BIN_DIR` 就失败；
- 没有完成 SuperWagie 自有 assembler、七阶段真实流程、三个人工门和真实 WPS smoke。

当前 Gate 证据为 `evidence/gate-3/20260901T073138Z-33631/results.json`。因此只确认
业务 Workflow 和组合方向可行，不把当前候选列为 `PROVEN_EXISTING`，也不得把
Codex workspace runtime 或 `@oai/artifact-tool` 打入产品。

2026-09-01 又在 SuperWagie 仓库内完成了独立的 `PresentationService` 结构子验证：
固定并锁定 `pptxgenjs@4.0.1`，在不引用 `@oai/artifact-tool`、Codex package、cache、
配置、服务或 Runtime 环境变量的生成代码中，一次性构建 3 页 16:9 PPTX（图片页、
带原生可编辑标题对象的页面、重新生图页）。单元测试 8/8、PPTX ZIP 完整性、
3 页全量渲染和画布溢出检查均通过，产物与源码/lockfile 都由 SHA-256 绑定。证据为
`evidence/gate-3/presentation-service-spike-20260901T091243Z/results.json` 与同目录
`visual-qa.json`、`blur-root-cause.json`、`dependency-security-audit.json`。用户发现的预览模糊不是
预览器或 PptxGenJS 压缩造成：旧验证误用 800×156 的 Markdown 行内图作为整页图，
原始字节未被降采样，却被不等比例拉伸到 16:9。现在 `PresentationService` 在发布前硬性拒绝
低于 1920×1080 或偏离 16:9 的整页 PNG/JPEG，新的 1920×1080 确定性图片经 1600×900
逐页渲染人工检查未观察到模糊或比例失真。这是 `PPT-04` assembler 路径的 `PROVEN_POC` 子结论，不是
`G3-PPT-001` 的替代证据；实际 SuperPPT 候选、七阶段/三个人工门、局部失效、
Signed Runtime Image、macOS/Windows 双平台以及真实 WPS/PowerPoint 父 fixture 均未因此通过。
依赖审计还发现 PptxGenJS 的开发安装闭包含 `image-size@1.2.1`，命中两个当前无修复
版本的 High 级拒绝服务公告。随后完成的 `G3-PPT-RUNTIME-BUNDLE-SPIKE-001` 已把
PresentationService 构建为 713,831 字节的单文件 ESM Runtime 候选：构建 metafile 与
14 项可达组件 SBOM 均不含 `image-size`，生成完整第三方 NOTICE，并在无 `node_modules`、
隔离 HOME/XDG cache、受限 PATH 的临时目录成功生成同一 3 页 PPTX；全页渲染哈希与
未 bundle 版本逐页一致。证据为
`evidence/gate-3/presentation-runtime-bundle-20260901T091243Z/`。这证明“构建时保留
上游锁与许可、发行时只携带审计后的可达 bundle”路径可行；但执行使用的仍是开发机
Node，不是签名 Runtime Image，完整开发 lock 的 npm audit 也仍报告该不可达依赖，
所以正式发行还必须做 build/runtime 双 SBOM、安全裁决、签名、公证和双平台干净机验收。

`G3-PPT-WPS-MACOS-SMOKE-001` 已在当前真实 WPS 12.1.28492 中对上述 bundle
产物完成单平台子操作：分别取得第 1/3 页窗口证据，可编辑标题可选中修改，撤销恢复，
保存重开保留 `TITLE SAVED`，放弃重开恢复 `TITLE EDIT` 且哈希不变。机器验证同时绑定
固定 WPS 路径、codesign/TeamIdentifier/可执行哈希/运行进程，并校验截图解码、PPTX CRC、
精确三页和关系顺序；人工 UI 语义未绑定所有者签署，因此当前为 `CONDITIONAL_GO`。
证据在 `evidence/gate-3/20260901T111904Z-19860/`。这只证明当前 bundle 产物的
macOS WPS 兼容性；实际 SuperPPT 集成、七阶段/三人工门、局部失效、
Signed Runtime 和 Windows WPS/PowerPoint 仍是 `G3-PPT-001` 的硬阻塞项。

### 2.3 许可证发行门

发行前对每个能力执行：

1. 确认仓库版权主体与产品发行主体的授权关系；
2. 审计外部贡献者和代码来源；
3. 根目录提供正式 LICENSE；
4. 第三方依赖生成 SPDX/CycloneDX SBOM；
5. 聚合 NOTICE、字体、模型、模板和媒体资产许可；
6. Private Capability 包仍包含应随二进制分发的许可证文本；
7. 不因代码编译或加密而省略开源义务。

## 3. 每项能力的适配结论

### 3.1 SuperPPT

**现有证据**

本地设计和候选实现已经定义：

- 输入为主题、粘贴文本或 Markdown；
- 人工门为整套大纲、逐页描述、代表性风格样页；
- 默认高保真图片页，用户点名的页面再做可编辑重建；
- 稳定 page ID、上游 revision、局部失效、失败页重试和旧版本保留；
- 依赖 ai-image-to-ppt 与 image-to-editable-pptx；
- 输出 PPTX、PDF、最终渲染图、项目状态和验收清单。

SuperPPT 已用 SuperWagie 自有 `PresentationService` 替换 Codex 专用
artifact runtime；候选代码与门禁已通过脱耦、OOXML 语义、原子发布和三页混合
PPTX 子验证。因此原先的 Codex 耦合 `NO_GO` 已解除。

当前权威状态是 `BLOCKED_ENVIRONMENT / REAL_PPT_EVALUATION_REQUIRED`：尚需在
macOS/Windows 完成七阶段、三个 Human Gate、局部失效、Signed Runtime 与真实
WPS/PowerPoint 验收。这些是外部环境证据缺口，不得回退为 Codex 耦合结论。

**落地形态**

`Private Durable Workflow`，不直接操作 Provider、文件系统或 WPS：

```text
ContentBaseline
→ OutlineRevision [human gate]
→ PagePlanRevision [human gate]
→ StyleRecipe + Sample [human gate]
→ SlideImage Requests
→ optional Editable Reconstruction
→ Deck Assembly
→ Render / Visual QA / Real Host Smoke
→ DeliveryRevision
```

**必须修改**

- `superppt.json` 降为人类可导出的 projection，权威状态进入 Workflow event log；
- 模型、Provider 和 Key 从项目业务状态移除，仅在内部 receipt 中记录不可见 route ID；
- 依赖从“相邻 Skill 路径发现”改为 Capability version negotiation；
- 所有图片、页面和 deck 使用 Artifact refs；
- 三个人工门改为声明式 `InteractionSpec`；
- 组装必须消费统一 `SlideArtifact`，不能消费任意临时 PPTX。
- 用 SuperWagie 自有 `PresentationService` 或经审计的 OOXML adapter 替换
  `@oai/artifact-tool`；若仍需 Node，只使用 Signed Runtime Image 中由 Runtime Manifest
  固定的 Node，不得寻找系统/用户 Node、Codex Desktop package、cache、配置或 workspace runtime。

**风险/PoC**

- 当前 Gate 3 为 `NO_GO`，解耦完成前停止把候选 deck builder 作为生产实现；
- 自有 assembler 结构子验证已通过；下一步必须把该边界接入实际 SuperPPT 候选，而不是把 spike 目录直接当生产模块；
- 解耦后必须在隔离 HOME/XDG cache、未安装 Codex Desktop 的机器重跑；
- 再执行 3 页混合 fixture、七阶段/三人工门、局部失效、kill/restart 和真实 WPS smoke；

- 当前候选代码不能进入产品；解耦后必须先完成最小 3 页 Workflow Spike；
- 修改上游后只失效受影响页面；
- 一页可编辑、一页重新生图、一页保持图片，重组后页序/渲染/哈希一致；
- kill/restart 后恢复到准确人工门。

### 3.2 ai-image-to-ppt

**现有证据**

当前仓库已实现 host-first 候选顺序、serial sticky batch、Host Artifact 物化、严格 16:9、原图保留、1280×720 可编辑转换输入、PDF/PPTX 导出、output ownership、锁与恢复。Python 依赖为 Pillow 和 python-pptx，当前 requirements 使用下限而非完整 lock。

**落地形态**

- 首阶段：受限 Python Worker + Rust Product Core image facade；
- 第二阶段：路由状态、图片校验、规范化、hash、Artifact 发布和 deck manifest 迁 Rust；
- Pillow/python-pptx 只保留仍有价值的确定性处理，或由统一 Deck Assembler 替代导出。

**必须修改**

- 删除 Provider Key/浏览器/Host tool discovery 分支；调用 `ai.image()`；
- Provider 候选顺序变为服务端策略，不向 Skill 暴露品牌；
- 当前 POSIX publication/recovery 替换为 Workspace Transaction Layer；
- `requirements.txt` 转 locked environment，固定 wheel/hash；
- 输出不再由此能力直接占有最终 delivery directory；它只返回 owned image/slide artifacts；
- 将“图像生成”和“图片型 PPTX 导出”拆成两个 contract，避免与 SuperPPT assembler 重复。

**判断**

现有实现充分证明核心处理可行；适配工作集中在 Host Facade、跨平台文件事务与职责拆分。

### 3.3 image-to-editable-pptx

**现有证据**

当前 0.1.0 使用 Node >=22.6、TypeScript、OpenAI SDK、PptxGenJS 4.0.1、Sharp 0.35.3 和 Zod 4。pipeline 使用 DashScope OCR/Vision，生成 clean background、文字/图标候选、可编辑 PPTX、ledger、recording 与 failed-run evidence；已有 staging、marker、脱敏、schema、大小界限和离线 replay tests。

**可编辑性边界**

- 可读文字：原生文本框；
- 简单图形/线条/表格：能可靠识别时原生对象；
- 照片、人物、纹理、复杂插画：仍是可移动 raster crop 或背景；
- 不恢复源图中不存在的隐藏 layer、动画、原始 chart data；
- “可编辑 PPTX”不得被描述为“每个像素都可编辑”。

**落地形态**

- 首阶段保留 Node Worker，因为 Sharp、PptxGenJS 和现有 fixture 价值高；
- `openai`/DashScope provider 代码替换为 `ai.ocr()` 与 `ai.vision()` Host Request；
- Worker 消费固定 1280×720 PNG 和 recorded analysis artifact；
- 输出从单独 PPTX 扩展为 `EditableSlideArtifact`：scene manifest、assets、text/style、fallback background、warnings；
- 最终 PPTX 由统一 Deck Assembler 构建。

**Rust 迁移候选**

- contracts、schema、mask bounds、hash、ledger、ownership、path 和 validators；
- 不急于重写 Sharp 图像处理和 PptxGenJS OOXML 生成；
- 必须以相同 fixture 比较文字、bbox、z-order、render similarity 和 WPS 可编辑性。

**依赖风险**

Sharp 有平台/架构 native artifact；必须在发布构建阶段预取签名、固定版本并为 macOS arm64/x64、Windows x64 建矩阵。Node 22.6 是能力 runtime 要求，但不为该能力重复打包 Node；按“Signed Runtime Image 单一固定 Node + pinned pnpm + 锁定内置依赖图”路线验证，基础安装结束即具备，首次执行不安装。

### 3.4 SuperWriter

**现有证据**

当前 0.1.0 定义阶段 0～9、阶段契约、客户工作区、评分表/应答矩阵、素材库、深访、大纲、分章、核查、配图、合稿、终稿和 WPS 导出；人工门主要在 2/5/8，机器门有明确检查。它依赖 WPSComposer、grilling 系列、domain-modeling、ai-image-to-ppt 和 obsidian-excalidraw。

**落地形态**

`Private Durable Workflow`：

- `grilling`、`domain-modeling` 等不再作为用户另装 Skill，而成为 Host Guided Interaction/Domain Context 能力；
- markitdown/文档解析变成 versioned import capability；
- 图片调用 ai-image capability，精确结构图调用 Excalidraw capability；
- DOCX/PDF 调用 WPS Capability；
- 内容缺口统一使用 `ContentReadiness`；
- 客户/标段范围映射为 Workspace scopes 和 delivery ownership。

**必须修改**

- `流水线状态.md` 只做人类 projection，不能承担 lease/recovery；
- 每次人工门绑定 baseline revision；
- 评分点、章节、证据、图和导出使用稳定 ID；
- 依赖清单改成 Capability IDs/versions，不扫描 home 目录；
- 对投标资料建立敏感等级、网络发送 disclosure、组织策略和审计；
- “去 AI 腔”不得破坏事实引用和评分点 binding；
- 最终验收不能只比较提取文本，还要真实分页、编号、表格、图片和 WPS 重开。

**许可风险**

仓库当前没有根 LICENSE。即使代码由产品团队自有，也要先补版权/贡献和发行授权证据，再生成闭源衍生包。

### 3.5 WPSComposer

**现有证据**

当前 Python package 声明 MIT，提供 `generate/edit/inspect/convert_to_pdf` 等高层 API，支持 DOCX/PPTX/XLSX/PDF。Windows 通过 COM 驱动 WPS/MS Office；macOS 通过锁定 `wpsjs` 2.2.3 运行时驱动 WPS。已有原子发布、语义验证、timeout、进程 ownership 和 Windows 实机 COM 记录。

**必须诚实记录的缺口**

项目自己的 Windows 验证文档明确写明：macOS JSAPI 主要覆盖 `generate()` / `convert_to_pdf()`，完整 inspect/edit 路径没有等价 macOS backend。Windows COM 还存在单进程复用、localized style、对象 ID、进程泄漏和 attach-active 无回滚等宿主特性。

**落地形态**

```text
WpsPlan (versioned JSON)
→ Rust Product Core validates and authorizes
→ isolated WPS Host Worker executes
→ platform adapter
   ├── Windows isolated COM worker
   └── macOS authenticated JSAPI proxy
→ staging copy
→ WPS operation
→ structural validator + render
→ receipt / artifact
```

**必须修改**

- Python public API 固化为语言无关 `WpsPlan`/`WpsResult` schema；
- Rust 管理 WPS session、互斥、deadline、process ownership、staging 和 cleanup；
- 每个 job 默认使用副本，禁止 attach 用户活动文档执行验收；
- Windows COM Worker 使用 STA/thread/process 隔离；WPS 无响应时杀死的只能是当前 job 可证明拥有的进程；
- macOS proxy 的 session token、origin、callback 和本机端口继续收紧；
- 不把 WPS 安装包捆入 SuperWagie；把兼容 WPS 版本、缺失状态和安装引导做成 capability health；
- 补正式 LICENSE 文件，并审计 `wpsjs`/WPS SDK 的再分发和使用条款。

**平台契约**

首版可以声明：

| 能力 | Windows | macOS |
|---|---|---|
| 生成 DOCX/PPTX/XLSX/PDF | 必测 | 必测 |
| Office 转 PDF | 必测 | 必测 |
| 结构化 inspect/edit | 必测 | 在完成 JSAPI adapter PoC 前标为受限 |
| 真实 smoke edit | COM/UI controlled copy | JSAPI/UI controlled copy，缺 API 时需要 UI adapter |

不能用 Windows 成功替代 macOS 结论，也不能因为结构测试通过就宣称目标 WPS 视觉通过。

#### 3.5.1 WPS 渲染 Review 工作区

**产品边界**

SuperWagie 不实现一套新的 Office 排版引擎。WPS 负责把受控副本渲染为 PDF 或分页图片，SuperWagie 在这些页面上提供浏览、批注、差异、接受/拒绝和 revision 确认。页面是视觉底图，不是伪装成可编辑 Office 文档的 HTML。

需要自由编辑时，打开 WPS 中的受控副本并与 Review 面板并排工作。WebOffice SDK 是否适用于离线、私有文件和商业授权需要另行调查；直接把桌面 WPS 窗口嵌入或 reparent 到 Electron/任意桌面壳在跨平台上不可靠，不作为首版路径。

**数据与更新闭环**

```text
Office Artifact Revision
→ controlled preview copy
→ WPS render
→ immutable Preview Revision + page cache
→ ReviewAnnotation / ReviewDecision
→ semantic WpsPlan
→ controlled edit copy
→ WPS apply + re-render
→ visual confirmation
→ new Office Artifact Revision
```

`ReviewAnnotation` 使用组合锚点：Artifact revision、页/幻灯片、语义对象 ID（可得时）、normalized bbox、附近文本/对象哈希。DOCX 重分页或 PPT 对象重建后先尝试语义重定位；置信度不足时标记为 stale/unresolved，必须人工确认，不能按旧坐标静默套用。

**流畅性约束与暂定 PoC 门槛**

- 已缓存文档在基准机器上首屏可见的 P95 不超过 1 秒；
- 滚动、缩放、翻页、选择和批注反馈的热路径不调用 WPS，不发生明显掉帧或超过 100ms 的交互阻塞；
- 未缓存文档在 300ms 内显示真实进度，代表性 30 页 DOCX / 20 页 PPTX 的首个可审阅页面目标不超过 5 秒，其余页面渐进加载；
- 修改后立即生成可见回执并后台重渲染；代表性单页 PPT 修改目标 8 秒内更新，30 页 DOCX 的局部修改目标 15 秒内给出可审阅新版本；
- 缓存键必须包含 Artifact hash、WPS/Office 版本、字体环境和渲染参数，任何一项变化都不能误报为当前精确预览。

这些秒数是原型准入目标，不是未验证的产品承诺。PoC 必须同时记录冷启动、热启动、缓存命中、内存、页面数、图片密度、字体缺失和目标机器。若代表性文档不能稳定达标，首版采用“外部/并排 WPS + SuperWagie Review 面板”，并把内嵌页面 Review 延后。

### 3.6 SessionReviewer

**现有证据**

Go 内核已有 bounded evidence、allowlist/redaction、cursor、packet digest、proposal/apply、CAS、receipt、事务恢复、三方同步、人类 Markdown 投影和项目演化材料。它是当前能力中最适合验证 Go→Rust/Wasm 差分迁移的一项。

**落地形态**

- 不扫描机器 `~/.codex/sessions`；直接订阅 SuperWagie Runtime 结构化事件；
- Event Sanitizer 先于持久化，原始敏感 tool output 不进入长期账本；
- Continuity Engine 生成 project review/history/evolution proposals；
- Workspace Transaction Layer apply；
- 原 Obsidian companion 的浏览效果由 SuperWagie 原生视图实现。

详细事件、连续性和记忆安全放在下一份专项报告。本报告确认其代码适配和迁移路径可行。

### 3.7 任务管理模块与统一投影

Tasks 是客户端一级工作模块，但不是独立 Skill、插件、云服务或第二套存储。Markdown 中的任务由 Workspace 索引后，作为 Tasks、工作台、日历、项目和统计的统一数据源：

```text
Markdown lossless parser
→ Task IR with stable task identity
→ SQLite derived task index
→ Workbench todo/calendar/project/statistics query views
→ semantic task patch
→ Workspace CAS commit
```

首版功能范围：

- 用户手动、Agent 对话和 Project Milestone 三种创建入口；
- 项目自动任务只到 Milestone 粒度，并使用稳定 origin key 幂等 reconcile；
- user override、删除 tombstone、superseded 历史和 Task/Thread/Workflow 控制分离；
- `- [ ]`/`- [x]`；
- due/scheduled/start/completion/cancelled；
- priority、tags、recurrence、dependency、block ID；
- filter/sort/group；
- 工作台日历创建、编辑和打开源文件；
- recurring task completion产生下一实例的明确规则；
- 真实 Markdown 往返和任务语法 fixture。

任务管理是 V1 核心模块，但实现依赖 Markdown 编辑、无损往返和外部编辑冲突基础先通过。全部界面只消费统一 Task IR，不反向决定 Markdown 架构。具体 Task 状态、来源和 Milestone 规则以 `2026-08-29-superwagie-task-management-design.md` 为准。

### 3.8 obsidian-excalidraw 与 draw.io

obsidian-excalidraw 当前使用 Python 3.11、Playwright 1.62、Excalidraw 0.18.1 和固定 Web renderer，把结构 spec 生成 `.excalidraw` / `.excalidraw.md` 并做视觉检查。MIT 允许复用；SuperWagie 不为它单独安装 Playwright 或浏览器，而是复用随包 Chromium 的隔离 surface：

- Excalidraw React 组件直接进入隔离的 `diagram_editor` Surface；
- Agent 操作使用受限 scene operation schema；
- Python layout generator 首阶段可做 Worker，随后确定性几何/路由迁 Rust/Wasm；
- 渲染验收在独立 Electron Render Worker Host 运行，并记录 Chromium、字体与输入输出 hash；
- `.excalidraw.md` 的 protected section 仍需 Obsidian round-trip PoC。

draw.io 使用自托管 diagrams.net Embed Mode，结论已在报告 01 给出。两者共用 Workspace/Artifact/Agent/preview/exports，不共用数据模型。

### 3.9 AgentWiki 与 agentwiki-sync

AgentWiki 当前是完整远程服务：React/Vite 客户端、NestJS 服务、Prisma、PostgreSQL、Redis、Worker、Socket.IO、MCP 和本地同步协议。把整个服务端嵌入桌面会引入 Node server、PostgreSQL/Redis/容器和自己的模型 Provider 配置，直接违背“小客户端、托管 AI、服务独立”的边界。

正确形态：

- AgentWiki 保持远程产品/服务；
- SuperWagie 只内置 Connector UI、Secret reference、Space/Agent mapping；
- 复用 MIT sync-protocol 的 snapshot/delta/hash/idempotency；
- agentwiki-sync 的 Obsidian adapter 替换为 SuperWagie Workspace port；
- pull/push 都使用 preview → explicit confirm → journal → receipt；
- AgentWiki 服务端自己的 OpenRouter/Provider Key 体系不能泄漏或复刻到客户端；涉及 SuperWagie Managed AI 的协作由双方服务契约定义。

详细 Connector 授权、三重确认和离线恢复放在下一专项报告。

### 3.10 codex-roundtable

当前仓库主要是设计/Skill 编排，没有独立 runtime。其价值是：角色、人设、顺序发言、只读上下文、讨论轮数、终止和纪要。

落地为 `Private Multi-agent Workflow`：

- 参与 Agent 都由 SuperWagie Runtime 创建，不连接机器其他 Codex；
- 每个角色只有当前 scope 的只读 snapshot；
- 由 Host 控制轮次、预算、取消、失败隔离和最大输出；
- 模型品牌不可见，角色只声明 reasoning/fast 等 profile；
- 最终纪要写入 Markdown，原始内部 chain-of-thought 不存储/展示；
- roundtable 自身不能拥有任意 write/network 权限。

缺少根 LICENSE；生产包应基于确认权属后的新 Workflow contract，不直接分发 prompt-only Skill。

### 3.11 agentsoul

当前 0.1.15 是 OpenCode wrapper/plugin：读取 `~/.agentsoul/soul/*.md`，注入 system prompt，把 conversation 写入 `memory.db`，并修改/启动 OpenCode。SuperWagie 不应安装它或修改外部 OpenCode 配置。

吸收的只是产品概念：

- `AgentProfile`：Identity、Style、Preferences、User relationship；
- scope：User / Organization / Workspace / Agent；
- versioned profile changes；
- consented Safe Memory；
- memory provenance、expiry、delete、audit；
- 注入前把记忆视为不可信数据，不允许覆盖 system policy。

README 写 MIT，但 GitHub 根目录无 LICENSE；行为可作为需求，代码进入产品前仍需补齐权属/许可。

## 4. PPT 技术链

### 4.1 统一的 SlideArtifact

避免把工具输出的 PPTX 互相 ZIP 拼接。定义：

```text
SlideArtifact
├── slide_id
├── slide_revision_id
├── size/aspect
├── mode                 image | editable | hybrid
├── background_image?
├── scene_objects[]      text/shape/line/table/chart/image
├── assets[]             hash + mime + crop + provenance
├── speaker_notes?
├── source_bindings[]
├── warnings[]
├── render_ref
└── acceptance
```

最终 Deck Assembler 一次性创建：

- presentation size/theme/master；
- 全部页面及顺序；
- 每页 relationship/media；
- notes、metadata 和 accessibility；
- PPTX package；
- current render set 与 PDF。

PptxGenJS 是 MIT，能生成标准 OOXML、主要对象和 master，且已被 image-to-editable-pptx 使用，是首阶段 assembler 的合理选择。当前结构子验证已固定 `4.0.1`，验证了图片、原生文本对象、notes、对象名、原子输出和哈希绑定；其开发安装闭包中的 `image-size@1.2.1` 虽存在两个无修复版的 High 级拒绝服务公告，但 Runtime bundle 子验证已证明可从发行可达闭包中排除该未调用组件，并生成逐组件 SBOM/NOTICE。正式准入仍须审计 build/runtime 两套闭包并以 PowerPoint/WPS/Keynote/LibreOffice fixture 验证。其 API 能生成对象不等于可以无损合并任意第三方 PPTX。

### 4.2 图片页与可编辑页混合

- image 页：一张覆盖 slide 的受检高分辨率图；
- editable 页：从 scene objects 重新构建；
- hybrid 页：clean background + native text/可靠对象 + raster crops；
- 每种 page mode 都共享同一 page size、stable ID、source revision 和 final render；
- 替换一页生成新 deck revision，不覆盖旧 deck；
- PDF/缩略图必须从当前 deck/page revision 重新产生，不能沿用修改前图片。

### 4.3 质量门

四层验收：

1. **结构**：ZIP/OOXML、关系、页序、媒体、尺寸、字体引用；
2. **语义**：标题/正文/数字、speaker notes、对象类型、可编辑清单；
3. **视觉**：真实渲染、全页/关键区 diff、裁切/溢出/重叠；
4. **目标客户端**：WPS 或 PowerPoint 受控副本 smoke edit。

真实 smoke：

```text
copy canonical artifact to acceptance workspace
→ open target app
→ select known text/object by stable test marker or verified UI route
→ temporary edit
→ verify visible change
→ undo
→ choose save/discard explicitly
→ close
→ reopen
→ verify expected original state and editability
→ record screenshots/log/target version/hash
```

没有安装目标应用时可以交付“结构/渲染已验收”，不能标记为“目标 WPS/PowerPoint 已验收”。

## 5. 长文档与 WPS 技术链

### 5.1 Document IR

SuperWriter 不应把自由 Markdown 直接交给 WPS 黑盒。建立 versioned Document Plan：

```text
DocumentPlan
├── source baseline
├── section tree + stable IDs
├── styles/theme
├── numbering definitions
├── paragraphs/runs
├── tables/charts/images
├── references/captions
├── headers/footers/page sections
├── TOC/fields
└── acceptance constraints
```

Markdown 是内容真相；DocumentPlan 是交付 revision 的可重建中间表示；DOCX/PDF 是 Artifact。

### 5.2 DOCX/PDF 验收

必须覆盖：

- 标题层级与原生多级编号；
- 目录域更新；
- 表格跨页、列宽、合并单元格；
- 图片清晰度、caption、引用和分页；
- 中文字体 fallback、行距、孤行/寡行；
- 横竖混排 section；
- header/footer/page number；
- DOCX 与 PDF 的正文/页数/关键对象对应；
- WPS close/reopen 后编号、目录、图片、表格仍正常；
- 用户选中的代表性段落/表格可编辑。

只用 `python-docx`/OOXML 解包和 PDF 文本提取不能覆盖分页、字体替换与 WPS 实际渲染，因此真实 WPS 是高风险交付的必选门。

### 5.3 并发与崩溃

- 同一个 WPS 应用实例/文档不并行写；
- Host 以 job lease 和 target lock 排队；
- 默认在 staging copy 上生成/编辑；
- deadline 贯穿启动、执行、保存、验证、关闭；
- WPS crash 后保留 staging/日志，canonical 不变；
- attach-active 文档只允许显式用户操作，不用于自动 Workflow；
- kill 只能针对 current job ownership 已证明的进程。

## 6. HTML 页面制作与发布

### 6.1 HTML Workflow

没有现成 SuperWagie Skill，不代表不可行。推荐路径：

```text
ContentBaseline
→ ContentReadiness
→ Information Architecture [confirm]
→ Page/Section Plan [confirm]
→ Visual Direction + Sample [confirm]
→ Declarative WebPageSpec
→ trusted component renderer
→ local isolated preview
→ accessibility/performance/security QA
→ static bundle artifact
```

`WebPageSpec` 只引用 Host 提供的组件、tokens、assets 和有限 interaction。LLM/Skill 不直接提交任意可执行 HTML/JS 进入主应用 origin。

首阶段可用 TypeScript/React 静态 renderer；Rust-first 可参考 Rust template/Markdown 生态。Zola 是单二进制 Rust SSG，但当前新代码许可为 EUPL-1.2，且它的完整站点模型对单页交付偏重，因此只作为架构参考，不默认捆入。SuperWagie 更适合自有小型 renderer + 固定组件库。

### 6.2 预览安全

- 静态 bundle 在隔离 origin/WebView 中预览；
- strict CSP，默认无外网、无 inline/eval script；
- 本地资源通过 asset broker；
- 清洗 Markdown raw HTML、SVG、URL、iframe 和 form action；
- 模板不能调用文件/进程/Secret API；
- 外链、analytics、表单和远程字体分别显示授权；
- 导出前跑 broken link、a11y、viewport、asset hash 和 offline test。

### 6.3 发布

“导出静态包”和“发布到官方 Host”是两个 effect。对用户只存在 SuperWagie 官网提供的这一个发布目标，不提供第三方部署选择、自定义服务器或用户配置的 Publisher Connector：

1. 生成 immutable static artifact；
2. 客户端向 Official Publisher API 创建版本化发布请求；
3. 展示官方域名、将上传文件、访问范围和预计替换内容；
4. Official Host 生成 preview deployment / preview URL；
5. 用户确认；
6. promote deployment；
7. receipt 保存 official deployment ID、artifact hash 和 rollback target；
8. Secret 留在 Secret Vault/服务端，不进入 Workflow 文件。

Official Host 后端可以内部选择对象存储、CDN 或托管基础设施，但这是官网服务内部实现，不能出现在客户端 UI、Skill 参数或用户权限中。Official Publisher API 必须支持 preview、promote、同链接更新、rollback、revoke 和审计。

## 7. 分项可行性结论

| ID | 状态 | 实现路径 | 转为已证明前的验收 |
|---|---|---|---|
| PPT-01 | `FEASIBLE_CONDITIONAL` | SuperPPT Private Durable Workflow + 三人工门 + stable slide DAG | 3 页最小 workflow、重启恢复、局部失效和改单页闭环 |
| PPT-02 | `FEASIBLE_CONDITIONAL` | ai-image-to-ppt → Host `ai.image` + image artifact/normalizer | 去 Provider/Key、macOS/Windows、fallback receipt 与固定 fixture |
| PPT-03 | `FEASIBLE_CONDITIONAL` | Node Worker + Host OCR/Vision + EditableSlideArtifact | 1280×720 corpus、文本/对象/editability/visual/WPS 差分报告 |
| PPT-04 | `FEASIBLE_CONDITIONAL` | unified SlideArtifact + one Deck Assembler | image/editable/hybrid 混合、页序/theme/notes/render/PDF 一致 |
| PPT-05 | `FEASIBLE_CONDITIONAL` | controlled copy + target app adapter + edit/undo/reopen receipt | macOS WPS、Windows WPS/PowerPoint 实机自动/半自动验收 |
| DOC-01 | `FEASIBLE_CONDITIONAL` | SuperWriter Private Workflow + ContentReadiness + WPS plan | 真实标书 fixture、人工门恢复、引用/评分点/导出闭环 |
| DOC-02 | `FEASIBLE_CONDITIONAL` | language-neutral WpsPlan + Rust Product Core + WPS Host Worker/COM/JSAPI adapters | macOS inspect/edit gap、并发/崩溃/版本矩阵和正式 SDK 许可 |
| DOC-03 | `FEASIBLE_CONDITIONAL` | structural + semantic + render + real WPS QA | 编号、表格、分页、字体、图片、目录、DOCX/PDF/reopen corpus |
| DOC-04 | `RESEARCH_REQUIRED` | WPS render → immutable Preview Revision → virtualized Review UI | 冷/热/缓存性能、30 页 DOCX、20 页 PPTX、缩放/批注/重渲染和 fallback |
| DOC-05 | `RESEARCH_REQUIRED` | revision + semantic ID + page/bbox + content hash 组合锚点 | DOCX 重分页、PPT 对象重建、stale/unresolved 和人工重定位 corpus |
| HTML-01 | `FEASIBLE_CONDITIONAL` | Guided Workflow + declarative WebPageSpec + trusted static renderer | 3 类页面 fixture、隔离预览、CSP/a11y/offline/asset tests |
| HTML-02 | `FEASIBLE_CONDITIONAL` | immutable static bundle + Official Publisher API | 官网测试服务完成 preview/promote/同链接更新/rollback/revoke PoC，客户端无第三方目标 |

`PPT-04` 的 Deck Assembler 已有 `G3-PPT-ASSEMBLER-SPIKE-001` 结构子证据；表中状态不升级，
因为统一 `SlideArtifact` 接入、PDF 一致性、真实 Host 与双平台产品闭环仍未完成。

## 8. 必须执行的组合 PoC

### 8.1 PPT Vertical Slice

用 3 页内容：

- 第 1 页保持高保真图片；
- 第 2 页转可编辑并改标题；
- 第 3 页复杂视觉重新生图。

跑完三个确认门、生成、重组、PDF、视觉 QA、WPS/PowerPoint smoke，随后修改大纲只失效第 2 页并验证恢复。

当前只完成其中的“3 页混合结构组装 + 全页渲染 + 溢出检查”子步骤；尚未执行三个确认门、
PDF、局部失效/恢复和真实 WPS/PowerPoint smoke，因此不得把子步骤通过写成 Vertical Slice 通过。

### 8.2 Editable Converter Adaptation

用 recorded OCR/Vision fixtures 先证明去掉 DashScope key 后结果相同；再用 Managed AI Host Request 做一页真实调用。比较 reference 与 adapted：scene、文字、bbox、背景、PPTX、render、edit/undo/reopen。

### 8.3 WPS Platform Matrix

至少：

- macOS arm64 + 当前支持 WPS；
- Windows 11 x64 + WPS；
- Windows 11 x64 + PowerPoint（若宣称兼容）；
- DOCX/PPTX/XLSX/PDF generate；
- convert/render；
- inspect/edit；
- crash/timeout/locked file/process ownership；
- 用户已有 WPS 文档打开时不误关/误写。

### 8.4 WPS Rendered Review Vertical Slice

选取含目录、表格、图片、批注和字体替换风险的 30 页 DOCX，以及含图片型页、可编辑对象和备注的 20 页 PPTX。在 macOS WPS 与 Windows WPS 上记录冷/热渲染、缓存命中、首屏、滚动/缩放、批注定位、修改后重渲染、内存和崩溃恢复。随后制造 DOCX 重分页和 PPT 对象重建，验证批注能可靠重定位或明确进入 unresolved；任何静默错位均判定失败。

### 8.5 SuperWriter Vertical Slice

选择一个小型真实招标包，验证导入、评分点、内容不足引导、人工门、章节/图、DOCX/PDF、真实 WPS 与 kill/restart。所有内容补充必须落 Workspace Markdown。

### 8.6 工作台任务投影

用独立 Task IR 实现代表性 fixture，验证 Markdown 修改能增量刷新待办、日历、项目和统计；工作台编辑使用 semantic patch、stable identity 和 revision，不覆盖文档其他内容。

### 8.7 Static HTML

选择一个文章页、一个项目介绍页、一个数据说明页；生成离线 bundle，在 CSP 无网络环境预览，跑 viewport/a11y/link/asset tests，再用 Official Host 测试环境验证 preview/promote/同链接更新/rollback/revoke。

## 9. Go / No-Go 条件

### 9.1 Go

- 每项能力都有 Capability Manifest、locked deps、SBOM、权限和 Artifact contract；
- SuperPPT/Writer 的人工门和恢复由 Durable Workflow 驱动；
- Managed AI 适配后没有 Provider Key 或模型品牌泄漏；
- 混合 deck 使用统一 SlideArtifact/Assembler；
- PPTX/DOCX 的目标客户端 smoke 有真实证据；
- macOS/Windows 能力差异在 UI 和 manifest 中明确；
- 所有缺失根 LICENSE 的自有仓库完成权属/许可整理；
- HTML preview 与 publish 不共享任意主应用权限。

### 9.2 No-Go

- 为了省事把所有 Skill/仓库/`node_modules`/venv 直接塞进安装包；
- 让用户或脚本配置 Provider Key；
- 把 SuperPPT 设计稿当成已实现能力；
- 直接 ZIP 拼接来自不同工具的 PPTX 页面；
- 把整页 raster 宣称为全可编辑；
- 仅用 LibreOffice/PDF/OOXML 测试替代 WPS/PowerPoint 真实验收；
- 在 macOS 宣称支持完整 inspect/edit，但仍只有 generate/convert backend；
- WPS job 能误杀或覆盖用户已有 WPS 会话/文件；
- 用自研 HTML/OOXML 近似渲染冒充 WPS 精确预览，或让滚动、缩放、批注热路径同步等待 WPS；
- Review 批注在文件 revision、重分页或对象重建后按旧坐标静默附着到错误内容；
- LLM 生成的任意 JS 在主应用 origin 执行；
- 向用户暴露第三方 Publisher 选择或自定义服务器；没有 Official Host preview/rollback/revoke/audit 就宣称支持一键发布。

## 10. 主要一手资料

- NeoMei/SessionReviewer: <https://github.com/NeoMei/SessionReviewer>
- NeoMei/ai-image-to-ppt: <https://github.com/NeoMei/ai-image-to-ppt>
- NeoMei/SuperWriter: <https://github.com/NeoMei/SuperWriter>
- NeoMei/agentwiki-sync: <https://github.com/NeoMei/agentwiki-sync>
- NeoMei/image-to-editable-pptx: <https://github.com/NeoMei/image-to-editable-pptx>
- NeoMei/AgentWiki: <https://github.com/NeoMei/AgentWiki>
- NeoMei/obsidian-excalidraw: <https://github.com/NeoMei/obsidian-excalidraw>
- NeoMei/WPSComposer: <https://github.com/NeoMei/WPSComposer>
- NeoMei/codex-roundtable: <https://github.com/NeoMei/codex-roundtable>
- NeoMei/agentsoul: <https://github.com/NeoMei/agentsoul>
- PptxGenJS official repository: <https://github.com/gitbrent/PptxGenJS>
- PptxGenJS masters documentation: <https://gitbrent.github.io/PptxGenJS/docs/masters.html>
- Excalidraw official repository: <https://github.com/excalidraw/excalidraw>
- diagrams.net integration repository: <https://github.com/jgraph/drawio-integration>
- Zola official repository: <https://github.com/getzola/zola>
