# 规则包：Universal Viewer Platform（viewer-platform）

适用范围：Viewer Registry、格式探测、解析/渲染 Worker、Viewer Surface/Shell、ReviewBridge、格式准入、离线 Chunk 与 `PptPageRender`。

## R-VP-01 格式准入是唯一支持事实

每个扩展名/容器变体必须在 Format Admission Ledger 中有稳定记录；Registry 只投影已通过当前平台所需 Gate 的记录，不得以扩展名匹配、README 或运行时猜测宣称支持。[VIEWER §5] [VIEWER §12.5] [VIEW-01]

## R-VP-02 `ready` / `partial` 严格诚实

`ready` 必须同时满足准入、特性盘点、字体/解码器可用且无强制 partial 诊断；未识别部件、替代字体、占位或容错恢复一律是 `partial`，并绑定页/Slide/Sheet/记录/元素范围。[VIEWER §4.2] [VIEWER §6.2] [VIEW-04]

## R-VP-03 Viewer 路径独立

文件打开、阅读、批注和 Review 路径禁止调用外部 Office 宿主、LibreOffice/`soffice`、WpsComposer、FFmpeg、在线转换器或系统命令；用户显式“在系统应用中打开”和最终交付 smoke 是独立授权动作。[VIEWER §4.1] [VIEWER §8.3] [VIEWER §13] [VIEW-03]

## R-VP-04 签名离线 Chunk

所有 Viewer 代码、WASM、资产、字体和解码器在安装事务中完备，由 ViewerChunkManifest 绑定平台/架构、直接/传递依赖、许可/NOTICE、provenance、逐文件 hash 和签名；懒加载不得变成首次下载。[VIEWER §8.1] [VIEW-06]

## R-VP-05 Handle 与密码隔离

Viewer 只使用 audience/operation/revision-bound ViewerResourceHandle，不获取真实路径、Workspace 根、网络、进程或通用文件系统；密码只经受信 UI 和一次性 SecretHandle 到可终止 Worker，不进日志、缓存、恢复或崩溃包。[VIEWER §9.2] [VIEWER §9.5] [VIEW-07]

## R-VP-06 逐格式资源上限

探测读取、输入、解压字节/条目/层数/压缩比、XML/DOM、页/Slide/Sheet、图像/动画、表格/文本、RSS 和时限必须按描述符实时执行；提高基线上限必须有新 Gate 回执。[VIEWER §9.4] [VIEW-08]

## R-VP-07 供应链准入

上游 commit、lock、源码/构建 provenance、SBOM、NOTICE、商业再分发、漏洞和构建脚本必须在 GVP-0 审查；不明许可、可达 high/critical 或不可复现产物直接阻止格式准入。[VIEWER §8.4] [VIEWER §15] [VIEW-12]

## R-VP-08 缓存与 Revision

Viewer 缓存键绑定文件内容、Workspace/Artifact Revision、Core commit、Viewer/parser/dependency、渲染参数和字体环境；任一身份变化必须 `stale` 并重建，缓存不得成为文件或验收事实。[VIEWER §10.1] [VIEW-09]

## R-VP-09 格式专属 Diff 与批注

Diff 能力按格式声明 `text/structure/visual/time/metadata_only/none`；视觉 Diff 必须绑定 renderer 与字体身份。批注锚点绑定源 Revision 和渲染上下文，低置信重定位进入 `unresolved`，不得静默漂移。[VIEWER §7.4] [VIEWER §10.2] [VIEW-10]

## R-VP-10 GVP 阻塞拓扑

Viewer 发布严格依赖 GVP-0 → GVP-1 → GVP-2 → GVP-3 → GVP-4 → GVP-5；每个 V1 格式的所需支持模式必须有 macOS/Windows 绑定回执，`CONDITIONAL_GO` 仍阻止聚合发布。[VIEWER §12.5] [VIEW-14]

| Gate | Meaning |
|---|---|
| GVP-0 | Contract + Provenance |
| GVP-1 | Office Fidelity |
| GVP-2 | Per-format Corpus |
| GVP-3 | Isolation + Malicious Files |
| GVP-4 | Package + Performance |
| GVP-5 | Product Integration + Recovery |

## R-VP-11 未准入禁止生产实现

候选 Core、全部格式和 GVP-0–5 初始均是 `RESEARCH_REQUIRED`。在绑定证据升级前只允许可抛弃 PoC、Corpus、契约 fixture 和 Gate runner，不得进入生产 Registry 或对外宣称支持。[VIEWER §1.1] [VIEWER §15.1] [VIEW-01]
