# Markdown Live Preview 本机验收

日期：2026-09-05。平台：macOS 26.6.2 / arm64，Electron 44.1.0。

## 修正的产品行为

按 WD §17.5、R-WM-02：打开 Markdown 默认进入实时预览；光标/选区涉及的语法范围展开原文，其他范围就地渲染。源码与阅读是独立模式，通过同一文档和历史切换。原来的“编辑 / 分栏 / 预览”不满足该要求。

基准语义来自 [Obsidian 官方编辑模式说明](https://obsidian.md/help/edit-and-read)。应用外框继续使用 SuperWagie 的确认视觉。

实现为 CodeMirror source-range decorations，直接保留文本节点和源位置；标题、强调、删除线、代码、WikiLink/Markdown 链接、列表、任务框、引用、Callout、属性和表格具有就地编辑表现。表格当前在进入其源范围时展开 Markdown 表格，不声称已实现 Obsidian 的完整单元格编辑器。

## 可重复验证

```sh
npm --prefix apps/desktop test
node scripts/check-spec-refs.mjs
```

新增真实 Electron suite `apps/desktop/scripts/test-live-preview.mjs` 使用独立临时 Project 与状态目录，检查：

- 默认就地渲染；点入粗体仅展开相关语法；点击文字中间精确插入并撤销；
- 方向键、Shift 跨段选区、跨块全选、双击选词；光标移动不改文件；
- 任务框仅修改自身标记；表格点击/离开恢复呈现；WikiLink 别名展开完整目标；
- 活动 HTML 不执行，代码中的 Markdown 标记不被解释；
- 实时预览/源码/阅读切换保持编辑历史，⌘E 往返恢复编辑模式；
- Chromium 组合输入中不落盘预编辑文本，提交后保存；
- 真实 CodeMirror 编辑并保存 CRLF 文件后换行保持；
- 800 段 Markdown 的末尾输入与保存，文件字节一致。

本机结果与截图输出到 `apps/desktop/test-results/live-preview/`，不提交生成证据。结果记录实际平台、实现文件 hash、各项检查和长文输入耗时。原有 `test:ui` 继续验收自动保存、三种冲突动作、外部重命名、关闭重开、Core 崩溃恢复与撤销授权。

## 尚未由本 suite 证明的范围

- 系统中文输入法候选窗与真实 Obsidian 逐项操作对照；组合测试使用 Chromium `Input.imeSetComposition`；
- 完整 Obsidian 语法、数学/Mermaid、附件/Embed 与表格单元格操作的全部等价性；这些仍属于原定兼容要求，不能凭本次测试勾选整体 MD-09；
- Windows 与跨平台验收。

`admission_effect: none`；本次结果是光标驱动编辑的本机实现证据。
