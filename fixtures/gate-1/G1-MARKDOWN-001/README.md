# G1-MARKDOWN-001 — Obsidian 方言无损往返

- Owner role: Markdown Engine
- 平台: macos-15-arm64
- 执行器: scripts/poc/gate-1/markdown-gate.mjs
- 运行: ./scripts/poc/run-gate.sh gate-1 --fixture G1-MARKDOWN-001 --platform macos-15-arm64
  （加 --obsidian-vault <vault-dir> 将样本准备到真实 Obsidian Vault；人工验收后可加 --checklist-result <path> 翻正为 GO）

## 固定输入

- fixtures/torture.md：frontmatter（含自定义字段）、WikiLink/Embed/块引用、callout、脚注、数学、mermaid、dataview 等未知插件块、HTML 注释与原生 HTML、任务与块 ID、CJK/emoji/RTL、Excalidraw markdown 容器
- fixtures/checklist.md：真实 Obsidian 宿主人工验收步骤（R-QS-02）

## 阈值

- 无编辑往返字节一致
- 三处语义编辑后，全部未知语法区域字节不变
- Excalidraw 容器：场景 JSON 更新后 markdown 壳字节不变
- 过期 revision 提交被拒绝，按块 ID 重定位后成功且外部修改保留
- 索引计数与 fixture 预期一致

## 证据

results.json checks；编辑产物 torture-edited.md、conflict-resolved.md 落 artifacts；传入 --obsidian-vault 后，torture-edited.md 同时进入 Vault 的独立 run 目录，并由 当前验收.md 指向本次人工验收样本。

## SuperWagie 编辑器界面补充验证

`scripts/poc/gate-1/markdown-editor-poc/` 补足本 fixture 原先只验证 Markdown 引擎与
真实 Obsidian 宿主、没有验证 SuperWagie 自身编辑界面的缺口。该 PoC 使用真实
Electron/Chromium + CodeMirror 6 覆盖 Live Preview、Reading、Source、中文组合输入、
保存重开、外部修改冲突、WikiLink/Embed、PNG 与 `.excalidraw.md`。其结论只能记为
macOS 技术路径已证明；不能替代 Windows 同 fixture，也不能替代正式产品实现和 Owner
签署。
