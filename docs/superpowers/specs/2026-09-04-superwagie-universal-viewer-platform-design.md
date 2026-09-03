# SuperWagie 通用文件 Viewer Platform 设计

> 状态：已确认设计；待权威规格同步后进入实施计划
>
> 日期：2026-09-04
>
> 决策：采用“冻结 Omni Viewer Core + SuperWagie 自有宿主层”；文件打开与 Review 不依赖 WpsComposer、WPS、Office 或 LibreOffice
>
> 用户确认：范围与组件边界、格式矩阵、打包与性能、Viewer/Review 体验、安全与验收五部分均已确认
> 准入约束：在 CAC、WD、UIC、规则包和技术要求矩阵完成同步前，本设计不得单独作为生产编码授权

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
├── extensions
├── mime_types
├── magic_signatures
├── container_probe?
├── support_mode: visual | structured | text_metadata
├── required_chunk
├── resource_limits
├── optional_features
└── fallback_policy
```

注册表必须以内容探测修正错误扩展名，但矛盾或歧义容器不得猜测执行高风险解析器。`fallback_policy` 只允许降级为安全文本、十六进制、元数据或明确 `unsupported`；不允许启动外部程序。

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
- 接受输入、解压、条目、页面、Sheet、图层、节点、媒体和内存硬限制；
- 崩溃或被终止只影响当前 Viewer Session；
- 对依赖 DOM 的渲染器，在隔离 Viewer Surface 内执行最小 DOM 阶段，整个 Surface 仍可销毁且不获得路径、Node 或网络；
- 不将解析模型持久化为业务真相；可丢弃缓存必须绑定完整身份。

### 3.4 `ViewerSurface`

- 使用独立 `artifact_preview` WebContentsView，不在 `app_ui` 主 DOM 中执行第三方解析或文档内容；
- `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；
- revision-scoped 内存 Session，不共享 Cookie、Cache Storage、service worker 或登录状态；
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
- `partial`：已呈现可用内容，但存在确定的未还原特性；
- `password_required`：不得绕过密码或上传解密；
- `limit_exceeded`：显示触发的限制和安全下一步；
- `unsupported`：不调用外部转换器，不伪造空白成功；
- `recoverable_failed`：允许安全重试、选择文本/元数据视图或在系统应用中打开；
- `stale`：源 Revision 或 Viewer 身份变化，必须重新加载。

### 4.3 恢复

同一 window 内逻辑文件继续以 `workspace_id + file_identity` 保持唯一 Tab。阅读位置、缩放和格式 UI 状态可按 `file_identity + revision + viewer_version` 恢复；它们不是领域真相。Renderer 崩溃后重新获取 Snapshot、ResourceHandle 和 Viewer Session，不重放修改副作用。

## 5. 格式矩阵与支持语义

“支持”按真实能力声明，不以识别扩展名代替完成打开：

- `visual`：完整视觉查看、缩放、分页或播放；
- `structured`：表格、目录、图层、模型、信号、数据包或计算图；
- `text_metadata`：安全文本、十六进制和元数据；
- `partial`：文件可用，但已检测到未还原特性；
- `unsupported`：无法安全或有效呈现，明确失败原因。

| 类别 | V1 格式 | 承诺能力 |
|---|---|---|
| Office | DOCX、DOC、PPTX、PPT | 高还原 `visual`；旧 DOC/PPT 和检测到未还原特性的文件可进入 `partial` |
| 表格 | XLSX、XLS、CSV、TSV | Sheet/表格 `structured`、搜索、排序、分页；不承诺 Excel 打印排版 |
| 文档 | PDF、HWP/HWPX、LaTeX | PDF 页面 `visual`；HWP 页面/结构；LaTeX 结构和公式，不宣称完整排版编译 |
| 文本与源码 | TXT、LOG、MD、JSON、JSONL、YAML、TOML、XML、常见代码 | 高亮、目录、搜索、大文件分段 |
| 图片与设计 | JPG、JPEG、PNG、GIF、BMP、WebP、SVG、PSD | 图片 `visual`；PSD 合成图和图层 `structured` |
| 音视频 | MP3、WAV、OGG、FLAC、AAC、M4A、MP4、WebM、MOV 等 Chromium 可解码格式 | 播放、速度、波形或媒体信息；不在打开路径临时转码 |
| 数据 | Parquet、Avro、SQLite/DB3、HDF5、MAT、NPY/NPZ | Schema、变量、表格、元数据和分页 `structured` |
| 图表与 GIS | Mermaid、PlantUML、Shapefile | 图形/源码切换和属性 `structured` |
| 工程 | DBC、ARXML、A2L、ASC、BLF、MF4、PCAP/PCAPNG、ROS bag、STEP、ReqIF | 信号、记录、数据包、需求或模型 `structured` |
| AI 模型 | Safetensors、GGUF、ONNX、TFLite、Keras | 元数据、张量索引、计算图和模型结构 |
| 压缩包 | ZIP、JAR、APK、TAR、TGZ、GZ、BZ2、XZ | 目录、条目预览和受控解压 |

RAR、7z、DMG 不进入 V1 承诺。只有获得体量受控、许可清晰、可随包签名、可隔离运行且不调用系统命令的解码器后，才能通过范围变更加入。

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

只有解析器实际发现问题时，Viewer Shell 才显示克制的 `partial` 状态，例如：

- 使用替代字体；
- 动画、宏、OLE、嵌入应用或复杂 SmartArt 不可预览；
- 个别元素、外链媒体或受保护内容未呈现；
- 文件损坏但已安全恢复部分内容；
- 旧 DOC/PPT 解析能力有限。

状态详情必须说明影响范围；不得用通用免责声明遮挡正常文件，也不得把已知内容丢失标为 `ready`。

### 6.3 最终 Office smoke

可选真实 WPS/Office smoke 只回答最终 Artifact 是否能在目标应用中打开、编辑、撤销、保存/放弃并重开。它是交付验收动作：

- 不生成 Viewer 底图；
- 不阻止未安装 Office 的用户打开和 Review 文件；
- 不参与 Viewer 缓存身份；
- 不把 WPS/Office 进程带入 Workspace 打开热路径；
- 未执行 smoke 时，产品不得伪造对应目标应用兼容性结论。

## 7. Viewer 与 Review 体验

### 7.1 通用交互

所有格式共用文件身份、Revision、搜索、缩放、刷新、取消、状态、批注、Diff、“让 Agent 修改”“在系统应用中打开”和阅读位置恢复。不同格式通过专属组件扩展，不复制另一套 Viewer Shell。

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

## 13. WpsComposer 与外部 Office 边界

| 能力 | Universal Viewer Platform | WpsComposer | WPS/Office |
|---|---|---|---|
| 打开与浏览文件 | 是 | 否 | 否 |
| 搜索、分页、缩放、目录 | 是 | 否 | 否 |
| 批注、Diff、Agent 上下文 | Viewer 提供锚点，Review 模块持久化 | 否 | 否 |
| DOCX/PPTX 生成与格式化 | 否 | 是 | 作为明确授权的执行宿主时可用 |
| Agent 结构化修改 | 只展示新 Revision | 生成/应用修改计划 | 按平台能力和授权执行 |
| 自由 Office 编辑 | 否 | 否 | 用户显式外部打开 |
| 最终目标应用 smoke | 否 | 可编排但不提供 Viewer 页面 | 可选、显式、独立验收 |

WpsComposer 不再承担 `convert_to_pdf()` 形式的 Viewer 渲染责任。若其他交付或导出流程仍需要 PDF 转换，必须以该流程独立 Capability 和权限建模，不能重新接回文件打开热路径。

## 14. 权威规格迁移

本设计经书面复核后，必须在同一迁移中修正以下权威或派生文档，不能依靠本文件默默覆盖：

1. `2026-08-29-superwagie-coding-admission-contract.md`
   - §1 增加 Viewer Platform 分领域权威；
   - §2.4 替换 WPS 视觉事实；
   - §3 增加 Viewer Platform 模块；
   - Preview、Surface、Artifact 和验收相关条款同步；
2. `2026-08-28-superwagie-workspace-delivery-design.md`
   - §15–§24 中 Office Review、ArtifactViewer 和 WPS 页面底图语义同步；
3. `2026-08-29-superwagie-ui-implementation-contract.md`
   - `ArtifactViewer`、Review 状态、设置项和格式专属 UI 同步；
4. `2026-09-01-superwagie-bundled-chromium-electron-architecture-design.md`
   - 移除“不用 Chromium 重排 DOCX/PPTX”；
   - `artifact_preview` 改为 Universal Viewer Surface；
   - 进程拓扑加入 Viewer Worker；
5. `rules/deliverables.md`
   - 重写 R-DL-09；保留 R-DL-05、R-DL-07 中生成和可选真实宿主 smoke；
6. `rules/quality-scope.md`
   - 重写 R-QS-02，区分 Viewer 视觉 Gate 与可选目标应用 smoke；
7. `rules/ui-shell.md`、`rules/runtime-isolation.md`、`rules/security-extensions.md`
   - 增加 Viewer Surface、离线 Chunk、无路径/无网络和不可终止解析限制；
8. 新增 `rules/viewer-platform.md`，并在 `AGENTS.md` 与 `rules/README.md` 增加改动区域路由和别名；
9. `docs/技术可行性/08-独立Office-Reviewer.md`、`05-内置能力逐项适配-PPT-Word-HTML-WPS.md`
   - 旧 WPS authoritative Preview 路径改为历史决策，并重新执行 Viewer PoC；
10. `技术要求矩阵.md`、`技术验证执行计划.md`、`当前技术验证状态.json`
    - 原 Gate 3 Office Review 证据不得自动继承；创建新的格式、视觉、独立性、包体与安全 Gate；
11. `docs/contracts/v1/`
    - 增加 Viewer Descriptor、Viewer Open、Viewer State、ResourceHandle audience 和 Viewer Annotation Anchor 的机读定义或扩展现有契约。

迁移后运行 `node scripts/check-spec-refs.mjs`。任何仍声称“Office Viewer 页面必须来自 WPS/Office”的有效规范引用都必须被显式裁决；不能只改摘要或规则包。

## 15. 上游准入与升级策略

### 15.1 初次准入

1. 固定候选 commit 和依赖 lock；
2. 生成源码、许可证、NOTICE、SBOM、包体和原生/WASM 清单；
3. 证明 Obsidian 宿主、Share、writeback、LibreOffice/`soffice` 和系统命令路径不可达；
4. 为每个入选格式建立 SuperWagie Adapter 和 Corpus；
5. 运行上游测试、SuperWagie 差分测试、恶意样例、双平台离线和性能 Gate；
6. 只有通过的格式进入 `ready` 支持表，其他格式保持 `partial`、`unsupported` 或移出 V1；
7. 冻结生产快照、hash 和补丁账本。

### 15.2 升级

每次上游升级必须：

- 重新审查新 commit 之间的源代码和依赖 diff；
- 禁止小版本自动漂移；
- 更新 provenance、NOTICE、SBOM、漏洞与包体记录；
- 重跑受影响格式 Corpus、Office 视觉、安全、性能和恢复测试；
- 验证缓存 identity 和历史 Revision 的 compatibility state；
- 失败时保留当前冻结版本，不静默降级或远程热修复。

## 16. 已知限制与产品诚实性

- 浏览器端 DOCX/PPTX 高还原不等于目标 Office 逐像素一致；
- Office 动画、宏、嵌入程序、复杂 OLE 和部分 SmartArt 允许进入明确 `partial`；
- XLSX 以数据和表格查看为目标，不承诺打印分页、公式重算和完整条件格式；
- Chromium 不支持的媒体 codec 不在打开时转码；
- RAR、7z、DMG 暂不支持；
- 某格式只有在 Corpus、独立性、安全和性能 Gate 全部通过后才能进入对外“支持”列表；
- 上游 0.x API 不稳定由冻结 Adapter 隔离，不向业务层泄漏。

## 17. 参考与研究基线

- Omni Viewer Hub：<https://github.com/battlecook/omni-viewer>
- Omni Viewer Core：<https://github.com/battlecook/omni-viewer-core>
- 初始 Core 候选：<https://github.com/battlecook/omni-viewer-core/tree/ffdcda3eea83527380996ac935605f1422e43d3b>
- Omni Viewer Obsidian Adapter（只作宿主与格式路径研究）：<https://github.com/battlecook/omni-viewer-obsidian/tree/1db3137806dc4047513f6abd2ec010030e5029a2>
- docx-preview：<https://github.com/VolodymyrBaydalka/docxjs>
- PDF.js：<https://github.com/mozilla/pdf.js>

上游 README、社区展示和本次本地构建测试只证明候选价值，不代替第 12、15 节的 SuperWagie 准入证据。
