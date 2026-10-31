# 紧凑中文逐条释义

用于规则释义、条款解释和内部操作说明。显式设置 `typography_profile: compact-explainer`；默认仍是 `formal`。它是排版 profile，与主要控制默认表格样式的 `preset` 独立，不是公文标准合规声明。用户模板和明确要求优先，排版不自动改写、删减或重组用户内容。

## 样式合同

| 角色 | 已实现请求值 |
|---|---|
| 文档题名 Title | 中文宋体 16 pt，加粗居中；非大纲标题，不入目录 |
| H1 | 宋体 13.5 pt，加粗左对齐；段前 15 pt、段后 7.5 pt |
| H2 | 宋体 11.5 pt，加粗左对齐；段前 12 pt、段后 4.5 pt |
| H3—H6 | 宋体 11.5 pt，加粗左对齐；段前依次 10 / 8 / 6 / 4 pt，段后 4.5 pt |
| 正文 | 宋体 10.5 pt，两端对齐，1.6 倍行距；无首行缩进；段前后各 2.25 pt |
| 来源注 `<small>` | 10 pt、`#555555`、正常字重；其他未指定格式继承段落 |
| 西文 / 行内代码 | Times New Roman / Consolas |
| 页面 | 显式纵向 A4（595.28 × 841.89 pt）；上下 25.4 mm、左 30 mm、右 25 mm；宽对象横向节后恢复纵向 |

标题保留 `keepWithNext`；封面、目录、页码和原生标题编号仍按已有语义配置。profile 本身不会开启封面或目录，也不会将手写数字变成另一套编号规则。H1 等指题名消费和层级归一化后的正文标题。

## 可运行的离线示例

```python
from skills.WPSComposer.scripts.longform import build_longform_generation

markdown = """---
title: 操作说明
typography_profile: compact-explainer
heading_numbering: decimal
---
# 操作说明

## 检查要求 <small>来源：内部操作规则</small>

**目的：**保留用户原文，核对 *重点*、~~旧说明~~、`状态码` 与 [帮助](https://example.com)。

1. **检查：**记录实际结果。<small>来源：检查清单</small>
2. **处理：**按现有流程执行。
"""

build = build_longform_generation(markdown, base_dir=".")
for operation in build.plan.operations:
    if operation.op in {"writer.configure_page", "writer.ensure_styles", "writer.add_heading", "writer.add_paragraph", "writer.add_list"}:
        print(operation.to_dict())
```

真实输出使用公开 `generate(markdown, source_is_text=True, format="docx", output="compact-sample.docx", engine="wps")`。离线计划不启动 Office，不能证明原生分页或字体可用。

正文、列表、标题支持局部加粗、斜体、删除线、行内代码、超链接及有界 `<small>…</small>`，并保留同段的引用/引文语义。`<small>` 仅对字面文本应用来源注格式；其中引用/引文仍保留语义域和默认域格式。Word 支持普通富文本列表，当前拒绝包含结构化引用/引文的列表。来源注可自然换行；标记不进入标题可见文字和目录。普通 Markdown 不暴露任意 CSS、任意字体/字号或通用 HTML。未指定格式继承段落；来源注显式恢复正常字重，避免继承标题加粗。

## 验收方法

以最终 run 有效格式为准：按文档默认、样式继承链、段落属性、字符样式和 run 直接格式核对；不能仅读取段落结束标记或单个 `w:rPr`。记录请求字体与目标应用实际字体，区分 half-point、twip、pt 和行距倍率。引擎以独立 `lineSpacing=1.6` 与 `lineSpacingRule="multiple"` 请求倍数行距。

同一合成样稿覆盖短长段落、标题同行来源注、局部强调、跨页条目及末页。按[专业 Word 工作流](professional-docx-workflow.md)检查实际 A4/边距、结构与内容保全，并在接收编辑器保存重开后用同一引擎导出 PDF、逐页检查。精确页数和换行依赖内容、字体和原生应用；配置或离线测试不能替代实机验收。Windows/Word 的新能力原生验收须另行记录。
