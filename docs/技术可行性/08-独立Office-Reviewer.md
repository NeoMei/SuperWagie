# 技术可行性 08：独立 Office Reviewer

> 状态：核心 PoC 已执行；独立干净机和人工视觉签署未完成  
> 日期：2026-09-01  
> 结论：`FEASIBLE_CONDITIONAL`

> 架构更新（2026-09-01）：Reviewer 使用 `artifact_preview` WebContentsView；Rust Product Core 保持 Artifact/Policy 权威，WPS/Office Host Worker 产生视觉事实页，Renderer 只取得短期 Resource Handle。旧 Tauri/System WebView PoC 只保留为历史证据。

## 1. 要回答的问题

SuperWagie 需要提供接近 Codex Desktop 右侧 Review 面板的 Office 浏览和审阅体验，但该能力必须由 SuperWagie 独立实现：

- 用户未安装 Codex Desktop 时仍能运行；
- 不读取、启动、连接或探测机器上已有的 Codex Desktop、Codex CLI/Server 及其文件、IPC、配置、会话和缓存；
- 不复制 Codex Desktop 私有代码、静态资源、协议或内部文档模型；
- 可以使用审查通过的开源库和经过 feature probe 的系统 WPS/Office Runtime；
- Office 视觉事实仍以真实 WPS/Office 渲染为准，不能为了获得内嵌体验而接受格式走样。

本调查只确定独立实现路径和 PoC 准入条件，不把本机只读观察升级为可再分发代码，也不把 PoC 视为生产实现。

2026-09-01 的 Gate 3 证据将 `G3-REVIEW-001` 判为 `CONDITIONAL_GO`，将要求
“从未安装 Codex Desktop 的干净环境”的 `G3-REVIEW-002` 判为
`BLOCKED_ENVIRONMENT`。这证明快速/原格式双预览、批注重锚和真实 WPS 事实源
有实现路径，但不能据此签署生产 GO；当前仍缺干净 macOS/Windows、人工逐页视觉
清单和 WPS 条款签署。

## 2. 调查结论

### 2.1 可以独立重建体验，不能直接移植组件

OpenAI 当前公开的 Codex SDK 是 Agent 执行接口，不是 Office Reviewer SDK。公开文档中没有找到可供第三方应用嵌入的 Codex Office Reviewer API、组件包或再分发条款。因此生产架构不能依赖“以后把 Codex Reviewer 组件抽出来”，必须按独立实现设计。

对本机已安装 Codex Desktop `26.825.32147` 的只读观察显示：

- DOCX 预览包含 `docx-preview 0.3.7`；
- PDF 预览包含 `pdfjs-dist 5.4.296` 和 `react-pdf 10.4.1`；
- 产品体验还包含自有的预览页头、分页/缩略图、缩放、批注、差异、选区和 Agent 交互层；
- PPT/演示文稿使用专用结构化模型、渲染 Worker 和交互层，不是第三方声明中可直接复用的公开 Office 组件。

这说明优秀体验主要来自“格式渲染器 + 统一 ReviewShell + Revision/Annotation 模型”的组合。SuperWagie 可以独立重建组合，但不得复制 Codex 私有实现。

### 2.2 结论等级

| 能力 | 结论 | 约束 |
|---|---|---|
| PDF 查看、文字层、搜索、分页与缩放 | 高可行 | 使用固定版 PDF.js；必须离线、虚拟化并隔离文件权限 |
| DOCX 快速预览 | 高可行 | `docx-preview` 只提供响应快的近似预览，不是视觉事实 |
| DOCX 原格式 Review | 条件可行 | WPS/Office 渲染 PDF；字体、分页和目标版本进入缓存身份 |
| PPTX 原格式 Review | 条件可行 | WPS/PowerPoint 渲染页面；不自研 PPTX 排版引擎 |
| 批注、差异、Agent 修改请求和版本确认 | 高可行 | SuperWagie 自有 ReviewOverlay 与稳定锚点模型 |
| 任意 PPTX 对象级语义选择和直接编辑 | 首版不承诺 | 无可靠语义 ID 时只允许页、区域或附近文本锚点 |
| XLSX Review | 预留，不进入当前 V1 承诺 | 可增加 Spreadsheet Adapter，但须另做范围和大表性能 PoC |
| 直接复用 Codex Reviewer | `NO_GO` | 无公开组件契约，违反独立 Runtime 与 clean-room 边界 |

## 3. 产品与技术边界

### 3.1 “独立”的可测试定义

生产包和运行过程必须同时满足：

1. 安装清单不包含任何来自 Codex Desktop 的二进制、代码、资源或生成物；
2. 运行时不访问 Codex Desktop 安装目录、App Container、配置目录、Socket、端口或进程；
3. 移除或从未安装 Codex Desktop 后，Reviewer 的功能和测试结论不变；
4. Codex Desktop 正在运行、升级、崩溃或使用不同配置时，Reviewer 的 hash、依赖选择、行为和缓存身份不变；
5. 第三方依赖只来自固定来源和 lock，进入 NOTICE、SBOM、许可证与漏洞审计；
6. WPS/Office 仅作为 External Host，经绝对路径、版本、架构和 feature probe 选择，不携带任何其他 Agent 环境状态。

SuperWagie Agent 核心按既有架构使用随产品固定分发的 App Server sidecar，不属于“复用机器上的 Codex Desktop”。Reviewer 的打开、渲染、翻页、批注、缓存和恢复不经过该 sidecar；只有用户明确发送 Agent 修改请求时，`AgentReviewBridge` 才通过 SuperWagie Public Agent Facade 建立任务上下文，不能调用 raw App Server 协议或 Codex Reviewer 私有接口。Agent Runtime 暂时不可用时，纯浏览与批注仍须工作。

### 3.2 Review 不是 Office 编辑器

Reviewer 负责浏览、审阅和发起修改，不伪装成完整 Office 编辑器：

- 中央视图只读显示 Preview Revision；
- 批注、选择、差异和 Agent 请求写入 Review 数据，不直接修改渲染底图；
- Agent 修改必须经过 WPSComposer、SuperPPT 或受控 Office Adapter 生成新的 Artifact Revision；
- 新 Revision 重新渲染后，用户进行视觉确认；
- 需要自由编辑时打开 WPS 受控副本并与 SuperWagie 并排工作。

## 4. 架构

```text
Office Artifact Revision
        │
        ▼
Trusted Artifact Broker
        │  logical URI / bounded bytes / revision identity
        ▼
Preview Orchestrator
├── PdfAdapter ────────────── PDF.js
├── DocxFastAdapter ───────── docx-preview
└── OfficeTruthAdapter ────── WPS/Office → PDF
        │
        ▼
Immutable Preview Revision + Page/Thumbnail Cache
        │
        ▼
ReviewShell
├── VirtualizedPageRail
├── DocumentViewport
├── Search/TextLayer
├── ReviewOverlay
├── RevisionDiff
└── AgentReviewBridge
        │
        ▼
ReviewAnnotation / ReviewDecision / Agent Change Request
        │
        ▼
Controlled Edit → New Artifact Revision → Re-render
```

`artifact_preview` WebContentsView 只运行固定、签名的 ReviewShell 静态资源，并使用 revision-scoped 内存 Session。Rust Product Core 拥有 Artifact、权限、revision 与缓存提交权威，WPS/Office Host Worker 只执行当前请求；renderer 只获得 audience-bound Preview Resource Handle，不获得真实路径、Node、进程或任意网络接口。Office 视觉事实仍由 WPS/Office 生成，Chromium 只显示 authoritative page surface。

## 5. 核心组件契约

### 5.1 `PreviewOrchestrator`

职责：选择 Adapter、管理渐进状态、取消、缓存和重试，不包含格式渲染细节。

```text
PreviewRequest
├── artifact_revision_id
├── logical_uri
├── media_type
├── preferred_fidelity: fast | authoritative
├── target_platform
└── deadline

PreviewState
├── queued
├── loading_fast
├── fast_ready
├── rendering_authoritative
├── authoritative_ready
├── dependency_missing
├── unsupported
├── failed_recoverable
└── failed_terminal
```

`fast_ready` 不是验收状态。存在 authoritative 路径时，后台自动继续渲染，不要求用户重复打开文件。

### 5.2 `PreviewAdapter`

每个 Adapter 只能通过统一契约暴露能力：

```text
probe() -> AdapterAvailability
open(ArtifactRef, PreviewOptions) -> PreviewJob
get_manifest(PreviewJob) -> PreviewManifest
get_page(page_id, scale_bucket) -> PageSurfaceRef
get_thumbnail(page_id) -> PageSurfaceRef
get_text_layer(page_id) -> TextLayer? 
cancel(PreviewJob) -> Receipt
```

Adapter 不能返回真实文件路径、WPS 句柄或任意可执行脚本。每个响应绑定 `artifact_revision_id`、`renderer_id`、`renderer_version` 和输入 hash。

### 5.3 `PreviewRevision`

```text
PreviewRevision
├── preview_revision_id
├── artifact_revision_id
├── fidelity: fast | authoritative
├── renderer_id
├── renderer_version
├── renderer_environment_hash
├── font_environment_hash
├── page_manifest_hash
├── source_content_hash
├── created_at
└── acceptance_state
```

缓存键至少包含以上身份。WPS/Office 版本、字体集合、渲染参数或源文件变化时必须生成新 Preview Revision，不能复用旧页面并宣称精确。

### 5.4 `ReviewAnnotation`

批注使用组合锚点：

- Artifact Revision；
- Preview Revision；
- 页/幻灯片稳定身份；
- normalized bounding box；
- 选中文本与前后文 hash（可得时）；
- 语义对象 ID（由 SuperPPT/SuperWriter IR 提供时）；
- 创建时 renderer/environment identity。

重分页、页面插删或对象重建后按语义 ID、附近文本、页邻域和图像特征逐级重定位。低于阈值必须标为 `stale` 或 `unresolved`，不得静默移动到相似内容。

## 6. 分格式实现

### 6.1 PDF

采用固定版 PDF.js 的 display layer，自建 ReviewShell，不直接搬用未修改的通用 viewer UI。启用 Worker、分页虚拟化、scale bucket、缩略图和文字层；WebView 不通过任意 URL 读取本地文件，二进制由 Artifact Broker 按权限提供。

PDF 是 authoritative 预览格式，也是 WPS 渲染 DOCX/PPTX 后的统一页面协议。PDF.js 只解释已经生成的 PDF，不决定原 Office 文档是否正确。

### 6.2 DOCX 快速预览

`docx-preview` 以 HTML 快速显示内容，适合在 WPS 渲染等待期间建立首屏和基本阅读体验。它受 HTML 排版、实时分页、字段、字体和 Office 特性限制，因此：

- UI 明确显示“原格式预览准备中”，不显示“已精确还原”；
- 快速预览的页面号和坐标不能直接成为永久 authoritative 锚点；
- 在快速预览创建的批注必须在 authoritative Preview 就绪后重投影并验证；
- 未能可靠重投影的批注进入 `unresolved`，要求用户重新定位；
- 快速预览失败不阻止 WPS authoritative 渲染继续。

### 6.3 DOCX/PPTX 原格式预览

OfficeTruthAdapter 使用受控副本调用已验证的 WPS/Office Adapter 转为 PDF：

```text
Artifact Revision
→ controlled copy
→ WPS/Office feature probe
→ isolated render job
→ staging PDF
→ page count/text/font/basic integrity validation
→ atomic Preview Revision publish
→ PDF.js progressive display
```

热路径不调用 WPS：已经发布的 PDF 页面、缩略图、搜索索引和批注全部由本地缓存与 ReviewShell 响应。WPS 只出现在首次渲染、源文件修改后的重渲染和真实验收中。

PPTX 原始动画、触发器、媒体播放和演讲者视图不属于静态 Review 保真范围；静态页面必须与目标 WPS/PowerPoint 一致。PPT 讲解视频对动画的处理继续服从视频规格，不由 Reviewer 扩大范围。

## 7. Review 交互

V1 必须包含：

- 连续 Word 页面、PPT 缩略图和单页模式；
- 适宽、适页、百分比缩放和键盘翻页；
- 渐进加载、当前页优先、邻页预取和取消；
- PDF/DOCX 可得文字层上的搜索和文字选择；
- 点、区域、文字三类批注；
- 当前 Revision 与上一确认 Revision 的页面级视觉差异；
- 将选区、批注、页码和 Revision 作为结构化上下文发送给 Agent；
- Agent 完成修改后自动打开新 Preview Revision，并显示旧/新差异；
- 接受、继续修改、在 WPS 打开和标记已验收。

V1 不包含：

- 在 ReviewShell 内直接自由编辑 DOCX/PPTX；
- 对任意 PPTX 承诺对象级选择、图层树或原动画编辑；
- 多人实时批注协作；
- 依赖 Codex Desktop、在线 Office Viewer 或第三方云上传才能工作。

## 8. 性能、恢复与降级

沿用现有 Gate 3 目标：

- 300ms 内出现真实加载/进度状态；
- 已缓存 Preview 首屏 P95 不超过 1 秒；
- 代表性 30 页 DOCX / 20 页 PPTX 的 authoritative 首个可审阅页面目标不超过 5 秒，其余页面渐进加载；
- 滚动、缩放、翻页、选区和批注热路径不调用 WPS，P95 反馈不超过 100ms；
- 修改后立即显示任务回执，后台生成新 Preview Revision；
- WebView、WPS Worker 或应用崩溃后，不发布半成品 Preview、不丢批注、不覆盖已确认 Revision。

降级顺序：

1. authoritative Preview 已缓存：继续完整 Review；
2. WPS 缺失但 DOCX 快速 Adapter 可用：允许阅读并明确标注非原格式，不允许完成视觉验收；
3. PPTX 且 WPS 缺失：显示依赖状态和安装引导，不伪造 PPT 页面；
4. 内嵌滚动/缩放未达标：使用外部/并排 WPS + SuperWagie Review 面板；
5. 单一 Adapter 故障：只禁用对应格式，不阻止 Workspace、Markdown、Agent 和其他预览启动。

LibreOffice/ONLYOFFICE 不作为静默替换 WPS 的 authoritative renderer。若未来增加，必须产生独立 renderer identity、视觉差分证据、许可证和包体决策，不能沿用 WPS 的通过记录。

## 9. 安全与许可证

- `docx-preview` 与 PDF.js 当前为 Apache-2.0；`react-pdf` 当前为 MIT。实际打包版本必须重新核对 LICENSE/NOTICE，并进入 lock、SBOM 和漏洞扫描；
- 可以借鉴公开行为和交互原则，不能复制 Codex 私有 bundle、协议、模型、样式代码或内部命名；
- PoC 和生产都使用团队自有的 Office fixture，不把用户文档或本机 Codex 资源放入仓库/evidence；
- DOCX/PPTX/PDF 均视为不可信输入；解析和 WPS Worker 有大小、页数、时间、内存、路径、外链和子进程限制；
- PDF.js、DOCX HTML 和文字层运行在无网络、严格 CSP 的受限 origin；
- WPS SDK/JSAPI/COM 的商业使用与再分发条款仍是独立发布门，本调查不替代法律和供应链准入。

## 10. PoC 与验收

### 10.1 Fixture

扩充 `G3-REVIEW-001`：

- 30 页 DOCX：目录、编号、多节、页眉页脚、脚注、表格、浮动图片、横竖页、中文字体、缺失字体和重分页；
- 20 页 PPTX：图片型页、可编辑页、图表、表格、SVG、透明度、渐变、媒体封面、缺失字体和对象重建；
- 100 页 PDF：文字层、扫描页、书签、链接、批注、混合页面尺寸和损坏尾页；
- 每种格式至少一份恶意/超限样例。

新增 `G3-REVIEW-002`：

- 干净机器从未安装 Codex Desktop；
- 已安装但未启动、正在运行、升级前后和配置变化的 Codex Desktop；
- WPS 正常、缺失、不兼容、渲染超时和崩溃；
- WebView 崩溃、应用重启、缓存损坏和源 Artifact 外部修改。

### 10.2 必须记录的指标

- fast/authoritative 首屏、全页完成、缩略图和搜索索引时间；
- 滚动/缩放/选区/批注 P50/P95、长任务和掉帧；
- 峰值内存、缓存大小、Worker/进程数量、取消完成时间；
- WPS 直接打开/导出与 Preview 的页面数、尺寸、像素差异和人工视觉结论；
- 批注在插页、删页、重分页、字体替换和对象重建后的定位结果；
- Codex 安装/运行/配置变化前后的 SuperWagie dependency manifest、进程树、访问日志和 Preview hash。

### 10.3 通过条件

1. PDF、DOCX、PPTX 三种代表文档完成打开、滚动、缩放、搜索/选择（格式支持时）、批注、Agent 请求、新 Revision 和确认闭环；
2. authoritative Preview 与同环境 WPS/Office 直接渲染结果在规定容差内，且人工检查无影响审阅的走样；
3. 批注不能可靠重定位时全部进入 `unresolved`，静默错位为零；
4. 热路径、首屏、缓存和恢复达到第 8 节门槛；
5. 从未安装 Codex Desktop 的目标机完整通过；Codex 运行和配置变化不改变 SuperWagie 行为；
6. 包、进程、网络、文件访问和 SBOM 中不存在 Codex Desktop 依赖或私有资源；
7. WPS 缺失/故障按能力降级，不阻止核心客户端启动；
8. 许可证、NOTICE、SBOM、WPS 条款和 clean-room provenance 形成签署决定。

未满足 2、3、5、6 任一项时为 `NO_GO`，不能以“基本能看”进入生产实现。性能未达标但视觉和独立性通过时为 `CONDITIONAL_GO`，启用并排/外部 WPS fallback。

## 11. 进入生产计划前的输出

Gate 3 通过后才能编写 Production Implementation Plan。计划至少拆为：

1. Preview/Revision/Annotation 契约、Rust Product Core 与 WPS Host Worker；
2. PDF.js ReviewShell 和虚拟化页面；
3. DOCX Fast Adapter 与 authoritative 切换；
4. WPS OfficeTruthAdapter、缓存和崩溃隔离；
5. 批注重定位、视觉 Diff 与 AgentReviewBridge；
6. 双平台打包、安全、许可证和真实 Office 验收。

## 12. 参考证据

- OpenAI, Codex SDK：<https://openai.com/index/codex-now-generally-available/>
- OpenAI, ChatGPT Work and Codex：<https://help.openai.com/en/articles/20001275>
- docxjs / `docx-preview`：<https://github.com/VolodymyrBaydalka/docxjs>
- Mozilla PDF.js：<https://mozilla.github.io/pdf.js/getting_started/>
- LibreOffice PDF CLI（仅作可选 renderer 对比研究）：<https://help.libreoffice.org/latest/en-US/text/shared/guide/pdf_params.html>
- ONLYOFFICE Docs API（仅作大型嵌入式 Office 方案对比研究）：<https://api.onlyoffice.com/docs/docs-api/get-started/basic-concepts/>
- 本机 Codex Desktop 第三方声明：`/Applications/ChatGPT.app/Contents/Resources/THIRD_PARTY_NOTICES.txt`
- 现有 WPS Review 基线：[05-内置能力逐项适配-PPT-Word-HTML-WPS.md](05-内置能力逐项适配-PPT-Word-HTML-WPS.md#351-wps-渲染-review-工作区)
