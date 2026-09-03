# 规则包：界面骨架与交互契约（ui-shell）

适用范围：View 结构、组件职责、布局度量、标签页、快捷键与无障碍、异步状态、视觉 token。视觉权威是 docs/界面原型确认索引.md 指向的原型；本文只锁实施行为。

## R-US-01 View 结构与外框固定

七个 View ID（workbench / tasks / workspace / delivery / review / settings / user_extensions）与各自必须保留的外框按 UIC §1 执行；delivery 是 workspace 内的持久工作流状态，不是独立应用。[UIC §1] [UI-01]

## R-US-02 组件唯一职责不可越权

每个组件只承担 UIC §2 分配的唯一职责，禁止承担“不允许承担”列中的行为；组件模块归属以 CAC §3 模块边界表为准。[UIC §2] [CAC §3] [UI-02]

## R-US-03 布局度量与窄窗口

最小窗口 960×680；GlobalRail 48px；左右栏默认/最小/最大宽度、交付阶段 AgentPanel 临时扩展与恢复、布局存储键 project_id + view_id + window_id 按 UIC §3 执行。[UIC §3] [UI-09]

## R-US-04 标签身份与拖放语义

一个逻辑文件在一个 window 内只有一个 tab；tab 用 workspace_id + file_identity 定位，不用可变路径；FileExplorer 拖动只产生 move proposal，拖入 AgentPanel 默认只读加入 Content Scope。[UIC §4] [CAC §4] [UI-03]

## R-US-05 快捷键、IME 与无障碍

⌘P / ⌘⇧F / ⌘J / ⌘W / Esc 的行为与焦点规则按 UIC §5；中文输入法组合、剪贴板、读屏 label、键盘可达、减少动效必须真实生效；播放与停止不能只靠颜色区分。[UIC §5] [UI-06] [UI-07]

## R-US-06 异步状态统一映射

九类业务状态（initial、loading、awaiting_user、permission_denied、credits_blocked、disconnected、recoverable_failed、completed、stale）的组件表现与下一步动作按 UIC §6 映射；Task Item 状态与 Agent Thread 状态分栏呈现，完成任务时提供“仅标记任务完成”和“停止关联执行”两个真实动作。[UIC §6]

## R-US-07 工作台实时与全局切换

主工作台的日历、待办、统计使用统一查询模型增量更新；QuickSwitcher 当前项目优先，文件/任务/交付物统一索引。[UIC §1] [UIC §2] [UI-08] [UI-10]

## R-US-08 交付阶段稳定 ID

四类交付物的阶段只使用 UIC §7 的稳定 stage ID；动态引导表单与统一预览按 Guided Workflow 协议实现，不重定义阶段。[UIC §7] [UI-04] [UI-05]

## R-US-09 视觉 token 与禁用方向

基础色为象牙白/奶油白/米灰、深暖灰侧轨、克制暗红强调；边界和阴影只用于层级；禁用 Neumorphism、Claymorphism 与拟物效果；首页唯一视觉基线是 confirmed-i2-original-replay.html。[UIC §8] [WD §15.1]

## R-US-10 设置与扩展子页

设置主页面固定四项（外观、启动恢复、关键任务通知、Viewer 诊断与缓存空间）；诊断项只展示格式、Chunk、字体、缓存和修复状态，不把外部 Office 宿主暴露为 Viewer 依赖。用户扩展是设置内子页，账户与 Credits 在头像菜单。[UIC §1] [CAC §2.3] [VIEWER §6.4] [UI-11]

## R-US-11 组件验收最小集

进入生产切片前按 UIC §9 提供原型对照截图、全部异步状态组件测试、分辨率与缩放矩阵、双平台 IME/键盘/拖放往返、无障碍与恢复边界证据。[UIC §9]

## R-US-12 唯一桌面壳与 Surface 分类

Electron + 随基础安装包分发的 Chromium 是唯一首选桌面壳。Workbench、Tasks、Agent 与 CodeMirror Markdown 同属沙箱化 `app_ui`；Excalidraw/draw.io 使用 `diagram_editor` WebContentsView；Artifact Review 使用 `artifact_preview` WebContentsView；视频/图表/浏览器 QA 使用独立 Electron Render Worker Host。各 Surface 按 BCRA §6 使用最小权限与 ephemeral session，外部授权使用系统浏览器。旧 Tauri/System WebView 结果只作历史证据；新壳必须通过 BCRA §18 的 Gate，不维护双壳或静默 fallback。[BCRA §2] [BCRA §4] [BCRA §6] [BCRA §18] [UI-01] [UI-07]

## R-US-13 UI Query 与恢复协议唯一

产品 UI 只通过 UI Query Gateway 读取 Snapshot 和增量订阅，不复用 Public Capability Facade，也不把 Web Storage 当领域真相。每个 Snapshot 带 revision/projection version，每个订阅带 Event Cursor；cursor gap、projection 变化或 Core 重启必须进入 resync_required 并重读 Snapshot，Renderer 崩溃后按同一协议恢复。[CAC §5] [CAC §8] [BCRA §8] [UI-08]

## R-US-14 Universal Viewer Surface 状态

`artifact_preview` 承载独立 Universal Viewer Surface，ViewerShell 显示格式、Revision、诊断与专属导航；状态只能是 Viewer Contract 的 `detecting/loading/password_required/ready/partial/unsupported/too_large/corrupt/failed_recoverable/failed_terminal/stale/cancelled`。密码、超限、损坏、能力禁用和事务导出必须给出安全下一步。[UIC §2] [VIEWER §4.2] [VIEWER §7]
