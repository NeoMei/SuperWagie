# G0-SHELL-001：桌面壳核心交互 PoC

> **历史 fixture（2026-09-01）：** 本 fixture 验证 Tauri/System WebView 路线，只保留原始证据。当前 Electron/bundled Chromium 架构由 `G0-SHELL-002` 替代；本 fixture 的 GO/CONDITIONAL_GO 不具备当前生产准入效力，也不得继续演化为产品壳。

- Gate：gate-0（见 docs/技术可行性/技术验证执行计划.md §6）
- 所有者角色：Desktop Runtime
- 平台：macos-15-arm64、windows-11-x64
- 状态：脚手架与自动冒烟已实现（scripts/poc/gate-0/shell/ + shell-gate.mjs）；macos-15-arm64 自动检查 6/6 通过（evidence gate-0/20260829T151942Z-38050，decision_hint=CONDITIONAL_GO）。剩余：人工 checklist 8 项执行后以 --checklist-result 复跑签署；windows-11-x64 未验证。
  - 2026-08-29 修复：拖放改用 Tauri 原生拖放事件（HTML5 dnd 在 WKWebView 下不可靠，且原生事件返回真实文件路径）；缩放改为整页缩放并显示百分比；崩溃测试改为确定性窗口销毁重建（原内存炸弹只会冻结 UI，且渲染进程死亡不触发 Destroyed 事件，恢复入口永远无法激活）；新增前端自诊断横幅（__TAURI__ 注入失败时显式红框提示）。
  - 人工验收启动方式：双击 scripts/poc/gate-0/shell/SuperWagieShell.app（正规 .app 包，LaunchServices 支持的启动形态；裸二进制双击在部分环境下 __TAURI__ 注入会失败）。前端对注入失败有 5 秒重试自愈；每次启动会在数据目录写 shell-boot.json（pid/argv0/cwd），注入仍失败时把红框截图与该文件一起反馈。
  - 2026-08-29 拖放策略调整：wry 原生拖放事件在 macOS 26.x（WebKit 拖放注册行为变更）上不触发，改为 dragDropEnabled=false + 文档级 HTML5 dnd（记录文件名/类型/大小），原生事件保留为次要通道。待联网恢复后核对 wry/tauri 上游修复版本。
  - 2026-08-30 拖放策略再修正：HTML5 dnd 在 WKWebView 下本就不响应外部文件拖拽（这正是 wry 做原生处理的根本原因）。恢复 dragDropEnabled=true，并在 Rust 侧对 WKWebView 显式 registerForDraggedTypes(file-url)；macOS 26 Finder 拖拽不再携带 wry 依赖的 NSFilenamesPboardType，Drop 路径为空时由 Rust 从通用剪贴板读取 public.file-url 补全，前端经 path_info 命令记录文件名/类型/大小。HTML5 监听保留为次要通道。

## 固定输入

1. 中文测试文本集：常用句、生僻字、emoji、中英混排长段落（随 fixture 分发，不含用户隐私）；
2. 拖放测试文件集：md / png / pdf 各若干的固定副本；
3. 固定窗口布局配置：多标签、分栏与窗口尺寸的初始状态文件。

## 步骤

1. 以系统 WebView 构建最小 dev shell（仅含一个编辑视图和一个列表视图）；
2. 按 checklist 逐项执行：中文 IME 组合输入、剪贴板复制粘贴、文件拖放、页面缩放、布局保存后重启恢复；
3. 人为触发 WebView 渲染进程崩溃，验证恢复入口与状态还原；
4. 全程留存 screenshots/ 与操作记录（执行人角色、应用精确版本、每步结果）。

## 指标与阈值

- checklist 每项 pass/fail，任何阻断性缺陷即 fail；
- IME 组合键输入不丢字、不重复；
- 崩溃恢复后窗口布局与文档状态与崩溃前一致；
- 全部通过则 results.json pass=true，否则 fail。

## 当时的 Fallback 触发条件（已失效）

系统 WebView 无法达标时，记录具体缺陷并重评 Electron；不得静默降低验收标准。
