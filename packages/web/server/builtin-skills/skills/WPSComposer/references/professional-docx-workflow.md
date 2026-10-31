# 专业 Word 排版工作流

用于新建或实质重排 DOCX：参考样式 → 任务内排版合同 → 能力映射 → 原生生成 → 几何与逐页视觉检查 → 保存重开验收。
合同是本次任务的执行记录，沿用用户已有要求；没有模板时直接采用下列可执行默认，不为常规选择反复询问。

## 1. 从参考文件提取有效样式

有参考 DOCX 时，先抽取封面、正文、每级标题、列表、表格、题注、页眉页脚、目录及分节各一组代表样本，记录页码与对象。
按“文档默认值 → 样式继承链 → 段落属性 → run 直接格式”核对有效格式；同时检查字符样式、编号/表格样式、主题字体和节属性的影响。
只读 `styles.xml` 的样式名称或单个 `w:rPr` 都不足以判断实际字体、字号和缩进。混合中西文分别记录，区分字号、行距模式、段前后距和空段。
OOXML 可证明声明的样式、继承关系、编号/域结构、节和直接格式；字体是否替代、最终换行分页、字段显示和视觉节奏须由目标原生编辑器与其 PDF 证明。
只有 PDF/截图时可提取视觉目标，不能推断原生样式、可编辑性或编号关联。无参考文件时跳到默认合同，不虚构企业模板。

## 2. 写出合同并逐项映射

在任务工作区记录以下内容；每项同时写“要求/来源、实现方式、最终观测值、差距”。实现方式只取：公开输入、当前固定默认、平台不支持。

| 合同项 | 必须明确的内容 |
|---|---|
| 用途与文体 | 读者、正式程度、已有模板要求；目标页数是软目标还是硬约束 |
| 页面角色 | 封面、目录/前置页、正文、横向图表页、参考文献；纸张、边距、栏宽、页码起点 |
| 文字与段落 | 中文/西文字体、字号、对齐、首行/悬挂缩进、行距模式、段前后距 |
| 标题体系 | Title 与 H1—H6、编号方案、目录深度、标题与下段同页；编号交给原生列表 |
| 表格与图 | 样式、可用宽度、列数与长文本、重复表头、跨页/合并规则；图尺寸与题注位置 |
| 字段与交付 | 页眉页脚、PAGE/TOC/SEQ/REF；接收编辑器、可编辑性检查、保存重开、请求格式 |

当前 M5 提供 `typography_profile: formal|compact-explainer`；省略时使用 formal。它不能复制任意 Word 模板，未公开任意正文/标题字体字号或页边距参数。无效 profile 会产生配置提示并回退默认值。
`preset="academic|business|proposal|consultant|tech"` 不改变 M5 正文、标题或边距；当前影响默认表格样式等受支持属性。不要从 preset token 推断成品字体。
无模板时用固定默认完成自动生成；有模板硬要求而接口不支持时，列出具体差距和受影响对象，先解决要求与能力的冲突，再生成正式交付物。
不得静默近似、发明 frontmatter 键，或先自选一套引擎不能落实的数值再依赖大量手工收尾。必要的新能力应明确作为 exporter 开发处理。

## 3. 当前 M5 可执行默认

以下是 `longform/policy.py` 与 `longform/plan.py` 的 formal 默认策略，须以本次运行计划和原生有效值复核；它不是任意公文标准合规声明。

| 对象 | 当前值 / 控制方式 |
|---|---|
| 页面 | 显式纵向 A4（595.28 × 841.89 pt），边距上下各 25.4 mm、左 30 mm、右 25 mm；理论正文宽 155 mm，仍须从原生文件/PDF 核对。宽对象独立横向节，随后恢复纵向 |
| 正文 | 中文仿宋 12 pt、西文 Times New Roman；两端对齐；1.5 倍行距；首行缩进 24 pt（2 字） |
| 正文段距 | `ensure_styles` 未显式发射段前/段后值；记录原生有效值，不把自行指定的段距当成已执行 |
| 封面 Title | 黑体 22 pt、西文 Times New Roman，居中加粗；非标题大纲级别，排除目录 |
| H1—H6 | 黑体、西文 Times New Roman；字号依次 16 / 15 / 15 / 14 / 14 / 12 pt；全部加粗 |
| 标题段距 | H1—H6 段前依次 16 / 14 / 12 / 10 / 8 / 6 pt，段后均 5 pt；`keepWithNext`；H1 居中，其余左对齐 |
| 目录与封面 | `toc: true` 启用三级目录；`title_page: true` 启用独立封面；标题/署名/日期走 frontmatter，不重复手写 |
| 编号与页码 | `heading_numbering` 选择受支持方案；封面不编号，前置页罗马数字，正文阿拉伯数字从 1 起；横向节后续接 |
| 表格 | academic 默认三线表，其他 preset 默认网格；可显式 `style="grid|three-line"`、`repeat_header=true`，表题在上方 |
| 图与引用 | 使用受支持的本地媒体及 `width` / `orientation`；图注在下方；`{{ref:id}}` 和题注使用原生域 |

表格固定列宽、任意表格字号、四级目录等目标不能当成已公开的 M5 输入。纸张与边距已进入原生计划，仍须核对保存文件中的实际页面。长表先按实际页面和边距预算内容宽度选择方向，再核对所选平台是否支持。
全部语法与范围见 [API reference](api.md)。Microsoft Word 的支持/拒绝边界见 [native Word](native-word.md)：尤其 macOS Word 的横向媒体节、合并表格和高级操作限制。
“Word 文档”通常指 DOCX；明确要求 Microsoft Word 执行才使用 `engine="msoffice"`，否则保持默认 `wps`。遇不支持操作报告具体限制，不自动换引擎或转到其他生成器。

逐条释义类文档可显式选择 `typography_profile: compact-explainer`，数值、来源注语法和完整示例见[紧凑中文释义](compact-chinese-explainer.md)。它与表格设计 `preset` 独立，不改变旧文档默认，也不自动改写用户内容。

正文、列表与标题保留 `**加粗**`、`*斜体*`、`~~删除线~~`、行内代码和 Markdown 链接；`<small>来源文字</small>` 为有界来源注（10 pt、`#555555`、正常字重），可与引用/引文同段使用。未指定的格式继承段落样式。标题标记不进入可见目录文字，原生编号保持语义关联；普通 Markdown 不提供任意 HTML/CSS。

引擎将 `lineSpacing` 的倍率数值与 `lineSpacingRule="multiple"` 分开传递；1.5/1.6 是倍数，不能误当固定磅值。正式默认段距仍沿用宿主有效值，紧凑 profile 才显式设置正文段前后距。

## 4. 离线核对实际计划，再生成

在可导入 `skills.WPSComposer` 的环境运行以下完整示例。它只构建计划、不启动原生应用、不写文件；打印实际模块来源、页面及样式操作。

```python
import inspect
import json
from pathlib import Path
from skills.WPSComposer.scripts.longform import build_longform_generation

markdown = """---
title: 排版验证样稿
title_page: true
toc: true
design: academic
heading_numbering: decimal
caption_numbering: global
---
# 排版验证样稿

## 总则

这是一段合成正文，用于核对中文与 Latin 文字、首行缩进和行距。

### 管理要求

短段与较长段均使用语义正文，不靠空格或空段模拟缩进与分页。

#### 检查记录

1. 核对结构与字段。
2. 核对原生保存后的结果。

:::table {#tab:checks caption="检查项目" style="grid" repeat_header=true}
| 项目 | 方法 | 状态 |
|---|---|---|
| 正文 | 检查有效样式 | 待检查 |
| 表格 | 检查换行与表头 | 待检查 |
:::

检查项目见 {{ref:tab:checks}}。
"""

print("runtime:", Path(inspect.getfile(build_longform_generation)).resolve())
build = build_longform_generation(markdown, base_dir=".")
for operation in build.plan.operations:
    if operation.op in {"writer.configure_page", "writer.ensure_styles"}:
        print(json.dumps(operation.to_dict(), ensure_ascii=False, indent=2))
```

将打印值逐项对照合同。离线计划证明请求内容与支持映射，不证明宿主执行、字体可用或分页正确。上述标题由封面消费后，正文从 H1 开始，不再手写编号。
随后在同一脚本/会话中调用真实生成；完整任务的媒体应使用源 Markdown 文件及其资源目录。

```python
from skills.WPSComposer import generate

path = generate(
    markdown, source_is_text=True, format="docx",
    output="layout-sample.docx", preset="academic", engine="wps",
    timeout=600, overwrite=False, open_result=True,
)
print(path)
```

`open_result=True` 只是发布后尽力打开。真实长文另用同一内容/引擎覆盖长段落、跨页表、宽图、题注、前置页和末页；短样稿不能证明这些场景通过。

## 5. 检查、修复和最终保存

1. **结构**：比对源内容、标题层级/原生编号、表格行列、题注和引用；封面标题只出现一次，目录不收录自身。检查局部降级和“生成质量提示”。
2. **几何**：公开 `generate()` 只返回文件路径，不提供完整内部质量 findings 的读取接口。记录返回结果及文档中的可见提示；另用同一引擎导出 PDF，独立检查越界、空页、孤立标题、题注分离、表格跨页、目录密度和页码，并记录采用的工具/坐标或页图检查方法。未取得内部明细写“未读取”，不调用私有入口补取。几何检查不评价字体气质、视觉层级或阅读节奏。
3. **逐页视觉**：为最终 DOCX 用同一引擎单独导出验收 PDF，渲染页图并实际查看每一页。检查缺字/替代字体、段落密度、留白、表格换行和首中末页表头、图片可读性、页眉页脚与末页；缩略总览不能替代逐页检查。
4. **修复**：只修真实问题，优先修改受支持的语义输入后重新生成。保留原生样式、列表和域；不对 M5 成品运行 legacy 编号后处理。涉及代码能力变更时遵守仓库排版回归守则。
5. **原生验收**：在接收编辑器打开最终 DOCX，核对字体与字段显示，保存、关闭、重开再检查；在测试副本插入同级标题验证自动重编号与目录更新。只“能打开”不等于可编辑结构通过。
6. **复验最终版本**：任何修正、字段更新或原生保存都使旧 PDF/截图失效。重新导出并检查最终保存文件，记录其哈希与证据；以真实页数报告，不能靠缩小正文或删内容凑页。

验收 PDF 的公开接口为 `convert_to_pdf(path, "qa/final.pdf", engine="wps", timeout=600, overwrite=False)`，先创建 `qa/`；所选引擎须与生成一致。PDF 仅作证据，不自动作为额外交付物。
M5 内部修复上限是两次生成、一次提示补丁、三次 PDF 导出；保留剩余问题与明确限制，不能把成功返回等同于无问题。

## 6. 交付记录

交付请求的文件，并用简短记录分别陈述下列证据；未执行项写“未验证”。

| 证据 | 记录内容 |
|---|---|
| 结构 | 内容/样式/编号/域检查方法及结果；离线计划与 DOCX 检查分开 |
| 几何 | 本次原生引擎、公开生成返回结果、可见提示；独立 PDF 检查方法、实际页数与发现；内部 findings 未取得则记“未读取” |
| 视觉 | 最终 PDF/页图来源、实际检查页范围、发现与修复结果 |
| 原生编辑 | 接收应用及版本、保存重开、测试副本编号/目录更新结果 |
| 身份与安装 | 输入和最终文件 SHA-256、实际 import 来源；skill 源码改动、安装入口生效、实机输出验收分别记录 |

只有源码文档更新时写“源码工作流增强”；只有入口/哈希检查时写“安装入口已核验”。这两者均不替代真实输出验收。
