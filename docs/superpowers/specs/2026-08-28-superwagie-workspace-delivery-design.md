# 超级牛马（SuperWagie）智能工作区与交付物设计规范

> 状态：界面与核心交互已完成逐项确认，可作为技术 PoC 输入；尚未进入实施计划  
> 日期：2026-08-28  
> 上位基线：`docs/最早期产品方案-V0.1.md`  
> 编码准入契约：`docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md`  
> 本文定义产品与架构边界，不是实现计划。

## 1. 设计目标

SuperWagie 的默认工作环境不是空聊天框，也不是 PPT、Word 等工具入口的集合，而是以本地 Markdown 内容为中心的智能工作区。

用户在工作区中选择目录、文档或内容块，与 Agent 一起阅读、研究、整理、补充和改写内容；内容达到就绪标准后，再选择 PPT、Word、HTML、视频、PDF 等交付形式。每种交付物拥有独立制作目录、持久工作流和对应 Skill 的分阶段引导。

设计目标包括：

- 主工作台同时承担个人概览和进入工作的职责；
- 智能工作区是所有内容加工和交付物制作的统一底座；
- 目录、单个文档和多选内容都是一等 Agent 上下文；
- 所有纯文本内容统一使用 Markdown；
- 同一 Vault 可由 Obsidian 与 SuperWagie 无转换、无损地打开和编辑；
- 每种交付物的过程文件、中间产物和最终结果位于独立目录；
- 内容不足时先通过引导式对话完善内容，再进入正式制作；
- SuperPPT、SuperWriter、视频制作等系统能力决定业务阶段，客户端提供统一引导协议；
- 视频制作内核独立实现，只研究 OpenMontage 的流程思想和 Remotion 的帧式合成思想，不集成两者代码或 UI；
- 第一阶段保留传统 Skill、MCP 和脚本形态调试，第二阶段闭源产品化；
- 第二阶段采用 Rust-first 策略，尽量减少生产包中的 Python、Node、Go 和常驻子进程。

## 2. 产品对象模型

### 2.1 Content Workspace

`Content Workspace` 是一个用户拥有的本地目录，保存长期内容、来源、任务、图表和交付项目。它是用户持续工作的容器，而不是一次会话的临时目录。

### 2.2 Content Scope

`Content Scope` 表示当前 Agent 被允许理解和加工的内容范围，可以是：

- 一个目录；
- 一个 Markdown 文档；
- 多个目录或文档；
- 文档中的标题、块、任务或选区；
- 用户临时附加的外部只读材料。

界面必须持续显示当前范围，避免用户误以为 Agent 正在使用整个 Workspace。范围发生变化时，上下文和权限一同更新。

### 2.3 Content Baseline

`Content Baseline` 是用户在进入交付物正式制作前确认的来源版本集合，包括文件身份、revision、内容哈希、选中范围和确认时间。它用于恢复、影响分析和重新生成，不替代原始 Markdown。

### 2.4 Delivery Project

`Delivery Project` 是一次明确交付目标的独立制作项目，例如“董事会季度汇报 PPT”“技术方案长文档”“产品介绍 HTML”或“AI 入门视频课”。它拥有自己的目录、Workflow Run、来源绑定、确认记录、预览、输出和历史。

同一个 Content Workspace 可以拥有多个 Delivery Project；同一份内容也可以产生多个不同受众、目的和风格的交付物。

### 2.5 Task Item 与 Project Milestone

`Task Item` 是用户可计划、执行和完成的工作，来源统一为用户手动、Agent 对话或 Project Milestone。`Project Milestone` 是对用户有意义、可以独立验收的项目阶段目标；每个已确认 Milestone 最多派生一个活跃任务。Task Item、Agent Task Thread 和 Workflow Stage 是三个不同对象，不能用“任务”一词混成同一个状态机。

## 3. 主工作台

SuperWagie 登录后默认进入主工作台，不直接打开空聊天。

主工作台采用暖调、编辑式、克制的 Bento 工作台布局，包含：

- 当前时间、日期和工作状态；
- SuperWagie 任务、项目节点和截止时间组成的日历；
- 今日待办、已逾期和本周完成情况；
- 进行中的内容项目及其当前目标、阶段、最后进展和下一步；
- 活跃项目、完成任务、生成成果、进行中 Workflow 和 Credits 等统计；
- 最近交付物；
- “新建智能工作区”和“继续最近项目”的主要入口。

PPT、Word、HTML 和视频不与智能工作区平级。最近交付物可以提供“继续制作”快捷入口，但它仍然打开所属 Content Workspace 和 Delivery Project。

V1 日历首先呈现 Workspace 任务和项目节点。操作系统或第三方日历同步属于后续 Connector 能力，不作为 V1 核心闭环的前置条件。

统计信息只展示用户可理解的工作数据和 Credits，不显示 Token、Provider 或具体模型。

## 4. 智能工作区界面

智能工作区使用统一三栏结构：

```text
┌─────────────────┬──────────────────────────┬────────────────────┐
│ 文件、目录与来源 │ Markdown 编辑与成果预览   │ Agent 与阶段引导     │
│                 │                          │                    │
│ Workspace Tree  │ Live Preview             │ 当前 Content Scope  │
│ Outline         │ Reading View             │ 对话                │
│ Sources         │ Source Mode              │ 问题与选择          │
│ Deliveries      │ 文档 / 页面 / 视频 Preview│ 确认与影响范围      │
└─────────────────┴──────────────────────────┴────────────────────┘
```

### 4.1 选择文档

选择 Markdown 文档时，中间区域打开 Obsidian 式编辑器。右侧 Agent 默认只围绕该文档工作；用户可以把同目录、反向链接或其他选中文档加入范围。

### 4.2 选择目录

选择目录时，中间区域打开目录内容概览，展示：

- 子目录和文档结构；
- 文档摘要和最近变化；
- 标题、链接、标签和任务；
- 重要来源和未处理材料；
- 当前关联的交付物。

右侧 Agent 可以围绕目录整体进行归纳、比较、整理和内容规划。

### 4.3 多选范围

用户可以多选目录、文档、标题或内容块。界面以可删除的范围项显示当前集合，并在 Agent 调用、搜索、修改和制作交付物时使用同一范围。

### 4.4 制作交付物

内容加工完成后，用户在工作区点击“制作交付物”，选择 PPT、Word、HTML、视频、PDF 或后续支持的其他形式。视频按优先级包含网站 Demo、教学课件、PPT 讲解、图片绘本和照片动态五个制作 Profile。系统显示目标、受众、用途、来源范围和目录位置，再进入内容就绪检查。

## 5. Workspace 与交付物目录

默认目录使用用户可理解的名称；内部实现通过稳定语义 ID 识别目录角色，不能依赖某个固定中文或英文目录名。

```text
项目名称/
├── 内容/
│   ├── 项目主页.md
│   ├── 核心内容.md
│   ├── 研究笔记/
│   └── 章节/
├── 来源材料/
│   ├── 原始文档/
│   ├── 网页资料/
│   ├── 图片/
│   └── 数据/
├── 图表/
│   ├── 系统架构.excalidraw.md
│   └── 业务流程.drawio
├── 交付物/
│   ├── 产品汇报-PPT/
│   │   ├── 项目状态.md
│   │   ├── 来源清单.md
│   │   ├── 制作要求.md
│   │   ├── 大纲.md
│   │   ├── 页面描述/
│   │   ├── 素材/
│   │   ├── 预览/
│   │   ├── 输出/
│   │   └── .superwagie/
│   ├── 完整方案-长文档/
│   │   ├── 项目状态.md
│   │   ├── 来源清单.md
│   │   ├── 写作要求.md
│   │   ├── 大纲.md
│   │   ├── 章节/
│   │   ├── 插图/
│   │   ├── 审查/
│   │   ├── 输出/
│   │   └── .superwagie/
│   ├── 对外介绍-HTML/
│   │   ├── 项目状态.md
│   │   ├── 来源清单.md
│   │   ├── 页面结构.md
│   │   ├── 页面内容/
│   │   ├── 资源/
│   │   ├── 预览/
│   │   ├── 输出/
│   │   └── .superwagie/
│   └── AI入门-视频课件/
│       ├── 项目状态.md
│       ├── 来源清单.md
│       ├── 课程方案.md
│       ├── 讲稿.md
│       ├── 分镜.md
│       ├── scene-plan.json
│       ├── 素材/
│       ├── 音频/
│       ├── 字幕/
│       ├── 样片/
│       ├── 渲染/
│       ├── 审查/
│       ├── 输出/
│       └── .superwagie/
└── .superwagie/
```

目录规则：

- 每个 Delivery Project 只写自己的目录；
- 核心内容的补充和修改写回 `内容/` 或用户指定的 Markdown；
- 新来源写入 `来源材料/` 或用户指定的位置；
- 人类可读过程使用 Markdown；
- `.superwagie/` 只保存 revision、hash、lease、receipt、journal、source snapshot 和核算等机器状态；
- 机器状态不得形成第二套不可见的语义内容真相；
- failed-run evidence 和恢复记录不能作为普通临时文件清理；
- 多个交付物可以绑定同一来源，但中间文件、预览和输出不得混用。

## 6. Obsidian 兼容的 Markdown 体验

### 6.1 兼容目标

同一个 Vault 可以由 Obsidian 和 SuperWagie 直接打开，不经过导入、导出或格式转换。在任意一端修改后，另一端重新打开仍能正确呈现和继续编辑。

严格一致指文件语义、编辑行为和核心工作区体验一致；SuperWagie 的应用外框、品牌视觉和 Agent 面板不要求像素级复制 Obsidian。

### 6.2 工作区体验

至少包括：

- Obsidian 式目录树和文件操作；
- 新建、重命名、移动、拖放和删除；
- 多标签页和左右拆分；
- 最近文件、快速切换和全局搜索；
- 命令面板；
- Outline、Backlinks、Outgoing Links、Tags 和 Properties；
- 打开文件并定位标题、块、链接或任务；
- 外部修改检测和增量刷新。

### 6.3 编辑与渲染

至少包括：

- Live Preview 作为默认编辑模式；
- Reading View；
- Source Mode；
- 标题、列表、表格、引用、代码块和任务；
- Frontmatter / Properties；
- `[[WikiLink]]`、`![[Embed]]`、标题锚点和 `^block-id`；
- Callout、脚注、数学公式和 Mermaid；
- 图片、音频、PDF 和本地附件；
- 相对路径和文件重命名后的链接更新；
- Excalidraw Markdown 容器的受保护结构化区段。

### 6.4 无损编辑

编辑器使用可逆的 Markdown AST 和 source range。不得因为打开、渲染或局部编辑而自动重排全文、删除未知 Frontmatter、改变列表风格或破坏 HTML、自定义代码块和未知扩展语法。

Agent 默认提交语义 patch。提交时文件 revision 已变化，应重新定位目标或进入冲突处理，不能用旧全文覆盖用户的新修改。

### 6.5 插件边界

V1 不实现完整 Obsidian Plugin API，也不承诺运行任意第三方 Obsidian 插件。Markdown 任务直接投影到统一工作台；Excalidraw 和项目演化等必要用户效果由 SuperWagie 原生实现。第三方主题、CSS snippets 和完整插件生态不属于本设计的兼容承诺。

## 7. 内容就绪门

选择交付形式后，对应 Skill 先执行内容就绪评估，不立即生成页面、章节或最终文件。

```text
选择交付形式
→ 明确用途、受众和交付要求
→ 评估当前 Content Scope
→ 发现缺口
→ 引导补充内容或材料
→ 重新评估
→ 用户确认 Content Baseline
→ 进入正式制作
```

就绪检查包括：

- 交付目标和目标读者；
- 核心结论和希望读者采取的行动；
- 内容结构和逻辑；
- 事实、数据、案例和引用；
- 图片、图表、Logo 和品牌要求；
- 必要章节或页面；
- 页数、篇幅、语言、格式和截止时间。

缺口分为：

- 硬性缺口：没有目标、没有可用内容或缺少强制材料，不能进入制作；
- 质量缺口：案例、图片或辅助数据不足，用户可以补充，也可以在看到影响后确认继续。

引导必须说明“缺什么、为什么需要、会影响哪里、如何补充”。用户可以回答问题、选择已有文件、上传材料、让 Agent 从现有内容归纳、授权研究或新建 Markdown 补写。

补充结果必须写入 Workspace 文件，不能只留在聊天历史。确认内容就绪后，系统生成来源清单和 Content Baseline。

## 8. 交付物制作台

Delivery Project 仍在当前智能工作区中打开，不启动独立应用或失去来源上下文。界面切换为专用制作模式：

```text
┌─────────────────┬──────────────────────────┬────────────────────┐
│ 来源与制作目录   │ 当前阶段编辑与预览       │ Skill 引导          │
│                 │                          │                    │
│ 来源文件        │ 大纲 / 页面 / 章节       │ 当前目标           │
│ 项目状态.md     │ 文档 / 页面 / 视频 Preview│ 补充材料           │
│ 来源清单.md     │ Compare / Diff           │ 内容相关问题       │
│ 大纲.md         │                          │ 选择与确认         │
│ 素材与输出      │                          │ 返回修改           │
└─────────────────┴──────────────────────────┴────────────────────┘
```

顶部和底部显示阶段、保存状态、上一步、下一步、暂停和恢复入口。

### 8.1 Guided Workflow UI Protocol

客户端提供统一组件，不把 SuperPPT、SuperWriter、HTML 或视频 Workflow 的问题和阶段写死：

- 单选、多选和排序；
- 内容相关问题和自由补充；
- 选择、上传和授权研究材料；
- 大纲、页面和章节编辑；
- 风格样例比较；
- 分镜、代表样片、时间点批注和视频播放；
- 页面、章节和整体验收预览；
- 差异和影响范围；
- 确认、拒绝、返回修改；
- 暂停、恢复和失败重试。

Skill 声明当前阶段、输入 Schema、用户问题、候选方案、确认策略、影响范围、下一阶段和恢复状态。客户端只负责安全、一致地呈现和提交用户决策。

### 8.2 PPT

唯一阶段定义是 §20.2 的 SuperPPT 七阶段：内容就绪、大纲、逐页规划、视觉风格、代表内容样张、完整生成和真实渲染 Review。按页可编辑重建、单页返工和导出是阶段内动作，不另建 Workflow Stage。

### 8.3 Word / 长文档

唯一阶段定义是 §20.3 的 SuperWriter 七阶段：内容就绪、写作要求、浅层顶级大纲、逐章写作和来源绑定、插图、WPSComposer DOCX 格式化和 WPS 真实渲染 Review。内容访谈、一致性审查和 DOCX/PDF 导出是阶段内动作。

### 8.4 HTML

唯一阶段定义是 §20.4 的 HTML 七阶段：内容就绪、发布目标、信息架构和组件、视觉方向、本地构建、真实浏览器 Review 和官方 Host 一键发布。页面内容编辑、响应式检查和静态包导出是阶段内动作。

HTML Workflow 内置 `HtmlTastePolicy`。它从发布目标、受众、内容类型、品牌素材和无障碍约束推导设计语言、视觉密度与动效强度，并在视觉方向、本地构建和浏览器 Review 三个阶段执行质量规则。该能力不形成独立产品入口、不暴露 Skill 名称或技术旋钮，也不改变 SuperWagie 客户端自身的界面设计。

### 8.5 视频

唯一阶段定义是 §20.5 的视频八阶段：内容就绪、制作场景与设定、内容脚本、分镜/素材计划/Credits 估算、代表样片、素材生产、完整合成与媒体 QA、最终 Review 与导出。

视频只有一个系统内置 Delivery Workflow，内部按网站 Demo、教学课件、PPT 讲解、图片绘本和照片动态五个 Profile 运行。SuperWagie 独立实现 Workflow、Scene IR、Timeline IR 和确定性帧渲染器；OpenMontage 与 Remotion 仅作为研究参考，不进入生产依赖。用户只通过 SuperWagie Agent 驱动流程，不看到代码、时间线、Provider 面板或任何 Skill 自带 UI。

### 8.6 可修改的确认

确认形成版本基线，不是永久锁。用户返回修改上游内容时，系统先展示受影响的页面、章节和交付物，并允许只更新当前交付物或更新所有关联交付物。

关闭制作台后，Workflow Run 保留当前阶段、已确认选择、预览、缺口、失败步骤和下一步。再次打开时从持久状态恢复，不重新开始。

## 9. 原生绘图能力

Excalidraw 和 draw.io 是工作区原生能力。它们可以作为核心内容，也可以被 PPT、Word、HTML 和视频 Delivery Project 引用。

- Excalidraw 面向手绘白板、快速构思和教学图解；
- draw.io 面向架构图、流程图、网络拓扑、UML 和精确排版；
- 两者共用 Workspace 文件事务、素材、Agent 操作、预览、导出和安全校验；
- Agent 使用结构化 Diagram API，不依赖鼠标模拟完成常规制图；
- 生产版使用固定、签名的静态编辑器资源和随包 Electron/Chromium `diagram_editor` Surface；renderer 启用 sandbox/context isolation、关闭 Node integration，不获得真实路径、进程或任意网络权限。

## 10. 两阶段实现与发布

### 10.1 第一阶段：Reference Capability

使用传统 `SKILL.md + MCP + Scripts + Templates + Schemas + Evaluations` 开发和调试内置能力。该形态保留可读源码、快速 Prompt 修改、完整日志和真实宿主调试能力。

传统形态不代表必须公开：公开项目可以继续公开维护，SuperPPT 等私有能力可以只在私有仓库或内部制品库发版。

从第一天起必须遵守最终 Capability Contract、文件边界、AI Gateway、凭证、阶段、确认、恢复和计量要求，避免第二阶段重新设计。

进入产品化前冻结：

```text
Capability Candidate
├── source_commit
├── capability_version
├── contract_version
├── dependency_lock
├── evaluation_suite
├── golden_artifacts
└── acceptance_report
```

### 10.2 第二阶段：Private Capability

把冻结候选转译或封装为：

- Private Workflow IR；
- Signed Capability Package；
- Native Client Module；
- Trusted Host Adapter；
- Runtime Dependency Bundle。

生产安装包不直接附带可复制的标准 SKILL.md、内部 Prompt、MCP 配置、开发脚本目录和测试夹具。

第二阶段必须与 Reference Capability 执行相同回归，比较阶段、人工门、文件修改、中间 Artifact、最终结果、错误恢复、权限和 Credits，而不是只检查最终文件存在。

能力版本、私有制品版本和 SuperWagie 客户端版本分别记录；客户端发布清单固定包含的能力版本和兼容契约。

## 11. Rust-first 产品化

第二阶段以 Rust-first 为默认策略，优先减少安装包、Runtime 数量、冷启动时间、常驻内存和环境差异。

### 11.1 必须 Rust 化

- Agent Runtime 管理；
- Rust Product Core、UI Query Gateway 与 Worker Supervisor；
- Durable Workflow Runtime；
- Capability Router；
- 权限、沙箱、Credential、Network 和 Host Broker；
- Dependency Resolver；
- Workspace 文件、事务、revision、CAS 和恢复；
- Markdown 文件监听、索引、任务和 SQLite；
- Artifact Registry 和 Delivery Project 管理；
- Checkpoint、Lease、Journal、幂等执行和 Credits；
- Connector 生命周期、签名、升级和制品校验。

### 11.2 优先 Rust 化

- SessionReviewer 的 evidence、cursor、ledger、同步和 Markdown 生成；
- AgentWiki Sync 的 revision、hash、diff3、preview 和 journal；
- SuperPPT、SuperWriter 的状态、依赖失效、目录、Artifact 和恢复；
- 图片校验、缩放、格式转换和组装；
- 可编辑 PPTX 的预处理、布局、Artifact 和可替代的 OOXML 构建；
- WPSComposer 的 Markdown 解析、文档计划和确定性校验；
- Excalidraw Scene、draw.io XML 的结构化操作和安全校验。

### 11.3 保留必要生态层

- Excalidraw 和 draw.io 编辑器保留静态 Web 实现，通过随基础安装包分发的 Electron/Chromium `diagram_editor` Surface 运行；Electron 自带的 Node 只存在于受控壳层，不能暴露给 renderer、用户 Skill 或工作区内容；
- WPS、Office、COM 和 macOS JSAPI 保留协议要求的适配代码；Rust Product Core 管理策略、请求和回执，真实调用由隔离 WPS/Office Host Worker 执行；
- Prompt、角色、阶段说明和评价标准保留为签名的 Private Workflow IR，不硬编码进 Rust；
- Rust 生态不能达到相同质量的专业格式库，可以暂时保留在隔离 Worker 中并逐步替换。

### 11.4 迁移方式

```text
冻结 Reference Capability
→ 在相同 Contract 后实现 Rust Executor
→ Reference 与 Rust 双跑
→ 比较状态、文件、Artifact、视觉和恢复结果
→ 等价后切换默认执行器
→ 从生产包移除不再需要的 Runtime
```

Rust 迁移不能降低产物质量，也不能改变人工确认和失败恢复语义。不能仅凭语言替换宣称包体积或效率改善，发布报告必须记录安装包、冷启动、峰值内存、子进程数量和真实任务耗时的前后数据。

## 12. 异常与恢复

- Durable Workflow 的机器真相保存在 SuperWagie App Data 的本地 SQLite，不放入项目目录或同步盘；
- 项目目录保存人类可读状态、Artifact 和版本化 checkpoint manifest；复制项目时不复制活跃 SQLite；
- 在另一台机器打开复制项目后，SuperWagie 校验相对路径、文件/Artifact 哈希、Capability 版本和外部 receipt，再创建新的本地 run binding；
- checkpoint 不包含 Credits 账本、平台凭证、私有 Prompt/Workflow 实现或可直接重放的高权限请求；未完成外部动作在导入后进入待核对/暂停，不能自动重放；
- 内容硬性缺口存在时不进入正式制作；
- 用户带质量缺口继续时，在 Delivery Project 中记录影响和确认；
- 来源 revision 变化时重新执行影响分析，不静默使用过期内容；
- Workspace 文件冲突时保留双方内容和 Base，提供语义合并；
- Workflow 崩溃后从 durable checkpoint 恢复；
- 重试不得重复扣费或覆盖已验收 Artifact；
- Delivery Project 远程发布成功、本地记录失败时保留可恢复 journal；
- Reference 和 Private Capability 行为不一致时阻止产品发版；
- 单项可选能力依赖缺失时只阻止该能力，不阻止 Workspace 和其他能力启动。

## 13. 验收标准

### 13.1 主工作台

- 登录后默认进入主工作台；
- 时钟、日历、待办、项目、统计和工作入口可见；
- 项目“继续”能恢复文件、范围、对话和 Workflow 阶段；
- PPT、Word、HTML、视频不作为与智能工作区平级的产品入口。
- 工作台快速创建、Tasks 手动创建、Agent 对话创建和 Project Milestone 自动创建进入同一任务列表与详情；
- 三个 Milestone 只产生三个活跃自动任务，内部 Workflow Stage 数量不改变任务数；
- Task Item 完成与 Agent Thread 停止分别控制，不产生隐式副作用。

### 13.2 智能工作区

- 目录、文档和多选内容都能成为明确 Content Scope；
- Agent 的读取和修改不会越出当前权限；
- 目录概览可展示结构、摘要、任务、链接和交付物；
- 内容加工结果写入 Markdown，而不是只存在聊天中。

### 13.3 Obsidian 兼容

- 同一测试 Vault 在 Obsidian 与 SuperWagie 中往返编辑不需要转换；
- WikiLink、Embed、Frontmatter、Callout、任务、公式、Mermaid、附件和 block ID 保持语义；
- Live Preview、Reading、Source、文件树、标签页、拆分、Outline 和 Backlinks 可用；
- 未知语法在打开、保存和局部编辑后保持原文；
- 不以完整 Obsidian 插件 API 作为兼容要求。

### 13.4 Delivery Project

- 每个交付物拥有独立目录和输出；
- 内容不足时进入引导补充，不启动正式生成；
- 内容就绪确认产生可复现 Content Baseline；
- Skill 引导问题与真实内容和交付目标相关；
- 上游修改能显示影响范围并局部重算；
- 暂停、关闭、崩溃和重试后可恢复；
- PPT、Word、HTML、视频最终产物通过各自真实客户端、浏览器或播放器验收。

### 13.5 WPS 渲染 Review

- Office 文件由 WPS 对受控副本进行高保真渲染，SuperWagie 不自建 Office 排版引擎；
- SuperWagie 的 Review 工作区负责页面浏览、批注、差异、接受/拒绝和 revision 确认；
- 滚动、缩放、翻页、选择和批注热路径不等待 WPS，首次渲染和修改后重渲染在后台进行；
- 批注通过 Artifact revision、语义对象、页码、bbox 和内容哈希组合定位，不能可靠重定位时明确进入待确认状态；
- 原型达不到流畅性门槛时，首版使用外部或并排 WPS 与 SuperWagie Review 面板，不发布失真或卡顿的内嵌视图。

### 13.6 两阶段发布

- 每个 Private Capability 都绑定一个冻结 Reference Candidate；
- Reference 与 Private 形态通过相同回归和真实任务；
- 生产包不暴露标准 Skill、内部 Prompt 和开发脚本目录；
- Rust 迁移有行为等价证据和可量化体积、性能报告；
- 客户端发布清单能精确定位和回滚每项能力版本。

## 14. 当前不在范围内

- 完整 Obsidian Plugin API 和任意第三方插件运行；
- 第三方 Obsidian 主题、CSS snippets 的完整兼容；
- 将所有成熟 Web 编辑器和 Office 协议代码重写为 Rust；
- 跨平台劫持或 reparent 桌面 WPS 窗口；
- V1 系统日历和第三方日历双向同步；
- V1 多人实时协作和 CRDT；
- 第一阶段所有私有 Skill 必须公开发布；
- 仅为了闭源而牺牲产物质量、可恢复性或真实客户端验收。

## 15. 视觉与应用外框

### 15.1 视觉基线

采用最早确认的暖调、清晰、克制的编辑式工作台风格。页面强调信息层级、留白和可读性，不采用 Neumorphism、Claymorphism 或其他会削弱内容辨识度的拟物效果。

应用保持统一全局侧轨，承载工作台、项目、任务、交付物、设置和账户入口。核心内容视图不因进入 PPT、Word、HTML、视频或绘图能力而更换产品外框。

### 15.2 四个核心视图

1. 主工作台：时间、日历、待办、项目、统计、最近成果和开始工作入口；
2. 智能工作区：文件与知识导航、中心内容编辑、右侧 Agent；
3. 交付引导：仍位于智能工作区，右侧 Agent 临时扩展并承载 Skill 阶段；
4. Office Review：中心显示真实 WPS / Office 渲染结果，保留项目导航和 Agent Review。

四个视图共享相同导航、任务状态、文件语义和 Agent 交互，不形成四套独立应用。

## 16. 主工作台确认稿

主工作台采用已确认的 A2 平衡布局与 I2 工作入口：

- 唯一视觉基线是 `confirmed-i2-original-replay.html`；`four-view-overall-confirmation.html` 中的主工作台是同版缩略图；
- 页面标题和概览信息位于 Bento 网格上方；
- “开始工作”是网格左上角的紧凑深色卡片，不是横跨页面的大输入栏；
- 卡片标题在上，短输入框在下；
- 用户输入今天想完成的工作后，先做轻量项目归属确认；
- 不把大标题与大通栏输入框并排；
- 不使用后来受拟物风格影响的工作台变体，也不使用 `workbench-restored-i2.html`、`workbench-compact-start-v3.html` 或 `workbench-start-card-v4.html` 的重画版本。

### 16.1 Tasks 一级模块

- 全局侧轨“任务”进入独立 Tasks 视图，采用已确认的“统一日程列表 + 任务详情”布局；
- 左侧提供今天、即将到期、全部和已完成，并支持项目、来源、责任人、状态、优先级和标签筛选；
- 右侧展示任务语义、Markdown 来源、Project Milestone、dependency、Agent/Workflow 运行状态和继续入口；
- 用户可在 Tasks 或工作台快速创建；Agent 可根据对话创建；已确认项目计划按 Milestone 自动创建；
- 项目自动创建只到 Milestone 粒度，内部 Workflow Stage 和工具步骤不进入任务列表；
- Workbench 任务卡片是摘要和快速入口，不替代完整 Tasks 模块；
- 完整领域、状态、幂等和冲突规则见 `2026-08-29-superwagie-task-management-design.md`。

## 17. 智能工作区确认稿

### 17.1 三栏职责

- 左栏：Obsidian 式切换器，覆盖文件、搜索、大纲和引用；
- 中栏：Markdown Live Preview、Reading View、Source Mode、绘图画布或交付物真实预览；
- 右栏：Codex 式项目任务对话、工作范围和操作记录。

所有栏宽可拖动。左栏默认约 240px、最小约 180px；右栏普通模式约 360px、交付引导约 440px；中心内容区最小约 420px 并始终优先保证可用宽度。

### 17.2 布局行为

- 左右侧栏可分别折叠；
- 双击分隔线恢复默认宽度；
- 专注模式同时隐藏左右栏，但保留全局侧轨；
- 进入交付引导时临时加宽右侧 Agent；
- 窄窗口优先收起左栏，并以边缘抽屉呼出；
- 布局按项目、窗口和模式记忆。

### 17.3 文件与标签页

- 文件树直接操作真实本地文件；
- 支持单选、多选、拖动、移动、右键菜单和行内重命名；
- 重命名和移动时自动维护 WikiLink、Markdown link 和 Embed；
- 删除先进入项目回收站并可撤销，只有永久删除才要求明确授权；
- 中央文档标签采用克制的编辑器式标签，不使用厚重浏览器标签造型。

### 17.4 快速切换

- Command/Ctrl + O 快速打开文档、项目或任务；
- Command/Ctrl + P 进入命令模式；
- 默认优先当前项目，再扩大到全部项目；
- 快速切换用于到达目标，左侧搜索负责正文全文检索。

## 18. Markdown 保存、外部修改与恢复

- Markdown 真实文件是唯一内容源；
- 日常输入和 Agent patch 自动保存，不提供手动保存负担；
- 当前没有并行修改时，磁盘外部变化自动增量同步并轻提示；
- 当前工作区与磁盘新版本同时修改同一文件时才进入冲突处理；
- 冲突处理始终保留双方原始内容和 Base；
- 用户可选择“合并两份内容”“保留当前版本”或“使用磁盘版本”；
- Agent 大修改、冲突处理和异常退出前建立本地恢复点，不要求项目使用 Git。

## 19. Agent 交互与注意力

### 19.1 Composer

- Agent 输入框使用 Codex Desktop 式紧凑 Composer；
- 空闲状态显示播放图标，运行状态显示停止方块；
- 停止表示在安全检查点暂停，不等于撤销；
- 不使用通用“确定 / 取消”控制运行。
- Agent 面板在 Composer 下方固定显示弱化的“本次会话已消耗 N Credits”；这里的会话等于当前 Agent 任务线程；
- 同一任务线程跨页面、跨交付阶段、关闭客户端和稍后恢复时持续累计，新建任务线程时从零开始；
- 每轮交互完成后更新累计值，点击这一行才展开简单明细；余额正常时不显示账户总余额，余额较低时才增强提示并提供充值入口。

### 19.2 Agent 任务线程与工作范围

- Task Item 可以启动或关联项目内的 Agent Task Thread；没有 Task Item 时也允许从即时对话创建 Thread；
- Task Item 完成、取消或重新安排不等于隐式停止 Thread，运行控制必须作为独立动作；
- Agent 可搜索和读取整个项目；
- Agent 只能修改显式 Working Set；
- 需要扩大可编辑范围时，在原对话中说明具体文件并请求明确动作；
- 已完成修改直接落到工作副本，提供 Review 和 Undo，不逐项弹出确认。
- 不同项目的 Agent 任务可以并行运行；
- 同一项目允许多个只读任务并行，也允许 Working Set 不重叠的写任务并行；
- 写任务按文件或授权 subtree 获取互斥 Lease；父子目录、rename 源/目标和跨文件引用更新均参与重叠判断；
- 重叠写任务默认排队，或在前序任务提交后基于最新 revision 重算；不允许同时覆盖同一文件后依赖自动合并；
- 外部 Obsidian/WPS 不参与 Lease，最终提交仍执行 revision/CAS，冲突时保留 Base、Current 和 Proposed；
- 交付物各自独立目录，是 PPT、Word、HTML、视频并行制作的主要隔离边界。

### 19.3 注意力与通知

- 运行过程留在任务页，不持续发送系统通知；
- 导航侧轨和项目页持续显示运行或待处理状态；
- 只有完成、等待用户回答、可恢复失败和 Credits 不足触发一次系统通知；
- 点击通知准确返回项目、任务和上下文；
- 用户主动停止不显示为失败；
- 同一状态不重复通知。

## 20. 交付引导与四类交付物

### 20.1 统一入口

用户可以点击“制作交付物”，也可以在 Agent 对话中自然表达制作意图。两种入口进入同一 Skill Workflow。右侧 Agent 临时扩展，但必须持续保留完整对话、Composer、Working Set 和播放/停止控制。

内容不足时，缺口卡片作为对话中的结构化消息和快捷操作，不替代自由对话。Agent 每次只追问一个与当前内容相关的问题；补充结果先写回 Markdown，再进入正式制作。

### 20.2 SuperPPT 七阶段

1. 内容就绪；
2. 大纲；
3. 逐页规划；
4. 视觉风格；
5. 代表内容样张；
6. 完整生成；
7. 真实渲染 Review。

大纲、逐页规划和代表样张是必经确认点。风格阶段必须展示 SuperPPT 使用同一代表内容实际生成的效果图，不能只展示色板、字体或文字描述。风格预览保存在交付物的“风格预览”目录，选择结果写入“风格方案.md”。图片型高保真为默认结果，只对用户指定页面执行可编辑重建。

### 20.3 SuperWriter 七阶段

1. 内容就绪；
2. 写作要求；
3. 浅层顶级大纲；
4. 逐章写作和来源绑定；
5. 插图；
6. WPSComposer DOCX 格式化；
7. WPS 真实渲染 Review。

章节、来源、引用和插图均有可见中间文件。普通插图默认使用 ai-image-to-ppt 的图像能力，精确图解使用 Excalidraw。

### 20.4 HTML 七阶段

1. 内容就绪；
2. 发布目标；
3. 信息架构和组件；
4. 视觉方向；
5. 本地构建；
6. 桌面、平板和移动端真实浏览器 Review；
7. 一键发布。

HTML 只发布到官网提供的官方 Host，不提供第三方部署目标或自定义服务器。默认以“知道链接的人可访问”生成稳定分享链接；后续更新保持同一链接，并支持停止分享。发布只上传最终静态 site 输出，不上传项目文档、Agent 对话或内部日志。

第 4 阶段由 `HtmlTastePolicy` 生成可见的设计方向和代表性页面效果，用户确认后才进入本地构建。第 5–6 阶段必须检查布局重复、字体层级、色彩与圆角一致性、真实素材、响应式回流、键盘焦点、对比度、减少动效、LCP/CLS 预算和断链；生成技术栈由交付目标决定，不因上游规则偏好而强制使用 React、Next.js、Tailwind、Motion 或 GSAP。

### 20.5 视频五场景与八阶段

1. 内容就绪；
2. 制作场景与设定；
3. 内容脚本；
4. 分镜、素材计划与 Credits 估算；
5. 代表样片；
6. 素材生产；
7. 完整合成与媒体 QA；
8. 最终 Review 与导出。

五个制作 Profile 按优先级为：网站 Demo、教学课件、PPT 讲解、图片绘本和照片动态。Agent 根据用户目标和素材自动判断，只有不明确时才追问。内容脚本根据场景表现为网站操作步骤、课程讲稿、PPT 逐页讲稿、绘本故事或照片叙事顺序。

视频只有一个“制作视频”入口。Agent 根据当前 Content Scope、素材类型和用户目标自动识别 Profile，并在右侧对话中用一张紧凑卡片说明识别结果、依据、来源、预计时长和默认输出。用户轻量确认后才创建视频交付目录；识别不明确时才追问，识别错误时由用户直接用自然语言纠正，不展示五张场景选择卡。

PPT 讲解以已有 PPT/PPTX 为视觉事实源，使用真实 WPS/PowerPoint 渲染页，不由视频内核重新排版。视频 Workflow 只增加逐页旁白、字幕、停留时长、重点聚焦、光标/激光笔、受控翻页和视听包装；需要修改页面正文时返回 PPT Workflow，重渲染后再进入视频。

分镜、10–15 秒代表样片和最终 Review 是通用必经确认点，各 Profile 还可以增加自己的高风险确认。代表样片必须包含真实画面、运动、旁白和字幕，不能只用静态风格板代替。最终交付至少包含 MP4、SRT/VTT 字幕、封面和来源说明；修改通过 Agent 绑定到稳定的 scene、asset、narration 和 revision ID，不向普通用户开放代码或多轨编辑器。

视频制作台以中央播放器为主，底部使用紧凑场景导航，不提供多轨时间线。逐页讲稿、分镜、素材和媒体 QA 是同一中心区域的辅助标签；右侧 Agent 始终可用，用户围绕 scene、时间点、讲稿或样片提出修改。代表样片确认和最终 Review 使用同一制作台结构；最终状态显示场景级 QA，只有需确认项处理完毕后才开放导出，一次输出 MP4、字幕、封面和来源说明。

生产版使用 SuperWagie 自有的 Workflow、有限 Scene IR、HTML/SVG/Canvas 帧渲染器和 FFmpeg 媒体层，不复制或依赖 OpenMontage、Remotion 代码。具体定义见[轻量视频制作内核与五个首发场景](../../技术可行性/07-轻量视频制作内核-五场景.md)。

## 21. Office Review 与原生绘图

### 21.1 Office Review

- 中央视图使用真实 WPS / Office 渲染结果，不由 SuperWagie 重画 DOCX 或 PPTX；
- PPT 使用页面缩略图和单页视图；
- Word 使用连续页面视图；
- Review 批注、差异和 Agent 交互由 SuperWagie 原生层提供；
- ReviewShell、Preview Adapter、缓存和批注模型由 SuperWagie 独立实现；未安装 Codex Desktop 时必须完整工作，不读取、调用、连接或打包 Codex Desktop 的代码、资源、进程、IPC、配置与状态；
- 深度编辑明确进入 WPS；
- 若内嵌方案无法达到流畅滚动、缩放和批注门槛，首版使用并排或外部 WPS，不接受失真视图。

### 21.2 Excalidraw 与 draw.io

.excalidraw、.excalidraw.md 和 .drawio 是中心工作区的一等文档标签。两种画布保留各自原生工具和文件格式，并持续显示右侧 Agent。绘图可以嵌入 Markdown，也可以被 PPT、Word、HTML 和视频引用。

- 不建立 SuperWagie 私有绘图文件格式；Excalidraw 与 draw.io 的原生文件分别是唯一事实源；
- 普通项目新建 Excalidraw 默认使用 `.excalidraw`，Obsidian Vault 或已启用兼容模式的项目默认使用 `.excalidraw.md`；
- 打开已有 `.excalidraw`、`.excalidraw.md`、`.drawio` 或包含源数据的 `.drawio.svg/.png` 时，始终按原格式原位保存，不静默转换或迁移；
- SVG、PNG、PDF 和清理后的预览是派生产物，不反向成为普通文档的编辑真相；
- Agent 层共享创建、更新、连接、布局、导出等命令语义，但由 Excalidraw Adapter 与 draw.io Adapter 分别修改原生模型；
- 图层、页面、箭头绑定等格式专属能力通过独立 typed operation 保留，不为统一接口牺牲格式能力；
- 所有 Agent 绘图修改都必须结构校验、原子保存并支持 Review/Undo。

## 22. Credits、授权与任务恢复

### 22.1 Credits

- Credits 是 Agent 面板的附加状态，不作为交付引导的主内容，也不使用大块 Credits 卡片或独立确认页面；
- Composer 下方固定显示当前 Agent 任务线程累计消耗，默认采用弱化的小号文字；
- 每轮交互完成后累加；任务线程关闭、恢复或跨制作阶段时不清零，新建任务线程时从零开始；
- 点击累计信息才展开本次任务的简单消耗明细；正常余额不展示账户总余额；
- 可能消耗较多的长任务只在普通 Agent 回复中增加一行预计增量，不改变页面主层级；
- 余额较低时才增强固定状态行并提供充值入口；
- 余额不足时在安全检查点暂停；
- 充值后从检查点继续，不重复已完成工作或费用；
- Personal Wallet、Organization Wallet 和 reserve/settle 属于后台语义，不暴露给普通用户。

### 22.2 行内授权

所有确认保持 Codex 式行内交互，但按机制分为三类，不能用一个通用“确认框”混合：

1. **Workflow Gate**：内容是否就绪、方案/风格选择、阶段预览和交付验收；绑定 Workflow revision 与候选内容哈希；
2. **Risk Gate**：只处理四种风险——扩大可编辑范围、发布/分享/发送等外部动作、永久不可恢复删除、高成本 Credits 阶段；
3. **Install Gate**：用户 Skill/MCP 的来源、文件范围、网络目标、构建脚本、原生依赖和权限变化；绑定待安装版本与 Manifest hash。

按钮必须描述真实动作，例如“允许修改这 3 个文件”“发布并生成分享链接”“预计增加 80–120 Credits，继续生成”，不用通用“确定 / 取消”。普通、可逆、本地且已授权的操作不中断用户；低成本常规模型调用不逐轮确认。

### 22.3 状态模型

Agent Task Thread 的完整持久生命周期由 CAC §6.1 定义，包括 `ready`、`running`、可恢复中断、`completed` 与 `archived`。界面统一重点呈现的六类注意/结果投影是：已完成、等待回答、用户停止、Credits 不足、连接中断和可恢复失败；它们不是完整“六态状态机”，不得用来覆盖 ready/running/archived 等持久状态。所有长任务持续写入安全检查点：

- 停止不等于撤销；
- 连接恢复不重复执行；
- 重试不重复生成和扣费；
- 用户可看到已完成内容、暂停原因和下一步动作；
- 内部堆栈、模型错误和调用细节不直接暴露。

## 23. 极简设置与用户扩展

### 23.1 设置

设置采用无侧栏、无多级分类的单页界面，只保留：

1. 外观；
2. 是否恢复上次工作；
3. 关键任务通知；
4. WPS / Office Review 自动检测状态。

修改立即生效，不提供保存按钮。账户余额和消费主体位于头像菜单；充值、消耗记录、发票、企业成员和账户安全跳转官网。

### 23.2 用户扩展

- 系统内置能力不展示、不启停，也不出现在扩展列表；
- 用户扩展只允许 Skill 和 MCP；
- 安装、查看、启停和移除全部位于设置中的“用户扩展”子页；
- 项目工作区不出现安装或查看扩展入口；
- 设置子页提供自然语言输入，用户告诉 SuperWagie 要安装的名称、GitHub 地址、本地路径或 MCP 连接说明；
- SuperWagie 自动识别 Skill 或 MCP，并在安装前展示来源、文件范围和网络权限；
- 不提供按来源或类型选择的专门安装向导；
- 用户扩展可以通过 Public Capability Facade 调用 SuperWagie 已发布的文件、系统 Runtime、WPS、浏览器/网络、绘图、Artifact、Workflow 和托管 AI 等高层系统能力；与官方能力共用接口语义，不提供功能残缺的用户版 API；
- 用户扩展无法直接获得平台 API Key、底层模型信息、Codex App Server 原始协议、私有 Workflow/Prompt、任意 shell、其他 Agent 环境参数或宿主内部凭证；
- 进程隔离只隔离实现、状态、配置和权限，不隔离产品能力。已经声明并授权的普通调用不重复确认，高风险外部动作仍遵守统一行内授权。
- 用户 Skill 可以携带并运行已声明的 Python、Node 或原生脚本，MCP 可以声明本地 stdio server；全部由 Process Broker 按 ExecutionManifest、绝对 Runtime 路径、结构化参数和沙箱执行；
- 普通用户 Skill 不获得任意交互式 shell，也不能通过 `shell -c`、`cmd /c`、PowerShell `-Command` 或运行时拼接命令绕过 Broker；复杂逻辑写入 Skill 包内的版本化脚本；
- 内置能力开发期可使用显式 Developer Mode 诊断终端，但不属于生产用户扩展权限。
- V1 内置能力若需要 Python、Node、FFmpeg/codec、字体等可再分发 Runtime，只在只读 Signed Runtime Image 随基础安装一份并由 Runtime Manifest 固定；不读取系统/用户全局语言环境，不把 Electron Node 作为 Skill Runtime；
- 内置 Runtime 安装后必须做身份、签名/hash、版本、架构和 feature probe；缺失或失败表示安装损坏，进入修复/回滚，不是普通 Capability 降级；
- WPS/Office、Git 等外部宿主按绝对路径 feature probe；缺失时显示官方来源与重新检测，只禁用依赖能力，不由客户端静默安装；
- 官方内置能力的必要原生依赖在发布构建阶段完成并随签名安装包交付；用户 Skill 的依赖只在用户主动触发的扩展安装/更新事务中建立，优先使用已验证的预编译 wheel/binary，确需构建时进入独立 Installer Worker，不能拖到首次执行；
- 用户 Skill 必须在扩展安装前展示包来源、构建脚本、网络目标和产物，并取得一次明确授权；
- Installer Worker 不挂载 Workspace、用户主目录或凭证，只能访问声明的不可变制品和 staging；验证、SBOM 与环境签名完成后才原子提升，失败进入 quarantine；
- Skill 升级改变原生包、构建脚本、网络目标或权限时必须重新授权。

## 24. 已确认决策摘要

1. 主工作台是默认首页和进入工作的入口。
2. 智能工作区高于 PPT、Word、HTML、视频等交付形式。
3. 先加工内容，再选择交付和发布形式。
4. 每个交付物拥有独立制作目录。
5. 所有纯文本内容使用 Markdown。
6. Obsidian 文件格式和核心编辑体验严格兼容，但不实现完整插件 ABI。
7. 目录、文档和多选内容都是一等 Agent 加工范围。
8. 交付物制作台属于智能工作区，不拆成独立应用。
9. 内容不足时先引导补充，硬性缺口阻止制作，质量缺口可确认继续。
10. 第一阶段使用传统 Skill、MCP 和脚本完成调试与能力发版。
11. 第二阶段转译和封装为闭源能力，并与第一阶段进行等价验收。
12. 第二阶段 Rust-first，能可靠迁移的部分尽量转为 Rust，保留必要生态适配层。
13. Office Review 采用 WPS 渲染底图与 SuperWagie Review 交互层分工，是否内嵌进入首版由流畅性 PoC 决定。
14. 视觉采用暖调、克制、清晰的编辑式风格，不采用拟物设计。
15. 主工作台固定采用 A2 + I2 紧凑“开始工作”卡片。
16. 智能工作区三栏可拖动、折叠并支持专注和引导模式。
17. Markdown 自动保存，外部并行修改使用保留双方内容的安全合并。
18. Agent 采用播放 / 停止控制、项目任务线程、Working Set 和安全检查点。
19. 系统通知只用于完成、等待回答、可恢复失败和 Credits 不足。
20. SuperPPT 风格选择必须使用实际效果图。
21. HTML 只发布到官网官方 Host，并提供一键分享和停止分享。
22. 设置保持四项单页；系统内置能力不进入设置或扩展列表。
23. 用户扩展仅限 Skill 和 MCP，通过设置内的自然语言 Agent 安装。
24. 首发只支持受维护的现代 macOS 与 Windows 11，不为旧系统增加浏览器 Runtime、旧编辑器分支或额外兼容层。
25. Markdown 默认编辑内核采用 CodeMirror 6；Markdown 原文是唯一真相，Live Preview 只通过视觉装饰层实现。
26. Excalidraw 与 draw.io 各自保留原生文件作为唯一事实源；SuperWagie 只统一 Agent 命令契约，不建立私有 Diagram 持久化格式。
27. Agent Runtime 采用分层进程隔离；用户 Skill 通过 Public Capability Facade 调用与官方能力同语义的已发布系统能力，隔离不得造成用户 Skill 功能降级。
28. 用户 Skill 允许通过 ExecutionManifest 和沙箱化 Process Broker 执行已声明脚本、程序及 MCP stdio server；普通扩展不提供任意通用 shell。
29. V1 内置能力若仍需要 Python/Node，只在只读 Signed Runtime Image 随基础安装一份并共享；不读取或动态安装系统/用户 Python/Node，不把 Electron Node 作为 Skill Runtime。内置依赖缺失属于安装损坏，必须修复或回滚。
30. 官方内置能力的原生依赖在发布构建阶段完成并随签名安装包交付；用户 Skill 的原生依赖只能在用户明确触发的扩展安装/更新事务中，经预编译优先、权限受限、可审计的 Installer Worker 建立，不能拖到首次执行时临时补装。
31. Durable Workflow 机器状态保存在本机 App Data SQLite；项目仅保存人类投影、Artifact 和可迁移 checkpoint manifest，跨机器导入创建新 run 并禁止自动重放未完成外部动作。
32. 多项目可并行；同一项目的只读任务及 Working Set 不重叠的写任务可并行，重叠写任务由 Lease/fencing 排队或重算，不能同时覆盖后依赖自动合并。
33. 视频是第四类正式交付物，首发按优先级固定为网站 Demo、教学课件、PPT 讲解、图片绘本和照片动态五个 Profile；全部只由 Agent 驱动，不暴露代码、多轨时间线或 Skill 自带 UI。
34. 视频能力采用独立重写的轻量 Workflow、Scene IR 和帧渲染内核；OpenMontage 与 Remotion 仅作研究参考，其代码和运行时不进入生产依赖。
35. PPT 讲解视频为第三优先级 Profile；PPT/PPTX 真实渲染页是视觉事实源，讲解层不得重新排版或伪造原页面效果。
36. 视频只提供一个“制作视频”入口；Agent 自动识别五个 Profile，只有判断不明确时才追问，不预先展示场景选择卡或拆分工作台入口。
37. 视频制作台固定采用“中央播放器 + 紧凑场景导航 + 右侧 Agent”，不向普通用户提供多轨时间线。
38. 视频代表样片与最终 Review 复用同一制作台；最终导出前必须处理场景级 QA，一次交付 MP4、字幕、封面和来源说明。
39. Credits 只作为 Composer 下方的固定会话状态显示；每轮交互后按当前 Agent 任务线程累计，点击才展开明细，不再使用大块 Credits 卡片。
40. Credits 会话等于 Agent 任务线程；跨页面、跨交付阶段、关闭和恢复时继续累计，新建任务线程时从零开始。
41. Tasks 是一级工作模块；用户手动、Agent 对话和 Project Milestone 创建统一 Task Item，Markdown 保持事实源，项目自动任务只到 Milestone 粒度。
42. Electron Main 属于客户端可信计算基，但只作为非业务权威 Shell Controller；Rust Product Core 是唯一业务、数据与策略权威，高风险与长任务进入隔离 Worker。
43. CodeMirror Markdown 留在 `app_ui`；Excalidraw/draw.io 与 Artifact Preview 使用隔离 WebContentsView；视频、图表导出与浏览器 Review 使用独立 Electron Render Worker Host。
44. Renderer、Agent 和用户扩展只能提交 ClientIntent；身份、Project、有效授权、Billing 和风险上下文由可信网关注入，字节访问使用 audience-bound 短期 Resource Handle。
