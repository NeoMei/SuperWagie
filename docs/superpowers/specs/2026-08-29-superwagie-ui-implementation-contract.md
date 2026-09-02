# 超级牛马（SuperWagie）UI 实施契约

> 状态：已确认原型的实施级补充；不重新设计视觉  
> 日期：2026-08-29  
> 视觉权威：`docs/界面原型确认索引.md` 指向的原型

## 1. 界面结构和 View ID

| View ID | 用户入口 | 必须保留的外框 | 主数据源 |
|---|---|---|---|
| `workbench` | 启动默认页、全局侧轨首页 | GlobalRail、账户入口 | Workbench projection、Project/Task Query、Artifact Query |
| `tasks` | GlobalRail 任务、工作台任务卡片、项目任务入口 | GlobalRail、TaskList、TaskDetail | Task projection、Project/Milestone Query、Agent execution links |
| `workspace` | 选择 Project/文件/开始工作 | GlobalRail、ProjectShell、AgentPanel | Workspace、Markdown/Diagram、Agent Session |
| `delivery` | “制作交付物”或 Agent 识别到交付意图 | 与 `workspace` 同一外框，AgentPanel 临时扩展 | Delivery Project、Workflow、Artifact |
| `review` | 打开已生成 Artifact/验收阶段 | GlobalRail、ProjectShell、AgentPanel | Artifact/Preview Revision、ReviewAnnotation |
| `settings` | GlobalRail 设置 | GlobalRail，单页主设置 | local preferences、capability health |
| `user_extensions` | 设置中的“用户扩展”子页 | GlobalRail、Settings header | Extension registry/install state |

`delivery` 不是与智能工作区平级的独立应用；它是 `workspace` 内的持久工作流状态。`settings` 和 `user_extensions` 是辅助视图，不计入四个核心工作视图。

## 2. 组件清单与唯一职责

| 组件 | 唯一职责 | 不允许承担 |
|---|---|---|
| `GlobalRail` | 工作台、项目、任务、交付物、设置和账户入口 | 扩展安装、模型选择 |
| `WorkbenchGrid` | 日历、待办、项目、统计和成果卡片排布 | Agent 长对话 |
| `StartWorkCard` | 紧凑输入“今天想完成什么”并进入轻量项目归属 | 横跨页面的大输入框 |
| `TaskQuickCreate` | 在工作台或 Tasks 中快速创建用户任务 | 暗中启动 Agent 或创建内部 Workflow Stage 任务 |
| `TaskList` | 今天、即将到期、全部、已完成和项目/来源/责任人筛选 | 保存第二套任务真相 |
| `TaskDetail` | 编辑任务、打开源文件、查看 Milestone/执行关联和开始/继续 Agent | 把 Task Item 状态与 Agent Thread 状态合并 |
| `ProjectShell` | Project 标题、三栏布局、宽度和折叠状态 | 文件语义或 Agent 执行 |
| `FileExplorer` | 真实目录/文件树、新建、重命名、移动、删除和拖放意图 | 直接写文件系统；必须通过 Workspace API |
| `DocumentTabs` | 打开文档、预览和绘图标签的顺序、激活、关闭和恢复 | 浏览器式粗重 Tab 造型 |
| `EditorHost` | 按文件类型承载 Markdown、Excalidraw、draw.io 或其他原生编辑器 | 自行越过 revision 协议保存 |
| `QuickSwitcher` | 当前 Project 优先的项目/文件/任务/交付物模糊切换 | 扩展商店搜索 |
| `AgentPanel` | 对话、结构化消息、Working Set、任务状态和 Composer | 设置、扩展管理 |
| `AgentComposer` | 文本/附件输入、工作范围、播放/停止 | 确定/取消通用弹窗 |
| `SessionCreditsLine` | 弱化显示当前 Task Thread 累计 Credits | 大卡片、余额主页 |
| `WorkflowStageRail` | 展示当前交付阶段、已完成阶段和可返回阶段 | 重新定义 Skill 阶段 |
| `HumanGateCard` | 问题、候选、Diff、影响范围和真实动作 | 只有“确定/取消”的无语义控件 |
| `ArtifactViewer` | 加载当前 Preview Revision 和显示真实/缓存/过期/兼容状态 | 伪造精确 Office 渲染 |
| `ReviewOverlay` | 批注、选区、差异、锚点状态和 Agent 修改请求 | 直接修改 Office 底图 |
| `AttentionCenter` | 只展示需用户注意的去重状态 | 重复通知流式输出 |

## 3. 布局度量与窄窗口

原型使用缩尺像素表达构图，实施使用以下桌面窗口度量：

- 支持的最小窗口：`960 × 680`；低于该尺寸只阻止继续缩小，不建立手机布局；
- GlobalRail：`48px` 固定；
- 左文件栏：默认 `240px`，最小 `200px`，最大 `360px`；
- 右 AgentPanel：默认 `360px`，最小 `320px`，最大 `520px`；
- 中心编辑/预览区：最小 `520px`；
- 交付引导中 AgentPanel 可临时扩展到 `405–520px`，离开后恢复用户上次宽度；
- Tasks：列表默认 `360px`、最小 `300px`、最大 `480px`，详情占剩余空间；窄窗切换为列表/详情单栏导航；
- `>= 1280px`：默认三栏；`960–1279px`：先折叠左文件栏为 drawer，中心与 Agent 仍并排；
- 内容专注模式同时折叠左右栏，保留 GlobalRail 和退出入口；退出后恢复原宽度/展开状态。

布局存储键为 `project_id + view_id + window_id`。应用恢复布局时必须先验证 Project/Tab 仍存在；丢失对象只从布局移除，不触发文件删除。

## 4. 文档标签和拖放

- 一个逻辑文件在一个 window 内只有一个 tab identity；重复打开只激活已有 tab；
- tab 保存 `workspace_id + file_identity`，不使用可变路径作唯一身份；文件重命名后 tab 继续指向同一文件；
- 关闭已修改 tab 先请求 EditorHost 提交；revision 冲突显示 Base/Current/Proposed，不用通用“是否保存”弹窗覆盖外部编辑；
- FileExplorer 拖动只创建 move proposal，展示目标、冲突、引用影响和权限，经 Workspace Transaction 提交；
- 将文件拖到 AgentPanel 默认加入 Content Scope，只读；要加入 Working Set 必须显示可写范围并获得授权；
- 外部文件拖入默认作为外部只读来源，只有用户选择复制入 Workspace 才创建新文件。

## 5. 焦点、快捷键与无障碍

| 动作 | macOS | Windows | 焦点规则 |
|---|---|---|---|
| 快速切换 | `⌘P` | `Ctrl+P` | 打开时焦点进入查询，关闭后返回原控件 |
| 内容专注 | `⌘⇧F` | `Ctrl+Shift+F` | 隐藏面板不卸载其状态 |
| 焦点 Agent Composer | `⌘J` | `Ctrl+J` | 不启动/停止任务，只移动焦点 |
| 关闭当前 tab | `⌘W` | `Ctrl+W` | 有未提交修改时走 revision 处理 |
| 停止当前 Agent 回合 | `Esc` | `Esc` | 仅在 Agent 正在运行且 Composer/对话拥有焦点时生效 |

- 所有图标按钮必须有可读 label/tooltip，播放与停止不能只靠颜色区分；
- 面板折叠、stage、tab、gate、批注和 Credits 更新使用适当 ARIA role/live region，不把每个 token 流式更新宣读给读屏；
- 键盘可以遍历 FileExplorer、DocumentTabs、WorkflowStageRail、ReviewAnnotation 和 Composer；
- 对话中新消息只在用户已停留底部时自动滚动；用户正在阅读历史时显示“有新消息”，不抢滚动位置；
- 缩放、高 DPI 和系统减少动效设置必须生效；不使用动画表达唯一状态信息。

## 6. 统一异步状态映射

| 业务状态 | 组件表现 | 必须提供的下一步 |
|---|---|---|
| initial/empty | 用户目标相关的空状态 | 新建、打开、授权或开始工作 |
| loading/streaming | 内容骨架或局部流式结果，既有内容不消失 | 停止、隐藏详情或继续阅读 |
| awaiting_user | HumanGateCard 作为结构化对话消息 | 选择真实动作或自然语言修改 |
| permission_denied | 显示被拒绝的具体 scope/capability | 保持拒绝、缩小范围或重新授权 |
| credits_blocked | Composer 附近紧凑提示，保留已完成内容 | 打开官网充值、更换已授权钱包或停止 |
| disconnected | 保留当前内容和 checkpoint 时间 | 自动重连、手动重试或稍后继续 |
| recoverable_failed | 显示失败范围、已完成产物和安全 checkpoint | 从检查点继续、更换 fallback 或导出已完成内容 |
| completed | 保留最终 Artifact、验收和 Session Credits | 继续对话、新建任务、打开制品或归档 |
| stale/outdated | 显示当前 revision 与来源已变化 | 重新渲染、重定位、对比或明确使用旧版 |

Task Item 的 `waiting_user/blocked` 与 Agent Thread 的 `credits_blocked/disconnected/recoverable_failed` 分栏呈现。用户完成 Task Item 时若仍有活跃执行，必须提供“仅标记任务完成”和“停止关联执行”两个真实动作，不允许一个 checkbox 暗中停止 Agent。

Tasks 的实施视觉基线为 `tasks-implementation-prototypes.html`，包含四个必须实现的界面状态：

1. `tasks.main`：今天/即将到期/全部/已完成、快速创建、筛选、统一列表和详情；
2. `tasks.origins`：manual、agent、project_milestone 三种创建来源进入同一列表，来源与责任分开表达；
3. `tasks.execution`：Task Item 状态与 Agent Task Thread 状态并列，完成任务时显示两个真实动作；
4. `tasks.recovery`：user override、superseded、tombstone 和 Base/Current/Proposed 冲突恢复。

异步组件不得只有 spinner、不可关闭弹窗或底层错误码。内部堆栈、Provider、模型、API Key 和其他 Agent 环境不进入用户文案。

## 7. 交付阶段的稳定 UI ID

| 交付物 | 稳定 stage ID（按顺序） |
|---|---|
| SuperPPT | `ppt.content_ready`、`ppt.outline`、`ppt.page_plan`、`ppt.visual_style`、`ppt.representative_sample`、`ppt.full_generation`、`ppt.rendered_review` |
| SuperWriter | `writer.content_ready`、`writer.requirements`、`writer.top_outline`、`writer.chapter_writing`、`writer.illustrations`、`writer.wps_composition`、`writer.rendered_review` |
| HTML | `html.content_ready`、`html.publish_goal`、`html.information_architecture`、`html.visual_direction`、`html.local_build`、`html.browser_review`、`html.official_publish` |
| Video | `video.content_ready`、`video.profile_settings`、`video.script`、`video.storyboard_assets`、`video.representative_sample`、`video.asset_production`、`video.composition_qa`、`video.final_review_export` |

单页返工、按页可编辑重建、一致性审查、静态包导出和媒体子检查是 stage 内 action，不增加第二套 Stage ID。

## 8. 视觉 token 和禁用方向

- 基础色使用象牙白/奶油白/米灰，全局侧轨使用深暖灰，主强调使用克制暗红/灰粉；
- 边界和阴影只用于层级，不使用 Neumorphism、Claymorphism、高浮雕卡片或模糊内容边界；
- 文档标题可使用编辑式衬线字体，操作、表单、文件树和对话使用清晰无衬线字体；
- 不重画已锁定的首页；`confirmed-i2-original-replay.html` 是唯一首页视觉基线。

## 9. 组件验收最小集

每个 View 在进入生产切片前必须提供：

1. 正常数据截图/录屏与确认原型对照；
2. 第 6 节全部异步状态的组件测试；
3. `1280×720`、`1440×900`、`1920×1080` 及 125%/150% 缩放验收；
4. macOS/Windows 中文 IME、键盘、剪贴板、拖放和焦点往返；
5. 读屏 label、键盘可达、对比度、减少动效和无焦点陷阱；
6. 关闭恢复后 tab、pane、Task Item、task thread、workflow 和 Credits 边界不串状态；
7. 手动、Agent 对话和 Project Milestone 创建的任务进入同一 Tasks 视图，自动任务不会细化到 Workflow Stage。
