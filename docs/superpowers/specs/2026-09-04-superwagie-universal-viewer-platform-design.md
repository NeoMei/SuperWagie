# SuperWagie 通用文件 Viewer Platform 设计

> 状态：核心方向与补全设计已获用户确认；下一步只执行权威规格迁移与 Frozen Core 准入 PoC，不进入生产 Viewer 实现
>
> 日期：2026-09-04
>
> 决策：采用“冻结 Omni Viewer Core + SuperWagie 自有宿主层”；文件打开与 Review 不依赖 WpsComposer、WPS、Office 或 LibreOffice
>
> 用户确认：范围与组件边界、格式矩阵、打包与性能、Viewer/Review 体验、安全与验收五部分均已确认
>
> 准入约束：本设计确认产品目标，不确认技术已达标。在权威规格同步、Viewer PoC 和对应逐格式 Gate 通过前，不得进入该切片的生产实现或对外宣称支持

## 1. 决策摘要

SuperWagie 新增独立的 `Universal Viewer Platform`，把丰富文件格式查看能力作为 Workspace 的基础产品能力，而不是 WpsComposer、交付 Workflow 或外部 Office 宿主的附属功能。

采用方案 A：

1. 从通过准入的 `omni-viewer-core` 上游 commit 冻结源码快照；
2. 仅吸收共享 Core 和选定格式模块，不引入 Obsidian Plugin 宿主代码；
3. SuperWagie 自有 Viewer Registry、Host Adapter、Viewer Shell、Review Bridge、权限、缓存和恢复；
4. 所有内置 Viewer 依赖随基础安装完成，按格式离线懒加载；
5. DOCX、PPTX 等 Office 文件直接由内置浏览器 Viewer 打开，正常状态不显示“快速预览”或“等待 WPS 渲染”；
6. LibreOffice、`soffice`、在线 Office Viewer、WPS/Office 转 PDF fallback 和首次使用下载均禁止进入 Viewer 路径；
7. WpsComposer 只负责 Office Artifact 的生成、格式化和结构化修改；可选真实 WPS smoke 只属于最终交付验收，不提供 Viewer 页面底图。

这项决策替换此前“Office 视觉事实必须由 WPS/Office 渲染”的产品方向。替换范围和迁移清单见第 14 节；在迁移完成前，冲突仍以 CAC §1 的权威优先级裁决。

### 1.1 决策与技术证据分层

本设计使用两层状态，禁止把“用户已确认目标”误解为“候选 Core 已证明可发布”：

1. **产品决策**：Universal Viewer Platform、无 LibreOffice 运行依赖、Office 内置打开和 WpsComposer 边界已确认；
2. **技术准入**：上游候选、每个格式、每个平台、包体和安全仍是 `RESEARCH_REQUIRED`，只能由可重复证据升级。

权威规格迁移只把新目标和新 Gate 变成唯一规则，不把任何 Gate 直接改成 `GO`。在 Viewer PoC 达标前，允许的代码仅限可抛弃技术验证、Corpus 和 Gate runner，不得合入生产模块。

## 2. 目标与非目标

### 2.1 目标

- 在未安装 WPS、Microsoft Office、LibreOffice 和 Codex Desktop 的现代 macOS、Windows 11 上打开已承诺格式；
- 用统一 Viewer Shell 提供标签、加载、搜索、缩放、分页、目录、结构浏览、诊断、批注、Diff 和 Agent 修改请求；
- DOCX/PPTX 默认在产品内快速、高还原呈现，不让外部 Office 进程进入打开热路径；
- 支持 Office、PDF、表格、文本、代码、图片、媒体、压缩包、数据、工程、GIS 和 AI 模型等丰富格式；
- 解析不可信文件时保持 Workspace 路径、业务状态、凭证和网络隔离；
- 通过冻结、许可、SBOM、补丁账本、差分测试和升级 Gate 控制上游 0.x 变化；
- 保持 WpsComposer、Workspace Revision、ReviewAnnotation 和 Agent 修改闭环的职责清晰。

### 2.2 非目标

- 不把 Viewer 做成完整 Word、PowerPoint、Excel 或 PDF 编辑器；
- 不承诺 DOCX/PPTX 与任一 Office 产品逐像素完全一致；
- 不在 Viewer 内执行宏、脚本、OLE 程序、外链媒体或嵌入应用；
- 不引入 LibreOffice、ONLYOFFICE Server、在线 Office Viewer 或其他大型 Office Runtime；
- 不引入 Omni Viewer 的外部分享服务、云上传、自动更新和宿主专用 UI；
- 不在首次打开时下载 Viewer、WASM、字体、模型、解码器或补充 Runtime；
- 不因 RAR、7z、DMG 等长尾格式扩大 V1 原生依赖或调用系统命令；
- 不让 Viewer 缓存、DOM、Web Storage 或第三方 sidecar 成为第二套文件或批注真相。

## 3. 架构与组件边界

```text
Workspace File / Artifact Revision
        │
        ▼
Rust Product Core
  permission + file identity + revision + ResourceHandle
        │
        ▼
Viewer Registry
  extension + MIME + magic bytes + container probe
        │
        ▼
Viewer Worker / isolated parser
  Frozen Omni Core parser + bounded dependencies
        │
        ▼
Typed Document Model / bounded render input
        │
        ▼
artifact_preview WebContentsView
  Viewer Surface + format renderer
        │
        ├── Viewer Shell
        └── Review Bridge
              │
              ▼
Rust Product Core
  ReviewAnnotation + ReviewDecision + Agent Change Request
```

### 3.1 `ViewerRegistry`

按声明式 `ViewerDescriptor` 管理：

```text
ViewerDescriptor
├── viewer_id
├── viewer_version
├── format_ids
├── extensions
├── mime_types
├── magic_signatures
├── container_probe?
├── support_modes: visual | structured | text_metadata | media (one or more)
├── declared_features
├── partial_rules
├── diff_modes
├── required_chunk
├── dependency_set
├── security_profile
├── benchmark_class
├── admission_state
├── resource_limits
├── optional_features
└── fallback_policy
```

注册表必须以内容探测修正错误扩展名，但矛盾或歧义容器不得猜测执行高风险解析器。`admission_state` 只能从签名的 Format Admission Ledger 投影，不得由插件 README、扩展名列表或运行时推断。`fallback_policy` 只允许降级为安全文本、十六进制、元数据或明确 `unsupported`；不允许启动外部程序。

### 3.2 `FrozenOmniCore`

冻结的是上游 Core 的审查后快照，不是 Obsidian Plugin：

- 记录仓库、commit、版本、发布日期、源码 hash 和获取方式；
- 保留 MIT 许可证、第三方 NOTICE、SBOM 和完整补丁账本；
- 只发布被 SuperWagie Viewer Registry 引用的格式模块和依赖；
- 通过 SuperWagie Adapter 隔离上游 API，业务模块不得直接依赖上游类型；
- 禁止自动升级；每次升级视为新的供应链和格式兼容变更；
- 初始 PoC 候选为 `omni-viewer-core` 0.16.0、commit `ffdcda3eea83527380996ac935605f1422e43d3b`，它不是未经 Gate 自动选定的生产版本。

### 3.3 `ViewerWorker`

负责不可信文件探测、解析、索引和可结构化的预处理：

- 只持有当前请求的 audience-bound ResourceHandle；
- 支持 bounded read、range read、取消、deadline、heartbeat 和 parent-death；
- 接受输入、解压、条目、页面、Sheet、图层、节点、媒体、CPU、时间和内存硬限制；
- 崩溃或被终止只影响当前 Viewer Session；
- 对依赖 DOM 的渲染器，在隔离 Viewer Surface 内执行最小 DOM 阶段，整个 Surface 仍可销毁且不获得路径、Node 或网络；
- 不可在同一 Renderer 进程复用高风险文件的长寿命解析状态；超限时销毁对应 Worker 或整个 Surface；
- 不将解析模型持久化为业务真相；可丢弃缓存必须绑定完整身份。

### 3.4 `ViewerSurface`

- 使用独立 `artifact_preview` WebContentsView，不在 `app_ui` 主 DOM 中执行第三方解析或文档内容；
- `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；
- revision-scoped 内存 Session，不共享 Cookie、Cache Storage、service worker 或登录状态；
- 每个高风险 Viewer Session 使用唯一不透明 origin 并验证独立 Renderer process；若 Electron 无法证明进程隔离，对应格式不得通过 GVP-3；
- 只允许签名静态资源、自定义只读资源协议和窄 Viewer Intent；
- 默认拒绝网络、导航、新窗口、下载、权限请求和任意 IPC；
- Tab 关闭、Revision 替换、超限或崩溃时显式销毁。

### 3.5 `ViewerShell`

SuperWagie 自有通用交互层，负责：

- 文件名、类型、大小、Revision 和格式状态；
- 搜索、目录、缩放、适宽、适页、分页、刷新和取消；
- 格式专属侧栏、状态说明、阅读位置和键盘/无障碍；
- “让 Agent 修改”“在系统应用中打开”和 Review 入口；
- 不暴露 Omni、PDF.js、docx-preview、SheetJS、WpsComposer 等实现名称。

### 3.6 `ReviewBridge`

Viewer 只提供页、Sheet、Slide、文字、区域和可选语义元素信息。ReviewBridge 把这些信息转换为 SuperWagie 自有 Review Intent；批注、Diff、验收与 Agent 修改请求仍由 Rust Product Core 持久化和授权。

## 4. 文件打开、状态与恢复

### 4.1 打开流程

```text
open(file_identity, expected_revision)
→ Core 验证 Project/Workspace/权限和当前 Revision
→ 签发只读 ResourceHandle
→ Registry 读取有限头部并选择 Viewer
→ 加载已安装的签名 Viewer Chunk
→ Worker/Surface 渐进解析和呈现首屏
→ 后台完成剩余页面、搜索索引、缩略图和缓存
```

打开动作不得调用 WpsComposer、WPS、Office、LibreOffice、FFmpeg 或系统命令。用户显式选择“在系统应用中打开”或进入生成/修改 Workflow 时，才允许通过相应授权路径启动外部或能力 Worker。

### 4.2 状态模型

```text
ViewerState
├── initial
├── detecting
├── loading
├── ready
├── partial
├── password_required
├── limit_exceeded
├── unsupported
├── recoverable_failed
└── stale
```

- `ready`：承诺能力已可用；
- `partial`：已呈现可用内容，但存在确定的未还原特性，或完整性无法证明；
- `password_required`：不得绕过密码或上传解密；
- `limit_exceeded`：显示触发的限制和安全下一步；
- `unsupported`：不调用外部转换器，不伪造空白成功；
- `recoverable_failed`：允许安全重试、选择文本/元数据视图或在系统应用中打开；
- `stale`：源 Revision 或 Viewer 身份变化，必须重新加载。

`ready` 不能只表示“解析器没抛异常”。它必须同时满足：格式已通过当前平台的准入 Gate、文件声明的 namespace/content type/relationship/特性都在 Viewer 已声明覆盖中、必需字体和解码器可用、渲染期间未产生内容级诊断。任一未识别部件、未识别绘图对象、替代字体、占位图或容错恢复都使当前文件进入 `partial`。无法证明特性清单完整时，宁可 `partial`，不得推断 `ready`。

`partial` 是正常可用状态，但诊断必须绑定页/Slide/Sheet/元素范围。对应格式尚为 `RESEARCH_REQUIRED` 时，候选 Viewer 只能出现在技术验证程序，不进入生产 Viewer Registry。

### 4.3 恢复

同一 window 内逻辑文件继续以 `workspace_id + file_identity` 保持唯一 Tab。阅读位置、缩放和格式 UI 状态可按 `file_identity + revision + viewer_version` 恢复；它们不是领域真相。Renderer 崩溃后重新获取 Snapshot、ResourceHandle 和 Viewer Session，不重放修改副作用。

## 5. 格式矩阵与支持语义

“支持”按真实能力声明，不以识别扩展名代替完成打开：

- `visual`：完整视觉查看、缩放、分页或播放；
- `structured`：表格、目录、图层、模型、信号、数据包或计算图；
- `text_metadata`：安全文本、十六进制和元数据；
- `partial`：文件可用，但已检测到未还原特性；
- `unsupported`：无法安全或有效呈现，明确失败原因。

| 格式组 | V1 目标模式 | 初始准入状态 | 关键边界 |
|---|---|---|---|
| DOCX | 高还原 `visual` | `RESEARCH_REQUIRED` | 分页、字体、图表、字段和浮动对象必须通过 Office 差分 Corpus |
| PPTX | 高还原 `visual` | `RESEARCH_REQUIRED` | 主题/母版、分组、图表、SVG/EMF/WMF、SmartArt 和透明度覆盖达标 |
| DOC、PPT | `structured + partial visual` | `RESEARCH_REQUIRED` | V1 允许明确 `partial`；只有单独旧格式 Gate 通过后才可升级为高还原 `visual` |
| XLSX、XLS | `structured` | `RESEARCH_REQUIRED` | Sheet、值、合并单元格和基本样式；不承诺打印排版、宏和完整公式重算 |
| CSV、TSV | `structured` | `RESEARCH_REQUIRED` | 编码、分隔符、巨型行和公式注入防护 |
| PDF | 页面 `visual` | `RESEARCH_REQUIRED` | 文字层、密码、表单/脚本禁用和打印/下载边界 |
| HWP、HWPX | `structured + partial visual` | `RESEARCH_REQUIRED` | 页面能力必须由样例证明；未经证明不宣称原版排版 |
| LaTeX | `structured` | `RESEARCH_REQUIRED` | 源码、目录和公式预览；不运行 TeX 编译器、shell escape 或远程 include |
| TXT、LOG、MD、JSON、JSONL、YAML、TOML、XML、常见代码 | `text_metadata` | `RESEARCH_REQUIRED` | 高亮、目录、搜索、大文件分段；Markdown/HTML 不执行主动内容 |
| JPG、JPEG、PNG、GIF、BMP、WebP、SVG | `visual` | `RESEARCH_REQUIRED` | 解码尺寸、帧数和 SVG 消毒受限 |
| PSD | `visual + structured` | `RESEARCH_REQUIRED` | 合成图、图层和色彩诊断；不编辑回写 |
| MP3、WAV、OGG、FLAC、AAC、M4A、MP4、WebM、MOV 等 | `visual/media` | `RESEARCH_REQUIRED` | 只承诺当前签名 Chromium codec manifest 实际支持的组合，不在打开路径转码 |
| Parquet、Avro、SQLite/DB3、HDF5、MAT、NPY/NPZ | `structured` | `RESEARCH_REQUIRED` | Schema、变量、表格、元数据、分页与 range read |
| Mermaid、PlantUML、Shapefile | `structured + visual` | `RESEARCH_REQUIRED` | 图形/源码或地理要素；不调用远程 PlantUML Server |
| DBC、ARXML、A2L、ASC、BLF、MF4、PCAP/PCAPNG、ROS bag、STEP、ReqIF | `structured` | `RESEARCH_REQUIRED` | 信号、记录、数据包、需求或模型；每种格式独立限额和 Corpus |
| Safetensors、GGUF、ONNX、TFLite、Keras | `structured` | `RESEARCH_REQUIRED` | 只读元数据、张量索引、计算图和模型结构；不加载或执行模型 |
| ZIP、JAR、APK | `structured` | `RESEARCH_REQUIRED` | 目录、条目预览和 Core 授权的事务式导出 |
| TAR、TGZ、GZ、BZ2、XZ | `structured` | `RESEARCH_REQUIRED` | 必须使用可随包签名、可中止的受限解码器；系统 `tar`/命令行不可达 |

RAR、7z、DMG 不进入 V1 承诺。只有获得体量受控、许可清晰、可随包签名、可隔离运行且不调用系统命令的解码器后，才能通过范围变更加入。

### 5.1 Format Admission Ledger

上表是 V1 产品目标，不是已通过支持列表。仓库必须维护机读 `FormatAdmissionRecord`，每个扩展名/容器变体一条：

```text
FormatAdmissionRecord
├── format_id + variants
├── product_target
├── admission_state: research_required | conditional_go | go | deferred
├── platform_states: macos | windows
├── parser_source + pinned_commit
├── superwagie_adapter
├── support_mode + declared_features + known_limits
├── dependency_ids + licenses + artifact_hashes
├── runtime_kind: js | wasm | native | chromium
├── chunk_id + compressed_bytes
├── read_mode: full | range | streaming
├── security_profile + resource_limits
├── corpus_id + benchmark_class + gate_receipts
└── supersedes?
```

Viewer Registry 只生成已达到对应发布门槛的记录。同一格式可在 macOS 与 Windows 保持不同证据状态，但 V1 对外列为跨平台支持前两端必须都达标。许可不明、商业再分发不允许、产物无法固定或安全限额不可执行的依赖直接阻止对应格式准入。

## 6. Office Viewer 新语义

### 6.1 正式 Viewer

DOCX、PPTX 打开后直接进入正式 Viewer。正常文件不显示以下旧文案或阶段：

- “快速预览”；
- “非 WPS 渲染”；
- “原格式预览准备中”；
- “正在等待 WPS/Office”；
- 后台 WPS/Office 转 PDF 进度。

产品以 SuperWagie 内置 Viewer 的呈现作为日常打开、阅读、批注和 Review 的正式显示结果。它不等于对任一 Office 产品逐像素一致的保证。

### 6.2 部分还原

只有特性盘点、解析、字体解析或渲染诊断实际发现问题时，Viewer Shell 才显示克制的 `partial` 状态，例如：

- 使用替代字体；
- 动画、宏、OLE、嵌入应用或复杂 SmartArt 不可预览；
- 个别元素、外链媒体或受保护内容未呈现；
- 文件损坏但已安全恢复部分内容；
- 旧 DOC/PPT 解析能力有限。

状态详情必须说明影响范围；不得用通用免责声明遮挡正常文件，也不得把已知内容丢失标为 `ready`。

Office Adapter 在解析前必须生成特性盘点，覆盖 OOXML content types、namespaces、relationships、绘图对象、嵌入对象、宏、外链、字体、主题/母版和文档保护。盘点中任何未声明支持的项都使文件进入 `partial`，即使首页看起来正常。差分 Corpus 负责发现“解析器未识别、因而也未报警”的回归；一旦发现，必须先增加特性诊断或降级规则，再修复渲染。

### 6.3 字体与跨平台排版

字体解析顺序固定为：

1. 文档内嵌且许可允许当前用途的字体，只在当前 Viewer Session 使用；
2. 与文档声明名称、weight、style 和度量匹配的系统字体；
3. 随包签名、允许商业再分发的最小度量兼容字体集；
4. 显式替代字体表。

使用第 3、4 级或嵌入字体不允许渲染时，文件必须进入 `partial`，诊断列出受影响的字体和页/Slide。不从 WPS/Office 安装目录私自提取字体，不把文档嵌入字体持久化为全局资产。字体文件、字形子集、许可文本和压缩体积全部计入第 8.2 节包体 Gate；若 20 MB Office 预算内无法建立可接受的 CJK/西文回退，必须缩小字体包或重新裁决预算，不得用首次下载规避。

### 6.4 最终 Office smoke

可选真实 WPS/Office smoke 只回答最终 Artifact 是否能在目标应用中打开、编辑、撤销、保存/放弃并重开。它是交付验收动作：

- 不生成 Viewer 底图；
- 不阻止未安装 Office 的用户打开和 Review 文件；
- 不参与 Viewer 缓存身份；
- 不把 WPS/Office 进程带入 Workspace 打开热路径；
- 未执行 smoke 时，产品不得伪造对应目标应用兼容性结论。

## 7. Viewer 与 Review 体验

### 7.1 通用交互

所有格式共用文件身份、Revision、搜索、缩放、刷新、取消、状态、批注、Diff、“让 Agent 修改”“在系统应用中打开”和阅读位置恢复。不同格式通过专属组件扩展，不复制另一套 Viewer Shell。

“共用”指统一入口、命令、状态和无能力说明，不表示每种格式自动获得同样的搜索、批注和 Diff 语义。按钮只在 ViewerDescriptor 声明对应 capability 且 Format Admission Ledger 已通过时可用。

### 7.2 格式专属交互

- DOCX/DOC：连续页面、目录、页码、全文搜索；
- PPTX/PPT：缩略图、单页/连续模式、演讲者备注与文字搜索；
- XLSX/XLS：Sheet 标签、冻结表头、搜索、排序和大表虚拟滚动；
- PDF：页面缩略图、目录、文字层和区域选择；
- 图片/PSD：缩放、旋转、背景切换、合成图和图层信息；
- 音视频：播放、速度、波形或媒体信息；
- 压缩包：目录树、条目预览和受控解压；
- 数据、工程和模型：结构树、属性面板、表格、信号、数据包或计算图。

### 7.3 只读边界

V1 Viewer 是只读查看与 Review Surface：

- 上游 PDF 编辑 sidecar、CSV writeback、图片保存等能力不直接进入 Workspace；
- “让 Agent 修改”创建受控修改请求并产生新 Artifact/Workspace Revision；
- “在系统应用中打开”是用户显式授权的外部动作；
- 外部保存由 Workspace watch 检测，经过 Revision/CAS 后重新打开；
- Viewer DOM、缓存和第三方内部状态不得直接覆盖源文件。

### 7.4 Diff 与批注能力

Viewer Platform 只统一入口和锚点协议，实际能力由格式声明：

- `text_diff`：文本、源码、Markdown 和可靠提取文字的文档；
- `structure_diff`：Sheet/单元格、数据表、模型、工程记录、归档目录和 Office 语义元素；
- `visual_diff`：PDF、图片、DOCX/PPTX 等稳定页面/画布，必须绑定 renderer 和字体身份；
- `time_diff`：音视频时间段，只在有稳定 timeline identity 时启用；
- `metadata_only` 或 `none`：未获准的格式明确显示能力边界。

任意 Diff 结果都是 Review 派生投影，不是新的文件事实。不同 Viewer 版本、字体环境或不可比的渲染参数禁止产生“精确视觉无变化”结论。

## 8. 打包与依赖策略

### 8.1 离线 Chunk

```text
viewer-base
├── registry / host contract / common shell
├── shared UI / sanitizer / resource client
└── text / image baseline
viewer-office
viewer-media
viewer-data
viewer-specialized
```

- 所有 Chunk 在产品安装事务中写入并校验签名/hash；
- 按格式懒加载只减少启动和运行内存，不代表按需下载；
- 未安装任何外部 Office 应用时 `viewer-office` 仍完整可用；
- Signed Runtime Image 缺失 Chunk 属安装损坏，不得在线补装或从全局 Node/npm 回退。

每个 Chunk 都必须有 `ViewerChunkManifest`，至少包含 chunk/version/hash/签名、入选 ViewerDescriptor、直接与传递依赖、许可/NOTICE、WASM/原生产物、字体、压缩与安装尺寸、平台/架构和构建 provenance。Registry 不得加载未在当前签名 Manifest 中的代码或资产。

### 8.2 包体积 Gate

- `viewer-base + viewer-office` 压缩后新增不超过 20 MB；
- 全部 V1 Viewer Chunk 压缩后新增不超过 50 MB；
- 不使用的格式模块不得进入活动 Renderer/Worker 内存；
- 超预算必须拆分、tree-shake、移除重复资产或裁剪 V1 格式；不得通过首次下载规避；
- 包体积、冷启动、首次 Chunk 加载和峰值内存进入持续回归。

### 8.3 禁止依赖

生产依赖图、源码扫描、产物扫描和运行证据必须共同证明不存在：

- LibreOffice、`soffice` 和 Office 转 PDF fallback；
- 由 Viewer 调用的 WPS、Microsoft Office、FFmpeg 或系统命令；
- 在线 Office Viewer、文档上传服务和 Omni 外部 Share；
- 运行时 CDN、远程脚本、字体、WASM、模型或解码器下载；
- 从 PATH、用户全局 npm、其他 Agent 环境或随机系统位置发现 Viewer Runtime。

### 8.4 依赖和供应链准入

- 只能从固定 commit/版本、lockfile 和 hash 可复现构建候选 Chunk；来自第三方 CDN 的 tarball 必须在准入时固定 hash 并进入 SuperWagie 受控源缓存，生产构建不依赖可变 URL；
- 每个直接和传递依赖必须确认商业使用、修改、再分发、NOTICE 和源码义务；许可不明或与发布方式不兼容直接阻止入选；
- 已知 critical/high 漏洞一律阻止；处于不可信文件可达路径的 moderate 漏洞也阻止；其他 moderate 只能用包含 owner、不可达证据、到期时间和替换计划的签名例外放行；
- 准入使用经审查的依赖版本和补丁集，不要求与上游宿主锁定的易受攻击版本完全相同；任何依赖替换都必须重跑对应格式 Gate；
- 生产包禁止未批准 install/postinstall 脚本；构建必需脚本在隔离构建阶段按 hash 和输出清单审核。

## 9. 安全模型

### 9.1 不可信输入

DOCX、PPTX、XLSX、PDF、HWP、SVG、Markdown、压缩包、媒体、数据库、工程文件和模型文件均是不可信输入。至少防御：

- ZIP bomb 与伪造声明大小；
- XML 实体、异常关系、路径穿越和超深嵌套；
- HTML/SVG/script/event handler/`javascript:` 注入；
- 外链图片、字体、媒体、超链接和远程 include；
- 宏、OLE、嵌入程序和协议处理器；
- 解析器无限循环、内存耗尽、巨型数组与页面爆炸；
- 恶意文件名、错误扩展名和容器混淆。

### 9.2 Resource Handle

Viewer 请求只携带：

```text
resource_handle
file_identity
expected_revision
allowed_operations: read | range_read
max_bytes
audience: viewer_session_id
expires_at
```

Viewer、Renderer 和第三方 Core 不取得真实路径、Workspace 根、通用文件系统、进程、凭证或任意网络。用户显式保存/解压/外部打开必须形成新的授权 Intent，不能复用只读 Handle。

### 9.3 DOM 与链接

- HTML、Markdown、Office 派生 DOM 与 SVG 使用按格式白名单消毒；
- `script`、`iframe`、`object`、`embed`、事件属性和外部资源默认移除；
- 链接点击只产生 `open_external_url` Intent，由 Core 按协议、来源和用户动作裁决；
- CSP、Trusted Types、导航拦截和权限拒绝属于 Surface 固定策略；
- 消毒策略差异必须进入格式安全测试，不以“使用 DOMPurify”替代逐格式证明。

### 9.4 基线资源限额

首个合同版本采用以下默认上限；ViewerDescriptor 可以按格式降低，提高必须有新的安全、内存和性能 Gate 回执：

| 限额 | 默认上限 |
|---|---:|
| 格式探测读取 | 1 MiB |
| 允许整体进入 JS/WASM 内存的单文件 | 256 MiB |
| 单归档条目实际解压字节 | 128 MiB |
| 单归档会话实际累计解压字节 | 512 MiB |
| 归档条目数 / 嵌套层数 / 实际压缩比 | 10,000 / 8 / 100:1 |
| XML/OOXML 嵌套深度 / 单文档 DOM 节点 | 128 / 250,000 |
| 页 / Slides / Sheets | 5,000 / 5,000 / 1,024 |
| 单张图像解码像素 / 动图帧数 | 100 MP / 10,000 |
| 单批表格投影单元格 / 单行文本 | 50,000 / 8 MiB |
| 单 Viewer Worker RSS | 768 MiB |
| 无首个可用内容时限 / 单次解析绝对时限 | 15 s / 60 s |

声明的 ZIP size 不能代替实际解压字节计数；限额必须在 stream/inflate 过程中持续执行。超大 GGUF、Safetensors、数据库、Parquet、HDF5 和媒体只能使用 range/streaming 路径，不允许因设备内存较大而回退为全量加载。超限结果返回结构化 limit code、实测值和安全下一步，不显示模糊的“打开失败”。

### 9.5 密码与归档导出

- `password_required` 只由 Core 打开的受信密码 UI 收集；文档 DOM 和第三方 Viewer UI 不取得明文密码；需要密码的解密/解析必须进入独立可终止 Worker，不在长寿命 Viewer Surface 处理；
- Core 签发一次性、audience-bound SecretHandle 给当前 Worker，密码不进日志、遥测、缓存、恢复状态或崩溃包；请求完成/取消/超时后尽快清零内存并撤销 Handle；
- 同一 Viewer Session 连续失败 5 次后结束会话，重试必须由新的用户动作发起；
- “解压/导出条目”不是 Viewer 写能力；Viewer 只提交条目身份和建议名称，Core 通过新的 Workspace/Export Command 选择目标并执行事务；
- 导出拒绝绝对路径、`..`、驱动器切换、设备名、符号链接、硬链接和特殊文件；冲突时必须询问覆盖/重命名/跳过，默认不覆盖；
- 导出同样执行第 9.4 节实际解压限额，临时文件通过事务 journal 清理，完成后返回可审计 receipt。

### 9.6 日志、遥测与崩溃信息

- Viewer 默认只记录 viewer/format/version、分桶文件大小、状态、诊断 code、耗时、峰值资源和 Gate/构建身份；
- 文件名、真实路径、内容 hash、文本、单元格、批注、密码、嵌入元数据和导出目标不进普通日志/遥测；
- 用于开发诊断的内容采样必须是显式、当次授权的导出动作，显示预览和脱敏范围，不能作为后台遥测；
- 包含文件或密码明文风险的 Worker/Renderer 不生成可自动上传的内存崩溃包；崩溃回执只保留去内容的进程、信号、版本和资源指标。

## 10. 缓存、Revision 与批注

### 10.1 缓存身份

```text
ViewerCacheKey
├── file_content_hash
├── workspace_revision_id | artifact_revision_id
├── viewer_core_commit
├── viewer_id + viewer_version
├── parser/dependency identities
├── render parameters
└── font environment hash
```

任一身份变化后旧缓存进入 `stale`。缓存可清理、不可作为验收或文件真相；重建不得改变源 Revision。

### 10.2 批注锚点

```text
ViewerAnnotationAnchor
├── source_revision_id
├── viewer_identity
├── page | slide | sheet | record identity
├── normalized region?
├── selected text + context hash?
├── semantic element id?
└── created_render_context
```

新 Revision 按语义 ID、文字上下文、页/Slide/Sheet 邻域和区域特征重定位。低于阈值进入 `unresolved`，不得静默漂移。批注的业务真相始终属于 Review 模块，不进入上游 Viewer sidecar。

## 11. 性能与故障边界

### 11.1 性能目标

- 用户打开后 150 ms 内出现真实 Viewer 状态；
- 已缓存文件首屏 P95 不超过 500 ms；
- 代表性 DOCX/PPTX 首屏 P95 不超过 1.5 秒；
- 翻页、滚动、缩放和批注反馈 P95 不超过 100 ms；
- 大文件使用 range read、分页、虚拟化、当前内容优先和邻近预取；
- 后台索引、缩略图和剩余页面不得阻塞已可交互首屏；
- 打开 Office 文件的进程树中不得出现 WPS、Office、LibreOffice 或 WpsComposer Worker。

性能 Gate 使用固定 `BenchmarkManifest`，记录机器 ID、CPU/内存/磁盘/GPU、OS、Electron/Chromium、电源模式、Viewer/Chunk/字体身份、Corpus hash、运行次数和原始样本。每个平台至少 30 次有效运行，发布门槛以受维护的最低性能参考机为准，不以开发机最佳结果代替。

- `state latency`：从用户命令被 Core 接受到显示真实 `detecting/loading/...` 状态；
- `cold`：App 已就绪，当前 Viewer Chunk 未进入内存且无派生缓存，但不把安装和 App 启动时间算入打开；
- `warm`：同一签名 Viewer Chunk 已加载，派生缓存身份完全命中；
- `first screen`：当前视口出现非占位的真实内容、正确文件级状态，且滚动/缩放/翻页中至少一项已响应；
- `Office representative`：压缩文件不超过 20 MiB、DOCX 不超过 50 页或 PPTX 不超过 50 Slides、不含密码，且属于 Office 视觉 Corpus 的中位复杂度组。

1.5 秒目标适用于 `cold Office representative`；500 ms 适用于 `warm`。超出代表档的大文件仍必须在 150 ms 内显示真实状态，其首个可用内容阈值由 Format Admission Record 的 benchmark class 单独定义，不得沿用不适用的 1.5 秒结论。

### 11.2 故障所有权

- 单格式解析失败只影响当前 Viewer Session；
- Worker 超时、超限或崩溃由 Supervisor 终止，不拖垮 App UI；
- ViewerSurface 崩溃从 Query Snapshot、ResourceHandle 和缓存重建；
- 文件外部修改使当前 Surface 进入 `stale`，由用户重载、对比或保留旧 Revision；
- 部分成功不得发布为 `ready`，也不得丢失已存在批注；
- WpsComposer、外部 Office 或 Agent Runtime 不可用不影响纯 Viewer。

## 12. 验收与发布 Gate

### 12.1 格式 Corpus

每个承诺扩展名至少包含：

1. 正常代表文件；
2. 复杂特性文件；
3. 损坏或矛盾容器；
4. 超限/资源攻击文件。

必须实际识别、打开、呈现有效内容和退出；只匹配扩展名、展示文件名或返回空视图不算支持。

### 12.2 Office 视觉 Gate

DOCX Corpus 覆盖分页、页眉页脚、编号、表格、图片、字体、脚注、目录和横竖页。PPTX Corpus 覆盖图片、文字、表格、图表、SVG、透明度、渐变、SmartArt、备注和缺失字体。

研发与准入阶段可以使用 WPS/Office 截图作为差分参考，但它们不是运行依赖，也不通过 WpsComposer 生成 Viewer 页面。以下情况阻止对应格式进入 `ready` 支持：

- 影响理解的文字或页面丢失；
- 严重错页、遮挡、裁剪或顺序错误；
- 未检测到的元素缺失；
- 已知 `partial` 被静默标成 `ready`；
- 批注锚点与用户所见内容不一致。

每个 Office fixture 必须携带不可变参考回执：源文件 hash、参考 Office/WPS 版本和字体环境、页/Slide 数、预期文字/元素盘点、页面尺寸、对比截图和按 fixture 声明的视觉容差。自动检查覆盖页数、文字/元素完整性、几何、遮挡、裁剪、顺序和特性诊断；人工只对阈值边界和关键复杂 fixture 签署，不用主观印象代替可重复检查。DOC/PPT 使用独立 Corpus 和门槛，不继承 DOCX/PPTX 的通过记录。

### 12.3 独立性 Gate

- 在从未安装 WPS、Microsoft Office、LibreOffice、Codex Desktop 的干净 macOS/Windows 上通过 Viewer Corpus；
- 打开所有 Office fixture 时记录进程树、文件访问和网络访问，外部 Office 进程和未授权网络均为零；
- 断网环境全部 Viewer Chunk 和依赖可用；
- 安装产物与 SBOM 不含 LibreOffice/`soffice`；
- 删除或损坏 Viewer Chunk 时进入安装修复，不从系统或网络回退。

### 12.4 安全、性能与恢复 Gate

- ZIP bomb、恶意 XML/SVG/HTML、路径穿越、外链、宏和异常媒体样例全部通过；
- 第 11.1 节性能指标在可重复硬件和 Corpus 上达标；
- 快速切换、取消、Worker/Surface 崩溃、应用重启、缓存损坏和外部修改不丢文件或批注；
- 每次上游升级重新执行全部受影响格式、视觉、安全、包体和恢复 Gate。

### 12.5 Gate 拓扑与发布聚合

```text
GVP-0 Contract + Provenance
  → GVP-1 Office Fidelity
  → GVP-2 Per-format Corpus
  → GVP-3 Isolation + Malicious Files
  → GVP-4 Package + Performance
  → GVP-5 Product Integration + Recovery
  → Universal Viewer Release Admission
```

- `GVP-0`：契约、Format Admission Ledger、上游/依赖身份、许可、SBOM、漏洞和 Chunk Manifest；
- `GVP-1`：DOCX/PPTX 视觉与特性诊断；DOC/PPT 独立分级；
- `GVP-2`：每个 format/variant 的正常、复杂、损坏、超限和跨平台 Corpus；
- `GVP-3`：无路径/无网络/无 Node/无系统命令、实际解压计数、Worker 终止和恶意文件；
- `GVP-4`：20/50 MB 包体、字体闭包、第 11.1 节基准和峰值资源；
- `GVP-5`：Viewer Shell、ReviewBridge、锚点/Diff、外部修改、崩溃恢复、安装损坏与可选 Office smoke 边界。

新 V1 范围中的每个格式必须达到其声明支持模式的双平台 `go`，才能聚合为发布 `GO`；`conditional_go` 仍阻止 V1 聚合。某格式无法达标时，不得悄悄从支持表删除；必须保持发布阻塞，或按 V1RS 范围变更规则获得明确产品裁决。

## 13. WpsComposer 与外部 Office 边界

| 能力 | Universal Viewer Platform | WpsComposer | WPS/Office |
|---|---|---|---|
| SuperWagie 默认打开与浏览 | 是 | 否 | 否 |
| 搜索、分页、缩放、目录 | 按 ViewerDescriptor 能力 | 否 | 否 |
| 批注、Diff、Agent 上下文 | Viewer 提供锚点，Review 模块持久化 | 否 | 否 |
| DOCX/PPTX 生成与格式化 | 否 | 是 | 作为明确授权的执行宿主时可用 |
| Agent 结构化修改 | 只展示新 Revision | 生成/应用修改计划 | 按平台能力和授权执行 |
| 自由 Office 编辑 | 否 | 否 | 用户显式外部打开 |
| 最终目标应用 smoke | 否 | 可编排但不提供 Viewer 页面 | 可选、显式、独立验收 |

WpsComposer 不再承担 `convert_to_pdf()` 形式的 Viewer 渲染责任。若其他交付或导出流程仍需要 PDF 转换，必须以该流程独立 Capability 和权限建模，不能重新接回文件打开热路径。

Viewer Surface 的屏幕截图和临时 DOM 不得被视频/导出 Workflow 当成稳定页面 Artifact。若 PPT 讲解、缩略图批处理或导出需要确定性页面，由隔离 Render Worker 在同一冻结 parser/renderer 身份下产生 `PptPageRender` Artifact，记录源 Revision、字体、渲染参数和专用 Gate 回执。它不调用交互 Viewer，也不把 WPS/WpsComposer 放回默认页面渲染路径。

## 14. 权威规格迁移

本设计经书面复核后，必须以一个原子迁移集同步产品、契约、规则、准入和索引。迁移后的技术状态仍是 `RESEARCH_REQUIRED`，不得借文档迁移伪造 `GO`。

### 14.1 必须修改的权威产品与实施规格

1. `docs/最早期产品方案-V0.1.md`
   - 新增 Universal Viewer Platform 产品能力；重写 §12.1 和 PPT 讲解页面来源；保留 WPSComposer/外部 Office 的生成、修改和可选 smoke 边界；
2. `docs/superpowers/specs/2026-08-29-superwagie-v1-release-scope.md`
   - 把通用 Viewer 和第 5 节全部格式作为明确 V1 范围变更；删除“并排 WPS Review”作为 Viewer fallback；新增 GVP-0–5 阻塞关系；
3. `docs/superpowers/specs/2026-08-29-superwagie-coding-admission-contract.md`
   - §1 增加 Viewer Platform 分领域权威；§2.3 替换 Office Review 检测设置；§2.4 替换 WPS 视觉事实；§3 新增 Viewer Platform 模块；同步 Preview/Surface/Artifact/验收条款；
4. `docs/superpowers/specs/2026-08-28-superwagie-workspace-delivery-design.md`
   - §15–24 中的 Office Review、ArtifactViewer、设置、交付阶段和 PPT 讲解页面语义同步；§1–14 摘要中的冲突文字就地修正；
5. `docs/superpowers/specs/2026-08-29-superwagie-ui-implementation-contract.md`
   - `ArtifactViewer`、ViewerState、`partial` 诊断、格式专属 UI、能力禁用、密码、超限、导出和设置项同步；
6. `docs/superpowers/specs/2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md`
   - 移除“不用 Chromium 重排 DOCX/PPTX”；`artifact_preview` 改为 Universal Viewer Surface；进程拓扑加入 Viewer Worker、Chunk Manifest、SecretHandle 和终止边界。

### 14.2 必须修改的契约、规则与路由

1. `docs/contracts/v1/`
   - 增加 ViewerDescriptor、FormatAdmissionRecord、ViewerChunkManifest、Viewer Open/State/Diagnostic、Viewer ResourceHandle/SecretHandle、FontEnvironment、OfficeFeatureInventory、AnnotationAnchor、Diff Capability、Export Command、BenchmarkManifest、PptPageRender 和 Gate Receipt；
   - `public-capability-facade.md` 废弃 `wps.render_preview`；Viewer 打开保持为产品内部 Query/Command，可选真实 Office smoke 使用独立 Trusted Host Contract；
2. `rules/deliverables.md`
   - 重写 R-DL-08、R-DL-09；保留 R-DL-05、R-DL-07 中生成/格式化和可选真实宿主 smoke；
3. `rules/quality-scope.md`
   - 重写 R-QS-02、R-QS-08，区分 Viewer 视觉 Gate、最终 Artifact 目标应用 smoke 和 Viewer 不达标时的发布阻塞；
4. `rules/video.md`
   - 重写 R-VD-10：PPT 讲解消费已封存的 `PptPageRender` Artifact；可复用同一冻结 PPTX renderer 代码，但必须在 Render Worker 经独立视频 Gate 产生，不调用交互 Viewer、WpsComposer 或默认 WPS 页面底图；
5. `rules/ui-shell.md`、`rules/runtime-isolation.md`、`rules/security-extensions.md`、`rules/rust-packaging.md`
   - 增加 Viewer Surface、Viewer Worker、离线 Chunk、字体、供应链、无路径/无网络、资源限额和可终止性规则；
6. 新增 `rules/viewer-platform.md`，并在 `AGENTS.md` 的“改动区域 → 必读”表和 `rules/README.md` 的别名/路由中注册。

### 14.3 必须重开的技术准入与交接文档

- `docs/技术可行性/技术要求矩阵.md`、`技术验证执行计划.md`、`当前技术验证状态.json`：新增 GVP-0–5，初始统一 `RESEARCH_REQUIRED`；原 Gate 3 Review 证据不自动继承；
- `docs/技术可行性/01-桌面界面-Markdown-WebView-绘图.md`、`02-Agent运行时-沙箱-共享依赖-托管AI.md`：同步 Surface、Worker、依赖和故障所有权；
- `docs/技术可行性/05-内置能力逐项适配-PPT-Word-HTML-WPS.md`、`07-轻量视频制作内核-五场景.md`、`08-独立Office-Reviewer.md`：建立新 Viewer/PptPageRender PoC，原 WPS authoritative 路径只保留为历史对照；
- `docs/技术可行性/技术验证外部条件清单.md`、`Windows11-x64-验证交接清单.md`、`README.md`：删除 Viewer 对 WPS 的外部环境阻塞，加入干净机、签名 Chunk、字体、断网和格式 Corpus 交接；
- `docs/界面原型确认索引.md`：旧 Office Review 原型标记为 superseded，新增 Universal Viewer 通用壳、Office ready/partial、密码/超限/损坏和专属格式原型索引。

### 14.4 历史证据保留

`docs/superpowers/plans/2026-08-30-independent-office-reviewer-poc.md`、`docs/技术可行性/编码前技术验证收口报告-2026-09-01.md` 以及旧 Gate 回执是历史证据，不改写当时结论。它们只增加指向本设计和新 Gate 的 `superseded-for-current-architecture` 页首；旧证据不能被新状态扫描器当成当前 Viewer GO。

### 14.5 迁移完整性

迁移必须在单一提交集中通过：

1. `node scripts/check-spec-refs.mjs`；
2. 新增的 Viewer 语义冲突扫描；
3. contracts/schema 验证；
4. Format Admission Ledger 与 MATRIX/Gate 状态对账；
5. 历史文档 superseded 标记检查。

扫描后任何仍声称“Office Viewer 页面必须来自 WPS/Office”的当前有效文档都必须被显式裁决：更新为新语义，或标记为历史证据并从当前权威索引排除。

## 15. 上游准入与升级策略

### 15.1 初次准入

1. 完成第 14 节权威迁移，但保持 GVP-0–5 为 `RESEARCH_REQUIRED`；
2. 在可抛弃 PoC 区固定候选 commit 和依赖 lock，不接入生产 Registry；
3. 生成源码、许可证、NOTICE、SBOM、漏洞、构建 provenance、包体和原生/WASM/字体清单；
4. 证明 Obsidian 宿主、Share、writeback、LibreOffice/`soffice`、系统命令和可变网络资源路径不可达；
5. 为每个入选格式建立 SuperWagie Adapter、Format Admission Record 和 Corpus；
6. 运行上游测试、SuperWagie 差分测试、恶意样例、双平台离线、包体、字体和性能 Gate；
7. 只有通过的格式才能按已声明模式进入生产 Registry；运行时 `partial` 是通过准入的诊断状态，不是绕过格式 Gate 的手段；
8. GVP-0–5 聚合通过后冻结生产快照、hash 和补丁账本，才允许生产实施计划执行。

2026-09-04 审查快照中，候选 Obsidian 宿主依赖闭包存在 DOMPurify 与 Mermaid moderate 漏洞，且 PPT 宿主存在 LibreOffice PDF fallback。这些路径不得直接继承：SuperWagie 候选必须移除宿主 fallback、升级或补丁可达漏洞依赖，并重跑相应的 Office、DOM 消毒和 Diagram Gate。

### 15.2 升级

每次上游升级必须：

- 重新审查新 commit 之间的源代码和依赖 diff；
- 禁止小版本自动漂移；
- 更新 provenance、NOTICE、SBOM、漏洞与包体记录；
- 重跑受影响格式 Corpus、Office 视觉、安全、性能和恢复测试；
- 验证缓存 identity 和历史 Revision 的 compatibility state；
- 失败时保留当前冻结版本，不静默降级或远程热修复。

### 15.3 后续规格与计划分解

本文是 Viewer Platform 总设计，范围跨越多种解析器、安全边界和产品交互，不得生成一份超大的生产实施计划。后续必须依次形成可独立审查的规格/计划切片：

1. **权威迁移与 Gate 底座**：第 14 节、机读契约、Ledger、状态对账和冲突扫描；
2. **Frozen Core 准入 PoC**：上游补丁、依赖/许可/SBOM、Chunk 打包、Host Adapter 和恶意输入基座；
3. **Viewer Foundation**：Registry、ResourceHandle/SecretHandle、Worker/Supervisor、Surface、Shell、状态、缓存和恢复；
4. **Modern Office Vertical Slice**：DOCX/PPTX、字体、特性盘点、视觉 Corpus、锚点/Diff 和可选 smoke；
5. **Baseline Formats**：文本/源码、图片/SVG、PDF、CSV/TSV、媒体和 ZIP；
6. **Structured Formats**：Excel、HWP/HWPX、LaTeX、PSD、数据、GIS、工程和 AI 模型，按依赖族继续拆分；
7. **Legacy/Archive Formats**：DOC/PPT 和 TAR/TGZ/GZ/BZ2/XZ 的独立受限解析路径；
8. **产品聚合与发布**：ReviewBridge、PptPageRender、双平台安装包、全量 GVP-0–5 和 V1 聚合。

书面设计通过后的第一份计划只覆盖第 1–2 切片，产出是新权威基线和可抛弃 PoC 证据，不是 Viewer 生产发布。后续切片必须基于前一 Gate 的真实结果再写子规格和实施计划，不预先把未知依赖展开为伪精确任务。

## 16. 已知限制与产品诚实性

- 浏览器端 DOCX/PPTX 高还原不等于目标 Office 逐像素一致；
- DOC/PPT 在 V1 中默认是 `structured + partial visual`，不继承 DOCX/PPTX 的高还原宣称；
- Office 动画、宏、嵌入程序、复杂 OLE 和部分 SmartArt 允许进入明确 `partial`；
- XLSX 以数据和表格查看为目标，不承诺打印分页、公式重算和完整条件格式；
- Chromium 不支持的媒体 codec 不在打开时转码；
- RAR、7z、DMG 暂不支持；
- 某格式只有在 Corpus、独立性、安全和性能 Gate 全部通过后才能进入对外“支持”列表；
- 未识别特性与字体环境会造成不可完全消除的视觉差异；系统以严格 `partial` 诊断和 Corpus 降低静默误报，不做无法验证的零差异承诺；
- 上游 0.x API 不稳定由冻结 Adapter 隔离，不向业务层泄漏。

## 17. 参考与研究基线

- Omni Viewer Hub：<https://github.com/battlecook/omni-viewer>
- Omni Viewer Core：<https://github.com/battlecook/omni-viewer-core>
- 初始 Core 候选：<https://github.com/battlecook/omni-viewer-core/tree/ffdcda3eea83527380996ac935605f1422e43d3b>
- Omni Viewer Obsidian Adapter（只作宿主与格式路径研究）：<https://github.com/battlecook/omni-viewer-obsidian/tree/1db3137806dc4047513f6abd2ec010030e5029a2>
- docx-preview：<https://github.com/VolodymyrBaydalka/docxjs>
- PDF.js：<https://github.com/mozilla/pdf.js>

### 17.1 2026-09-04 候选快照

- Core 0.16.0 commit：`ffdcda3eea83527380996ac935605f1422e43d3b`；
- Obsidian Adapter 0.8.0 commit：`1db3137806dc4047513f6abd2ec010030e5029a2`；
- 干净构建的 Obsidian 单 bundle 为 11,804,984 bytes，gzip 后 5,620,081 bytes，`styles.css` 为 423,533 bytes；这说明 50 MB 目标值得继续 PoC，但未计入 SuperWagie Host、独立 Worker、字体、平台产物和签名开销，不是 GVP-4 通过证据；
- 该宿主的 PPT Adapter 在无可渲染 Slide 时接入 LibreOffice/`soffice` PDF fallback，SuperWagie 不继承这段 Host 路径；
- 当次生产依赖审计中 DOMPurify 与 Mermaid 存在 moderate 公开漏洞。候选需分别升级/补丁并重跑 DOM 消毒和 Diagram Gate，不得直接以上游 lockfile 进入 GVP-0。

上游 README、社区展示和本次本地构建测试只证明候选价值，不代替第 12、15 节的 SuperWagie 准入证据。

## 18. 实施状态附录（2026-09-04，非设计修改）

首轮 Frozen Core 可抛弃 PoC 的证据报告见 [Universal Viewer Frozen Core 准入报告](../../技术可行性/Universal-Viewer-Frozen-Core-准入报告.md)。本附录只记录实施状态，不改写本文已确认的产品或架构决策。

- 精确 Core 0.16.0 commit `ffdcda3eea83527380996ac935605f1422e43d3b` 可复现，但可执行 PPT mount 到达 PDF fallback 的 8 个 write/save/file-pick 禁止引用；候选准入为 `NO_GO`。
- 在记录的限额下，该冻结候选解析了指定的 PoC DOCX/PPTX fixtures；Host Adapter 和恶意文件单项行为通过均只是表征，不是格式支持或 Frozen Core 准入。
- macOS GVP-0 最新公开运行因实时 npm 公告审计超时而 exit `2`，是 `BLOCKED_ENVIRONMENT`且没有 receipt；Windows 缺失；GVP-1–5 和 89 条格式记录仍为 `RESEARCH_REQUIRED`。
- 本计划 Completion Definition 第 4 项和第 6 项未满足，生产实施与发布均 `NO_GO`。下一步应修订 Frozen Core，移除／隔离 PDF fallback 后重跑，而不是假设已准入并进入 Viewer Foundation。
