# Universal Viewer Platform 技术验证入口

> 状态：`RESEARCH_REQUIRED`
> 迁移日期：2026-09-04
> 当前权威：`docs/superpowers/specs/2026-09-04-superwagie-universal-viewer-platform-design.md`

本文件已从旧 Independent Office Reviewer 调查迁移为 Universal Viewer 技术验证入口。旧架构证据保存在 `docs/superpowers/plans/2026-08-30-independent-office-reviewer-poc.md`、`docs/技术可行性/编码前技术验证收口报告-2026-09-01.md` 与两个 G3-REVIEW fixture README；它们只具历史地址性，不能满足 GVP-0–5。

## 1. 当前结论

- SuperWagie 内置 Viewer 是 DOCX、PPTX、PDF 及设计 §5 全部格式的默认打开与浏览权威。
- 打开路径不启动外部 Office 应用、外部转换器或系统命令；无法证明完整能力时必须返回带范围诊断的 `partial`，不得伪造 `ready`。
- WpsComposer 继续拥有 DOCX/PPTX 生成和格式化语义，不向 Viewer 提供页面、底图或转换依赖。
- 用户显式选择外部编辑或最终交付 smoke 时，可通过受控 Trusted Host 合同打开目标应用；该证据与 Viewer 准入相互独立。
- 候选、所有格式记录与 GVP-0–5 当前均为 `RESEARCH_REQUIRED`，不得进入生产 Viewer Registry。

## 2. 必须验证的内部拓扑

```text
Rust Product Core
├── Viewer Registry + signed Format Admission Ledger
├── Viewer Open/State/Diagnostic internal contracts
├── audience-bound ResourceHandle / one-shot SecretHandle
├── isolated ViewerWorker
├── sandboxed ViewerSurface
├── ViewerShell
└── ReviewBridge → annotation/diff/version intents
```

ViewerSurface 必须使用独立、无 Node、无网络、revision-scoped 的 `artifact_preview` WebContentsView。ViewerWorker 只持有当前 audience-bound handle，并执行字节、条目、嵌套、像素、页数、内存、CPU、deadline 与取消限制。缓存键必须绑定源 Revision、Viewer/Parser/Renderer/字体身份和参数。

## 3. Office 格式验证

DOCX/PPTX 目标为高还原 `visual`；DOC/PPT 初始目标为 `structured + partial visual` 且 `partial_by_default=true`；XLSX/XLS 只承诺已声明的结构能力。测试 Corpus 必须覆盖主题/母版、分页、字体替换、图表、浮动对象、SVG/EMF/WMF、SmartArt、字段、合并单元格及损坏/加密/超限样例。

任何未知 namespace、content type、relationship、绘图对象、替代字体、占位图或容错恢复都会使文件进入 `partial`。密码只能经一次性 `SecretHandle` 注入当前解密操作，明文不得进入 renderer、日志、Workspace 或长期缓存。

## 4. Review 与 Diff

ReviewBridge 使用页、Slide、Sheet、文字范围、区域、记录或语义元素锚点，Rust Product Core 持久化批注、Diff、Agent 修改请求和版本确认。不同格式必须独立声明 Diff 能力；不支持语义 Diff 时只提供明确的 page/pixel/text/metadata 模式。

视频的 PPT 页面输入只能消费经隔离渲染、身份和 Gate 回执密封的 `PptPageRender`；不得截取交互 Surface 作为来源。

## 5. GVP-0–5

| Gate | 验证对象 | 初始状态 |
|---|---|---|
| GVP-0 | Schema、Registry、Ledger、检测顺序与契约 fixture | `RESEARCH_REQUIRED` |
| GVP-1 | 每个格式/容器变体的正确性、损坏、加密和限额行为 | `RESEARCH_REQUIRED` |
| GVP-2 | 格式专属 Corpus、视觉/结构/文本/媒体能力与 `ready`/`partial` | `RESEARCH_REQUIRED` |
| GVP-3 | Surface/Worker 隔离、handle/secret、网络/导航/主动内容和攻击语料 | `RESEARCH_REQUIRED` |
| GVP-4 | macOS 15 arm64 与 Windows 11 x64 的性能、崩溃、取消、恢复和缓存 | `RESEARCH_REQUIRED` |
| GVP-5 | 签名 Chunk、包体预算、SBOM、LICENSE/NOTICE、来源/构建可复现性 | `RESEARCH_REQUIRED` |

只有每个格式变体在两个目标平台持有全部 required Gate 的哈希绑定回执，才可升级 `FormatAdmissionRecord.current_state`。任何旧 G3 Review 的结论、截图或 renderer 记录都不能复用为 GVP 回执。

## 6. 验收输出

技术验证必须产出：候选/版本/平台/Corpus 身份、输入与输出哈希、Viewer/Parser/Renderer/字体身份、状态与范围诊断、资源与时间指标、攻击样例结果、Chunk/SBOM/许可清单及签名 `ViewerGateReceipt`。在此之前，本文不声明任何格式已实现或已准入。
