# 技术可行性 01：桌面界面、Markdown、WebView 与绘图

> 状态：已确认方案 B“分层模块化核心”；旧 Tauri fixture 仅作历史证据，G0-SHELL-002 与 Windows 真机仍待补跑  
> 日期：2026-09-01  
> 范围：UI-01～UI-11、MD-01～MD-12、DG-01～DG-07  
> 结论等级：本报告中的“可行”均为 `FEASIBLE_CONDITIONAL`，不能替代真实 macOS/Windows PoC。

## 1. 本轮结论

这一组技术要求**总体可行，但不能按“纯 Rust 原生 UI + 自研所有编辑器”的路线实施**。

已确认的首发架构是：

```text
Electron + 随基础安装包分发的 Chromium
├── Electron Main / Shell Controller（客户端 TCB，非业务权威）
├── app_ui Renderer：Workbench / Tasks / Agent / CodeMirror Markdown
├── diagram_editor WebContentsView：Excalidraw / diagrams.net
├── artifact_preview WebContentsView：HTML / PDF / Office authoritative pages
├── authenticated private channel
└── Rust Product Core（唯一业务、数据与策略权威）
    ├── Workspace / Task / Query / Artifact / Workflow / Policy
    ├── Worker Supervisor
    └── isolated Workers
        ├── App Server / Capability / Extension / WPS / FFmpeg / Connector
        └── Electron Render Worker Host：video / diagram / browser review
```

这不违背“尽量转 Rust”的决策。Rust 承载稳定、确定性、安全敏感和系统级权威；Electron Main 承载窗口与 Surface 生命周期；成熟 Web 编辑器保留为签名静态资源，高风险与长任务分 Worker。Renderer 不获得 Node、真实路径、进程或任意网络能力，只使用 ClientIntent、UI Query 与 Resource Handle。

### 1.1 关键架构调整

| 决策 | 第一轮结论 | 原因 |
|---|---|---|
| 桌面主壳 | Electron + bundled Chromium 是唯一首选；Rust Product Core 保持唯一业务、数据与策略权威 | 视频能力已要求固定 Chromium；统一 UI、编辑、Preview 与后台渲染的浏览器版本可删除 WKWebView/WebView2/Headless Shell 三套兼容链 |
| GPUI | 保留为未来局部原生 UI 备选，不作为首发主框架 | GPUI 已覆盖 macOS、Windows、Linux，但官方仍标记 pre-1.0 且存在频繁破坏性变更 |
| Markdown 编辑器 | 已确认采用 CodeMirror 6 + SuperWagie 自有 Obsidian 方言扩展 | Obsidian 官方开发文档确认底层使用 CodeMirror；CodeMirror 6 的 Decoration/Widget 模型符合源码真相与 Live Preview 要求 |
| Live Preview | 自研块级 Decoration/Widget 层，不采用 HTML 富文本作为真相 | 必须始终以 Markdown 原文为真相，才可做到与 Obsidian 往返不丢失 |
| Excalidraw | 直接嵌入官方 React 包并本地化全部字体/资源 | 官方明确提供嵌入组件和开放 JSON 格式，MIT 许可适合闭源客户端 |
| draw.io | 固定版本自托管，使用官方 embed messaging 协议 | 官方仓库和集成仓库都支持宿主负责存储的嵌入模式，Apache-2.0 可用于闭源分发 |
| 图表文件模型 | Excalidraw 与 draw.io 各自保留原生格式，不建立 SuperWagie 私有持久化格式 | 避免格式转换造成能力丢失，并保证文件离开 SuperWagie 后仍可编辑 |
| 图表 Agent | 统一命令语义、分别操作两种原生文档模型，不通过鼠标自动化 | 需要稳定对象 ID、事务、校验、预览和可撤销性；统一的是操作契约，不是文件结构 |

### 1.2 内嵌 Chromium 能解决什么

内嵌 Chromium 可以显著缩小 macOS 与 Windows 的 Web 前端差异，但不能独立解决整个桌面产品的跨平台问题。

它主要解决：

- CodeMirror、Excalidraw、draw.io 使用同一 Chromium/V8/Web API；
- CSS、字体测量、Canvas、SVG、剪贴板 Web API 和前端性能特征更一致；
- 不再受旧 macOS WKWebView 是否满足当前 draw.io 浏览器要求的直接限制；
- Web 编辑器只需维护一套主要兼容基线。

它不能解决：

- macOS 与 Windows 的中文 IME、系统剪贴板、拖放、窗口焦点和无障碍差异；
- 文件选择、目录授权、通知、菜单、快捷键、代码签名、公证和自动更新；
- WPS macOS JSAPI 与 Windows COM 的协议差异；
- 系统文件语义、Unicode、大小写、symlink 和路径安全；
- Chromium 自身对老操作系统的停止支持。固定旧版 Chromium 只能延迟淘汰，不能长期安全支持旧系统。

三种架构的最终裁决：

| 架构 | Web 一致性 | 包体积与 Runtime | 原生边界 | 结论 |
|---|---|---|---|---|
| Tauri 2 + 系统 WebView | 中等，必须维护 WKWebView/WebView2 差异 | 壳较小，但视频仍需另一套 Chromium | Rust Core 可直接承担 | 不再作为生产首选；旧 PoC 仅作历史证据 |
| Electron + 内嵌 Chromium + Rust Product Core/Workers | 高，Web 编辑器与渲染基线最一致 | 基础包增大，但删除系统 WebView 分支和首次下载浏览器 | 原生系统边界由 Core 授权、隔离 Worker 执行 | **唯一首选**；必须通过 G0-SHELL-002、Gate 4、Gate 6 |
| Tauri + 自行嵌入 CEF/Chromium | 高 | 同样增大，且自建桥接和升级链 | 同时维护 Tauri 与 CEF 两套生命周期 | 拒绝；复杂度高于直接采用 Electron |

已确认不考虑旧系统兼容，因此不为旧 macOS、Windows 10 或旧 WebKit 维护分支。Chromium 不是为旧系统兼容而加入，而是 UI、编辑器、Preview 和视频确定性渲染的共同必装 Runtime。Electron Gate 失败时阻止发布并重新裁决架构，不静默切换 Tauri/System WebView；Rust Core、Workspace Contract、Workflow 和 Agent Runtime 不随壳层变化。

## 2. 官方证据与开源参考

### 2.1 桌面壳与 Chromium

Electron 使用多进程模型，主进程管理应用生命周期与 renderer；renderer 可启用 Chromium sandbox。Electron Main 技术上属于客户端 TCB，但不能成为第二个业务后端：Main 只允许窗口、Surface 生命周期、Deep Link、sender 校验和生成式窄 IPC，Workspace、凭证、WPS/FFmpeg、Agent、Credits 与外部能力的决定权仍归 Rust Product Core，副作用进入 Worker。所有 renderer 强制 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，并通过 CSP、导航/权限白名单、fuses 与 ASAR integrity 收紧生产包。

参考：

- [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
- [Electron ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
- [Electron Offscreen Rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering/)

Tauri/System WebView 的历史路线在 Windows 使用 WebView2、macOS 使用 WKWebView，会引入两套 Web API、Canvas、字体测量和升级基线；视频又需要固定 Chromium。改用 Electron 后可删除这组浏览器内核分支，但仍必须分别验证 macOS/Windows 的 IME、剪贴板、拖放、无障碍、窗口、系统文件和 WPS 适配，不能把“同一 Chromium”误当作整个产品跨平台完成。

GPUI 官方 README 当前已列出 macOS、Windows、Linux/FreeBSD 的平台后端，说明跨平台在技术上已不是完全不可用；但同一 README 也明确说明其仍在积极开发、pre-1.0，并会频繁出现破坏性变更。因此它适合持续观察或局部实验，不宜成为第一版复杂编辑工作台的唯一基础。

参考：

- [GPUI README](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)

### 2.2 Markdown 与 Obsidian 方言

Obsidian 官方文档明确了需要兼容的核心语义：

- Live Preview 在同一编辑视图中渲染内容，只在光标附近显示 Markdown 标记；同时保留 Source Mode；
- WikiLink 与 Markdown Link、目录路径、标题锚点、block ID、别名和悬浮预览；
- `![[...]]` 文件、标题、block、图片、音频和 PDF 嵌入；
- Properties 使用文件头部 YAML，并有文本、列表、数字、复选框、日期、标签等类型；
- Callout 使用 blockquote 扩展语法，支持折叠、嵌套和自定义类型。

参考：

- [Obsidian Live Preview](https://help.obsidian.md/Live%2Bpreview%2Bupdate)
- [Obsidian Internal Links](https://obsidian.md/help/links)
- [Obsidian Embed Files](https://obsidian.md/help/embeds)
- [Obsidian Properties](https://obsidian.md/help/properties)
- [Obsidian Callouts](https://obsidian.md/help/callouts)
- [Obsidian API type definitions](https://github.com/obsidianmd/obsidian-api)

Obsidian API 类型定义使用 MIT 许可，但它不是 Obsidian 应用源码。SuperWagie 可以将其作为行为和插件数据结构的参考，不能宣称复制了 Obsidian 的内部实现，也不应承诺任意 Obsidian 社区插件兼容。

推荐基础：

- [CodeMirror 6](https://codemirror.net/)：MIT，负责文本编辑、增量语法树、Selection、Decoration、Widget、快捷键和输入法；
- [CodeMirror Markdown](https://github.com/codemirror/lang-markdown)：MIT，负责 CommonMark/GFM 基础解析；
- [SilverBullet](https://github.com/silverbulletmd/silverbullet)：MIT，已证明 CodeMirror 6 可以承载 Markdown Live Preview、双链和本地知识库。适合作为架构参考，但不可把“与 SilverBullet 相似”等同于“与 Obsidian 严格一致”。

实现上必须拆成两层：

```text
Markdown 原文（唯一真相）
├── 增量语法树：用于光标附近编辑、样式与块级 Widget
├── 无损 patch 层：只修改明确 source range
└── Rust Vault 索引
    ├── path / file identity
    ├── heading / block ID
    ├── wikilink / embed / tag
    ├── backlink / outgoing link
    └── task identity / properties
```

不能使用“Markdown → HTML → 富文本 → Markdown”作为编辑闭环，因为未知插件语法、空白、HTML、属性顺序和自定义区块会被归一化或丢失。Agent 修改也必须尽量使用 source range patch；只有用户明确要求格式化整篇文档时，才能做全量重写。

该路径已完成产品与技术方向确认。ProseMirror/Tiptap/Milkdown 不作为默认 Markdown 编辑器，因为严格 Schema 和序列化会增加未知语法丢失或格式归一化风险；Monaco 只保留为未来 Diff/源码辅助视图参考，不承担默认 Live Preview。

### 2.3 Excalidraw

Excalidraw 官方包直接导出可嵌入的 React 组件；官方仓库说明支持 PNG/SVG/剪贴板导出，并以开放 `.excalidraw` JSON 保存。官方还给出了字体静态资源自托管方式，所以完全离线运行是明确路径。项目许可证为 MIT。

参考：

- [Excalidraw repository](https://github.com/excalidraw/excalidraw)
- [Excalidraw package integration](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/README.md)
- [Excalidraw license](https://github.com/excalidraw/excalidraw/blob/master/LICENSE)

已确认保存策略：

```text
diagram.excalidraw       # 普通项目中新建绘图的默认格式；该文件自身是唯一编辑真相
diagram.excalidraw.md    # Obsidian 兼容项目中的原生文件；打开后原文件自身是唯一编辑真相
diagram.svg              # 从当前真相文件生成的派生预览/交付资源
diagram.png              # 可选派生位图预览
```

`.excalidraw.md` 不是 Excalidraw 官方格式，而是 Obsidian 插件生态约定；它涉及 Markdown 文本区、压缩 Drawing 数据、元素 ID、文本绑定和保护区段。SuperWagie 打开它时不得先转换为 `.excalidraw` 再覆盖原文件，也不得重排未知 Markdown 区段。此项必须对 NeoMei 的 `obsidian-excalidraw` 以及上游 Obsidian Excalidraw 插件做兼容语料和真实往返测试，现阶段不能标记为已证实。

新建格式采用项目感知规则：普通项目默认 `.excalidraw`；已识别为 Obsidian Vault 或用户已启用 Obsidian 兼容的项目默认 `.excalidraw.md`。两者都可显式选择，已有文件始终原格式保存，不静默迁移。

### 2.4 draw.io / diagrams.net

diagrams.net 官方集成仓库明确提供 Embed Mode：编辑器运行在 iframe/window，通过 HTML5 Messaging API 与宿主通信，宿主发送图表数据并接收 save/exit；宿主负责文件、认证、revision 和持久化。官方支持 XML、SVG、PNG 及在图片中嵌入可编辑源数据。主仓库是 Apache-2.0 许可，可自托管，并提供可部署的 WAR。

参考：

- [diagrams.net Integration](https://github.com/jgraph/drawio-integration)
- [Embed Mode Protocol](https://www.drawio.com/docs/reference/embed-mode/)
- [draw.io source repository](https://github.com/jgraph/drawio)

已确认保存策略：

```text
diagram.drawio           # mxGraph XML，编辑真相
diagram.drawio.svg       # 内嵌源 XML 的矢量交付资源
diagram.drawio.png       # 可选内嵌源 XML 的位图资源
diagram.preview.svg      # 清理过活动内容的只读预览
```

`.drawio` 的 XML 是普通流程图文档的唯一编辑真相；SVG/PNG/PDF 是派生交付物。若用户直接打开包含源 XML 的 `.drawio.svg` 或 `.drawio.png`，则该文件自身进入“可编辑嵌源文件”模式，保存时仍写回同一格式，不暗中拆成私有文件对。官方 Embed Mode 的 autosave/save 事件直接返回 XML，并提供 patch 与 checksum，这正好允许 Rust 文件事务层维护 revision、原子保存和冲突检测，而不需要再复制一份 SuperWagie 图表数据库。

### 2.5 原生格式与统一 Agent 命令层

SuperWagie 不定义第三种 Diagram IR 作为持久化真相。统一只发生在 Agent 的意图和事务层：

```text
Agent Diagram Command
├── create / update / delete
├── connect / disconnect
├── group / ungroup
├── align / distribute / layout
├── label / style / metadata
└── export / validate
        │
        ├── Excalidraw Adapter → 原生 elements/appState/files → 原文件原子保存
        └── draw.io Adapter     → 原生 mxGraph XML          → 原文件原子保存
```

共享命令只承诺两种格式都能可靠表达的语义。格式专属能力通过带命名空间的 typed operation 暴露，例如 `excalidraw.bind_arrow`、`drawio.set_layer`，不得为了追求表面统一而抹平图层、页面、绑定、库元素或格式专属元数据。每次 Agent 操作保存前必须经过 adapter 校验，并生成可撤销 patch；预览和导出始终是派生产物。

需要注意三个条件：

1. 当前官方仓库列出的支持范围包括 Safari 17.5+、Edge/Chrome 123+。macOS 最低版本必须据此确定，或固定一个通过旧 WebKit 验证的 draw.io 版本；
2. `draw.io` 是注册商标，SuperWagie 的产品名称、Logo 和宣传不得暗示官方关联或背书；界面宜使用“流程图”或“Diagram”，在关于页说明 diagrams.net 兼容和开源许可；
3. 官方仓库对内置图标、stencil 和模板列有额外条款，打包前必须生成 SBOM 并核对实际分发资产，不可只看主源码 Apache-2.0。

## 3. 分项可行性结论

### 3.1 桌面客户端与界面

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| UI-01 | `FEASIBLE_CONDITIONAL` | Electron Shell Controller + Rust Product Core/Workers + TypeScript UI；暂不采用 GPUI-first | G0-SHELL-002 在 macOS、Windows 构建、签名、安装、启动并完成离线 Runtime 校验 |
| UI-02 | `FEASIBLE_CONDITIONAL` | CSS design tokens + 可组合 Bento 布局；主题状态由 Workspace Shell 管理 | 100%、125%、150%、200% 缩放截图和交互验收 |
| UI-03 | `FEASIBLE_CONDITIONAL` | Rust 持久化产品投影与布局，UI Query Snapshot/Event Cursor 恢复；selection 仅为可丢弃 UI 状态 | 异常退出或 Renderer/Core 重启后恢复 tabs、split、active file，cursor gap 触发 resync |
| UI-04 | `RESEARCH_REQUIRED` | 依赖后续 Capability/Workflow UI Schema | 单独在 Workflow 组证明动态 UI 安全边界 |
| UI-05 | `RESEARCH_REQUIRED` | PDF/图片/WebView/Office adapter 的统一 Preview Contract | 留待交付物组逐格式验证 |
| UI-06 | `FEASIBLE_CONDITIONAL` | app_ui 中的 CodeMirror 6 + 平台 accessibility bridge | 中文 IME、emoji、组合输入、剪贴板、VoiceOver/Narrator PoC |
| UI-07 | `FEASIBLE_CONDITIONAL` | app_ui、diagram_editor、artifact_preview、render_worker 四类 Surface + Resource Handle + 窄 IPC | 离线加载、Surface 销毁、权限拒绝、Handle 越界和崩溃恢复 |
| UI-08 | `FEASIBLE_CONDITIONAL` | Rust UI Query Gateway + Snapshot/Event Cursor + resync_required | 文件/任务变化后正确增量刷新；gap/Core 重启不产生幽灵状态 |

### 3.2 Obsidian 兼容 Markdown

#### 2026-09-03 macOS 编辑器界面验证补充

`scripts/poc/gate-1/markdown-editor-poc/` 已用真实 Electron/Chromium 和 CodeMirror 6
运行代表性界面 PoC，并在同一真实 Obsidian Vault 中交叉回读。结果覆盖三种视图、
中文组合输入、Properties、WikiLink/锚点、文档/PNG/Excalidraw 嵌入、Callout、脚注、
数学、Mermaid、未知语法 passthrough、原子保存、外部修改通知和 stale revision 拒绝。
验证中发现并修正了 `.excalidraw` 到 `.excalidraw.md` 映射、自定义资源协议被净化、
Reading DOM 存在但仍隐藏，以及同名 WikiLink 错误命中 Vault 根目录等问题。

因此，R-WM-02、R-WM-03、R-WM-04 与 R-WM-09 所需的 macOS 代表性技术路径已有
可复现 PoC 证据。Backlinks、全库搜索、重命名事务、大型 Vault 增量索引、完整崩溃
恢复、Windows 真机和正式产品集成仍按原门禁执行；不得把本结论解释为生产实现准入。

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| MD-01 | `FEASIBLE_CONDITIONAL` | CodeMirror 6 Decorations/Widgets 实现 Live Preview；独立 Reading 与 Source | 兼容语料中光标移动、选择、撤销、粘贴不损坏源码 |
| MD-02 | `FEASIBLE_CONDITIONAL` | Lezer 增量树用于编辑；Rust 无损扫描器/source range patch 用于 Agent | 未知节点、空白、HTML、frontmatter 往返字节不变 |
| MD-03 | `FEASIBLE_CONDITIONAL` | Rust Link Resolver + heading/block index + rename transaction | WikiLink/Markdown Link/heading/block/alias 全矩阵测试 |
| MD-04 | `FEASIBLE_CONDITIONAL` | 扩展解析器 + typed property editor；源码仍为 YAML/Markdown | Properties/Callout/脚注在两端往返 |
| MD-05 | `FEASIBLE_CONDITIONAL` | KaTeX + Mermaid 固定版本、本地资源、禁用危险配置 | 离线渲染、导出和恶意输入测试 |
| MD-06 | `FEASIBLE_CONDITIONAL` | Rust attachment broker 发放受限资源 URL | 图片、音频、PDF 可嵌入且不能越过 Vault 根目录 |
| MD-07 | `FEASIBLE_CONDITIONAL` | Rust 增量 Vault Index + file watcher/event journal | 万级文件增量变更后链接图一致 |
| MD-08 | `RESEARCH_REQUIRED` | 任务 AST + stable block ID + frontmatter/inline field adapter | 必须先定义 SuperWagie 支持的 Obsidian Tasks 子集 |
| MD-09 | `RESEARCH_REQUIRED` | 建立真实 Obsidian compatibility corpus 与双向 reopen runner | 真实 Obsidian 保存/关闭/重开后无语义和意外格式变化 |
| MD-10 | `FEASIBLE_CONDITIONAL` | passthrough + source-range patch；未知语法默认只读渲染 | 语料库中所有未知插件区段哈希不变 |
| MD-11 | `FEASIBLE_CONDITIONAL` | Rust 目录摘要/选择 ID + Agent Context Builder | rename、移动和外部编辑后 Scope 不漂移 |

### 3.3 绘图平台

| ID | 结论 | 实现路径 | 进入实施前证据 |
|---|---|---|---|
| DG-01 | `FEASIBLE_CONDITIONAL` | 官方 Excalidraw React 包，本地字体/资源，固定版本 | 断网可创建、编辑、保存、重开、导出 SVG/PNG |
| DG-02 | `RESEARCH_REQUIRED` | `.excalidraw` 与 `.excalidraw.md` 均按原格式原位编辑；项目感知决定新建默认值 | NeoMei 与上游插件语料双向无损，文本 ID/绑定及未知 Markdown 区段保持 |
| DG-03 | `FEASIBLE_CONDITIONAL` | 固定版 draw.io 静态资源 + 本地 iframe + JSON embed protocol | 断网可编辑；macOS/Windows 两端通过；包体积可接受 |
| DG-04 | `FEASIBLE_CONDITIONAL` | `.drawio` 为真相，官方导出生成嵌源 SVG/PNG | 页面、图层、字体、链接、图片往返，源数据可重新编辑 |
| DG-05 | `FEASIBLE_CONDITIONAL` | 共享命令契约 + 两套 typed adapter；原生模型保存，专属能力使用 namespaced operation | 100 个 Agent 操作序列可撤销、可校验、无孤立引用且无格式能力静默丢失 |
| DG-06 | `FEASIBLE_CONDITIONAL` | 独立 Electron Render Worker Host；首发不自研纯 Rust 渲染器 | 同文档两平台像素/结构容差通过，Render Manifest 完整，崩溃可重试 |
| DG-07 | `RESEARCH_REQUIRED` | 完全本地资源、CSP、URL broker、插件关闭、预览清理 | 恶意 URL/脚本/远程图片/本地路径测试不得越权 |

## 4. 不采用的路径

- 不以 GPUI 自研 Markdown、Excalidraw 和 draw.io 的完整原生替代品；
- 不维护 Electron/Tauri 双壳，也不把 Tauri/System WebView 作为静默 fallback；
- 不直接 iframe 远程 `embed.diagrams.net`：这会破坏离线、隐私和网络控制边界；
- 不让 Chromium renderer 或 Electron Main 直接获得任意文件系统或 shell 权限；所有文件、网络和进程操作由 Rust Product Core 授权并通过隔离 Worker 的类型化命令执行；
- 不把 HTML 富文本或数据库作为 Markdown 内容真相；
- 不承诺完整 Obsidian 插件 ABI；只承诺明确列出的文件格式与核心交互兼容；
- 不让 Agent 通过坐标点击操纵绘图编辑器；Agent 必须调用 typed document operations。
- 不建立 SuperWagie 私有 Diagram 文件格式或数据库作为编辑真相；不在 Excalidraw 与 draw.io 之间自动互转后覆盖源文件。

## 5. 必须执行的组合 PoC

### 5.1 PoC 目标

用一个一次性技术 Spike 同时回答本组最危险的五个问题：

1. Electron 同版本 Chromium 能否稳定承载 CodeMirror 6、Excalidraw、draw.io、Preview 与离屏视频渲染；
2. 中文 IME、剪贴板、拖放、缩放和多标签在 macOS/Windows Chromium renderer 中是否可靠；
3. 三种编辑器能否完全断网运行，且 renderer/Main 不能越权读取文件或绕过 Rust Product Core；
4. Obsidian 方言能否用 source-range patch 保持未知语法无损；
5. 图表能否保存原生文件、生成预览并重新打开编辑。

### 5.2 PoC 范围

```text
superwagie-electron-shell-spike
├── Electron Main（窗口/Surface 生命周期/窄 IPC）
├── app_ui：Markdown Source / Live Preview / Reading
├── diagram_editor：Excalidraw / diagrams.net
├── Rust Product Core
│   ├── UI Query + ClientIntent Gateway
│   ├── vault grant / file transaction / Resource Handle
│   └── Worker Supervisor / network deny
└── Electron Render Worker Host：diagram export smoke
```

PoC 不接 Agent、不接 Credits、不做正式视觉系统，也不进入产品代码。它只验证技术边界，完成后保留 fixture、自动化脚本和报告，产品实现可以另起干净工程。

### 5.3 验收清单

| 类别 | 必须通过 |
|---|---|
| 平台 | macOS arm64；Windows x64 实机或干净 VM |
| 离线 | 启动后抓取网络，除测试探针外无外联；断网仍可完成全部操作 |
| 编辑 | 中文拼音组合输入、撤销/重做、多段粘贴、emoji、表格、列表 |
| Obsidian | 兼容语料在 SuperWagie 保存后由真实 Obsidian 打开，再保存并回到 PoC；未知区段哈希保持 |
| Excalidraw | `.excalidraw` 与 `.excalidraw.md` 均原格式保存/重开；SVG/PNG 导出；字体不访问 CDN；已有文件不静默迁移 |
| draw.io | `.drawio` 保存/重开；嵌源 SVG/PNG 原格式重新编辑；多页/图层保持；checksum 不一致时拒绝覆盖 |
| 图表 Agent | 同一命令语料分别作用于两种 adapter；通用操作语义一致，专属能力不丢失，全部操作可 Review/Undo |
| 安全 | sandbox/contextIsolation/nodeIntegration/fuses/ASAR、iframe origin、IPC capability、`../`、symlink、远程图片和 `javascript:` 攻击 |
| 稳定 | WebView crash 后不损坏文件；未完成写入不替换上一 revision |
| 体积性能 | 记录安装包、静态资源、冷启动、空闲内存和三个编辑器首次打开耗时 |

### 5.4 Go / No-Go 条件

G0-SHELL-002 与关联 fixture 通过后：`UI-01`、`UI-06`、`UI-07`、`MD-01`、`MD-09`、`DG-01`、`DG-03`、`DG-04` 可升级为 `PROVEN_POC`。

出现以下任一情况时不得直接进入实施：

- draw.io 当前固定版本无法在目标 Electron/Chromium 身份上运行；
- 中文 IME 或剪贴板在任一目标平台存在不可接受的数据丢失；
- 无法阻止 renderer/iframe/Electron Main 绕过 Rust 权限边界；
- `.excalidraw.md` 或 Obsidian 方言往返会静默破坏原文；
- 基础安装包体积、冷启动或常驻内存超过最终门槛且无法通过资源去重、裁剪或延迟加载解决。Chromium 与内置编辑器不能降为首次使用下载来规避门槛。

## 6. 已确认的平台约束

- 不考虑旧系统兼容；
- macOS 首发基线为 14.5 或更高，并在安装后做 bundled Chromium、GPU、字体与原生桥 feature probe；
- Windows 首发基线为仍受 Microsoft 支持的 Windows 11 版本，当前 PoC 基线使用 25H2；
- 不支持普通 Windows 10，不为 ESU/LTSC 单独增加首发兼容分支；
- 不固定或维护旧 draw.io 版本；
- Chromium 因统一 UI、编辑器、Preview 与视频渲染而随基础安装包，不是旧系统兼容措施；
- 不做 Tauri/Electron 双壳并行 PoC，只验证 Electron + bundled Chromium + Rust Product Core/Workers；
- 旧 G0-SHELL-001 只保留历史证据，当前壳层以 G0-SHELL-002 重新签署。

因此，本组 PoC 可以直接按现代系统基线执行，不再等待最低系统版本选择。
