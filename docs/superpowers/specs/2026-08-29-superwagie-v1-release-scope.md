# 超级牛马（SuperWagie）V1 发布范围基线

> 状态：产品范围权威基线  
> 日期：2026-09-01  
> 原则：不擅自裁掉已确认能力；用内部里程碑和技术 Gate 控制大范围首发

## 1. 范围状态

| 状态 | 含义 |
|---|---|
| `V1_REQUIRED` | V1 对外发布前必须完成对应用户闭环和验收 |
| `V1_CONDITIONAL_FALLBACK` | 用户目标必须实现，但在高体验路径 PoC 未达标时使用已定义的降级路径 |
| `DEFERRED` | 明确不进入 V1；重新纳入前必须重做影响分析和准入 |

范围状态只回答“V1 是否要有”，不等于技术证据状态。`V1_REQUIRED` 仍可以是 `RESEARCH_REQUIRED`；这意味着它阻止发布，不意味着技术已被证明。

## 2. V1 必须能力

| 能力组 | V1 最小用户闭环 | 状态 | 主准入门 |
|---|---|---|---|
| 官网与账户 | 注册、登录、下载、个人/企业充值、消耗、发票和账户 | `V1_REQUIRED` | Gate 6 |
| 封闭 Agent Runtime | 内置固定 Runtime，不发现或复用机器其他 Codex/Agent 配置，可与它们并行运行 | `V1_REQUIRED` | Gate 0 |
| Electron、Rust Product Core 与隔离 Worker | Electron 是唯一首选桌面壳；Main 只作非业务权威 Shell Controller；Rust Core 统一业务/数据/策略；CodeMirror、图表/Preview、后台 Render 分 Surface，高风险和长任务分 Worker | `V1_REQUIRED` | Gate 0、4、6 |
| 安装完备依赖与外部宿主 | OS Baseline、Signed Runtime Image、External Host、User Extension Environment 四层明确；可再分发的 Chromium、App Server、必要内置 Runtime、FFmpeg/codec、字体和静态资源随安装完备；WPS 等外部宿主按绝对身份 feature probe | `V1_REQUIRED` | Gate 0、6 |
| 主工作台 | 时钟、日历、待办、项目、统计、最近成果和紧凑“开始工作”入口 | `V1_REQUIRED` | Gate 0、1 |
| 项目与 Workspace | 一个 Project 绑定一个授权本地根，支持事务写入、CAS、外部编辑和恢复 | `V1_REQUIRED` | Gate 1 |
| Obsidian 式 Markdown | 真实文件、Live Preview/Reading/Source、WikiLink、Backlink、标签、属性、任务、搜索和不损坏未知语法 | `V1_REQUIRED` | Gate 1 |
| 任务管理 | Tasks 一级模块；手动、Agent 对话和 Project Milestone 三种创建来源；Markdown 事实源、稳定身份、semantic patch、Milestone 幂等更新和工作台/项目/日历投影 | `V1_REQUIRED` | Gate 1、2 |
| 原生绘图 | Excalidraw 和 draw.io 离线创建、编辑、保存、嵌入、导出和 Agent 高层操作 | `V1_REQUIRED` | Gate 1 |
| Agent 工作区 | 三栏工作区、持久任务线程、Working Set、播放/停止、恢复、行内授权和 Session Credits | `V1_REQUIRED` | Gate 2、6 |
| Managed AI | 官方和用户 Skill 通过同一平台接口获得 chat/reason/vision/OCR/image 等能力，用户不见模型、Provider 和 Key | `V1_REQUIRED` | Gate 2、5、6 |
| Durable Delivery Framework | 内容就绪门、Content Baseline、Human Gate、局部失效、检查点、独立交付目录和 Artifact Center | `V1_REQUIRED` | Gate 2 |
| SuperPPT | 七阶段完整闭环，默认图片型高保真，按页可编辑重建，真实 WPS/PowerPoint 验收 | `V1_REQUIRED` | Gate 3 |
| SuperWriter | 七阶段长文档闭环，来源绑定、逐章写作、插图、WPSComposer DOCX/PDF 和真实 WPS 验收 | `V1_REQUIRED` | Gate 3 |
| HTML 交付 | 七阶段制作、内置 HTML Taste 设计增强、真实浏览器 Review、静态包和官方 Host 一键发布/分享/更新/回滚/停止分享 | `V1_REQUIRED` | Gate 3、6 |
| 视频交付 | 单一入口和网站 Demo、教学课件、PPT 讲解、图片绘本、照片动态五个 Profile，八阶段、样片、QA 和导出 | `V1_REQUIRED` | Gate 4、6 |
| Office Review | 真实 WPS/Office 渲染页、渐进加载、批注、差异、修改回执和版本确认 | `V1_CONDITIONAL_FALLBACK` | Gate 3 |
| 用户扩展 | 设置内由 Agent 安装/更新/回滚/移除 Skill 和 MCP，可经授权调用 Public Capability Facade | `V1_REQUIRED` | Gate 5 |
| 项目连续性 | SessionReviewer 只消费 SuperWagie 自身事件，产生项目回顾、项目历史和演化视图 | `V1_REQUIRED` | Gate 2、5 |
| AgentWiki | 官方 Connector 支持授权、项目绑定、Pull/Push 预览确认、冲突处理、部分成功恢复、审计、只读查询桥和项目记忆共享（个人私有区跨设备、团队共享记忆空间） | `V1_REQUIRED` | Gate 5 |
| Roundtable | 作为 Private Workflow 在工作区由 Agent 驱动，结果回写 Markdown，不暴露独立 Skill UI | `V1_REQUIRED` | Gate 2、5 |
| Agent Profile 与 Safe Memory | 用户可见、可删除、可审计，按 scope 隔离，记忆作为不可信上下文 | `V1_REQUIRED` | Gate 5 |

连续性与 Profile/Safe Memory 的详细产品语义以 `2026-08-29-superwagie-continuity-profile-memory-design.md` 为权威规格。Connector 授权、项目绑定、同步与项目记忆共享的详细产品语义以 `2026-08-29-superwagie-connector-sync-design.md` 为权威规格。

## 3. 已确认 fallback

| 高体验路径 | 达标条件 | V1 fallback | 不变的产品语义 |
|---|---|---|---|
| Electron + bundled Chromium | 中文 IME、剪贴板、draw.io、复杂编辑、独立 Render Worker、沙箱和崩溃恢复达标 | 无静默双壳 fallback；失败则阻止发布并重新裁决架构 | Rust Product Core、Workspace、Workflow 和 Agent 契约不变 |
| 内嵌 WPS 渲染 Review | 滚动、缩放、批注、缓存和重渲染达标 | 外部/并排 WPS + SuperWagie Review 面板 | 视觉事实仍来自 WPS/Office，不用近似重绘顶替 |
| macOS WPS 结构化 inspect/edit | JSAPI/UI adapter 通过目标版本 PoC | 在 WPS 受控副本中完成编辑与重开验收 | 不在 macOS 假称拥有 Windows COM 对等能力 |
| 外部不可再分发 Runtime/宿主 | 绝对路径、版本和 feature probe 通过 | 禁用依赖该宿主的能力并给出官方下载说明；客户端不静默动态安装 | 工作台、Markdown 和 Agent 核心不因 WPS 等外部宿主缺失而失效 |

## 4. V1 明确暂缓

| ID | 能力 | 范围状态 | 重新纳入的最低条件 |
|---|---|---|---|
| DEF-01 | 云同步、多人实时协作和全 Workspace CRDT | `DEFERRED` | 完成身份、冲突、加密、离线和服务成本设计 |
| DEF-02 | 完整知识图谱和高级向量检索 | `DEFERRED` | 本地检索指标证明不足，并完成数据/包体评估 |
| DEF-03 | Skill Store 和大规模插件生态 | `DEFERRED` | 用户 Skill/MCP 安全闭环与审核治理已被证明 |
| DEF-04 | 完整 Obsidian Plugin API、任意第三方插件、主题和 CSS snippets | `DEFERRED` | 为安全兼容层建立独立产品和沙箱方案 |
| DEF-05 | draw.io 在线协作和第三方在线插件 | `DEFERRED` | 先完成离线原格式闭环和网络权限模型 |
| DEF-06 | 复杂企业部门预算、多级审批和全量数据治理 | `DEFERRED` | 个人/企业钱包、基础角色、充值和审计先稳定 |
| DEF-07 | 本地模型 | `DEFERRED` | 产品方向重新确认并完成安全、包体和计费分析 |
| DEF-08 | 系统/第三方日历双向同步 | `DEFERRED` | 作为 Connector 单独完成授权、冲突和审计 PoC |
| DEF-09 | 将全部历史 Skill、Web 编辑器和 Office 适配强制重写为 Rust | `DEFERRED` | 必须有独立包体/性能证据且不破坏成熟生态能力 |

## 5. 内部实施里程碑

里程碑只决定调试顺序，不将 V1 拆成对外不同产品。只有全部 `V1_REQUIRED` 闭环通过后才进入 V1 发布候选。

1. **Milestone A — 契约与验证底座**：Schema、fixture、Gate runner、证据目录和可观测性；
2. **Milestone B — 本地内容闭环**：桌面壳、封闭 Runtime、Workspace、Markdown、任务、工作台、绘图；
3. **Milestone C — Agent 与持久工作流**：Task Thread、Working Set、Checkpoint、Human Gate、Managed AI、Credits 模拟账本；
4. **Milestone D — 文档交付**：SuperPPT、SuperWriter、HTML、Artifact Center、WPS/Office Review 与 Official Host 测试环境；
5. **Milestone E — 视频交付**：五 Profile、Scene IR、样片、合成、媒体 QA 和时间点 Review；
6. **Milestone F — 扩展与连续性**：用户 Skill/MCP、SessionReviewer、AgentWiki、Roundtable、Profile 与 Safe Memory；
7. **Milestone G — 商业与发布工程**：真实个人/企业 Credits、充值、官方 Host、签名、公证、升级、SBOM 和故障注入。

## 6. 变更规则

- 将 `V1_REQUIRED` 改为 `DEFERRED` 是产品范围变更，必须获得明确产品确认；
- 将 `DEFERRED` 重新纳入必须补技术矩阵 ID、风险、PoC、fallback 和发布影响；
- fallback 只能替换技术表现方式，不能删除用户完成工作的闭环；
- 实施里程碑允许调整，但不自动改变 V1 范围。
