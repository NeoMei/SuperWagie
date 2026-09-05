# 规则包：Markdown 工作区与编辑体验（workspace-md）

适用范围：Markdown 编辑器、保存与恢复、外部修改同步、文件目录结构、Obsidian 兼容行为。

## R-WM-01 Markdown 是唯一事实源

所有用户内容的权威副本是项目内 Markdown 文件；Derived Index、缩略图、缓存都可以删除重建，索引不得反写或替代文件内容。[WD §6.4] [MD-02] [MD-10]

## R-WM-02 编辑体验对齐 Obsidian

编辑器必须覆盖 Live Preview、Reading View、Source Mode 三种形态与无损 AST（含 Frontmatter、WikiLink、Callout、未知插件语法 passthrough）；实现选型为 CodeMirror 6（已确认决策 25），未经重新决策不得更换为普通 textarea 或纯渲染视图。[WD §6.1] [WD §6.3] [WD §24] [MD-01] [MD-09]

Live Preview 必须是默认编辑形态：同一编辑区内，光标/选区涉及的语法范围展开原文，其他范围保持就地渲染；点击渲染文字准确落到 source range，离开后收起。普通源码编辑加分栏预览不满足此条。模式切换、鼠标/键盘移动与组合输入必须保持原文、光标、选区和撤销历史，具体验收按 WD §17.5。[WD §17.5] [MD-01]

## R-WM-03 自动保存与崩溃恢复

编辑采用 debounce 自动保存 + 原子落盘；崩溃或断电后可从最近一致版本恢复，不允许静默丢弃未保存内容或写入半截文件。[WD §18] [MD-12] [WS-03]

## R-WM-04 外部修改三方保留

Obsidian 或外部工具的修改先进入 watcher reconciliation；UI/Agent patch 提交前比较 source revision；无法唯一定位时进入 Base/Current/Proposed 三方冲突，禁止按旧行号覆盖。[WD §18] [MD-12] [WS-04]

## R-WM-05 交付物独立目录

PPT、Word、HTML、视频等每种交付物拥有独立制作目录，输出不落回源文档目录；目录 ownership、source binding 与清理边界遵循 WD §5 的定义。[WD §5] [WS-08] [WF-09]

## R-WM-06 引用随移动更新

附件、WikiLink、Embed 在文件移动或重命名时必须同步更新引用；无法原子完成多文件 patch 时整批失败回滚，不允许留下断链。[WD §6] [WS-09] [MD-03]

## R-WM-07 路径可改名、身份必须稳

人类可读目录名可以本地化改名；内部语义 ID 保持稳定，不依赖路径字符串；所有写操作受 root containment 与 symlink 防护约束。[WD §5] [WS-02] [WS-07]

## R-WM-08 文件事件与增量索引

文件事件经 notify/FSEvents/ReadDirectoryChangesW 归一化并去抖后驱动增量索引；Outline、Backlinks、Outgoing Links 与 Tags 索引跟文件事件保持一致；大型 Vault 扫描走后台增量索引，可取消、不阻塞冷启动。[WS-05] [WS-10] [MD-07]

## R-WM-09 方言扩展与嵌入资产

Properties、Frontmatter、Callout 与脚注按 Obsidian 方言与 CommonMark/GFM 的统一扩展模型处理；数学公式与 Mermaid 离线渲染并按不可信内容防护；图片、音频、PDF 与本地附件嵌入支持 MIME 识别、缓存、缩略图与受限路径读取。[MD-04] [MD-05] [MD-06]

## R-WM-10 Workspace 授权与路径身份

Workspace 经用户授权并持久化挂载映射，支持权限撤销；文件身份在 APFS/NTFS 大小写、Unicode normalization 与 rename 场景下保持稳定。[WS-01] [WS-06]

## R-WM-11 目录概览与多选 Scope

目录内容概览展示结构、摘要、任务、链接与交付物；多选内容成为明确 Content Scope 时携带选择身份与权限，上下文构造不越权。[MD-11] [WD §13.2]
